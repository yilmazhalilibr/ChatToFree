/* Browser script for the mock chat page (served as /app.js).
 * Renders replies the way ChatGPT/Claude do: markdown → <p> and
 * <pre><code class="language-x"> + a toolbar with a "Copy code" button.
 * Backticks never survive into the DOM, which is the trap the extension must handle. */
const thread = document.getElementById("thread");
const input = document.getElementById("prompt-textarea");
const send = document.querySelector("#composer button[type=submit]");
const form = document.getElementById("composer");
let streaming = false;
// Records any consent-banner click so the e2e can prove the extension never presses one.
window.__cookieClicks = 0;
for (const el of document.querySelectorAll("#consent button")) {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    window.__cookieClicks += 1;
  });
}

input.addEventListener("input", () => {
  send.disabled = streaming || !input.value.trim();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  submitPrompt();
});

async function submitPrompt() {
  const prompt = input.value;
  if (!prompt.trim() || streaming) return;
  input.value = "";
  send.disabled = true;
  // Simulates a send that silently fails (rate limit, disabled composer, missed button):
  // no user turn, no assistant node, so the previous reply is still the last one on page.
  if (/C2F_SILENT/.test(prompt)) return;
  const u = document.createElement("div");
  u.className = "turn user";
  u.textContent = prompt;
  thread.append(u);
  streaming = true;
  const stop = document.createElement("button");
  stop.type = "button";
  stop.setAttribute("data-testid", "stop-button");
  stop.setAttribute("aria-label", "Stop streaming");
  stop.textContent = "Stop";
  form.append(stop);
  const node = document.createElement("div");
  node.className = "turn";
  node.setAttribute("data-message-author-role", "assistant");
  thread.append(node);
  // Claude's real turn (measured): a 1x1 clipped sr-only <h3> that repeats the WHOLE answer
  // ("Claude responded: ..."), the answer itself, then a toolbar with a timestamp. It exists
  // from the first moment, before any text has streamed in.
  renderTurn(node, "");
  await streamReply(prompt, (chunk) => renderTurn(node, chunk));
  stop.remove();
  streaming = false;
  input.focus();
}

async function streamReply(prompt, onChunk) {
  const res = await fetch("/reply-stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    onChunk(acc);
  }
}

function renderTurn(node, md) {
  renderMarkdown(node, md);
  const sr = document.createElement("h3");
  sr.className = "sr-only";
  sr.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap";
  sr.textContent = "Claude responded: " + md;
  node.prepend(sr);
  const bar = document.createElement("div");
  bar.innerHTML = "<button type='button'>Copy</button><time>3 minutes ago</time>";
  node.append(bar);
}

function renderMarkdown(el, md) {
  el.replaceChildren();
  const parts = md.split("```");
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const bar = document.createElement("div");
      bar.className = "code-header";
      const lang = (part.match(/^[\w+#-]+/) || [""])[0];
      const label = document.createElement("span");
      label.textContent = lang || "code";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy code";
      bar.append(label, copy);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = lang ? "language-" + lang : "";
      code.textContent = part.replace(/^[\w+#-]*\n/, "");
      pre.append(code);
      const box = document.createElement("div");
      box.className = "code-block";
      box.append(bar, pre);
      el.append(box);
    } else if (part.trim()) {
      // Render line by line: any /^#{1,6}\s/ line is its own heading, runs of other lines
      // are paragraphs. Hashes never reach the DOM, exactly like ChatGPT/Claude, so the
      // extension has to put them back before the section parser can match.
      const lines = part.replace(/\n+$/, "").split("\n");
      let para = [];
      const flush = () => {
        if (!para.length) return;
        const p = document.createElement("p");
        p.textContent = para.join("\n");
        el.append(p);
        para = [];
      };
      for (const line of lines) {
        const head = /^(#{1,6})\s+(.*)$/.exec(line);
        if (head) {
          flush();
          const h = document.createElement("h" + head[1].length);
          h.textContent = head[2];
          el.append(h);
        } else if (line.trim() === "") {
          flush();
        } else {
          para.push(line);
        }
      }
      flush();
    }
  });
}

window.__mockChatReady = true;
