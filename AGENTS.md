# ChatToFree: notes for coding agents

This repo is a bridge: a CLI + MV3 browser extension that lets an agent use the user's own signed-in
web chat models (ChatGPT, Claude, Gemini, DeepSeek) without API keys. In OpenCode it is exposed as the
`c2f` MCP server (`opencode.jsonc`).

Installing, connecting, updating or removing c2f on a machine: read `docs/AI-INSTALL.md` first and
follow its hard rules (no test messages to DeepSeek, the user signs in themselves, never copy the login).

## Using the c2f tools

You have one tool by default: `c2f_advise`. It reaches a stronger model (DeepSeek) on the user's own chat
account, in one conversation per task that it remembers and that the user reads.

- Do the work yourself; you may ask it to write a hard part (with signature, examples, limits and the
  surrounding code), then understand, fit and test it. Consult before anything non-trivial and after each
  step, never twice in a row without doing work in between.
- Write naturally to a colleague about your own work, in the user's language, from the actual situation,
  no stock phrases; ask for detailed answers when you need to understand.
  Paste code when you want it reviewed (one file or class per message); from logs only the lines that matter; at most 30,000 characters.
- When it says to wait, to sign in (`c2f giris`), or that a limit is reached: tell the user once and
  finish on your own. Never retry in a loop.
- `c2f_status` is optional, instant and sends nothing.

`c2f_build`, `c2f_chat` and DeepSeek-as-the-model exist but are off (`automation` in the c2f config):
driving the web chat like an API got an account suspended on 2026-11-18. Do not ask the user to turn
them on.

## Working on this repo

- `npm test` (about 80 tests; real Edge in headless mode). Run it before reloading the extension into the user's browser.
- Bump `extension/manifest.json` `version` on every extension change and confirm the new version after `node src/reload.js`.
- Never run `taskkill /IM chrome.exe` / `msedge.exe`; never touch the user's browser profile.
- Measured facts about each site's UI live in `CONTROLS-MEASURED.md` and `STATUS.md`; measure with `node src/probe.js <site>` before changing selectors.
