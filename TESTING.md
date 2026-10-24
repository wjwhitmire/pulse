# Testing Pulse

Full function pass of 2026-10-23. Every item below was exercised on the published form: `git archive HEAD`, the release fill applied (`https://wjwhitmire.github.io/pulse/`, `wjwhitmire`, `https://github.com/wjwhitmire/pulse`), `docs/` served under `/pulse/` on localhost with its real Content-Security-Policy, in headless Chromium at 1280 px and at 400 px with touch, light and dark. The single-file `web/app.html` was also opened over `file://`. All test data is synthetic (an invented athlete on open-ocean coordinates).

Every run recorded page errors, console errors, CSP violations and every request outside the page's own origin. With all network switches off there were none, in every view, at both widths and in both themes.

## How to rerun

```
pip install -e .[dev] playwright
pytest -q                                  # 154 tests, includes the browser files
python tests/make_vectors.py && python web/build_pages.py
node web/parity.test.mjs                   # 238 cases, 10,126 checks against the Python core
node web/net.test.mjs                      # no network API outside the gate
node web/lib/test/run.mjs                  # 149 library tests
```

`tests/test_published_build.py` copies `docs/`, applies the release fill, serves it under `/pulse/` and drives the main workflows (listed in its docstring). `tests/test_reference_checks.py` checks training load, form, rMSSD and the HRV baseline against their published definitions with independent arithmetic, plus regressions for the bugs below. `tests/test_no_network.py` asserts zero requests with switches off.

## Function inventory and results

Result: Pass = worked as expected on the published form; Fixed = a bug was found, fixed and covered by a test; Limit = works, with a limit listed at the end.

### Imports

| Item | What was done | Result |
|---|---|---|
| One import field (new) | All file kinds below in one selection plus an unknown `.txt`; each routed to its reader, unknown file named | Pass |
| GPX 1.1 | 25 min run with HR and cadence extensions, unicode name; year-end track with -06:00 offsets | Pass |
| TCX | 30 min ride with power, cadence, HR | Pass |
| FIT | Little and big endian, compressed timestamps, developer fields, timer pause; truncated, bad CRC, PNG renamed `.fit`, empty | Fixed (CRC warning now shown in the import log) |
| Folder import | Same reader as multi-file; picker attribute checked | Pass |
| Apple Health zip and xml | 40 days of HRV, resting HR, sleep, weight, BP, minute HR; workout route, clinical record, ECG inside the zip; zip bomb; zip without export.xml; non-zip; a CSV picked by mistake | Fixed (wrong file now says no Health records instead of "0 records read") |
| Strava bulk zip | activities.csv with FIT.gz, GPX, TCX.gz, a manual swim and a manual lift at 12:05 AM; gear names | Fixed (gear on a ride was created as a shoe) |
| Whoop CSVs | physiological_cycles, sleeps with a nap, workouts, journal_entries; random CSV; negative and zero values | Fixed (impossible values such as -50 bpm were imported) |
| Daily CSV | 40 days; semicolon with decimal commas; BOM and unicode header; negative, zero, formula and 30 February dates; leap day, DST days, year end | Fixed (2026-02-30 was read as 2 March) |
| Elevation points CSV | 60 points; out-of-range row; empty | Pass |
| Pulse backup JSON | Round trip; bad JSON; wrong format; hostile backup with wrong types and a switch set on | Fixed (a damaged section replaced lists with strings and stopped the restore half way) |
| FHIR R4 bundle | Conditions, medications, immunization, allergy, labs with and without range; `__proto__` keys; bidi characters; truncated JSON | Pass |
| SMART Health Card | `.smart-health-card` file and `shc:/` QR text | Fixed (every card failed to decompress) |
| ECG CSV | Apple format 512 Hz at 60 and 75 bpm; no samples; empty | Fixed (heart rate always showed "-") |
| Duplicates | Same activity start within 60 s; same record or ECG twice | Fixed (records and ECGs were stored twice) |
| Progress and Cancel | Cancel mid-import, then import again | Pass |

### Today, Log, Trends, Body

| Item | What was done | Result |
|---|---|---|
| Readiness count and four horizons | Example and imported data | Pass |
| Load gauge, suggested range, suggested session | Example (Maintain, reason quoted with numbers) | Pass |
| Metric cards, last activity card, notes with numbers used | Example and imports | Pass |
| Goals on Today | Week, month, year goals | Pass |
| Tonight: bedtime plan | Plan text against wake time | Pass |
| Bedtime calendar file (new download) and Copy as text | File downloaded and parsed: VCALENDAR, two VEVENTs, CRLF, lines of 75 octets or fewer | Pass |
| Day so far, daytime stress chart | Example minute HR | Pass |
| Calendar: circle size select, sport filter, dots; agenda on phones | All four metrics; dot opens the activity; at 400 px an agenda of 44 px rows | Fixed (day cells were about 30 px wide on a phone) |
| Activity list, Show more | 40 then 75 rows | Pass |
| Activity detail | Stats, route canvas, elevation, HR, pace or speed, power, cadence, zones, splits, laps, fastest splits, same route | Pass |
| Segments | Save from sliders, effort found | Pass |
| Name, gear, effort 1 to 10, Save | Saved and recomputed | Pass |
| Export GPX, Export GPX with ends hidden | Downloaded, parsed, 200 m removed at each end | Pass |
| Delete with Keep and Delete | Both paths | Pass |
| Strength: add set, save, records, trend, delete | kg and lb (lb converted to kg); empty, negative reps, negative load, no date | Fixed (negative load was saved as 0 kg; example mode said "Session saved" and dropped it) |
| Journal: save, association table | Empty question refused | Pass |
| Goals: add, remove; Gear: add, remove | Zero, negative, blank targets refused; negative start distance clamped; miles setting | Fixed (goals stayed in km and m with miles set) |
| Trends: load stats and chart, weekly bars, weeks, months | Example and imports | Pass |
| Fitness estimates, race predictions, best power, fastest times | Checked against formulas (below) | Pass |
| Year in review and year select | Example | Pass |
| Personal heatmap | Pixels painted | Pass |
| Possible workouts and Add as activity | Example minute HR | Fixed (example mode said it was added to your log) |
| Body: sleep ring, need equation, stages, chart, stats | Example and Whoop | Pass |
| Readiness: HRV chart and band, RHR chart, vitals table, 14-day history | Example; a vital with a constant baseline | Fixed (a constant baseline showed z = 0; it now says there is not enough variation to compare) |
| Body log: weight and BP | Inverted BP (80/120), weight 1000 kg | Fixed (inverted BP was saved) |
| Cycle: add start, phase text, overlay switch | Two starts | Pass |
| Records, labs, ECG view | See imports | Pass |
| Bluetooth cuff (0x2A35) | Mocked device: mmHg, pulse rate flag | Pass |
| Clinician report: Build, FHIR bundle, Copy | Text, bundle parsed (collection, Observations) | Pass |
| Clinician report: Print or save as PDF (new) | Print view rendered to PDF, text extracted | Pass |

### Record

| Item | What was done | Result |
|---|---|---|
| Sport choice | Run, Ride, Walk | Fixed (now remembered) |
| Start, Pause, Resume, Lap, hold-to-Finish | Mocked GPS: 10 min at 3 m/s with a 60 s stop; lap at 200 s | Fixed (the stretch after the last lap was dropped; the chip never showed auto-pause; ride speed ignored miles) |
| Auto-pause and track filter | Distance 1,791 m of 1,800 m, moving 602 s of 600 s | Pass |
| Heart rate strap (0x2A37) | Mocked: uint8 HR with RR intervals | Pass |
| Morning HRV reading and Save | Alternating 1000/1040 ms gives 40 ms (hand value) | Pass |

### Network switches (all off by default)

| Item | What was done | Result |
|---|---|---|
| Defaults | `APP.kv.net` empty, all four switches unchecked, no requests | Pass |
| Refusal path, switch off | `net`, `netScript`, `netImport` for every feature and an unknown one | Pass |
| Refusal path, switch on | http, other host, other port, credentials in URL, look-alike host | Fixed (message told you to turn on a switch that was already on) |
| Backup cannot turn a switch on | Hostile backup | Pass |
| Maps and Route finder | Inline turn-on (new); Overpass mocked with the offline fixture; Find route, Suggest loops, Export GPX, Clear | Fixed (Suggest loops always failed: it passed the node object as an index; point numbers were off by one) |
| Map library | Cannot load from this machine (no network); refusal message shown | Limit |
| On-device coach | Inline turn-on (new); no WebGPU in headless Chromium, button disabled with the reason | Limit |
| Coach with your own AI service | One OpenAI-compatible endpoint, mocked as a hosted https service with a key and as a server on localhost with none: base address and model id typed on the coach card or in Settings, request body and Authorization header checked, symptom notice shown, HTML and URLs removed from the reply; other paths, hosts and plain http refused; switch off refuses again | Pass |

### Settings, data, app

| Item | What was done | Result |
|---|---|---|
| Settings form (26 fields), Save and recompute | Out-of-range and blank values, rest above max | Fixed (out-of-range values were dropped silently and "Settings saved" shown) |
| Settings read from data (new) | Resting HR, FTP, weight, units filled with a reason and a Change button; a typed value survives later imports | Pass |
| Theme Auto, Light, Dark | Kept after reload; theme-color meta follows | Pass |
| Export JSON, Export zip, Copy CSVs | Files opened: JSON parsed, zip tested, CSV headers and values checked | Pass |
| Delete all with Keep and Delete | IndexedDB cleared, example back | Pass |
| A log with entries but no activities | Strength session only, then reload | Fixed (the example replaced the person's own entries after a reload) |
| Method and limits | Opened | Pass |
| PWA manifest, icons, service worker | Manifest and four icons served; shell cached under `/pulse/` | Pass |
| Offline | Reload offline from the service worker cache, with a query string too | Pass |
| `web/app.html` over `file://` | Every view, a FIT import; one request to Google Fonts, as the README says | Pass |
| 400 px, touch | No sideways scroll in any view; segmented buttons have 46 px hit areas | Pass |
| CLI `activity`, `load`, `readiness`, `example` | All commands and flags | Fixed (`--units mi` still printed km; a bad `--day` or `--end` crashed) |

Inventory: 71 rows, many holding several controls. 47 passed as they were, 22 had bugs that are now fixed, 2 have limits. 25 bugs were fixed in the first pass, and the follow-up added: goal units follow miles, vitals with a constant baseline say there is not enough variation to compare, and the phone calendar became an agenda with 44 px rows. Some rows had more than one bug; three of the first 25 were in the core shared by Python and JS (impossible dates, vitals with a zero MAD, zero HRV values). Every fix has a test: Python, parity vectors or the published-build browser test.

## Hand checks against published definitions

Independent arithmetic, not the parity vectors (`tests/test_reference_checks.py`):

| Quantity | Published definition | Check |
|---|---|---|
| Fitness (CTL) and fatigue (ATL) | Banister impulse-response, daily form `F(t) = F(t-1) + (L - F(t-1)) (1 - e^(-1/tau))`, tau 42 and 7 | Constant 100 for 61 days: closed form `100 (1 - e^(-61/42))` = 76.599; impulse of 300 decays as `k 300 e^(-t/tau)`. Exact to 1e-9. The common `1/tau` variant would give 77.006; Pulse states which it uses |
| Form (TSB) | Yesterday's fitness minus yesterday's fatigue | Exact |
| This week against usual | 7-day mean over the previous 21-day mean, uncoupled | 80/50 = 1.6 exact |
| Banister TRIMP | `min x HRr x 0.64 e^(1.92 HRr)` (male), `0.86 e^(1.67 HRr)` (female) | 60 min at HRr 0.5: 50.14 and 59.46 |
| Edwards | Minutes x zone weight 1 to 5 | 60 min at 63 % of max = 120 |
| rMSSD | Task Force 1996: root mean square of successive differences | Hand list exact; one artefact removes exactly its two differences |
| HRV baseline | Plews 2013: 7-day mean of ln rMSSD against the 60-day mean plus or minus 0.5 SD | Mean, sample SD, band and 7-day mean exact |
| Robust z | Median and 1.4826 x MAD; MAD of 0 falls back to 1.253314 x mean absolute deviation (Iglewicz and Hoaglin) | Exact |
| Keytel, Uth, Daniels VDOT, Riegel, Epley, Brzycki, Minetti | Published equations | Exact; VDOT for 5 km in 20:00 = 49.8 (Daniels table) |

## Decisions Pulse now makes for you

| Decision point | Before | After |
|---|---|---|
| Which of eight import fields fits my file | Pick the right one of eight pickers | One field reads every file and routes it; the eight pickers sit under "Choose the file type yourself" |
| Maximum heart rate | Default 190 until typed | Raised to the highest heart rate in your activities, reason shown, Change button |
| Resting heart rate | Default 50 until typed | Mean of your last 60 days of resting HR (7 readings or more) |
| FTP for power zones and power load | 0 = unknown, power load missing | 95 % of your best 20-minute power in 120 days (Allen and Coggan) |
| Threshold pace for pace zones | Blank = unknown | One-hour pace from your best run of 3 km or more, by Riegel |
| Body weight for energy | Default 70 kg | Latest weight from the body log or Health export |
| Wake time for the bedtime plan | Default 06:30 | Median wake time of your last 14 nights |
| Kilometres or miles | Kilometres for everyone | From the browser's region; Change in Settings |
| Typed values | n/a | Anything typed in Settings is yours and never replaced |
| Strength load unit | kg every time | Last unit used, else lb with miles and kg with km |
| Record sport | Run every time | Last sport used |
| Which AI service for the coach | Pick one of two named services | Any OpenAI-compatible service or a server on this computer: base address, model id, and a key only when it is not on this computer; typed on the coach card the first time you ask |
| Coach is off | "Open Settings" | Turn-on buttons on the card, beside the same host list |
| Route planner is off | "Turn them on in Settings" | One button turns on Maps and Route finder, hosts named beside it |
| Entry made over the example | "Example data is not saved" (or a false "saved") | The first entry starts your own log and is kept |
| Bedtime in a calendar | Copy text, paste into a calendar | Download a calendar file; copy stays as an option |
| Report on paper | Copy text into another app | Print or save as PDF from the report card |
| Strava gear kind | Every item a shoe | Bike for gear used on rides |
| Settings out of range | Ignored silently | Names each field and its range; nothing saved until fixed |

Left as questions only you can answer, asked where they are used: sex coefficients for load, age, threshold heart rates, sleep need, effort per activity, journal questions, goal targets, gear retirement distance, cycle dates, every network switch, and your API key.

## Known limits

- MapLibre and the on-device model download cannot be reached from the test machine; the map draw and WebGPU coach were not exercised (their gates, refusals and CSP were).
- Web Bluetooth and GPS were driven through mocks of the browser APIs with the documented packet layouts, not real devices.
- The service worker registers only over https; offline was tested by registering it from the test on localhost.
- `connect-src` is `'self' https: http://localhost:* http://127.0.0.1:*` so the coach can reach an AI service at any address you type; the gate, not the policy, picks the exact address (SECURITY.md).
