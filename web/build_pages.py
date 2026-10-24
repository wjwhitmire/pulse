"""Build the browser tool.

1. web/app.html (standalone page contract) from web/src/: app.template.html, style.css, body.html,
   the core scripts (core.js, core_ext.js, then web/lib/*.js when present) and ui.js.
2. docs/index.html: app.html wrapped as a full HTML document for GitHub Pages, with a
   Content-Security-Policy, the PWA manifest link and service worker registration.

Run: python web/build_pages.py
"""

import base64
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "src"
LIB = ROOT / "web" / "lib"
APP = ROOT / "web" / "app.html"
DOCS = ROOT / "docs"

CORE_FILES = ["core.js", "core_ext.js"]


def read(p):
    return p.read_text(encoding="utf-8") if p.exists() else ""


def lib_sources():
    if not LIB.exists():
        return ""
    parts = []
    for p in sorted(LIB.glob("*.js")):
        if p.name.endswith(".test.js") or p.name.endswith(".test.mjs"):
            continue
        parts.append(f"// ---- web/lib/{p.name}\n" + p.read_text(encoding="utf-8"))
    return "\n".join(parts)


ICONS = json.loads(read(SRC / "icons.json") or "{}")


def icon_svg(name):
    return ('<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" '
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>")


def expand_icons(html):
    return re.sub(r"\{\{icon:([a-z]+)\}\}", lambda m: icon_svg(m.group(1)), html)


def ui_sources():
    parts = [p.read_text(encoding="utf-8") for p in sorted((SRC / "ui").glob("*.js"))]
    js = "\n".join(parts) if parts else read(SRC / "ui.js")
    return js.replace("/*ICONS*/", json.dumps(ICONS, sort_keys=True))


def build_app():
    t = read(SRC / "app.template.html")
    core = "\n".join(read(SRC / f) for f in CORE_FILES)
    lib = lib_sources()
    if lib:
        core += "\n" + lib
    for key, val in (("/*STYLE*/", read(SRC / "style.css")), ("<!--BODY-->", expand_icons(read(SRC / "body.html"))),
                     ("/*CORE*/", core), ("/*UI*/", ui_sources())):
        t = t.replace(key, val.rstrip("\n"))
    if "</script" in core or "</script" in ui_sources():
        raise SystemExit("a script source contains '</script'; it would end the block early")
    APP.write_text(t, encoding="utf-8")
    return APP


# connect-src: this site, https, and a model server on this computer (localhost and 127.0.0.1). The
# coach can use the person's own AI service at any address they type, which a fixed policy cannot
# name, so the policy fences connections to https and this computer, and the network gate (net() in
# web/src/ui/80_net.js, the only place the page calls fetch) decides each request: only with its
# switch on and only to that switch's exact hosts or, for the AI service, its one configured URL.
# Inline scripts are allowed by hash only ({SCRIPT_HASHES} is filled in by build_docs).
CONNECT = ["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*"]
CSP = (
    "default-src 'none'; "
    "script-src {SCRIPT_HASHES} https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/ "
    "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/ 'wasm-unsafe-eval'; "
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/; "
    "img-src 'self' data: blob: https://tiles.openfreemap.org; font-src 'self' data:; worker-src blob: 'self'; manifest-src 'self'; "
    "connect-src " + " ".join(CONNECT) + "; form-action 'none'; base-uri 'none'; object-src 'none'"
)

HEAD = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="{{CSP}}">
<meta name="referrer" content="no-referrer">
<meta name="description" content="Pulse: a private training log. Activity analysis, training load, readiness inputs, sleep and strength from your own files. Runs on your device.">
<meta name="theme-color" content="#0b0e1a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f2f3f9" media="(prefers-color-scheme: light)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-192.png">
<style>
:root {{ padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }}
body {{ margin: 0; }}
[hidden] {{ display: none !important; }}
</style>
"""

SW_REG = """<script>
if ("serviceWorker" in navigator && location.protocol === "https:") {
  try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) {}
}
</script>
"""


FONT_FACES = """<style>
@font-face{font-family:"Bricolage Grotesque";src:url(fonts/bricolage-grotesque-latin-standard-normal.woff2) format("woff2");font-weight:200 800;font-stretch:75% 100%;font-display:swap}
@font-face{font-family:"Onest";src:url(fonts/onest-latin-wght-normal.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(fonts/geist-mono-latin-400-normal.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(fonts/geist-mono-latin-500-normal.woff2) format("woff2");font-weight:500;font-display:swap}
</style>
"""


def build_docs(app):
    # The Pages build self-hosts the three fonts (for the offline app shell) instead of Google Fonts.
    app = re.sub(r'<link rel="stylesheet" href="https://fonts.googleapis.com[^>]*>\n?', FONT_FACES, app)
    cut = app.index("<style>\n/*") if "<style>\n/*" in app else app.rindex("<style>")
    head_part, body_part = app[:cut], app[cut:]
    style_end = body_part.index("</style>") + len("</style>")
    doc = (HEAD + head_part + body_part[:style_end] + "\n</head>\n<body>\n"
           + body_part[style_end:].lstrip("\n") + SW_REG + "</body>\n</html>\n")
    hashes = []
    for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", doc, re.S):
        h = "'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode() + "'"
        if h not in hashes:
            hashes.append(h)
    doc = doc.replace("{CSP}", CSP.replace("{SCRIPT_HASHES}", " ".join(hashes)), 1)
    DOCS.mkdir(exist_ok=True)
    (DOCS / "index.html").write_text(doc, encoding="utf-8")
    for src in sorted((SRC / "pwa").rglob("*")):
        if src.is_file():
            dst = DOCS / src.relative_to(SRC / "pwa")
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
    # Version the service worker's cache by the shell's content, so a new build replaces the old
    # cached page, fonts and icons (a byte change in sw.js is what makes the browser update it).
    shell = hashlib.sha256(doc.encode("utf-8"))
    for src in sorted((SRC / "pwa").rglob("*")):
        if src.is_file() and src.name != "sw.js":
            shell.update(src.read_bytes())
    sw = DOCS / "sw.js"
    sw.write_text(sw.read_text(encoding="utf-8").replace('"pulse-shell-v1"', '"pulse-shell-' + shell.hexdigest()[:12] + '"'), encoding="utf-8")
    return DOCS / "index.html"


if __name__ == "__main__":
    app = build_app()
    out = build_docs(app.read_text(encoding="utf-8"))
    print(f"wrote {app.relative_to(ROOT)} ({app.stat().st_size:,} bytes) and {out.relative_to(ROOT)}")
