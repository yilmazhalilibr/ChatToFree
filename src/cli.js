#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline/promises";
import { loadConfig, SITE_NAMES } from "./config.js";
import { Router, needsBrowser } from "./router.js";
import { Limits } from "./limits.js";
import { makeSettingsCommands } from "./cmd-settings.js";
import { Bridge } from "./bridge.js";
import { LocalModel } from "./local.js";
import { Workspace } from "./workspace.js";
import { Agent } from "./agent.js";
import { parseReply } from "./protocol.js";
import { ensureToken, tokenPath } from "./token.js";
import { DeepSeekHttp, hasAuth, saveAuth, authPath, discoverWasmUrl, sharedDeepSeek, loadAuth, checkWasm } from "./deepseek-http.js";
import { Advisor } from "./advisor.js";
import { captureLogin, finishLogin, findWasmInBrowser } from "./login.js";
import { installOpenCode, openCodeC2f, restartOpenCodeDesktop, agentPrompt } from "./opencode-setup.js";
import { startApi, ensureApiKey, API_PORT } from "./api.js";
import { readConfigFile, writeConfigFile, globalConfigPath } from "./config.js";
import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const ALIASES = { yap: "build", sohbet: "chat", giris: "login", kur: "setup", durum: "status", yardim: "help", danis: "ask", kurallar: "rules", guncelle: "update" };
const first = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
// No command at all: the short, plain page. `c2f help` is the full reference.
const cmd = first ? ALIASES[first] || first : argv.includes("--help") || argv.includes("-h") ? "help" : "short";
const rest = cmd === "help" || cmd === "short" ? argv : argv.slice(1);

const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  } else positional.push(a);
}

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
function dim(s) {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}
const log = (msg = "") => console.log(msg);
const die = (msg, code = 1) => {
  console.error(c.red(msg));
  process.exit(code);
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loud = Boolean(flags.ayrintili || flags.verbose);

function shortUsage() {
  log(`${c.bold("ChatToFree")}

  ${c.cyan("c2f kur")}               ilk kurulum (bir kez)
  ${c.cyan("c2f sohbet")}            DeepSeek ile konuş
  ${c.cyan("c2f durum")}             her şey hazır mı?
  ${c.cyan("c2f giris")}             DeepSeek girişini yenile
  ${c.cyan('c2f danis "mesaj"')}     DeepSeek'e danış (her ajan/harness kabuktan kullanabilir; --thread ile devam)
  ${c.cyan("c2f guncelle")}          en yeni sürümü al ve yeniden kur
  ${c.cyan("c2f kurallar")}          ajan kuralları: başka bir harness'ın talimat dosyasına koy (--cli: c2f danis ile)
`);
}

/** A plain-language version of the errors a person can act on. */
function friendly(err) {
  const m = String(err?.message || err);
  if (/no DeepSeek login saved|no DeepSeek login/i.test(m)) return "DeepSeek girişi yok. Önce:  c2f kur";
  if (/needs login|bot check/i.test(m)) return "DeepSeek girişi eskimiş. Yenile:  c2f giris";
  if (/usage limit|too frequent/i.test(m)) return "DeepSeek şu an çok hızlı mesaj gitti dedi. Birkaç dakika sonra tekrar dene.";
  if (m === "no_browser") return "Chrome ya da Edge bulunamadı. Birini kurup tekrar dene.";
  if (m === "timeout") return "10 dakika içinde pencere kapatılmadı. Tekrar dene:  c2f giris";
  if (m === "not_signed_in") return "Pencere kapandı ama DeepSeek girişi bulunamadı. Giriş yapıp pencereyi öyle kapat:  c2f giris";
  if (m === "no_wasm") return "DeepSeek sayfası tam yüklenmedi. Tekrar dene:  c2f giris";
  if (/saved on another computer/i.test(m)) return "Bu DeepSeek girişi başka bir bilgisayarda alınmış. Her bilgisayar kendi girişini alır:  c2f giris";
  return m;
}

/** Driving the chat account like a machine is off unless the user turned it on (it got an account suspended). */
function needAutomation(cfg, what) {
  if (cfg.automation === true) return;
  die(`${what} kapalı: DeepSeek hesabını makine gibi kullanıyor ve bu bir hesabın askıya alınmasına yol açtı.\nÖnerilen yol: OpenCode'da "ctf" ajanı (kendi modelin çalışır, DeepSeek'e danışır) ya da  c2f sohbet.\nYine de açmak istersen:  c2f config set automation true`);
}

/** true when DeepSeek accepts the saved login (asked for real, no message sent); else the reason. */
async function loginWorks() {
  if (!hasAuth()) return "yok";
  const state = await new DeepSeekHttp().loginState();
  return state === "ok" ? true : state === "expired" ? "eskimiş" : state === "other-machine" ? "başka bir bilgisayarda alınmış" : "kontrol edilemedi (internet?)";
}

/**
 * The login already open in the person's own Chrome, read through the extension when it is there
 * (nothing to sign in to, no captcha). false when there is no extension, no tab, or no login in it.
 */
async function loginFromChrome(cfg, waitMs = 20_000) {
  // The extension looks for us every 15 s, so this can take that long: only worth it when Chrome is open.
  try {
    if (!/chrome\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"], { encoding: "utf8" }))) return false;
  } catch {
    return false;
  }
  log(dim("Chrome'daki DeepSeek oturumuna bakılıyor…"));
  const bridge = new Bridge({ port: cfg.port, token: ensureToken(), log: () => {} });
  try {
    await bridge.start();
    if (!(await bridge.waitForClient(waitMs))) return false;
    const { auth } = await bridge.collectAuth();
    const wasmUrl = auth.wasmUrl || (await discoverWasmUrl(auth.scripts || []));
    if (!auth.token || !wasmUrl) return false;
    const before = hasAuth() ? fs.readFileSync(authPath(), "utf8") : null;
    saveAuth({ token: auth.token, cookie: auth.cookie, hif_dliq: auth.hif_dliq, hif_leim: auth.hif_leim, wasmUrl });
    if ((await new DeepSeekHttp().loginState()) !== "expired") return true;
    // The tab holds a login DeepSeek no longer accepts: put back what was there.
    if (before) fs.writeFileSync(authPath(), before);
    return false;
  } catch {
    return false;
  } finally {
    await bridge.stop().catch(() => {});
  }
}

async function doLogin() {
  if (await loginFromChrome(makeConfig())) {
    log(dim("Chrome'daki açık DeepSeek oturumu kullanıldı."));
    return;
  }
  log(dim("DeepSeek penceresi açılıyor…"));
  const raw = await captureLogin({ onWaiting: () => log(c.bold("→ Açılan pencerede DeepSeek'e giriş yap, sonra pencereyi KAPAT.")) });
  await finishLogin(raw);
}

async function cmdLogin() {
  await doLogin();
  log(`${c.green("✓")} DeepSeek girişi kaydedildi`);
}

async function cmdSetup() {
  const step = (ok, text) => log(`${ok ? c.green("✓") : c.red("✗")} ${text}`);
  log(c.bold("ChatToFree kurulumu"));
  if (!flags.yenile && (await loginWorks()) === true) step(true, "DeepSeek girişi hazır");
  else {
    await doLogin();
    step(true, "DeepSeek girişi alındı");
  }
  const file = globalConfigPath();
  const conf = readConfigFile(file);
  if (!conf.preferredSites) {
    conf.preferredSites = ["deepseek"];
    writeConfigFile(file, conf);
  }
  step(true, "DeepSeek ilk sırada");
  try {
    execFileSync(process.execPath, [path.join(REPO, "src", "install.js")], { stdio: "ignore" });
    step(true, "c2f komutu her yerden çalışır (yeni bir terminal aç)");
  } catch {
    log(dim("  (c2f komutu PATH'e eklenemedi; c2f.cmd ile çalışır)"));
  }
  try {
    const cfg = makeConfig();
    const r = installOpenCode({ repo: REPO, api: cfg.automation === true ? { port: API_PORT, key: ensureApiKey() } : null, makeDefault: cfg.ctfDefault !== false });
    step(true, r.changed ? "OpenCode'a eklendi" : "OpenCode ayarı güncel");
    // The desktop's background server keeps the old c2f and settings until it restarts; reopening the app is not enough.
    if (r.keptDefault) log(dim(`  OpenCode'un varsayılan ajanı senin seçtiğin "${r.keptDefault}" olarak kaldı; ctf için /ctf_ask ya da ajan seçici`));
    // Restarting the desktop's background server stops whatever runs in it: ask first when the app is open.
    let restart = true;
    if (desktopOpen()) {
      if (!process.stdin.isTTY) restart = false;
      else {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question("  OpenCode masaüstü açık. Yeni ayarlar için yenilenmesi gerekiyor; o an süren bir iş varsa yarıda kalır. Şimdi yenileyeyim mi? [E/h] ")).trim();
        rl.close();
        restart = !/^h/i.test(answer);
      }
    }
    if (!restart) log(dim("  OpenCode masaüstü yenilenmedi: işin bitince  c2f kur  çalıştır ya da OpenCode'u tamamen kapatıp aç"));
    else if (restartOpenCodeDesktop()) step(true, "OpenCode masaüstü yenilendi");
  } catch (err) {
    step(false, `OpenCode ayarı yazılamadı: ${err.message}`);
  }
  log(
    makeConfig().ctfDefault !== false
      ? `\n${c.bold("Hazır.")} OpenCode'da istediğin modeli seç ve isteğini yaz: yeni oturumlar ${c.cyan("ctf")} ajanıyla açılır, model işi yapar, ilerledikçe DeepSeek'e danışır. (Kapatmak için: c2f config set ctfDefault false, sonra c2f kur.)`
      : `\n${c.bold("Hazır.")} OpenCode'da istediğin modeli seç, sonra ${c.cyan("/ctf_ask isteğin")} yaz (ya da ${c.cyan("ctf")} ajanını seç): model işi yapar, ilerledikçe DeepSeek'e danışır.`,
  );
}

/**
 * c2f danis "message" [--thread id]: the advisor for any agent that can run a shell command (no MCP
 * needed). Each call is its own process, so the conversation (DeepSeek chat id and last message) is kept
 * on disk under the thread id the answer ends with. Plain output, made for the agent to read.
 */
async function cmdAsk() {
  // The message from --file (safest: no shell touches it), the arguments, or stdin. Real messages quote
  // code with ", $, ` and %, which no shell passes through unchanged inside quotes, and Windows
  // PowerShell 5.1 turns every Turkish letter piped to a program into "?" unless told to use UTF-8.
  let message = typeof flags.file === "string" ? fs.readFileSync(flags.file, "utf8").replace(/^\uFEFF/, "").trim() : positional.join(" ").trim();
  if (!message && !process.stdin.isTTY) message = (await new Promise((res) => {
    let d = "";
    process.stdin.setEncoding("utf8").on("data", (x) => (d += x)).on("end", () => res(d));
  })).trim();
  if (!message) die("Kullanım: c2f danis --file mesaj.txt [--thread <kimlik>]   (ya da mesaj stdin'den / kısa ise tırnak içinde; kimlik: önceki cevabın sonundaki thread)");
  const cfg = makeConfig();
  // The DeepSeek chat of a thread is kept by DeepSeekHttp (deepseek-chats.json, shared with the MCP
  // server); here only the last message and answer, for the repeat guard.
  const dir = path.join(path.dirname(authPath()), "threads");
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const http = sharedDeepSeek(() => {});
  const asked = String(flags.thread === true ? "" : flags.thread || "").replace(/[^a-z0-9]/gi, "");
  const known = Boolean(asked) && http.has(`advisor:${asked}`);
  const id = known ? asked : crypto.randomBytes(4).toString("hex");
  let last = null;
  try {
    last = known ? JSON.parse(fs.readFileSync(fileOf(id), "utf8")).last : null;
  } catch {
    /* no earlier message saved */
  }
  const note = asked && !known ? "(That thread is not known on this computer: this is a new conversation, so give the context again.)\n\n" : "";
  const done = (reply) => console.log(`${note}${reply}\n\n(thread: ${id})`);
  // The same message again soon after (agents repeat a call): the saved answer, nothing sent.
  if (last?.text === message && Date.now() - last.at < 10 * 60_000) return done(last.reply);
  const router = new Router({ cfg, bridge: null, http, log: () => {}, sessionKey: `advisor:${id}` });
  const res = await new Advisor({ getRouter: () => router, maxChars: cfg.advisorMaxChars, resume: known, project: process.cwd() }).consult({ message, deep: Boolean(flags.deep), search: Boolean(flags.search) });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileOf(id), JSON.stringify({ last: { text: message, at: Date.now(), reply: res.reply } }));
  done(res.reply);
}

/** c2f kurallar [--cli]: the working agent's rules, to put in any harness's system prompt or rules file. */
function cmdRules() {
  console.log(agentPrompt({ cli: Boolean(flags.cli) }));
}

/** Is the OpenCode desktop app open (a window, not just its background server)? */
function desktopOpen() {
  try {
    return /OpenCode\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq OpenCode.exe", "/NH"], { encoding: "utf8", windowsHide: true }));
  } catch {
    return false;
  }
}

/** c2f api: serve DeepSeek as a model without OpenCode running the MCP server (any OpenAI-compatible client). */
async function cmdApi() {
  needAutomation(makeConfig(), "c2f api");
  const port = Number(flags.port) || API_PORT;
  const server = await startApi({ port, log: (m) => log(dim(m)) });
  if (!server) die(`Port ${port} dolu: büyük olasılıkla c2f zaten çalışıyor (OpenCode açıkken kendiliğinden başlar).`);
  log(`${c.green("✓")} DeepSeek modeli: http://127.0.0.1:${port}/v1   anahtar: ${ensureApiKey()}`);
  log(dim("Durdurmak için Ctrl+C."));
  await new Promise(() => {});
}

async function cmdStatus() {
  const mark = (ok) => (ok ? c.green("✓") : c.red("✗"));
  const login = await loginWorks();
  log(`${mark(login === true)} DeepSeek girişi ${login === true ? "hazır" : `${login}  →  ${login === "yok" ? "c2f kur" : "c2f giris"}`}`);
  const gate = new Limits().check("deepseek", makeConfig().sites.deepseek.limit);
  if (!gate.ok) log(`${c.yellow("!")} DeepSeek bekleme istiyor: ${gate.reason}`);
  const inOpenCode = openCodeC2f(REPO);
  const serving = await fetch(`http://127.0.0.1:${API_PORT}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  log(`${mark(inOpenCode === "ok")} OpenCode ${inOpenCode === "ok" ? "hazır" : inOpenCode === "moved" ? "eski bir klasörü gösteriyor (c2f taşınmış)  →  c2f kur" : "bağlı değil  →  c2f kur"}`);
  const automation = makeConfig().automation === true;
  if (automation) log(`${serving ? c.green("✓") : dim("·")} DeepSeek modeli (otomasyon açık) ${serving ? "çalışıyor" : "OpenCode açılınca başlar"}`);
  else if (serving) log(`${c.yellow("!")} Eski bir c2f süreci DeepSeek'i hâlâ model olarak sunuyor  →  c2f kur (OpenCode'u yeniler)`);
  // DeepSeek's private web protocol can change: is its proof-of-work module still there? (CDN file, no account request)
  if (login === true) {
    const auth = loadAuth();
    const wasm = await checkWasm(auth.wasmUrl);
    if (wasm === false) {
      // The site moved it: find the new one on its public page and keep it.
      const found = await findWasmInBrowser();
      if (found && (await checkWasm(found)) === true) {
        saveAuth({ ...auth, wasmUrl: found });
        log(`${c.green("✓")} DeepSeek iş kanıtı modülünü değiştirmiş; yenisi bulundu ve kaydedildi`);
      } else log(`${c.red("✗")} DeepSeek'in iş kanıtı modülü bulunamıyor (site değişmiş olabilir)  →  c2f giris`);
    } else if (wasm === "unknown") log(dim("· iş kanıtı modülü kontrol edilemedi (internet?)"));
  }
  // A newer c2f on GitHub? (a fetch of the repository, nothing else)
  if (fs.existsSync(path.join(REPO, ".git"))) {
    try {
      execFileSync("git", ["-C", REPO, "fetch", "--quiet"], { stdio: "ignore", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });
      const behind = Number(execFileSync("git", ["-C", REPO, "rev-list", "--count", "HEAD..@{u}"], { encoding: "utf8", timeout: 5_000 }).trim());
      if (behind > 0) log(`${c.yellow("!")} c2f'nin yeni sürümü var (${behind} değişiklik)  →  c2f guncelle`);
    } catch {
      /* offline or no upstream */
    }
  }
  const dir = path.dirname(authPath());
  const hits = (new Limits().load().deepseek?.hits || []).filter((t) => t >= new Date().setHours(0, 0, 0, 0));
  log(dim(`· bugün DeepSeek'e ${hits.length} mesaj gitti${hits.length ? `, sonuncusu ${new Date(Math.max(...hits)).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}` : ""}  (ayrıntı: ${path.join(dir, "sent.log")})`));
  try {
    const week = Date.now() - 7 * 24 * 3_600_000;
    const unknown = fs.readFileSync(path.join(dir, "refusals.log"), "utf8").split("\n").filter((l) => / unknown /.test(l) && Date.parse(l.slice(0, 24)) > week);
    if (unknown.length) log(`${c.yellow("!")} DeepSeek'in tanınmayan bir ret mesajı kaydedildi (${unknown.length}): ${path.join(dir, "refusals.log")}  →  metnini paylaşırsan c2f tanır`);
  } catch {
    /* no refusals yet */
  }
}

/**
 * c2f guncelle: the newest c2f, then setup again (OpenCode files, PATH, OpenCode Desktop restart). The
 * setup runs in a fresh process, so it is the new code that writes the settings.
 */
function cmdUpdate() {
  if (!fs.existsSync(path.join(REPO, ".git"))) die("Bu kopya ZIP ile kurulmuş: yeni ZIP'i indirip aynı klasörün üstüne aç, sonra c2f kur.");
  try {
    execFileSync("git", ["-C", REPO, "pull", "--ff-only"], { stdio: "inherit" });
  } catch {
    die("Güncelleme alınamadı (internet yok ya da klasörde elle değiştirilmiş dosyalar var). git status ile bak, sonra tekrar dene.");
  }
  execSync("npm install --silent", { cwd: REPO, stdio: "inherit" });
  execFileSync(process.execPath, [path.join(REPO, "src", "cli.js"), "kur"], { stdio: "inherit" });
}

function usage() {
  log(`${c.bold("ChatToFree")} — your web chat model writes the code, a small local model keeps it on track.

${c.bold("Usage")}
  c2f build "<what you want>" [options]   plan + build it in ./out
  c2f chat [options]                      free-form chat through a web model
  c2f serve [options]                     just run the bridge (extension connects here)
  c2f doctor [options]                    check bridge, extension and local model

${c.bold("Models, reasoning and limits")}
  c2f config                              show every setting (per site, per phase)
  c2f use <site> [--model X] [--reasoning L] [--search on|off]
                  [--per-hour N] [--per-day N] [--cooldown MIN] [--enable|--disable]
                                          change one site (saved for every terminal)
  c2f config set <key> <value> [--local]  any setting, e.g. phases.design.reasoning high
  c2f models [site ...]                   what each site offers right now (models, levels)
  c2f apply [site ...]                    set the configured model/reasoning now, send nothing
  c2f usage [--reset [site]]              requests spent per site, cooldowns after a limit

${c.bold("Options")}
  --workspace <dir>   output directory (default ./out)
  --site <name>       chatgpt | claude | gemini | deepseek (default: first reachable of preferred list)
  --no-design         skip the design + review round (faster, weaker)
  --no-fresh          continue the same web chat instead of opening a new one
  --focus-tab         bring the chat tab to the front while it answers. Only needed if a
                      tab left hidden for many minutes slows down (Chrome throttles it)
  --yes               skip the design approval prompt (also implied when not a TTY)
  --resume            continue the unfinished build of this same request in this workspace
  --port <n>          bridge port (default 8787)
  --local <url>       local model base url (default http://127.0.0.1:8080/v1)
  --no-local          run without the local model (big model gets raw context)
  --max-rounds <n>    rounds allowed per step (default 14)
  --model <name>      model to select on --site (e.g. "Haiku 5.5", "Kod ve analiz")
  --reasoning <lvl>   off | on | low | medium | high | xhigh | max (sites map it to what they have)
  --search <on|off>   web search toggle (DeepSeek)

${c.bold("First run")}
  1. Chrome → chrome://extensions → Developer mode → Load unpacked → select ${c.cyan("extension/")}
  2. Sign in to the sites you want in that Chrome profile
  3. c2f build "a small minecraft-like voxel game in one html file"`);
}

function siteOverrides() {
  const picked = flags.site ? [String(flags.site)] : null;
  const out = {};
  const set = (site, key, value) => {
    out[site] = { ...(out[site] || {}), [key]: value };
  };
  if (flags.model !== undefined) {
    if (!picked) die("--model needs --site: model names differ per site (see c2f models)");
    set(picked[0], "model", String(flags.model));
  }
  for (const site of picked || SITE_NAMES) {
    if (flags.reasoning !== undefined && flags.reasoning !== true) set(site, "reasoning", String(flags.reasoning));
    if (flags.search !== undefined && flags.search !== true) set(site, "search", String(flags.search));
  }
  return Object.keys(out).length ? out : undefined;
}

/** "claude(Haiku 5.5, low) → gemini(defaults)": what each enabled site will be asked to use. */
function describeSites(cfg) {
  return cfg.preferredSites
    .filter((s) => cfg.sites[s]?.enabled !== false)
    .map((s) => {
      const { model, reasoning, search } = cfg.sites[s];
      const set = [model, reasoning, search === "default" ? "default" : `search ${search}`].filter((v) => v !== "default");
      return `${s}(${set.join(", ") || "site defaults"})`;
    })
    .join(" → ");
}

function makeConfig() {
  return loadConfig(process.cwd(), {
    sites: siteOverrides(),
    workspace: flags.workspace || flags.klasor,
    port: flags.port ? Number(flags.port) : undefined,
    preferredSites: flags.site ? [flags.site] : undefined,
    design: flags["no-design"] ? false : undefined,
    freshChatPerRequest: flags["no-fresh"] ? false : undefined,
    focusTab: flags["focus-tab"] === true ? true : flags["focus-tab"] === "false" ? false : undefined,
    maxRoundsPerStep: flags["max-rounds"] ? Number(flags["max-rounds"]) : undefined,
    local: {
      ...(flags["no-local"] ? { enabled: false } : {}),
      ...(flags.local ? { baseUrl: flags.local } : {}),
    },
  });
}

async function ensureBridge(cfg) {
  const bridge = new Bridge({ port: cfg.port, requestTimeoutMs: cfg.requestTimeoutMs, log: (m) => log(dim(`[bridge] ${m}`)), token: ensureToken() });
  try {
    await bridge.start();
  } catch (err) {
    if (String(err.code) === "EADDRINUSE") {
      die(`port ${cfg.port} is already in use (another "c2f serve"?). Use --port to change it, and set the same port in the extension options.`);
    }
    throw err;
  }
  log(dim(`[bridge] listening on ws://127.0.0.1:${cfg.port}`));
  if (!bridge.connected) {
    log(dim("[bridge] waiting for the Chrome extension…"));
    const info = await bridge.waitForClient(Number(flags["wait"] || 40) * 1000);
    if (!info) {
      await bridge.stop();
      die(
        `The Chrome extension did not connect within ${flags["wait"] || 40}s.\n` +
          `  Load ${c.cyan("extension/")} at chrome://extensions (Developer mode → Load unpacked), then re-run.\n` +
          `  If you already loaded it, click the toolbar icon → Reconnect.`,
      );
    }
    log(dim(`[bridge] extension v${info.version} connected (sites: ${info.sites.filter((s) => s !== "generic").join(", ")})`));
  }
  return bridge;
}

async function ensureBridgeForSites(cfg) {
  if (needsBrowser(cfg)) return ensureBridge(cfg);
  if (!hasAuth()) die("DeepSeek girişi yok. Önce:  c2f kur");
  if (loud) log(dim("[direct] DeepSeek over HTTP with the saved login: no browser needed"));
  return null;
}

/** c2f auth deepseek: copy the login of the signed-in DeepSeek tab once, so DeepSeek can be used without a tab. */
async function cmdAuth() {
  if (positional[0] !== "deepseek") die("Usage: c2f auth deepseek   (open chat.deepseek.com signed in first)");
  const cfg = makeConfig();
  const bridge = await ensureBridge(cfg);
  try {
    log("reading the login from your signed-in chat.deepseek.com tab (nothing is sent anywhere but this computer)…");
    const res = await bridge.collectAuth();
    let { token, cookie, hif_dliq, hif_leim, wasmUrl } = res.auth;
    if (!wasmUrl) wasmUrl = await discoverWasmUrl(res.auth.scripts || []);
    const file = saveAuth({ token, cookie, hif_dliq, hif_leim, wasmUrl });
    const names = String(cookie || "").split(";").map((x) => x.split("=")[0].trim()).filter(Boolean);
    log(c.green(`✓ saved to ${file}`) + dim(`  (token ${token.length} chars, ${names.length} cookie(s) visible to the page: ${names.join(", ") || "none"}, proof-of-work module ${wasmUrl ? "found" : "MISSING"})`));
    log(dim("  this file is a live login, kept in your user profile (%LOCALAPPDATA%): do not share it, copy it or commit it"));
    if (!wasmUrl) die("the page did not show its proof-of-work module; reload the DeepSeek tab and run this again");
    if ((await new DeepSeekHttp({ log }).loginState()) === "expired") die("DeepSeek refused that login: sign in again in the tab and retry");
    log(c.green("✓ DeepSeek accepts the login. It is used directly from now on (c2f config set sites.deepseek.transport browser to go back to the tab)."));
  } finally {
    await bridge.stop();
  }
}

async function cmdBuild() {
  const goal = positional.join(" ").trim() || (flags.goal ? String(flags.goal) : "");
  if (!goal) die('Ne yapılacağını yaz. Örnek:  c2f yap "tek dosyalık bir yılan oyunu"');
  const cfg = makeConfig();
  needAutomation(cfg, "c2f yap");
  const bridge = await ensureBridgeForSites(cfg);
  // Quiet by default: a few plain lines. --ayrintili shows everything the agent says.
  const detail = loud ? log : () => {};
  const local = new LocalModel(cfg.local, (m) => detail(dim(`[local] ${m}`)));
  const workspace = new Workspace(cfg.workspace);
  const agent = new Agent({
    cfg,
    bridge,
    local,
    workspace,
    log: detail,
    onEvent: (e) => {
      if (loud) return;
      if (e.type === "plan") log(`Plan hazır: ${e.steps.length} adım`);
      else if (e.type === "step") log(`  ${e.index + 1}/${e.total}  ${e.title}`);
      else if (e.type === "phase" && e.phase === "verify") log("  Son kontrol…");
    },
  });
  detail(`${c.bold("workspace")} ${cfg.workspace}`);
  detail(dim(`[bridge] sites: ${describeSites(cfg)}`));
  if (!loud) log(dim(`Klasör: ${path.resolve(cfg.workspace)}`));

  const started = Date.now();
  const interactive = Boolean(flags.onay) && process.stdin.isTTY;
  try {
    const res = await agent.build(goal, {
      resume: Boolean(flags.resume || flags.devam),
      approve: interactive
        ? async ({ design }) => {
            const file = `${cfg.workspace}/.c2f/design.md`;
            log(`\n${c.bold("design")} saved to ${file}`);
            if (design) log(c.dim(design.length > 4000 ? `${design.slice(0, 4000)}\n… (${design.length} chars, see the file)` : design));
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = (await rl.question(c.bold("\nbuild these steps? [Y/n] "))).trim().toLowerCase();
              return !["n", "no", "q", "quit"].includes(answer);
            } finally {
              rl.close();
            }
          }
        : null,
    });
    if (res.stopped) {
      log(c.yellow(`\nstopped — ${res.stopped}. Edit ${cfg.workspace}/.c2f/design.md, then re-run with --yes.`));
      return;
    }
    const problems = [];
    if (res.incomplete?.length) problems.push(`${res.incomplete.length} step(s) did not finish: ${res.incomplete.join("; ")}`);
    if (res.verified === false) problems.push("the final audit gave no verdict (result not verified)");
    const secs = Math.round((Date.now() - started) / 1000);
    if (!problems.length) log(`\n${c.green("✓ Bitti")} — ${res.steps} adım, ${secs} sn`);
    else {
      log(`\n${c.yellow("! Eksiklerle bitti")} — ${res.steps} adım, ${secs} sn`);
      for (const p of problems) log(c.yellow(`  - ${p}`));
      log(dim("  Kaldığı yerden devam için aynı komuta --devam ekle."));
    }
    log(`Klasör: ${path.resolve(cfg.workspace)}`);
  } finally {
    await bridge?.stop();
  }
}

async function cmdChat() {
  const cfg = makeConfig();
  const bridge = await ensureBridgeForSites(cfg);
  const router = new Router({ cfg, bridge, log: loud ? (m) => log(dim(m)) : () => {} });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  log(dim('Yaz ve Enter\'a bas. Yeni konu için "/yeni", çıkmak için "cik". (!raw eklersen cevap olduğu gibi gelir.)'));
  // One conversation: the first message opens a chat, the rest go into it.
  let started = false;
  try {
    for (;;) {
      let line;
      try {
        line = (await rl.question(c.bold("\nsen › "))).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (["exit", "quit", ":q", "cik", "çık"].includes(line.toLowerCase())) break;
      if (line.toLowerCase() === "/yeni") {
        router.resetSessions();
        started = false;
        log(dim("Yeni sohbet."));
        continue;
      }
      const raw = line.endsWith("!raw");
      const prompt = raw ? line.slice(0, -4).trim() : line;
      try {
        const res = await router.ask({ phase: "chat", prompt, followUp: prompt, freshChat: !started });
        started = true;
        if (raw) {
          log(`\n${c.cyan(res.site)} ›\n${res.reply}`);
        } else {
          const { text, ops, errors } = parseReply(res.reply);
          log(`\n${c.cyan(res.site)} ›\n${text || res.reply}`);
          if (ops.length) log(dim(`\n(${ops.length} ops in reply — run "c2f build" to execute them; ops are never auto-run in chat mode)`));
          for (const e of errors) log(dim(`(${e})`));
        }
      } catch (err) {
        log(c.red(`✗ ${friendly(err)}`));
      }
    }
  } finally {
    rl.close();
    await bridge?.stop();
  }
}

async function cmdServe() {
  const cfg = makeConfig();
  const bridge = new Bridge({ port: cfg.port, requestTimeoutMs: cfg.requestTimeoutMs, log: (m) => log(dim(`[bridge] ${m}`)), token: ensureToken() });
  await bridge.start();
  log(`${c.bold("ChatToFree bridge")} ws://127.0.0.1:${cfg.port}`);
  log(dim("waiting for the Chrome extension — Ctrl+C to stop"));
  const local = new LocalModel(cfg.local);
  if (await local.available()) log(dim(`[local] ${await local.modelName()} ready`));
  else log(dim("[local] not reachable (optional)"));
  bridge.onClient = (info) => log(c.green(`extension connected (sites: ${info.sites.filter((s) => s !== "generic").join(", ")})`));
  process.on("SIGINT", async () => {
    await bridge.stop();
    process.exit(0);
  });
  await new Promise(() => {});
}

async function cmdDoctor() {
  const cfg = makeConfig();
  const checks = [];
  const local = new LocalModel(cfg.local);
  const localOk = await local.available();
  checks.push(["local model", localOk ? `ok (${await local.modelName()})` : "not reachable (optional)", localOk]);
  let extensionOk = false;
  const bridge = new Bridge({ port: cfg.port, token: ensureToken() });
  try {
    await bridge.start();
    checks.push(["bridge port", `free, listening on ${cfg.port}`, true]);
    const info = await bridge.waitForClient(35_000);
    extensionOk = Boolean(info);
    checks.push(["extension", info ? `connected (v${info.version}, ${info.sites.length} adapters)` : "not connected — load extension/ in chrome://extensions", extensionOk]);
  } catch (err) {
    checks.push(["bridge port", `in use by another process (${err.code || err.message})`, false]);
  } finally {
    await bridge.stop();
  }
  log(c.bold("ChatToFree doctor\n"));
  for (const [name, detail, ok] of checks) log(`${ok ? c.green("✓") : c.yellow("•")} ${name.padEnd(14)} ${detail}`);
  // Diagnostics must not create anything: a read-only check should never leave an empty
  // directory behind in whatever directory the user happened to be in.
  const files = fs.existsSync(cfg.workspace) ? fs.readdirSync(cfg.workspace, { recursive: true }).length : 0;
  log(`${c.green("✓")} workspace      ${cfg.workspace} (${files} entries${fs.existsSync(cfg.workspace) ? "" : ", will be created on first build"})`);
  if (!extensionOk) {
    log(c.yellow(`\nExtension not connected. In the extension's options page set the bridge token to:`));
    log(`  ${c.cyan(ensureToken())}`);
    log(dim(`(stored at ${tokenPath()}; the same value is required or the bridge rejects the client)`));
  }
  if (!extensionOk) process.exitCode = 1;
}

const settingsCmds = makeSettingsCommands({ flags, positional, log, c, dim, die, ensureBridge, makeConfig });

// A mistake in a setting or a bridge failure is a message, not a stack trace.
try {
  switch (cmd) {
    case "config":
      await settingsCmds.cmdConfig();
      break;
    case "use":
      await settingsCmds.cmdUse();
      break;
    case "models":
      await settingsCmds.cmdModels();
      break;
    case "apply":
      await settingsCmds.cmdApply();
      break;
    case "usage":
      await settingsCmds.cmdUsage();
      break;
    case "auth":
      await cmdAuth();
      break;
    case "login":
      await cmdLogin();
      break;
    case "setup":
      await cmdSetup();
      break;
    case "status":
      await cmdStatus();
      break;
    case "api":
      await cmdApi();
      break;
    case "short":
      shortUsage();
      break;
    case "build":
    case "make":
      await cmdBuild();
      break;
    case "chat":
      await cmdChat();
      break;
    case "ask":
      await cmdAsk();
      break;
    case "rules":
      cmdRules();
      break;
    case "update":
      cmdUpdate();
      break;
    case "serve":
      await cmdServe();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      log(c.red(`unknown command: ${cmd}\n`));
      usage();
      process.exit(1);
  }
} catch (err) {
  if (process.env.C2F_DEBUG) console.error(err.stack);
  die(friendly(err));
}
