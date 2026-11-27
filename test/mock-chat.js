/**
 * A tiny stand-in for a web chat model. It mimics the ChatGPT DOM the extension
 * expects and streams scripted replies, so the whole bridge can be tested
 * headlessly without an account.
 *
 * Usage: node test/mock-chat.js [port]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = fs.readFileSync(path.join(HERE, "mock-app.js"), "utf8");

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock Chat</title>
<style>
 body{font:15px system-ui;margin:0;background:#f7f7f8;color:#111}
 #thread{padding:16px;min-height:60vh}
 .turn{margin:10px 0;padding:10px 12px;border-radius:8px;max-width:70ch;white-space:pre-wrap}
 .user{background:#e6f0ff;margin-left:auto}
 [data-message-author-role=assistant]{background:#fff;border:1px solid #e3e3e3}
 .code-block{border:1px solid #ddd;border-radius:8px;overflow:hidden;margin:8px 0;white-space:normal}
 .code-header{display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:#f0f0f0;font-size:12px}
 pre{margin:0;padding:10px;overflow:auto;background:#fafafa}
 form{display:flex;gap:8px;padding:12px;border-top:1px solid #ddd;background:#fff;position:sticky;bottom:0}
 #prompt-textarea{flex:1;min-height:44px;max-height:160px;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit;resize:vertical}
 button{padding:0 16px;border-radius:8px;border:0;background:#111;color:#fff;font:inherit}
 button:disabled{opacity:.35}
</style></head>
<body>
<div id="thread"></div>
<div id="consent" role="dialog" aria-label="Çerez ayarları">
  <form id="consent-form"><button type="submit" id="accept-all">Tümünü kabul et</button>
  <button type="submit" id="reject-all">Gerekli olmayanları reddet</button></form>
</div>
<form id="composer"><textarea id="prompt-textarea" placeholder="Message the mock model"></textarea>
<button type="submit" disabled>Gönder</button></form>
<script src="/app.js"></script></body></html>`;

const STEP_FILE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Snake</title></head>
<body style="margin:0;background:#111;color:#eee;font:14px system-ui">
<canvas id="c" width="480" height="480" style="display:block;margin:20px auto"></canvas>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');let s=[{x:9,y:9}],d={x:1,y:0},f={x:5,y:5},n=0;
addEventListener('keydown',e=>{const m={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]}[e.key];if(m)d={x:m[0],y:m[1]}});
setInterval(()=>{const h={x:(s[0].x+d.x+24)%24,y:(s[0].y+d.y+24)%24};s.unshift(h);if(h.x===f.x&&h.y===f.y){n++;f={x:(Math.random()*24)|0,y:(Math.random()*24)|0}}else s.pop();
x.fillStyle='#111';x.fillRect(0,0,480,480);x.fillStyle='#4ade80';for(const p of s)x.fillRect(p.x*20,p.y*20,19,19);x.fillStyle='#f87171';x.fillRect(f.x*20,f.y*20,19,19);x.fillStyle='#eee';x.fillText('score '+n,10,20)},100);
<\/script></body></html>`;

function ops(ops) {
  return "```json\n" + JSON.stringify({ ops: ops }, null, 1) + "\n```";
}

/** The section format the CLI asks for: headings + fenced bodies, no JSON escaping. */
function sections(...lines) {
  return lines.join("\n");
}

/** Deterministic scripted model. Real big models answer these same prompts. */
export function scriptedReply(prompt) {
  const p = String(prompt);
  if (/principal engineer/i.test(p)) {
    return "Stack: one static HTML file, canvas 2D, no build step.\n\nLayout: index.html only (pure client, safest to ship).\n\nAlgorithm: grid snake loop on a 100ms timer, wrap edges, food on random free cell, arrow keys turn.\n\nEdge cases: keep the score visible, no external assets, works offline.\n\nRoadmap:\n1. index.html renders a playable game; arrow keys move, food increments the score.";
  }
  if (/strict reviewer/i.test(p)) {
    return "Problems: none that block shipping a one-file game. Minimal fix: none. Design stands.";
  }
  if (/ordered build plan/i.test(p)) {
    return "```json\n" + JSON.stringify({ steps: [{ title: "Write a playable index.html", acceptance: "Opening index.html shows a snake that moves with arrow keys and a visible score", files: ["index.html"] }] }, null, 1) + "\n```";
  }
  if (/QA engineer/i.test(p)) {
    return "Everything the user asked for is present in index.html and self-contained. Nothing to fix.\n\n### DONE index.html is complete and playable";
  }
  // Sections only, no JSON: if the heading path breaks, the file never gets written.
  if (/# Current step/.test(p)) {
    return sections(
      "Writing the whole game as a single file: canvas render, input, food and score.",
      "",
      "### FILE index.html",
      "```html",
      STEP_FILE.trim(),
      "```",
      "",
      '### RUN node -e "console.log(require(\'fs\').statSync(\'index.html\').size)"',
      "",
      "### DONE index.html written",
    );
  }
  return "I am a scripted stand-in for a web chat model. Send a build prompt to see the ops protocol.";
}

export function startMockChat(port = 0) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && (req.url === "/reply" || req.url === "/reply-stream")) {
      let body = "";
      req.on("data", (b) => (body += b));
      await new Promise((r) => req.on("end", r));
      let prompt = "";
      try {
        prompt = JSON.parse(body).prompt;
      } catch {
        /* keep empty */
      }
      const text = scriptedReply(prompt);
      if (req.url === "/reply") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(text);
        return;
      }
      // Chunked stream, like a real site. Server timers are not throttled, so the
      // page's hidden-tab timer clamp cannot slow this down.
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      // A model that writes its heading and then thinks for over a second before the first
      // word (measured on Claude): the reader must not call the reply finished at "###".
      await new Promise((r) => setTimeout(r, 1150));
      const step = Math.max(24, Math.ceil(text.length / 20));
      for (let i = 0; i < text.length; i += step) {
        res.write(text.slice(i, i + step));
        await new Promise((r) => setTimeout(r, 15));
      }
      res.end();
      return;
    }
    if (req.url === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(APP_JS);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

if (process.argv[1] && process.argv[1].endsWith("mock-chat.js")) {
  const { port } = await startMockChat(Number(process.argv[2]) || 8099);
  console.log(`mock chat on http://127.0.0.1:${port}`);
}
