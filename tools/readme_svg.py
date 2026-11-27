"""Builds docs/readme-tr.svg and docs/readme-en.svg: the whole README as one picture per language.

GitHub shows a README SVG as a plain <img>: no clicks, scripts or copyable text. So the language switch is
two pages (README.md, README.en.md) and the commands to copy sit as text under the picture.
Every text below is a (Turkish, English) pair; the EN page stops the build if a Turkish letter is left.

New release: add an entry at the top of CHANGES, run `python tools/readme_svg.py`, commit both SVGs.
"""
import html
import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"

# newest first. kind: new | fix | change. Each item: (kind, Turkish, English)
CHANGES = [
    ("0.1.0", "2026-11-27", [
        ("new", "İlk açık sürüm: DeepSeek danışmanı (`c2f_advise`), `ctf` ajanı ve kabuktan `c2f danis`",
         "First public release: the DeepSeek advisor (`c2f_advise`), the `ctf` agent and `c2f danis` from any shell"),
        ("new", "README tek görsel: Türkçe ve İngilizce iki sayfa, örnek bir oturumla",
         "README as one picture: a Turkish and an English page, with an example session"),
        ("new", "MIT lisansı", "MIT license"),
    ]),
]

W, M = 1000, 48  # page width, side margin
IW = W - 2 * M
FG, TEXT, MUTED, DIM, LINE, CARD, CODE = "#f8fafc", "#cbd5e1", "#94a3b8", "#64748b", "#1e293b", "#0f172a", "#020617"
BLUE, VIOLET, PINK, GREEN, AMBER, DS = "#38bdf8", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#7c9cff"
TURKISH = re.compile(r"[çğıöşüÇĞİÖŞÜ]")
LANG = "tr"


def t(pair):
    return pair[0] if LANG == "tr" else pair[1]


def esc(s):
    return html.escape(s, quote=False)


def rich(s):
    """`code` -> monospace, **bold** -> bold."""
    out = []
    for part in re.split(r"(`[^`]+`|\*\*[^*]+\*\*)", s):
        if part.startswith("`"):
            out.append(f'<tspan class="m" fill="#e2e8f0">{esc(part[1:-1])}</tspan>')
        elif part.startswith("**"):
            out.append(f'<tspan font-weight="700" fill="{FG}">{esc(part[2:-2])}</tspan>')
        elif part:
            out.append(esc(part))
    return "".join(out)


def wrap(s, width, size):
    # ponytail: width from an average glyph size, not real font metrics; keep ~10% slack in the boxes
    s = re.sub(r"`[^`]+`|\*\*[^*]+\*\*", lambda m: m.group(0).replace(" ", "\u00a0"), s)
    per, lines, cur = max(8, int(width / (size * 0.53))), [], ""
    for word in s.split(" "):
        if cur and len(re.sub(r"`|\*\*", "", f"{cur} {word}")) > per:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}" if cur else word
    return lines + [cur]


def para(x, y, s, width, size=14, fill=TEXT, lh=1.55, weight=None):
    """Wrapped text whose first baseline is y + size; returns (svg, height)."""
    lines = wrap(s, width, size)
    step = round(size * lh, 1)
    spans = "".join(f'<tspan x="{x}" dy="{0 if i == 0 else step}">{rich(line)}</tspan>' for i, line in enumerate(lines))
    bold = f' font-weight="{weight}"' if weight else ""
    return f'<text x="{x}" y="{y + size}" font-size="{size}" fill="{fill}"{bold}>{spans}</text>', len(lines) * step


def code(x, y, w, lines, size=12.5):
    step = round(size * 1.6, 1)
    h = len(lines) * step + 22
    spans = "".join(f'<tspan x="{x + 16}" dy="{0 if i == 0 else step}">{esc(line)}</tspan>' for i, line in enumerate(lines))
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{CODE}" stroke="#334155"/>'
            f'<text x="{x + 16}" y="{y + 11 + size}" font-size="{size}" class="m" fill="#e2e8f0" xml:space="preserve">{spans}</text>', h)


def table(y, widths, header, rows, size=13.5):
    """widths: column widths summing to IW; a cell starting with '=' is monospace."""
    out = [f'<rect x="{M}" y="{y}" width="{IW}" height="38" rx="10" fill="#111a33"/>']
    x = M
    for w, cell in zip(widths, header):
        out.append(f'<text x="{x + 16}" y="{y + 24}" font-size="12" font-weight="700" letter-spacing="1" fill="{MUTED}">{esc(t(cell))}</text>')
        x += w
    y0, cy = y, y + 38
    for i, row in enumerate(rows):
        cells, h, x = [], 0, M
        for w, cell in zip(widths, row):
            s = t(cell) if isinstance(cell, tuple) else cell
            mono = s.startswith("=")
            svg, ch = para(x + 16, cy + 12, f"`{s[1:]}`" if mono and s[1:] else s.lstrip("="), w - 32, size - (1 if mono else 0))
            cells.append(svg)
            h, x = max(h, ch), x + w
        h += 24
        if i % 2:
            out.append(f'<rect x="{M}" y="{cy}" width="{IW}" height="{h}" fill="#0c1426"/>')
        out += cells + [f'<line x1="{M}" y1="{cy + h}" x2="{M + IW}" y2="{cy + h}" stroke="{LINE}"/>']
        cy += h
    return "".join(out), cy - y0


def head(y, num, title, kicker):
    return (f'<text x="{M}" y="{y + 14}" font-size="12" letter-spacing="3" fill="#7dd3fc">{num} · {esc(t(kicker))}</text>'
            f'<text x="{M}" y="{y + 48}" font-size="30" font-weight="800" fill="{FG}">{esc(t(title))}</text>'
            f'<rect x="{M}" y="{y + 62}" width="64" height="4" rx="2" fill="url(#accent)"/>', 84)


def bullets(y, items, size=14):
    out, cy = [], y
    for color, s in items:
        svg, h = para(M + 28, cy, t(s), IW - 28, size)
        out.append(f'<circle cx="{M + 8}" cy="{cy + size * 0.65}" r="4.5" fill="{color}"/>{svg}')
        cy += h + 10
    return "".join(out), cy - y - 10


def moving(path, color, dur, begin):
    # animateMotion needs a negative begin on GitHub, or the dot waits in the corner first
    return (f'<circle r="4.5" fill="{color}"><animateMotion dur="{dur}s" begin="-{begin}s" repeatCount="indefinite" '
            f'path="{path}"/></circle>')


def hero(y):
    x0, h, cx = 20, 340, W / 2
    ua, la = y + 214, y + 236  # upper and lower lane
    pills = [(GREEN, ("API anahtarı yok", "No API key")), (DS, ("DeepThink + web arama", "DeepThink + web search")),
             (VIOLET, ("OpenCode · MCP · kabuk", "OpenCode · MCP · shell")), (AMBER, ("MIT lisans", "MIT license"))]
    widths = [len(t(p)) * 13 * 0.55 + 46 for _, p in pills]
    px = cx - (sum(widths) + 12 * (len(pills) - 1)) / 2
    pill_svg = []
    for (color, p), w in zip(pills, widths):
        pill_svg.append(f'<rect x="{px}" y="{y + 282}" width="{w}" height="30" rx="15" fill="{CARD}" stroke="{color}" stroke-opacity=".7"/>'
                        f'<circle cx="{px + 18}" cy="{y + 297}" r="4" fill="{color}"/>'
                        f'<text x="{px + 30}" y="{y + 301.5}" font-size="13" fill="{TEXT}">{esc(t(p))}</text>')
        px += w + 12
    node = lambda x, icon, title, sub, color: (
        f'<rect x="{x}" y="{y + 192}" width="270" height="66" rx="14" fill="{CARD}" stroke="{color}" stroke-opacity=".8"/>{icon}'
        f'<text x="{x + 66}" y="{y + 219}" font-size="15" font-weight="700" fill="{FG}">{esc(t(title))}</text>'
        f'<text x="{x + 66}" y="{y + 240}" font-size="12" fill="{MUTED}">{esc(t(sub))}</text>')
    agent_icon = (f'<rect x="102" y="{y + 207}" width="36" height="36" rx="9" fill="{CODE}" stroke="{GREEN}"/>'
                  f'<text x="120" y="{y + 230}" text-anchor="middle" font-size="14" font-weight="700" class="m" fill="{GREEN}">&gt;_</text>')
    ds_icon = (f'<circle cx="678" cy="{y + 225}" r="18" fill="#4d6bfe"/>'
               f'<text x="678" y="{y + 229.5}" text-anchor="middle" font-size="12" font-weight="800" fill="#fff">DS</text>')
    return (f'<clipPath id="hc"><rect x="{x0}" y="{y}" width="{W - 40}" height="{h}" rx="22"/></clipPath>'
            f'<g clip-path="url(#hc)"><rect x="{x0}" y="{y}" width="{W - 40}" height="{h}" fill="url(#hero)"/>'
            f'<rect x="{x0}" y="{y}" width="{W - 40}" height="{h}" fill="url(#dots)"/>'
            f'<circle cx="170" cy="{y + 70}" r="230" fill="url(#glowB)"/><circle cx="850" cy="{y + 300}" r="240" fill="url(#glowV)"/></g>'
            f'<rect x="{x0}" y="{y}" width="{W - 40}" height="{h}" rx="22" fill="none" stroke="#1e293b"/>'
            f'<text x="{cx}" y="{y + 56}" text-anchor="middle" font-size="12" letter-spacing="4" fill="#7dd3fc">'
            f'{esc(t(("OPENCODE · CLAUDE CODE · CODEX · MCP · KABUK", "OPENCODE · CLAUDE CODE · CODEX · MCP · SHELL")))}</text>'
            f'<text x="{cx}" y="{y + 124}" text-anchor="middle" font-size="68" font-weight="900" fill="url(#title)">ChatToFree</text>'
            f'<text x="{cx}" y="{y + 164}" text-anchor="middle" font-size="19" font-weight="600" fill="{FG}">'
            f'{esc(t(("Ajanın kodu yazar. Kıdemli danışmanı DeepSeek web.", "Your agent writes the code. DeepSeek web is its senior advisor.")))}</text>'
            f'<path d="M356 {ua} H644" stroke="{BLUE}" stroke-width="2" stroke-dasharray="4 6" opacity=".75"/>'
            f'<path d="M644 {la} H356" stroke="{PINK}" stroke-width="2" stroke-dasharray="4 6" opacity=".75"/>'
            + moving(f"M356 {ua} H644", BLUE, 2.6, 0.4) + moving(f"M644 {la} H356", PINK, 2.6, 1.7)
            + f'<text x="405" y="{ua - 8}" text-anchor="middle" font-size="11.5" fill="{BLUE}">{esc(t(("danışır →", "asks →")))}</text>'
            f'<text x="595" y="{la + 20}" text-anchor="middle" font-size="11.5" fill="{PINK}">{esc(t(("← öneri · kod", "← advice · code")))}</text>'
            f'<rect x="455" y="{y + 207}" width="90" height="36" rx="10" fill="#1a1040" stroke="{VIOLET}"/>'
            f'<text x="500" y="{y + 231}" text-anchor="middle" font-size="17" font-weight="800" class="m" fill="{VIOLET}">c2f</text>'
            + node(86, agent_icon, ("Ajan · istediğin model", "Agent · any model"), ("yerel · big-pickle · Codex", "local · big-pickle · Codex"), GREEN)
            + node(644, ds_icon, ("DeepSeek web", "DeepSeek web"), ("DeepThink · Akıllı Arama", "DeepThink · web search"), DS)
            + "".join(pill_svg), h)


def latest(y):
    ver, date, items = CHANGES[0]
    label = t(("SON SÜRÜM", "LATEST"))
    news = " · ".join(t(i[1:]) for i in items[:2])
    text, h = para(M + 290, y + 13, news, IW - 310, 13.5, TEXT)
    h = max(56, h + 26)
    return (f'<rect x="{M}" y="{y}" width="{IW}" height="{h}" rx="14" fill="{CARD}" stroke="{GREEN}" stroke-opacity=".55"/>'
            f'<circle cx="{M + 24}" cy="{y + h / 2}" r="5" fill="{GREEN}"/><circle cx="{M + 24}" cy="{y + h / 2}" r="5" fill="none" stroke="{GREEN}" class="ping"/>'
            f'<text x="{M + 40}" y="{y + h / 2 + 4}" font-size="11" letter-spacing="2" fill="{GREEN}">{label}</text>'
            f'<text x="{M + 130}" y="{y + h / 2 + 5}" font-size="15" font-weight="700" class="m" fill="{FG}">v{ver}</text>'
            f'<text x="{M + 195}" y="{y + h / 2 + 4}" font-size="11.5" fill="{DIM}">{date}</text>' + text.replace("<text", '<text font-style="italic"', 1), h)


def cards(y):
    items = [
        (DS, ("Danışmanı: DeepSeek web", "Its advisor: DeepSeek web"),
         ("Ajan planı, yapıyı ve hatayı kıdemli bir meslektaşla konuşur gibi DeepSeek'e danışır. Ücretli API değil: senin ücretsiz web hesabın.",
          "The agent talks the plan, the structure and the bug over with DeepSeek like with a senior colleague. Not a paid API: your own free web account.")),
        (VIOLET, ("Zor kodu ona yazdırır", "Has it write the hard code"),
         ("Algoritma, ayrıştırıcı, çetrefil mantık: imza, örnek ve sınırlarla ister, o mesaj için **DeepThink**'i açar. Sonra kodu anlar, yerleştirir, test eder.",
          "An algorithm, a parser, tricky logic: asked with a signature, examples and limits, with **DeepThink** on for that message. Then it reads, fits and tests the code.")),
        (BLUE, ("Web'e baktırır", "Sends it to the web"),
         ("Cevap yeni bir kütüphane sürümüne ya da değişmiş bir API'ye bağlıysa DeepSeek'in **web aramasını** o mesaj için açar: eski bilgiyle kod yazılmaz.",
          "When the answer depends on a new library version or a changed API, DeepSeek's **web search** goes on for that message: no code from stale knowledge.")),
        (GREEN, ("Kodunu dosya dosya inceletir", "File-by-file code review"),
         ("İş bitince önce genel yapıyı, sonra her dosyayı ayrı bir mesajla gönderir ve gelen düzeltmeleri uygular. Senin yerine ikinci bir göz.",
          "When the work is done it sends the overall structure, then each file in its own message, and applies the fixes. A second pair of eyes for you.")),
        (PINK, ("Her modeli büyütür", "Lifts any model"),
         ("Yerel bir model, OpenCode'un ücretsiz big-pickle'ı ya da Claude Code: işi o yapar, takıldığı yerde DeepSeek'ten yardım alır.",
          "A local model, OpenCode's free big-pickle or Claude Code: it does the work and gets DeepSeek's help where it gets stuck.")),
        (AMBER, ("Hesabını korur", "Guards your account"),
         ("Mesajlar insan diliyle, aralıklı ve sınırlı gider. Parola, token ya da anahtar içeren mesaj **gönderilmez**; `.c2fignore` dosyaları dışarıda kalır.",
          "Messages go in plain words, spaced out and capped. A message holding a password, token or key is **not sent**; `.c2fignore` files stay out.")),
    ]
    w, gap = (IW - 40) / 3, 20
    out, cy = [], y
    for row in (items[:3], items[3:]):
        texts = [para(M + i * (w + gap) + 22, cy + 56, t(c[2]), w - 44, 13.5) for i, c in enumerate(row)]
        h = max(th for _, th in texts) + 76
        for i, ((color, title, _), (svg, _)) in enumerate(zip(row, texts)):
            x = M + i * (w + gap)
            out.append(f'<rect x="{x}" y="{cy}" width="{w}" height="{h}" rx="16" fill="{CARD}" stroke="{color}" stroke-opacity=".55"/>'
                       f'<rect x="{x + 22}" y="{cy}" width="48" height="4" rx="2" fill="{color}"/>'
                       f'<text x="{x + 22}" y="{cy + 38}" font-size="17" font-weight="700" fill="{color}">{esc(t(title))}</text>{svg}')
        cy += h + gap
    return "".join(out), cy - gap - y


def more(y):
    return bullets(y, [
        (GREEN, ("**Debug katmanı.** Ajan yazdığı her programa tek anahtarla (`APP_DEBUG=1`) açılan bir hata ayıklama katmanı koyar; hata çıkınca bloğu bulur, çözemezse DeepSeek'e o bloğu sorar.",
                 "**Debug layer.** Every program the agent writes gets a debug layer behind one switch (`APP_DEBUG=1`); on an error it finds the block, and asks DeepSeek about that block if it can't solve it.")),
        (BLUE, ("**Bir oturum, bir sohbet.** Bir ajan oturumundaki bütün danışmalar DeepSeek'te tek sohbette ilerler; ne sorulduğunu ve cevabı sen de okursun.",
                "**One session, one chat.** Every consult of an agent session runs in a single DeepSeek chat; you can read what was asked and answered.")),
        (VIOLET, ("**Körü körüne uygulamaz.** Gelen kodu anlamadan kullanmaz; paket kurma, silme, indirme ya da sistem ayarı içeren bir komuttan önce sana sorar.",
                  "**No blind copying.** It doesn't use code it doesn't understand, and asks you before a command that installs, deletes, downloads or changes system settings.")),
        (AMBER, ("**Küçük işte danışmaz.** Kısa bir soru ya da tek satırlık bir düzeltme için mesaj gitmez.",
                 "**No consults for small things.** A short question or a one-line fix sends nothing.")),
    ])


def flow(y):
    nodes = [
        (150, BLUE, ("Sen", "You"), [("isteğini yazar", "writes the request"), ("sonucu alır", "gets the result"),
                                      ("DeepSeek'teki", "reads the chat"), ("sohbeti okur", "on DeepSeek")]),
        (230, GREEN, ("Ajan", "Agent"), [("① klasöre bakar, planlar", "① reads the folder, plans"), ("② planı danışır", "② talks the plan over"),
                                          ("③ kodu yazar, test eder", "③ writes and tests code"), ("④ zor kısmı yazdırır", "④ has hard parts written"),
                                          ("⑤ dosya dosya inceletir", "⑤ file-by-file review"), ("⑥ sana özet verir", "⑥ sums up for you")]),
        (190, VIOLET, ("c2f", "c2f"), [("“ben” dili kontrolü", "first-person check"), ("gizli bilgi süzgeci", "secret filter"),
                                        ("≤ 30.000 karakter", "≤ 30,000 characters"), ("15 sn ara", "15 s between messages"),
                                        ("10 dk'da en çok 10", "at most 10 per 10 min"), ("1 oturum = 1 sohbet", "1 session = 1 chat")]),
        (220, DS, ("DeepSeek web", "DeepSeek web"), [("kendi hesabın, ücretsiz", "your own free account"), ("DeepThink: derin düşünür", "DeepThink: thinks deeper"),
                                                     ("Akıllı Arama: web'e bakar", "Search: looks at the web"), ("plan · kod · inceleme", "plans · code · reviews"),
                                                     ("sohbet hesabında kalır", "chat stays in your account")]),
    ]
    gap = (IW - sum(n[0] for n in nodes)) / (len(nodes) - 1)
    h = 44 + 6 * 24 + 18
    out, x = [], M
    for i, (w, color, title, lines) in enumerate(nodes):
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{CARD}" stroke="{color}" stroke-opacity=".7"/>'
                   f'<path d="M{x} {y + 40} V{y + 14} a14 14 0 0 1 14 -14 H{x + w - 14} a14 14 0 0 1 14 14 V{y + 40} Z" fill="{color}" fill-opacity=".16"/>'
                   f'<text x="{x + w / 2}" y="{y + 26}" text-anchor="middle" font-size="15" font-weight="800" fill="{color}"'
                   f'{" class=\"m\"" if title[0] == "c2f" else ""}>{esc(t(title))}</text>')
        for j, line in enumerate(lines):
            out.append(f'<text x="{x + 14}" y="{y + 66 + j * 24}" font-size="13" fill="{TEXT}">{esc(t(line))}</text>')
        if i < len(nodes) - 1:
            a, b, my = x + w + 4, x + w + gap - 4, y + h / 2
            out.append(f'<path d="M{a} {my - 9} H{b}" stroke="{BLUE}" stroke-width="1.6" stroke-dasharray="3 4"/>'
                       f'<path d="M{b} {my - 13} l5 4 l-5 4 z" fill="{BLUE}"/>'
                       f'<path d="M{b} {my + 9} H{a}" stroke="{PINK}" stroke-width="1.6" stroke-dasharray="3 4"/>'
                       f'<path d="M{a} {my + 5} l-5 4 l5 4 z" fill="{PINK}"/>'
                       + moving(f"M{a} {my - 9} H{b}", BLUE, 1.6, 0.3 * i) + moving(f"M{b} {my + 9} H{a}", PINK, 1.6, 0.8 + 0.3 * i))
        x += w + gap
    cap, ch = para(M, y + h + 18, t(("DeepSeek dosyalarını görmez; yalnızca ajanın ona yazdığını okur. İşi ajan yapar, danışman fikir, açıklama ve istenince kod verir.",
                                    "DeepSeek never sees your files; it reads only what the agent writes to it. The agent does the work; the advisor gives opinions, explanations and, when asked, code.")),
                   IW, 13.5, MUTED)
    return "".join(out) + cap, h + 18 + ch


SESSION = {
    "tr": [
        ("you", "Bir not uygulaması yap: notlar bir JSON dosyasında dursun, `ara` komutuyla bulunsun."),
        ("agent", "Klasör boş. Plan: `notes.js` (komutlar), `store.js` (kayıt), `search.js` (arama). Yazmadan önce kaydı danışıyorum."),
        ("ask", "c2f_advise", "Notları tek bir JSON dosyasında tutacağım. İki komut aynı anda yazarsa ne olur, sence kilit gerekir mi?"),
        ("ds", "Kilide gerek yok: önce geçici bir dosyaya yaz, sonra `rename` ile asıl dosyanın yerine koy. Yazma yarıda kesilse de dosya bozulmaz. Aynı anda yazılan iki nottan biri kaybolabilir; tek kullanıcılı bir CLI için bu kabul edilebilir."),
        ("agent", "`store.js` geçici dosya + `rename` ile yazıyor, testler geçti. Arama zor kısım; onu yazdırıyorum."),
        ("ask", "c2f_advise · deep: true", "`search(notes, query)` lazım: sorgudaki her kelime notta bir kelimenin başıyla eşleşsin, büyük/küçük harf ve İ/ı farkı gözetilmesin. Örnek: `ist` → \"İstanbul gezisi\"."),
        ("ds", "Türkçe küçük harfe çevir, sonra kelime başlarını karşılaştır:", [
            'const norm = (s) => s.toLocaleLowerCase("tr");',
            "export function search(notes, query) {",
            "  const words = norm(query).split(/\\s+/).filter(Boolean);",
            "  return notes.filter((n) => {",
            "    const heads = norm(n.text).split(/[^\\p{L}\\p{N}]+/u);",
            "    return words.every((w) => heads.some((h) => h.startsWith(w)));",
            "  });",
            "}"]),
        ("agent", "`search.js` yerleşti; `ist` → \"İstanbul gezisi\" testi dahil hepsi geçti. İş bitti, şimdi `store.js` ile başlayıp kodu dosya dosya inceletiyorum."),
    ],
    "en": [
        ("you", "Make a notes app: notes live in one JSON file and the `find` command finds them."),
        ("agent", "The folder is empty. Plan: `notes.js` (commands), `store.js` (storage), `search.js` (search). I'm talking storage over before I write it."),
        ("ask", "c2f_advise", "I'll keep the notes in a single JSON file. What happens if two commands write at the same time, do you think I need a lock?"),
        ("ds", "No lock needed: write to a temp file first, then `rename` it over the real one. Even if a write is cut off, the file stays intact. One of two notes written at the same moment can be lost; for a single-user CLI that's acceptable."),
        ("agent", "`store.js` writes through a temp file + `rename`, tests pass. Search is the hard part; I'm having that one written."),
        ("ask", "c2f_advise · deep: true", "I need `search(notes, query)`: every word of the query must match the start of a word in the note, ignoring case and accents. Example: `cafe` → \"Café notes\"."),
        ("ds", "Strip accents and lowercase, then compare word starts:", [
            'const norm = (s) => s.normalize("NFD").replace(/\\p{M}/gu, "").toLowerCase();',
            "export function search(notes, query) {",
            "  const words = norm(query).split(/\\s+/).filter(Boolean);",
            "  return notes.filter((n) => {",
            "    const heads = norm(n.text).split(/[^\\p{L}\\p{N}]+/u);",
            "    return words.every((w) => heads.some((h) => h.startsWith(w)));",
            "  });",
            "}"]),
        ("agent", "`search.js` is in; all tests pass, `cafe` → \"Café notes\" included. Done, now the file-by-file review, starting with `store.js`."),
    ],
}


def session(y):
    roles = {"you": (("SEN", "YOU"), BLUE, TEXT), "agent": (("ctf", "ctf"), GREEN, TEXT),
             "ask": (("→ DeepSeek", "→ DeepSeek"), VIOLET, "#ddd6fe"), "ds": (("DeepSeek", "DeepSeek"), DS, "#c7d2fe")}
    tx, tw = M + 140, IW - 160
    out, cy = [], y + 34 + 22
    for role, *rest in SESSION[LANG]:
        label, color, fill = roles[role]
        out.append(f'<rect x="{M + 20}" y="{cy}" width="104" height="22" rx="11" fill="{color}" fill-opacity=".14" stroke="{color}" stroke-opacity=".6"/>'
                   f'<text x="{M + 72}" y="{cy + 15}" text-anchor="middle" font-size="11" font-weight="700" letter-spacing=".5" fill="{color}">{esc(t(label))}</text>')
        ty = cy + 2
        if role == "ask":
            out.append(f'<text x="{tx}" y="{ty + 11}" font-size="11.5" class="m" fill="{DIM}">{esc(rest[0])}</text>')
            ty += 20
            rest = rest[1:]
        svg, h = para(tx, ty, rest[0], tw, 14, fill)
        out.append(svg.replace("<text", '<text font-style="italic"', 1) if role == "ask" else svg)
        ty += h
        if len(rest) > 1:
            box, bh = code(tx, ty + 8, tw, rest[1], 12)
            out.append(box)
            ty += bh + 8
        cy = max(ty, cy + 22) + 16
    foot = t(("thread 5e0c41a7 · bütün danışmalar DeepSeek'te tek sohbette; sen de açıp okuyabilirsin",
              "thread 5e0c41a7 · every consult sits in one DeepSeek chat that you can open and read"))
    out.append(f'<line x1="{M + 20}" y1="{cy}" x2="{M + IW - 20}" y2="{cy}" stroke="{LINE}"/>'
               f'<text x="{M + 20}" y="{cy + 26}" font-size="12" class="m" fill="{DIM}">{esc(foot)}</text>')
    h = cy + 44 - y
    title = t(("opencode · ctf ajanı · örnek oturum", "opencode · ctf agent · example session"))
    frame = (f'<rect x="{M}" y="{y}" width="{IW}" height="{h}" rx="14" fill="{CODE}" stroke="#334155"/>'
             f'<path d="M{M} {y + 34} V{y + 14} a14 14 0 0 1 14 -14 H{M + IW - 14} a14 14 0 0 1 14 14 V{y + 34} Z" fill="#111a33"/>'
             + "".join(f'<circle cx="{M + 22 + i * 18}" cy="{y + 17}" r="5.5" fill="{c}"/>' for i, c in enumerate(("#f87171", AMBER, GREEN)))
             + f'<text x="{W / 2}" y="{y + 22}" text-anchor="middle" font-size="12.5" fill="{MUTED}">{esc(title)}</text>')
    return frame + "".join(out), h


def install(y):
    steps = [
        (BLUE, "Node.js 20+", ("`node -v` ile bak. Yoksa `Kur.bat` winget ile kurmayı teklif eder.",
                               "Check with `node -v`. Missing? `Kur.bat` offers to install it with winget.")),
        (VIOLET, ("İndir", "Download"), ("`git clone` ya da GitHub'dan ZIP. Klasör adında boşluk ve Türkçe harf olabilir.",
                                         "`git clone` or a ZIP from GitHub. Spaces and non-English letters in the folder name are fine.")),
        (PINK, "Kur.bat", ("Çift tıkla. Açılan pencerede **kendi** DeepSeek hesabına gir, sonra pencereyi kapat.",
                           "Double-click it. Sign in to **your own** DeepSeek account in the window that opens, then close it.")),
        (GREEN, ("Hazır", "Ready"), ("Yeni terminalde `c2f durum`. OpenCode'da yeni oturumlar `ctf` ajanıyla açılır.",
                                     "`c2f durum` in a new terminal. New OpenCode sessions open with the `ctf` agent.")),
    ]
    gap = 16
    w = (IW - 3 * gap) / 4
    texts = [para(M + i * (w + gap) + 18, y + 64, t(s[2]), w - 36, 13) for i, s in enumerate(steps)]
    h = max(th for _, th in texts) + 84
    out = []
    for i, ((color, title, _), (svg, _)) in enumerate(zip(steps, texts)):
        x = M + i * (w + gap)
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{CARD}" stroke="{color}" stroke-opacity=".6"/>'
                   f'<circle cx="{x + 32}" cy="{y + 34}" r="14" fill="{color}"/>'
                   f'<text x="{x + 32}" y="{y + 39}" text-anchor="middle" font-size="14" font-weight="800" fill="{CODE}">{i + 1}</text>'
                   f'<text x="{x + 56}" y="{y + 40}" font-size="16" font-weight="700" fill="{color}">{esc(t(title) if isinstance(title, tuple) else title)}</text>{svg}')
    notes, nh = bullets(y + h + 24, [
        (PINK, ("`Kur.bat` ayrıca `c2f`'yi her klasörde çalışır yapar (kullanıcı PATH'i, yönetici izni gerekmez) ve OpenCode'a c2f'yi, `ctf` ajanını, `/ctf_ask` komutunu ve oturum eklentisini ekler.",
                "`Kur.bat` also puts `c2f` on your user PATH (no admin rights) and gives OpenCode c2f, the `ctf` agent, the `/ctf_ask` command and the session plugin.")),
        (BLUE, ("**Her bilgisayar kendi girişini alır.** Giriş alındığı bilgisayara bağlıdır, kopyalanırsa çalışmaz. Arkadaşların kendi DeepSeek hesaplarıyla girer.",
                "**Each computer signs in on its own.** A login is bound to the computer it was taken on; a copy is refused. Your friends sign in with their own DeepSeek accounts.")),
        (VIOLET, ("**Klasörü taşıdıysan** yeni yerinde `Kur.bat`'ı bir kez daha çalıştır; `c2f durum` bunu söyler.",
                  "**Moved the folder?** Run `Kur.bat` once more in the new place; `c2f durum` tells you.")),
        (GREEN, ("**Güncelleme:** `c2f guncelle` (ZIP ile kurduysan yeni ZIP'i aynı klasöre aç, sonra `Kur.bat`).",
                 "**Update:** `c2f guncelle` (installed from a ZIP? Unzip the new one into the same folder, then `Kur.bat`).")),
    ])
    return "".join(out) + notes, h + 24 + nh


def harnesses(y):
    f = ("<klasör>", "<folder>")
    return table(y, [230, IW - 230], [("ARAÇ", "TOOL"), ("NASIL BAĞLANIR", "HOW TO CONNECT")], [
        ("OpenCode", (f"`Kur.bat` bağlar. Yeni oturumlar `ctf` ajanıyla açılır; istediğin modeli seçip yazarsın. Başka ajandayken tek seferlik: `/ctf_ask isteğin`.",
                      f"`Kur.bat` connects it. New sessions open with the `ctf` agent; pick any model and type. From another agent, once: `/ctf_ask your request`.")),
        ("Claude Code", f"`claude mcp add c2f -- node {t(f)}/src/mcp.js`"),
        ("Codex CLI", (f"`~/.codex/config.toml`: `[mcp_servers.c2f]` altında `command = \"node\"`, `args = [\"{t(f)}/src/mcp.js\"]`, `tool_timeout_sec = 600`",
                       f"`~/.codex/config.toml`: under `[mcp_servers.c2f]` set `command = \"node\"`, `args = [\"{t(f)}/src/mcp.js\"]`, `tool_timeout_sec = 600`")),
        ("Cursor, Cline, Windsurf, Claude Desktop", (f"MCP ayarında `\"c2f\": {{ \"command\": \"node\", \"args\": [\"{t(f)}/src/mcp.js\"] }}`. Araç zaman aşımı en az 5 dakika olsun.",
                                                     f"In the MCP settings: `\"c2f\": {{ \"command\": \"node\", \"args\": [\"{t(f)}/src/mcp.js\"] }}`. Give tools a timeout of at least 5 minutes.")),
        (("Kabuk (her ajan)", "Shell (any agent)"), ("`c2f danis --file mesaj.txt` (`--thread`, `--deep`, `--search`). Ajanın kuralları: `c2f kurallar --cli`, çıktıyı `AGENTS.md`, `CLAUDE.md` ya da `.cursorrules` içine koy.",
                                                     "`c2f danis --file message.txt` (`--thread`, `--deep`, `--search`). The agent's rules: `c2f kurallar --cli`, put the output into `AGENTS.md`, `CLAUDE.md` or `.cursorrules`.")),
    ])


def commands(y):
    return table(y, [300, IW - 300], [("KOMUT", "COMMAND"), ("NE YAPAR", "WHAT IT DOES")], [
        ("=c2f kur", ("İlk kurulum ya da güncelleme sonrası: giriş, PATH, OpenCode, masaüstü yenileme", "First install or after an update: sign-in, PATH, OpenCode, desktop refresh")),
        ("=c2f giris", ("DeepSeek girişini yenile (yeni bilgisayar, eskimiş giriş)", "Renew the DeepSeek sign-in (new computer, expired login)")),
        ("=c2f durum", ("Giriş, OpenCode bağlantısı, bekleme, bugünkü mesaj sayısı, yeni sürüm; hiçbir şey göndermez", "Sign-in, OpenCode link, waits, today's message count, new version; sends nothing")),
        ("=c2f guncelle", ("En yeni sürümü alır (`git pull`, `npm install`) ve yeniden kurar", "Gets the newest version (`git pull`, `npm install`) and reinstalls")),
        ("=c2f danis --file m.txt", ("DeepSeek'e danış; `--thread` ile aynı sohbette devam", "Ask DeepSeek; `--thread` continues the same chat")),
        ("=c2f kurallar [--cli]", ("Ajan kurallarını yazdırır, her harness'a verilebilir", "Prints the agent's rules for any harness")),
        ("=c2f sohbet", ("DeepSeek ile terminalden konuş (`/yeni` yeni sohbet)", "Chat with DeepSeek from the terminal (`/yeni` starts over)")),
        (("=c2f config set <ad> <değer>", "=c2f config set <key> <value>"), ("Ayar değiştir; `c2f config` hepsini gösterir", "Change a setting; `c2f config` shows them all")),
    ])


def changelog(y):
    tags = {"new": (("YENİ", "NEW"), GREEN), "fix": (("DÜZELTME", "FIX"), AMBER), "change": (("DEĞİŞTİ", "CHANGED"), VIOLET)}
    out, cy, x = [], y, M + 170
    for n, (ver, date, items) in enumerate(CHANGES):
        rows, ry = [], cy + 20
        for kind, *text in items:
            label, color = tags[kind]
            svg, h = para(x + 112, ry, t(text), IW - 170 - 136, 14)
            rows.append(f'<rect x="{x + 12}" y="{ry + 1}" width="88" height="20" rx="10" fill="{color}" fill-opacity=".15" stroke="{color}" stroke-opacity=".6"/>'
                        f'<text x="{x + 56}" y="{ry + 15}" text-anchor="middle" font-size="10.5" font-weight="700" letter-spacing="1" fill="{color}">{t(label)}</text>{svg}')
            ry += max(h, 22) + 10
        h = ry - cy + 10
        color = GREEN if n == 0 else "#334155"
        out.append(f'<rect x="{x}" y="{cy}" width="{IW - 170}" height="{h}" rx="14" fill="{CARD}" stroke="{color}" stroke-opacity=".6"/>'
                   f'<circle cx="{M + 18}" cy="{cy + 30}" r="7" fill="{color}"/>'
                   f'<text x="{M + 38}" y="{cy + 36}" font-size="20" font-weight="800" class="m" fill="{FG}">v{ver}</text>'
                   f'<text x="{M + 38}" y="{cy + 58}" font-size="12" fill="{DIM}">{date}</text>'
                   + (f'<text x="{M + 38}" y="{cy + 80}" font-size="10.5" letter-spacing="2" fill="{GREEN}">{t(("EN YENİ", "LATEST"))}</text>' if n == 0 else "")
                   + "".join(rows))
        cy += h + 16
    line = f'<line x1="{M + 18}" y1="{y + 30}" x2="{M + 18}" y2="{cy - 16}" stroke="#334155" stroke-width="2" stroke-dasharray="3 6"/>'
    return line + "".join(out), cy - 16 - y


def ignore(y):
    box, bh = code(M + IW - 330, y, 330, [t(("# DeepSeek'e asla gitmez", "# never goes to DeepSeek")), "secrets/", "config/prod.json", "*billing*.py"])
    text, th = para(M, y, t(("Proje klasörüne bir `.c2fignore` koy (`.gitignore` gibi). Bu dosyalardaki satırları içeren bir mesaj **gönderilmez**; ajan onları kendi sözleriyle anlatır. "
                             "Çok büyük bir projede her dosya kontrol edilemezse mesaj yine gönderilmez. Dosyaya tek başına `off` yazarsan c2f o projede hiç danışmaz: şirket kodu gibi tamamen gizli projeler için.",
                             "Put a `.c2fignore` in the project folder (like `.gitignore`). A message holding lines from those files is **not sent**; the agent describes them in its own words. "
                             "If a huge project can't be checked file by file, the message is not sent either. A file with just `off` in it means c2f never consults in that project: for fully private work such as company code.")),
                    IW - 370, 14)
    return box + text, max(bh, th)


def limits(y):
    warn, wh = para(M + 64, y + 18, t(("**Hesabını koru.** DeepSeek web sohbeti bir API değil. Bir hesap, bu proje onu makine gibi sürerken (11 dakikada 25 mesaj, 14 yeni sohbet) askıya alındı. "
                                       "Bu yüzden c2f yalnızca **danışır**: insan diliyle, sınırlı ve aralıklı. Risksiz tek yol DeepSeek'in ücretli resmî API'si.",
                                       "**Protect your account.** DeepSeek's web chat is not an API. An account was suspended while this project drove it like a machine (25 messages and 14 new chats in 11 minutes). "
                                       "So c2f only **consults**: in plain words, capped and spaced out. The only risk-free way is DeepSeek's paid official API.")),
                       IW - 96, 14)
    bh = wh + 36
    box = (f'<rect x="{M}" y="{y}" width="{IW}" height="{bh}" rx="12" fill="#1c1408" stroke="{AMBER}" stroke-opacity=".6"/>'
           f'<rect x="{M}" y="{y}" width="5" height="{bh}" rx="2" fill="{AMBER}"/>'
           f'<circle cx="{M + 34}" cy="{y + 30}" r="12" fill="{AMBER}"/><text x="{M + 34}" y="{y + 35}" text-anchor="middle" font-size="15" font-weight="800" fill="#1c1408">!</text>' + warn)
    tab, th = table(y + bh + 20, [300, IW - 300], [("SINIR", "LIMIT"), ("DEĞER", "VALUE")], [
        (("Mesaj uzunluğu", "Message length"), ("30.000 karakter (DeepSeek'in sınırı yaklaşık 40.000)", "30,000 characters (DeepSeek's own cap is about 40,000)")),
        (("İki mesaj arası", "Between two messages"), ("en az 15 sn", "at least 15 s")),
        (("İki yeni sohbet arası", "Between two new chats"), ("en az 2 dk", "at least 2 min")),
        (("Kısa sürede çok mesaj", "Bursts"), ("10 dakikada en çok 10; fazlası bekler (`sites.deepseek.limit.burstMax` / `burstMinutes`)", "at most 10 per 10 minutes; more waits (`sites.deepseek.limit.burstMax` / `burstMinutes`)")),
        (("Gizli bilgi", "Secrets"), ("parola, API anahtarı, token, özel anahtar içeren mesaj gönderilmez; ajandan `<API_KEY>` gibi bir yer tutucu istenir",
                                      "a message holding a password, API key, token or private key is not sent; the agent is asked for a placeholder such as `<API_KEY>`")),
        (("Aynı mesaj", "Same message"), ("10 dk içinde tekrar gönderilmez", "not sent again within 10 min")),
        (("\"Çok sık\" cevabı", "\"Too frequent\""), ("aynı sohbette 30 / 60 / 120 sn bekleyip tekrar; olmazsa 10 dk ara", "retried in the same chat after 30 / 60 / 120 s; then a 10 min rest")),
        (("Kota doldu", "Quota used up"), ("hiç tekrar denenmez; ajan \"kota doldu, HH:MM'de açılır\" der ve işi kendi bitirir", "never retried; the agent says when it reopens and finishes the work on its own")),
    ])
    notes, nh = bullets(y + bh + 20 + th + 22, [
        (VIOLET, ("DeepSeek'i model ya da API gibi süren eski özellikler (`build`, OpenAI uyumlu uç, `c2f_chat`) varsayılan kapalı (`automation`); açılması önerilmez.",
                  "The old features that drive DeepSeek like a model or an API (`build`, the OpenAI-compatible endpoint, `c2f_chat`) are off (`automation`); turning them on is not advised.")),
        (BLUE, ("c2f tarayıcı parmak izi ya da başka bir tespit atlatma yöntemi kullanmaz.", "c2f uses no browser fingerprinting or any other detection evasion.")),
    ])
    return box + tab + notes, bh + 20 + th + 22 + nh


def trouble(y):
    return table(y, [IW * 0.42, IW * 0.58], [("BELİRTİ", "SYMPTOM"), ("ÇÖZÜM", "FIX")], [
        (("Ajan \"c2f_advise aracı yok\" diyor", "The agent says there's no c2f_advise tool"), ("`c2f kur`, sonra yeni oturum", "`c2f kur`, then a new session")),
        (("`c2f durum`: eski bir klasörü gösteriyor", "`c2f durum` points at an old folder"), ("Klasör taşınmış: yeni yerinde `c2f kur`", "The folder moved: `c2f kur` in the new place")),
        (("\"başka bir bilgisayarda alınmış\" / \"girişi eskimiş\"", "Login taken on another computer / expired"), ("`c2f giris`", "`c2f giris`")),
        (("\"DeepSeek asked to slow down\"", "\"DeepSeek asked to slow down\""), ("Kısa bekleme; ajan işine devam eder, verilen saatten sonra yine danışır", "A short wait; the agent keeps working and consults again after the given time")),
        (("\"kotası doldu\"", "Quota used up"), ("Açılış saatine kadar bekle; ajan işi kendi bitirir", "Wait for the reopening time; the agent finishes on its own")),
        (("Aynı oturum DeepSeek'te yeni sohbet açtı", "One session opened a second DeepSeek chat"), ("Ajan `thread` kimliğini göndermemiş: `c2f kurallar` çıktısını talimatına ekle", "The agent didn't pass the `thread` id: add the `c2f kurallar` output to its instructions")),
    ])


def footer(y):
    w = (IW - 20) / 2
    files, fh = para(M + 22, y + 44, t(("Hepsi `%LOCALAPPDATA%\\ChatToFree\\` altında, yalnızca bu bilgisayarda. `deepseek-auth.json` girişindir, şifre kadar değerli: paylaşma, kopyalama, depoya koyma. `sent.log` mesaj metnini yazmaz.",
                                        "All under `%LOCALAPPDATA%\\ChatToFree\\`, on this computer only. `deepseek-auth.json` is your login and worth as much as a password: never share, copy or commit it. `sent.log` keeps no message text.")),
                    w - 44, 13.5)
    lic, lh = para(M + w + 42, y + 44, t(("MIT. DeepSeek iş kanıtı çağrısı FreeDeepseekAPI'den (Apache-2.0) uyarlandı, bkz. `NOTICE`. Resmî bir proje değil; DeepSeek, OpenAI, Anthropic ya da Google ile bağlantısı yok. Kullanım şartlarına aykırı olabilir; risk kullananındır.",
                                          "MIT. The DeepSeek proof-of-work call is adapted from FreeDeepseekAPI (Apache-2.0), see `NOTICE`. Not an official project; no tie to DeepSeek, OpenAI, Anthropic or Google. It may break their terms of use; the risk is yours.")),
                   w - 44, 13.5)
    h = max(fh, lh) + 64
    return (f'<rect x="{M}" y="{y}" width="{w}" height="{h}" rx="14" fill="{CARD}" stroke="#334155"/>'
            f'<text x="{M + 22}" y="{y + 32}" font-size="17" font-weight="700" fill="{FG}">{esc(t(("Dosyalar", "Files")))}</text>{files}'
            f'<rect x="{M + w + 20}" y="{y}" width="{w}" height="{h}" rx="14" fill="{CARD}" stroke="#334155"/>'
            f'<text x="{M + w + 42}" y="{y + 32}" font-size="17" font-weight="700" fill="{FG}">{esc(t(("Lisans", "License")))}</text>{lic}', h)


def build(lang):
    global LANG
    LANG = lang
    parts, y = [], 20

    def put(fn, *args, gap=40):
        nonlocal y
        svg, h = fn(y, *args)
        parts.append(svg)
        y += h + gap

    put(hero, gap=16)
    put(latest, gap=56)
    put(head, "01", ("Ne yapar?", "What does it do?"), ("AJANIN KIDEMLİ DANIŞMANI", "YOUR AGENT'S SENIOR ADVISOR"), gap=8)
    put(cards, gap=28)
    put(more, gap=64)
    put(head, "02", ("Nasıl çalışır?", "How does it work?"), ("BİR DANIŞMA NASIL AKAR", "THE PATH OF A CONSULT"), gap=12)
    put(flow, gap=64)
    put(head, "03", ("Kullanım örneği", "Example"), ("OPENCODE'DA BİR OTURUM", "ONE OPENCODE SESSION"), gap=12)
    put(session, gap=64)
    put(head, "04", ("Kurulum", "Install"), ("WINDOWS · BİR KERE", "WINDOWS · ONCE"), gap=12)
    put(install, gap=64)
    put(head, "05", ("Her harness'ta", "Any harness"), ("OPENCODE · MCP · KABUK", "OPENCODE · MCP · SHELL"), gap=8)
    put(harnesses, gap=28)
    put(commands, gap=64)
    put(head, "06", ("Güncellemeler", "Updates"), ("HER SÜRÜMDE NE DEĞİŞTİ", "WHAT CHANGED IN EACH RELEASE"), gap=8)
    put(changelog, gap=64)
    put(head, "07", ("Projeni koru: .c2fignore", "Keep a project private: .c2fignore"), ("GİZLİLİK", "PRIVACY"), gap=12)
    put(ignore, gap=64)
    put(head, "08", ("Sınırlar ve hesap güvenliği", "Limits and account safety"), ("NEDEN BÖYLE", "WHY IT WORKS THIS WAY"), gap=12)
    put(limits, gap=64)
    put(head, "09", ("Sorun giderme", "Troubleshooting"), ("BELİRTİ → ÇÖZÜM", "SYMPTOM → FIX"), gap=8)
    put(trouble, gap=48)
    put(footer, gap=28)

    y = round(y)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {y}" width="{W}" height="{y}" '
            'font-family="Segoe UI, Helvetica, Arial, sans-serif">\n'
            '<style>.m{font-family:Cascadia Mono, Consolas, Menlo, monospace}'
            '.ping{animation:ping 2s ease-out infinite;transform-box:fill-box;transform-origin:center}'
            '@keyframes ping{to{transform:scale(3);opacity:0}}</style>\n'
            '<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1120"/>'
            '<stop offset=".5" stop-color="#0f1430"/><stop offset="1" stop-color="#0b1120"/></linearGradient>'
            f'<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{BLUE}"/><stop offset="1" stop-color="{VIOLET}"/></linearGradient>'
            '<linearGradient id="hero" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1430"/><stop offset="1" stop-color="#10123a"/></linearGradient>'
            '<linearGradient id="title" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#60a5fa"/>'
            f'<stop offset=".55" stop-color="{VIOLET}"/><stop offset="1" stop-color="{PINK}"/></linearGradient>'
            '<radialGradient id="glowB"><stop offset="0" stop-color="#4d6bfe" stop-opacity=".45"/><stop offset="1" stop-color="#4d6bfe" stop-opacity="0"/></radialGradient>'
            '<radialGradient id="glowV"><stop offset="0" stop-color="#a78bfa" stop-opacity=".3"/><stop offset="1" stop-color="#a78bfa" stop-opacity="0"/></radialGradient>'
            '<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#94a3b8" fill-opacity=".14"/></pattern>'
            '</defs>\n'
            f'<rect width="{W}" height="{y}" rx="24" fill="url(#pg)"/>\n' + "\n".join(parts) + "\n</svg>\n")


if __name__ == "__main__":
    for lang in ("tr", "en"):
        svg = build(lang)
        if lang == "en":
            left = [s for s in re.findall(r">([^<>]+)<", svg) if TURKISH.search(s)]
            if left:
                sys.exit(f"Turkish text left on the EN page: {left[:5]}")
        out = DOCS / f"readme-{lang}.svg"
        out.write_text(svg, encoding="utf-8")
        print(f"{out.name}: {out.stat().st_size // 1024} KB, {svg.split('height=\"', 1)[1].split('\"', 1)[0]} px")
