# Security

## What Pulse does with your data

- Everything stays on your device, in this browser's IndexedDB. There are no accounts, no uploads, no analytics, no beacons.
- With every network switch off (the default) the page makes no network requests. Every request Pulse can make goes through one gate, `net()` in `web/src/ui/80_net.js` (with `netScript`, `netStyle` and `netImport` for libraries), that checks the feature's switch and then either an exact host list over https (maps, route finder, on-device coach) or, for the coach with your own AI service, the one chat completions address you configured. `web/net.test.mjs` fails the build if any network API appears outside the gate, and `tests/test_no_network.py` loads the page in a browser, imports files and asserts zero requests.
- Third-party libraries (MapLibre GL JS, WebLLM) load only when their switch is on, from pinned versions; MapLibre is checked with Subresource Integrity.
- The coach with your own AI service works with any service that speaks the OpenAI-compatible chat completions API, or a model server on this computer. You type its base address, the model id and a key (a server on localhost or 127.0.0.1 may need none). The gate then allows exactly one address, that service's chat completions URL: https to any host, or http only to localhost and 127.0.0.1, with no user name, password, query or fragment. The key is kept in memory for the page only, sent only in that request's Authorization header, and never stored or exported. The numbers the coach may see are shown under "The numbers the coach sees" before you ask; no free text you typed (activity names, notes) is in them.
- Restoring a backup never turns a network switch on.
- On GitHub Pages the Content-Security-Policy allows inline scripts by hash only, scripts only from the two pinned library paths, and `connect-src 'self' https: http://localhost:* http://127.0.0.1:*`. The policy cannot name the address of an AI service you type in, so it fences connections to https, this site and a model server on this computer; the gate decides each request inside that fence. Map tiles (`img-src`) stay limited to tiles.openfreemap.org. With the On-device coach switch on, the model library's own downloads are bounded by this fence rather than by host; it is pinned by an import-map integrity hash and fetches its model files from huggingface.co.
- Files are read with the File API from files you pick, with size and row caps. XML with a DOCTYPE or ENTITY declaration is refused; the Apple Health scanner never processes the export's DTD and never expands entities. FHIR JSON is accepted only as plain data with depth, size and key limits.
- User text is inserted with `textContent`, never `innerHTML`. No `eval`, no `new Function`, no inline event handlers. CSV exports neutralise cells that a spreadsheet would run as a formula. Coach replies pass an output guard and are shown as text.
- The service worker caches only the app shell (page, icons, fonts, manifest), only good same-origin answers, under a cache name stamped from the build, and never sees user data or any other host's responses.
- `localStorage` holds one convenience (the theme choice).

## Python library

No runtime dependencies, no network calls, no pickle, no eval, no shell calls. XML is parsed with the standard library after DOCTYPE and ENTITY declarations are refused. The CLI reads only the paths you pass.

## Reporting a problem

Open a GitHub issue labelled `security`, or use GitHub's private vulnerability reporting on this repository if the issue should not be public. Include steps to reproduce and the browser or Python version.
