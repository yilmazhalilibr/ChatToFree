# ChatToFree: installation and maintenance guide for AI agents

This document is for an AI agent (OpenCode, Claude Code, Codex, Cursor, Tern, …) that is asked to
install, connect, update, verify or remove ChatToFree (`c2f`) on a user's Windows machine. Read it
completely before running anything. The human-facing overview is `README.md` (Turkish).

## 0. What you are installing

- `c2f` lets a coding agent consult a stronger model, **DeepSeek, through the user's own signed-in web
  chat account**, without an API key. The working agent runs the work (reads, writes, runs, tests);
  DeepSeek sees only what the agent sends, gives advice, explains in depth, and writes hard parts on
  request (the agent then fits them in and tests them).
- Every consult is a **real message on the user's DeepSeek account**, in one readable chat per agent
  session. A DeepSeek account was suspended once when this project drove the web chat like an API
  (bursts of messages, many new chats, oversized messages, repeated prompts). Everything below is
  shaped by that.
- Pieces:
  - `src/mcp.js`: MCP server (stdio). Tools: `advise` (consult) and `status` (instant, sends nothing).
  - `src/cli.js`: the `c2f` command (`kur`, `giris`, `durum`, `danis`, `kurallar`, `sohbet`, `config`).
  - `.opencode/plugins/c2f-session.js`: OpenCode plugin that tells c2f which OpenCode session a call
    belongs to (OpenCode 1.x and 2.x).
  - `src/opencode-setup.js`: writes the OpenCode config, the `ctf` agent and its rules (`agentPrompt`).

## 1. Hard rules (apply to every step)

1. **Never send test messages to DeepSeek.** Do not call `advise`, `c2f danis` or `c2f sohbet` to
   "check that it works". `c2f durum` and the `status` tool are the checks; they send nothing or one
   read-only request. If a live consult is truly needed, ask the user first and send exactly one short
   message.
2. **Never sign in for the user.** The sign-in window is for the user's own account. Do not type
   credentials, solve captchas or read the login out of the user's browser profile.
3. **Never copy, print, upload or commit `%LOCALAPPDATA%\ChatToFree\deepseek-auth.json`.** It is a live
   session, bound to the machine and Windows user it was created on, and refused anywhere else. Each
   machine (and each friend) signs in with `c2f giris`.
4. **Do not turn on `automation`** (`c2f config set automation true`). It enables the API-style features
   (`build`, the OpenAI-compatible endpoint, `c2f_chat`) that most likely caused the suspension.
5. **Do not loop or retry consults.** When c2f answers that the user must wait, sign in, or that a
   limit is reached: tell the user once and finish the work without it.
6. **Never `taskkill` `chrome.exe` / `msedge.exe`**, never touch the user's own browser profile.
7. **Never kill `node …/src/mcp.js` processes that OpenCode Desktop started** (their parent is
   `opencode-cli.exe serve --service`). They are not restarted; the tool silently disappears from every
   session. Reload through `c2f kur` (it runs the desktop's own `opencode-cli.exe service restart`).
8. Do not edit the user's PATH, OpenCode config or registry by hand; `c2f kur` does it, with backups.

## 2. Prerequisites

| Check | Command | Expected |
|---|---|---|
| Windows 10/11 | — | c2f is Windows-first (PATH, registry, OpenCode Desktop paths) |
| Node.js ≥ 20 | `node -v` | `v20.x` or newer |
| git (or ZIP download) | `git --version` | any |
| A browser for sign-in | Chrome or Edge installed | the sign-in window uses one of them |
| The agent tool | e.g. `opencode --version` | optional; c2f also works without OpenCode |

## 3. Install

```powershell
git clone https://github.com/yilmazhalilibr/ChatToFree <folder>   # spaces / Turkish letters are fine
cd <folder>
npm install
node src/cli.js kur
```

Or ask the user to double-click `Kur.bat` in the folder (without Node it offers to install it with
winget; then it runs `npm install` once and `c2f kur`).

`c2f kur` does, in order:

1. **Sign-in check.** If no valid login exists for this machine, it opens a plain browser window with
   c2f's own profile (`%LOCALAPPDATA%\ChatToFree\login-profile`). **The user** signs in to DeepSeek and
   closes the window; c2f then reads the login (including the HttpOnly cookie) headless and saves it.
   Saving sends one read-only request; it never opens a chat. Tell the user what to do and wait.
2. **Config:** puts DeepSeek first in `%LOCALAPPDATA%\ChatToFree\config.json`.
3. **PATH:** adds the repo folder (with `c2f.cmd`) to the user PATH. It reads PATH raw from the
   registry, writes it back through an environment variable, repairs doubled backslashes and duplicate
   entries an older c2f left, removes the folder c2f was in before a move, and saves the old value to
   `%LOCALAPPDATA%\ChatToFree\path-backup-<time>.txt` before any change.
4. **OpenCode:** in `~/.config/opencode/opencode.jsonc` (backup `opencode.jsonc.bak-c2f` once): MCP
   server `c2f`, permission `c2f_advise: allow`, agent `ctf` (no model of its own; it uses the model
   selected in OpenCode), `default_agent: "ctf"` (unless the user already chose another default, which is
   kept), `command/ctf_ask.md`, `plugins/c2f-session.js`.
5. **OpenCode Desktop:** when the desktop app is open, `kur` asks first (in a non-interactive run it
   skips the restart and says so); then it runs `%APPDATA%\ai.opencode.desktop\cli\<version>\opencode-cli.exe service
   restart`, so the background server loads the new c2f and settings. A task running in the desktop app
   at that moment is interrupted: check with the user first if the app is open.

## 4. Verify (sends no message)

```powershell
node src/cli.js durum
```

| Output line | Meaning | Action |
|---|---|---|
| `✓ DeepSeek girişi hazır` | login valid on this machine | — |
| `✗ DeepSeek girişi yok → c2f kur` | never signed in here | `c2f kur` (user signs in) |
| `… eskimiş → c2f giris` | session expired | `c2f giris` (user signs in) |
| `… başka bir bilgisayarda alınmış → c2f giris` | login file copied from elsewhere | `c2f giris` |
| `✓ OpenCode hazır` | OpenCode config points at this folder | — |
| `✗ OpenCode eski bir klasörü gösteriyor` | repo was moved/renamed | `c2f kur` in the new folder |
| `✗ OpenCode bağlı değil` | not set up for OpenCode | `c2f kur` (only if the user uses OpenCode) |
| `! DeepSeek bekleme istiyor: …` | a limit or cooldown is active | wait; do not retry |
| `✓ … iş kanıtı modülünü değiştirmiş; yenisi bulundu` | DeepSeek moved its proof-of-work module; c2f read the page again in its own headless browser profile and found the new one (plain requests get a bot check) | — |
| `✗ … iş kanıtı modülü bulunamıyor` | the site changed more than that | `c2f giris`; if it persists, c2f needs an update |
| `! c2f'nin yeni sürümü var` | the repository has newer commits | `c2f guncelle` |
| `! DeepSeek'in tanınmayan bir ret mesajı kaydedildi` | a refusal c2f does not recognise | show `refusals.log` to the maintainer |

`durum` makes one read-only request to DeepSeek. Run it once, not in a loop.

For OpenCode, also confirm the server started: a new line per project folder appears in
`%LOCALAPPDATA%\ChatToFree\mcp-sessions.log` when the user opens a session.

## 5. Connect a harness

### OpenCode (CLI and Desktop)

Nothing else to do after `c2f kur`. New sessions open with the `ctf` agent; `/ctf_ask <request>`
switches to it from another agent and passes only the user's words (the rules live in the agent's
system prompt). To stop making `ctf` the default: `c2f config set ctfDefault false`, then `c2f kur`.

One OpenCode session keeps one DeepSeek chat: the plugin notes the session for each call (1.x: in the
call arguments; 2.x: in `%LOCALAPPDATA%\ChatToFree\oc-sessions.json`, entries live two minutes, because
2.x does not pass changed tool input on from inside its `execute` code tool).

### Any MCP client

Server: `node <repo>/src/mcp.js` (stdio). Tool: `advise` with `{ message, thread? }`. One consult can
take minutes (DeepSeek's answer plus at least 15 s between messages): set the client's tool timeout to
**at least 300 s**. The snippets below follow each client's documented format; only OpenCode has been
tested end to end.

- Claude Code: `claude mcp add c2f -- node <repo>/src/mcp.js` (raise the tool timeout, e.g. the
  `MCP_TOOL_TIMEOUT` environment variable in milliseconds).
- Codex CLI, `~/.codex/config.toml`:
  ```toml
  [mcp_servers.c2f]
  command = "node"
  args = ["<repo>/src/mcp.js"]
  tool_timeout_sec = 600
  ```
- Cursor / Cline / Windsurf / Claude Desktop (JSON `mcpServers`):
  ```json
  { "mcpServers": { "c2f": { "command": "node", "args": ["<repo>/src/mcp.js"] } } }
  ```

Use forward slashes in `<repo>` inside JSON/TOML. Then give the agent its rules (section 6).

Outside OpenCode there is no session plugin: the agent must pass back the `thread` value printed at the
end of every answer (`(thread: a3f9c2)`), or each call opens a new DeepSeek chat. The rules say so.

### Any agent with a shell (no MCP)

Write the message to a UTF-8 file with your file-writing tool, then run:

```
c2f danis --file .c2f-message.txt                    # first call: a new DeepSeek chat
# … answer …
# (thread: a3f9c2)
c2f danis --file .c2f-message.txt --thread a3f9c2    # every later call in this conversation
```

`--file` is the encoding-safe way on every shell. Alternatives, with their traps:

- bash: `c2f danis --thread a3f9c2 <<'EOF' … EOF` (quoted heredoc: nothing is expanded).
- Windows PowerShell 5.1: a plain pipe turns every non-ASCII letter (ş, ğ, ı, ö, ü, ç) into `?`
  (measured). If you must pipe, first run
  `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false`.
- A quoted argument (`c2f danis "…"`) only for a short one-liner without `"`, `$`, backticks or `%`.

The thread (DeepSeek chat id and last message) is kept in `%LOCALAPPDATA%\ChatToFree\threads\<id>.json`,
so every call may be a separate process. An unknown thread starts a new chat and says so.

## 6. Give the agent its rules

```powershell
c2f kurallar         # for an agent that uses the MCP tool
c2f kurallar --cli   # for an agent that uses `c2f danis`
```

Put the output into the harness's system prompt or rules file (`AGENTS.md`, `CLAUDE.md`,
`.cursorrules`, …). Both variants come from one source (`agentPrompt` in `src/opencode-setup.js`). They
tell the agent to:

- consult only for real work (no consult for quick questions or one-line edits);
- look first, then consult before starting; talk the structure over (folders, code split, data flow,
  technology) as soon as the first version runs, before tests or more features;
- build a switchable debug layer (one switch such as `APP_DEBUG=1`, off by default, no cost when off,
  lines tagged with their block, errors never swallowed) and consult with the failing block, the few
  debug lines and the error;
- ask the advisor to write hard parts (algorithms, parsers, tricky logic) with the language, signature,
  inputs/outputs, limits and surrounding code, with DeepThink on for that message (`deep: true` /
  `--deep`), then understand, fit and test that code;
- treat answers as advice: read code before using it, ask the user before running install / delete /
  download / system commands taken from an answer;
- never send secrets (placeholders instead; c2f also refuses messages that look like they hold one);
- honour the project's `.c2fignore` (gitignore-style patterns; `off` turns the advisor off for that
  project). c2f enforces it on content: a message holding a line (30+ chars) of a listed file is refused.
  Exact paths are resolved directly; wildcard rules skip dependency/build folders (node_modules, .venv,
  dist, build, target, vendor …); past 20,000 entries the check fails closed (nothing is sent);
- set `search: true` / `--search` when the answer depends on something recent;
- in a long conversation, open the next message with a short summary of where the work stands;
- write naturally from the actual situation, in the user's language and the first person as the owner of
  the work, with no set openings or stock phrases (c2f adds nothing to the message), asking for detailed
  answers when it needs to understand; at most 30,000 characters (one file or class per message); and at
  the end send the code file by file for a detailed review. A message written about "the user" is
  refused before sending.

## 7. Limits enforced by c2f

| Limit | Value |
|---|---|
| Message length | 30,000 characters (refused, not truncated; DeepSeek takes about 40,000, measured 60k accepted / 90k refused) |
| Gap between two messages | ≥ 15 s (queued) |
| Gap between two new chats | ≥ 2 min (queued): one message per new chat is the pattern of the suspended account |
| Burst | ≤ 10 messages per 10 min across all processes (`sites.deepseek.limit.burstMax` / `burstMinutes`); over that a message waits, and a wait longer than 4 min is handed back as `c2f is spreading your messages out … consult again after HH:MM` |
| Total messages | no count of c2f's own: DeepSeek's quota decides |
| Secrets | a message that looks like it holds a password, API key, token, private key or env secret is not sent; the agent is asked to use a placeholder |
| Same message again | within 10 min: the earlier answer is returned, nothing is sent |
| "Messages too frequent" from DeepSeek | waits 30 / 60 / 120 s and retries in the same chat |
| Third-person phrasing | refused with rewrite guidance, nothing sent |
| "Too frequent" / rate limit from DeepSeek | retried in the same chat after 30/60/120 s; if still refused, 10 min rest; the agent is told `DeepSeek asked to slow down … consult again after HH:MM` and goes on working |
| Quota used up (daily/quota wording, or a reset > 15 min away) | **no retry**; nothing is sent until the reset DeepSeek names (else 1 h); the agent is told `DeepSeek's quota is used up … Tell the user once ("DeepSeek kotası doldu, HH:MM'de açılır") … finish on your own` |

The waits are kept per machine. Two machines on one account double the real rate: tell users to use one
machine at a time. When the quota runs out nothing breaks: `advise` / `c2f danis` return the quota
message above, and `c2f durum` shows `DeepSeek bekleme istiyor: cooling down until HH:MM`. c2f has only
ever seen DeepSeek's "Messages too frequent" wording. A refusal in wording it does not recognise (any
`hint` event without an answer) is not retried: 10 min rest, and DeepSeek's text is passed on as it is.

## 8. Update, move, remove

- **Update:** `node src/cli.js guncelle` (= `git pull --ff-only`, `npm install`, then `kur` in a fresh process). A ZIP copy: unpack the new ZIP over the folder, then `kur`.
- **Move or rename the folder:** run `node src/cli.js kur` in the new place. It fixes the OpenCode path
  and removes the old PATH entry.
- **Remove:**
  1. `node src/install.js --remove` (PATH; backup saved first).
  2. In `~/.config/opencode/opencode.jsonc` remove `mcp.c2f`, `agent.ctf`, `permission.c2f_advise`, and
     `default_agent` if it is `"ctf"`; delete `command/ctf_ask.md` and `plugins/c2f-session.js`.
  3. Restart OpenCode Desktop's background server: `opencode-cli.exe service restart`.
  4. Optionally delete `%LOCALAPPDATA%\ChatToFree\` (login, usage, threads, backups) after asking the user.

## 9. Files

| Path | Content |
|---|---|
| `%LOCALAPPDATA%\ChatToFree\deepseek-auth.json` | the login (secret, machine-bound) |
| `…\config.json` | user settings (`c2f config set`) |
| `…\usage.json` | send timestamps for the limits |
| `…\deepseek-chats.json` | advisor conversations' DeepSeek chat id and last message id (kept 30 days, survives restarts) |
| `…\oc-threads.json` | OpenCode session → conversation (30 days) |
| `…\threads\*.json` | `c2f danis`: last message and answer (repeat guard) |
| `…\sent.log` | one line per message: time, chat, size, outcome; never the text |
| `…\refusals.log` | DeepSeek's refusal / limit wording, verbatim (`c2f durum` points at unknown ones) |
| `…\deepseek.sent` | send times of the burst window |
| `…\oc-sessions.json` | OpenCode plugin notes (2 min) |
| `…\mcp-sessions.log` | one line per MCP server start |
| `…\installed-at.txt` | where c2f was put on PATH (to clean up after a move) |
| `…\path-backup-*.txt` | PATH before each change |
| `…\login-profile\` | browser profile of the sign-in window |
| `~/.config/opencode/opencode.jsonc` | OpenCode settings c2f adds to |
| `~/.config/opencode/command/ctf_ask.md`, `plugins/c2f-session.js` | copies from the repo's `.opencode/` |

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agent says the `c2f_advise` tool does not exist | OpenCode Desktop's background server lost or never started c2f | `c2f kur`, then a new session |
| Every consult opens a new DeepSeek chat (non-OpenCode client) | the agent does not pass `thread` back | add `c2f kurallar` output to its rules |
| `DeepSeek asked to slow down … after HH:MM` | DeepSeek's rate limit | keep working; consult again after that time |
| `DeepSeek's quota is used up … before HH:MM` | the account's quota | tell the user once; finish alone; do not retry |
| `this DeepSeek login was saved on another computer` | copied login file | `c2f giris` on this machine |
| `no DeepSeek login saved yet` | not signed in | `c2f kur` |
| The tool call times out in an MCP client | client timeout below DeepSeek's answer time | raise it to ≥ 300 s |
| `c2f` not found in a terminal | terminal opened before install | open a new terminal, or call `<repo>\c2f.cmd` |

## 11. Developing and testing

- `npm test` runs ~180 tests, including real headless Edge. None of them talk to DeepSeek: a local
  stand-in server answers.
- End-to-end checks in real OpenCode also use a stand-in DeepSeek: a project-level `opencode.jsonc`
  overrides the `c2f` MCP entry with a wrapper that points `C2F_DEEPSEEK_URL` at a local mock and
  `C2F_CONFIG_HOME` at a temp folder, so the user's login, limits and account are untouched. Run test
  OpenCode servers on their own ports and stop the `opencode-cli.exe` process itself afterwards.
- Every behaviour change: run the narrowest test, then `npm test`; commit only when it exits 0.
- Measured site behaviour and history: `STATUS.md`; older browser-extension path: `KULLANIM.md`.
