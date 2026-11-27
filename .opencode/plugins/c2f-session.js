// Tells c2f which OpenCode session a c2f_advise call comes from, so one OpenCode session keeps one
// DeepSeek conversation even when the model forgets to pass its `thread`. OpenCode does not send the
// session to MCP servers. Installed by `c2f kur`; works with OpenCode 1.x and 2.x.
//
// Two channels, because neither works everywhere:
// - 1.x: the session is written into the call's arguments (`opencode_session`).
// - 2.x runs most tool calls from inside its `execute` code tool, where a changed input is not passed on.
//   So the hook also notes "this message comes from this session" in a small file c2f reads
//   (oc-sessions.json next to c2f's other files; entries live two minutes).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP_MS = 120_000;
const isAdvise = (tool) => /(^|_)c2f_advise$/.test(String(tool || ""));
const home = () => process.env.C2F_CONFIG_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "ChatToFree");

function note(args, sessionID) {
  if (!args || typeof args !== "object" || typeof args.message !== "string" || !sessionID) return;
  try {
    const file = path.join(home(), "oc-sessions.json");
    let seen = {};
    try {
      seen = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* none yet */
    }
    const now = Date.now();
    for (const [k, v] of Object.entries(seen)) if (!(now - v.at < KEEP_MS)) delete seen[k];
    seen[crypto.createHash("sha1").update(args.message).digest("hex")] = { session: String(sessionID), at: now };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, file);
  } catch {
    /* without the note c2f falls back to the thread id */
  }
}

export default {
  id: "c2f-session",
  // OpenCode 2.x
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (isAdvise(event.tool)) note(event.input, event.sessionID); // a changed input is not passed on (seen in 2.3.0)
    });
  },
  // OpenCode 1.x: also written into the arguments object it already holds (it keeps using that object).
  async server() {
    return {
      "tool.execute.before": async (input, output) => {
        if (!isAdvise(input.tool)) return;
        note(output.args, input.sessionID);
        if (output.args && typeof output.args === "object" && input.sessionID) output.args.opencode_session = String(input.sessionID);
      },
    };
  },
};
