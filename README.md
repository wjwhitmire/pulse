# Pulse

A free, private training log and recovery tracker that runs entirely on your own device. Import your GPX, TCX and FIT files, your Apple Health export, or your whole Strava or Whoop history, and get activity analysis, training load, readiness inputs, sleep, strength, goals and gear, with every equation published.

Live tool: https://wjwhitmire.github.io/pulse/

- **No account, no upload, no tracking.** Data lives in your browser's IndexedDB on this device. With every network switch off (the default) the installed app makes no network requests beyond its own files, and two browser tests prove it. (The single-file version also loads its three fonts from Google Fonts.)
- **Training guidance, not medical advice.** Pulse compares you with your own last 60 days and describes trends. For symptoms such as chest pain, fainting or an unusual heartbeat, see a doctor.
- **Opens with example data:** a labeled, synthetic athlete on an invented course in the open ocean at 41.0 N, 40.0 W. No real person, no real place.

Field Tools No. 14. Not affiliated with, endorsed by, or connected to Strava, Whoop, Apple, Garmin or any other company. Their names appear only to say which export files Pulse reads.

## What it does

Five views: **Today**, **Log**, **Record**, **Trends**, **Body**, plus Settings (import, export, network switches).

| Area | Feature | Status |
|---|---|---|
| Imports | GPX 1.1, TCX, FIT (own binary decoder: definitions, compressed timestamps, developer fields skipped, both byte orders, chained files, CRC check), multi-file and folder import, dedupe by start time (within 60 s) | Done |
| | Apple Health `export.zip` or `export.xml`, streamed in chunks (never one big string): HRV (SDNN, beat-to-beat lists, rMSSD), resting HR, sleep stages and in-bed time, steps, active energy, all-day heart rate, breathing rate, blood oxygen, wrist temperature, weight, blood pressure, workout routes, clinical records, ECGs | Done |
| | Strava bulk export zip (activities.csv plus `.fit`, `.gpx`, `.tcx`, and their `.gz` versions; names, sports, gear; manual entries as summaries) | Done |
| | Whoop CSV export (physiological_cycles, sleeps, workouts, journal_entries); Whoop's own branded scores are not imported | Done |
| | Generic daily CSV (date, hrv_ms, resting_hr, sleep_hours), Pulse JSON backup, elevation points CSV | Done |
| | One import field for all of the above plus FHIR records and ECG CSVs: Pulse reads each file and sends it to the right reader (the typed pickers stay under "Choose the file type yourself") | Done |
| | Settings read from your data, each with its reason shown in Settings and a Change button: maximum heart rate (highest in your activities, only ever raised), resting heart rate (mean of the last 60 days, once there are 7 readings), FTP (95 % of the best 20-minute power in 120 days), threshold pace (the speed for one hour from your best run of 3 km or more, by Riegel), units (from the browser's region). A value you type is yours and is never replaced | Done |
| Activity | Route on a plain canvas (equal-aspect local projection, no tiles), drawn in heart rate zone colors | Done |
| | Elevation (recorded and corrected side by side, plus a third value from your own elevation file), heart rate with zone bands, pace or speed, power, cadence charts | Done |
| | Splits per km or mile, device laps re-measured, moving time with auto-pause hysteresis and device timer pauses, max speed with GPS spikes excluded | Done |
| | Time in heart rate zones (reserve or % of max), pace zones (from threshold pace), power levels (from FTP) | Done |
| | Activity load: Banister exponential (per sample), Edwards zones, Lucia thresholds, session effort (1 to 10) x minutes without HR, power load from FTP | Done |
| | Fastest splits at 400 m, 1 km, 1 mile, 5 km, 10 km, half marathon (sliding window, interpolated ends, elapsed time) | Done |
| | Grade-adjusted pace (Minetti 2002), weighted power (30 s rolling fourth-power mean) and best power by duration | Done |
| | Energy: Keytel 2005 from heart rate, else METs (Compendium of Physical Activities) | Done |
| | Same-route history, personal segments (start and finish gates plus a corridor; your history only), GPX export (with an option that hides the first and last 200 m) | Done |
| Trends | Long-term and short-term load, form, daily load; weekly load against your usual band; this week against your usual (uncoupled, descriptive) | Done |
| | Weekly and monthly totals, year in review, personal heatmap (histogram equalised) | Done |
| | Fitness estimates: VO2max from heart rate (Uth), VDOT from runs (Daniels and Gilbert), race predictions (Riegel), fitness age (FRIEND registry norms) | Done |
| | Workouts found in all-day heart rate (you confirm before anything is saved) | Done |
| Body | Readiness inputs as four horizons (HRV, resting HR, sleep against need, breathing rate), each against its own 60-day baseline, with a count of inputs inside your usual range; no composite score | Done |
| | Sleep against need as a visible equation (baseline + debt share + optional load term - naps), imported stages, efficiency, consistency, bedtime plan and a calendar file (.ics) to download or copy | Done |
| | Vitals against your usual (robust z), daytime stress (descriptive, 0 to 3), steps and active energy, day load index | Done |
| | Body log (weight trend, blood pressure), cycle tracking with phase shading on charts (calendar estimates) | Done |
| | Health records: FHIR R4 and SMART Health Cards (conditions, medications, immunizations, allergies, labs against the lab's own range), ECG viewer on 25 mm/s paper with beat detection, Bluetooth blood pressure cuff, clinician report as text, FHIR bundle and a print view that saves as PDF | Done |
| Log | Calendar, activity list, strength log (sets x reps x load, volume, estimated one-rep max by Epley and Brzycki, records, trends), journal with yes/no questions and next-day associations (permutation test), gear with retire alerts, goals and personal challenges (week, month, year; distance, time, climb, sessions) | Done |
| Today | Readiness count, load gauge with a suggested range, suggested session (Recover, Maintain, Build, with the reason), notes from your own numbers (each shows the numbers it used), goals, tonight's bedtime | Done |
| Record | GPS recording with auto-pause, laps, live pace, heart rate strap over Web Bluetooth, morning HRV reading from beat-to-beat intervals | Done |
| Optional network features | Map under routes and route planner with loops (OpenFreeMap tiles, Overpass paths, A* on this device); coach on this device (WebLLM) or with your own AI service (any OpenAI-compatible API, hosted or on this computer) | Done, off by default |
| Data | Export everything as JSON, or as a zip with CSVs, GPX files and your original activity files; restore from a backup; delete everything | Done |
| App | Installable PWA on GitHub Pages (manifest, icons, a service worker that caches the app shell only) | Done |

### Not included, and why

| Feature | Why |
|---|---|
| Social feed, kudos, comments, follows, clubs | Need other people's data on a server. Planned for Pulse Hub (below). |
| Hub challenges, segment leaderboards, global heatmap, live tracking | Same: need a shared server. Personal segments, the personal heatmap and personal challenges are included. |
| AI chat with a company's hosted coach | Pulse offers an on-device model or your own AI service instead; there is no Pulse server. |
| Clinician access, telehealth | Pulse cannot supply licensed clinicians. It builds a report for your own doctor. |
| Medical records from a provider's servers, lab ordering | Pulse imports files you download; it does not connect to providers or order tests. |
| Hardware-only features (wrist ECG capture, cuff hardware, haptic alarm) | A web page has no such hardware. Pulse reads ECG files, connects to Bluetooth cuffs and gives the bedtime as a calendar event. |
| Sleep staging from raw motion | Exports carry no raw motion data. Pulse shows the stages your device scored. |
| A map-tile basemap with the network off | Tiles come from a server; with Maps off the route is drawn on a plain background. |

### Planned: Pulse Hub (self-hosted, invite-only)

Social feed, kudos, clubs, hub challenges, segment leaderboards, a hub-wide heatmap and live tracking will run on Pulse Hub: a small open-source server (Python standard library and SQLite) that a club, a family or one person hosts on their own machine. There is no central Pulse server and no account with us. Privacy zones are cut on the device before anything is shared and checked again by the hub; heat tiles need at least three distinct members. The network gate in the app is built so a hub switch can be added later.

## Quick start

```
pip install -e .[dev]
pytest -q
python tests/make_vectors.py && python web/build_pages.py
node web/parity.test.mjs && node web/net.test.mjs && node web/lib/test/run.mjs
```

Command line (Python 3.10 or newer, no runtime dependencies):

```
pulse activity run.fit ride.gpx --units mi
pulse load *.fit                      # date,load,fitness,fatigue,form as CSV
pulse readiness export.zip            # or export.xml or a daily CSV
pulse example --end 2026-10-21
```

Python:

```python
from pulse import decode_fit, parse_gpx, analyze, load_series, readiness
act = decode_fit(open("run.fit", "rb").read())
r = analyze(act, {"max_hr": 188, "rest_hr": 48})
r["moving"], r["load"], r["fastest"][1]
```

### Getting your files

- Apple Health: Health app, your picture, Export All Health Data. Import the zip as is.
- Strava: Settings, My Account, Download or Delete Your Account, Request your archive. Import the zip as is.
- Whoop: app settings, Data Export. Select the four CSV files together.
- Garmin and most watches: the activity's original FIT file, or a GPX or TCX export.

## Method

Every number is computed on your device by the JS core in `web/app.html`, which mirrors the Python package `src/pulse` line for line; `tests/vectors.json` (238 cases, over 10,000 checks) holds them to 1e-9.

**Distance.** Haversine on a sphere of radius 6,371,008.8 m: `d = 2R asin(sqrt(sin^2(dphi/2) + cos phi1 cos phi2 sin^2(dlambda/2)))`. Without positions, the device distance channel (forward filled, never decreasing).

**Moving time.** Segment speed `v = dd/dt`. Running is stopped below 0.5 m/s and moving again at 0.8 m/s (riding 1.0 and 1.5 m/s); between the two the state holds (hysteresis). Stops shorter than 5 s count as moving. FIT timer stop and start events are honoured. All values are in Settings.

**Elevation.** Recorded gain is the sum of every rise. Corrected gain applies a centred 5-sample moving average and then counts only legs between turning points that reverse by 3 m or more (a zigzag filter). Pulse never replaces your device's elevation; with an elevation points file it adds a third value (inverse distance squared mean of the 4 nearest points within 150 m).

**Splits.** Boundaries every 1,000 m or 1,609.344 m, times interpolated linearly at each boundary; a final partial split if it is 10 m or longer. Moving time and average HR within a split are apportioned by distance overlap.

**Fastest splits by distance.** For each target D, the shortest elapsed time over any stretch covering D: windows that start on a sample with an interpolated end, and windows that end on a sample with an interpolated start (exact for a piecewise-linear track). Windows with a segment faster than 12 m/s (runs) or 30 m/s (rides) are skipped. Tested against brute force.

**Heart rate zones.** Reserve (Karvonen): `rest + f x (max - rest)`, f = 0.5, 0.6, 0.7, 0.8, 0.9. Or percent of maximum. Sample and hold; gaps over 60 s are not counted.

**Activity load.**
- Banister exponential, per sample: `sum dt/60 x HRr x a x e^(b HRr)`, `HRr = (HR - rest)/(max - rest)` clamped to 0..1, a = 0.64 and b = 1.92 (male coefficients), a = 0.86 and b = 1.67 (female). Banister EW, Modeling elite athletic performance, in Physiological Testing of Elite Athletes, 1991; Morton RH, Fitz-Clarke JR, Banister EW, J Appl Physiol 1990;69:1171-1177. The coefficients were checked against reproductions of the primary papers; the primary texts were not available to us.
- Edwards: minutes in 50-60, 60-70, 70-80, 80-90, 90-100 % of max HR x 1 to 5 (Edwards 1993).
- Lucia: minutes below VT1 x 1, VT1 to VT2 x 2, above VT2 x 3 (Lucia et al. 2003, Med Sci Sports Exerc 35(5):872-878).
- Session effort: effort (1 to 10) x minutes (Foster's session RPE; Haddad et al. 2017, Front Neurosci 11:612).
- Power load: `hours x (weighted power / FTP)^2 x 100`. Summary-only imports with only an average HR use Banister on the average, labelled approximate (it understates intervals).

**Long-term load, short-term load, form.** Daily load L is the sum of the day's activity loads. `F(t) = F(t-1) + (L(t) - F(t-1)) x (1 - e^(-1/tau))` with tau = 42 days (fitness) and 7 days (fatigue), both editable. Form on a day = fitness minus fatigue at the end of the previous day. This is Banister's impulse-response recursion `g(t) = g(t-1) e^(-1/tau) + L(t)` scaled by `(1 - e^(-1/tau))`, so the value reads in daily-load units (checked numerically in review). Banister EW, Calvert TW, Savage MV, Bach T 1975, Aust J Sports Med 7:57-61; the scaled form is the one common coaching software uses. Pulse does not claim to match any other service.

**This week against your usual.** Mean daily load of the last 7 days over the mean of the 21 days before them (uncoupled). Descriptive only, never colored as danger: Impellizzeri FM et al. 2020, IJSPP 15(6):907-913; Windt J, Gabbett TJ 2019, Br J Sports Med 53:988. The weekly band is the previous 4 weeks' mean plus or minus 1 SD.

**Readiness inputs.** Each against the 60 days before today.
- HRV: 7-day mean of ln(HRV), shown once there are 3 readings in the week and 14 in the baseline, against the baseline mean plus or minus 0.5 SD of daily ln values (smallest worthwhile change; Plews DJ et al. 2013, Sports Med 43:773-781; Plews et al. 2014 IJSPP 9(5):784-791 for 3 readings a week; Kiviniemi AM et al. 2007, Eur J Appl Physiol 101:743-751). rMSSD comes only from beat-to-beat data: FIT hrv messages, Apple's per-beat lists inside HRV records (intervals from the beat clock times), Apple's rMSSD type, Whoop, or a CSV. Beats outside 300 to 2000 ms or more than 25 % from the median are dropped; differences only between neighbouring kept beats; at least 20 pairs. Apple's SDNN is used only when there is no rMSSD baseline, with its own baseline, never mixed.
- Resting HR: mean of the last 3 days above the baseline mean + max(SD, 1 bpm) is above usual.
- Sleep: last night's main sleep against need = baseline (8 h) + 0.1 x the last 7 nights' debt + an optional load term (off by default; there is no published equation, so it is labelled a heuristic) - yesterday's naps. Below 85 % of need is short. Apple sleep is the union of asleep intervals across sources (so two devices are not double counted), split into blocks at gaps over 60 min; a block under 3 h starting between 09:00 and 20:00 is a nap.
- Breathing rate, blood oxygen, wrist temperature, steps: against the 60-day median with robust SD = 1.4826 x median absolute deviation; beyond 2 is outside usual. When more than half the baseline equals the median (MAD = 0, common for whole-number blood oxygen) the scale is 1.253314 x the mean absolute deviation instead (Iglewicz and Hoaglin's modified z-score), so a real drop is still flagged.
- The Today count is the number of inputs inside their usual range. There is no combined score. The suggestion uses three states internally: none off baseline, one, two or more.

**Suggested session.** Recover if two or more inputs are off baseline or form is below -30 % of fitness; Maintain if one is off or form is below -10 %; otherwise Build. Sport from your most frequent sport in the last 28 days. The load gauge's suggested range is 0 to 0.5, 0.75 to 1.25, or 1.25 to 2 x fitness. A heuristic, not coaching.

**Energy.** Keytel LR et al. 2005, J Sports Sci 23(3):289-297, without VO2max: men `(-55.0969 + 0.6309 HR + 0.1988 W + 0.2017 A) / 4.184` kcal/min, women `(-20.4022 + 0.4472 HR - 0.1263 W + 0.074 A) / 4.184`, used when HR covers half the moving time. Otherwise MET x kg x hours with running METs interpolated by speed and cycling METs by speed band from the Compendium of Physical Activities (Ainsworth BE et al. 2011).

**Fitness estimates.** VO2max = 15.3 x HRmax / HRrest (Uth N et al. 2004, Eur J Appl Physiol 91:111-115). VDOT (Daniels J, Gilbert J, Oxygen Power, 1979): `VO2 = -4.60 + 0.182258 v + 0.000104 v^2` (v in m/min), `%max = 0.8 + 0.1894393 e^(-0.012778 t) + 0.2989558 e^(-0.1932605 t)` (t in min), VDOT = VO2 / %max, from runs of a mile or more in the last 120 days. Race times: `T2 = T1 x (D2/D1)^1.06` (Riegel PS 1981, American Scientist 69:285-290). Fitness age: the age at which the treadmill 50th percentile of the FRIEND registry (Kaminsky LA et al. 2022, Mayo Clin Proc 97(2):285-293; men 46.5, 39.7, 35.3, 29.2, 24.6, 20.6, 17.6 and women 36.6, 28.3, 25.7, 22.9, 19.6, 17.2, 15.4 ml/kg/min for ages 20-29 to 80-89, taken from a secondary reproduction) equals your estimate, linear between decade midpoints, clamped to 20 to 90.

**Grade-adjusted pace.** `Cr(i) = 155.4 i^5 - 30.4 i^4 - 43.3 i^3 + 46.3 i^2 + 19.5 i + 3.6` J/kg/m (Minetti AE et al. 2002, J Appl Physiol 93:1039-1046), grade over 20 m chunks clamped to plus or minus 0.45; equivalent flat distance = sum of moving distance x Cr(i)/Cr(0).

**Power.** Weighted power: fourth root of the mean of the fourth power of 30-second rolling means on a 1 s sample-and-hold grid (after Allen H, Coggan A, Training and Racing with a Power Meter). Power levels at 55, 75, 90, 105, 120 and 150 % of FTP. Pace zones (Pulse's own table) at 78, 88, 95, 100 and 104 % of threshold speed.

**Strength.** Epley: `w x (1 + r/30)` (a single is its own 1RM); Brzycki: `w x 36/(37 - r)`. Volume load = sets x reps x load.

**Journal.** Next-day ln(HRV) on yes days against no days within 90 days, with at least 5 of each; difference, Cohen's d with pooled SD, and a two-sided permutation test (2,000 shuffles, fixed seed). An association, not a cause.

**Daytime stress, workout detection, day load index.** Stress per hour (10 minutes of data needed): `e = (mean HR - resting baseline) / (max - baseline)`, levels 0 to 3 at 0.10, 0.20, 0.30, plus one when a daytime SDNN reading is more than 1 SD below its baseline. Workouts: blocks of at least 10 minutes at or above rest + 0.30 x reserve, gaps up to 3 minutes joined, not covered by a saved activity. Day load index: `10 x ln(1 + T/25) / ln(1 + 1000/25)`, capped at 10, where T is Banister load over every minute of the day.

**Sleep measures.** Efficiency = asleep / in bed. Consistency = `100 x max(0, 1 - (SD bedtime + SD wake time) / 120 min)` over the last 4 nights. Bedtime = wake time - need - time to fall asleep (15 min default).

**Routes and segments.** Same route: start and end within 200 m, distance within 10 %, mean offset of 50 points spaced by distance under 100 m. Segments (an independent design, not tile overlap): gates 50 m wide across the track at each end; an effort is a start-gate crossing in the right direction followed by the next end-gate crossing, with 90 % of the points between within 25 m of the reference line; times interpolated at the crossings. Heatmap: every track drawn additively into a count image, then histogram equalised.

**Cycle phases.** Average of the last six cycle lengths between 21 and 45 days (else 28); ovulation estimated 14 days before the next expected start; menstrual days 1 to 5. A calendar estimate.

## Network features

All off by default. Each request goes through one gate, `net(feature, url, opts)` (and `netScript`, `netStyle`, `netImport` for libraries), which refuses unless that feature's switch is on, the URL is https, and its host is on that feature's list.

| Switch | Hosts | What is sent |
|---|---|---|
| Maps | tiles.openfreemap.org, cdnjs.cloudflare.com (MapLibre GL JS 4.7.1, pinned with Subresource Integrity) | The map area you look at, which can show where you live and train |
| Route finder | overpass-api.de | The box around the points you place, which shows where you plan |
| On-device coach | cdn.jsdelivr.net (WebLLM 0.2.84, pinned with an import-map integrity hash), huggingface.co and its download hosts, raw.githubusercontent.com | Nothing about you; downloads a model once |
| Coach with your own AI service | The one chat completions address you set: any service with an OpenAI-compatible API over https, or a server on this computer (http://localhost or http://127.0.0.1, no key needed). You type the base address, the model id and your key (kept in memory only) | Your question and the numbers the coach shows you |
| Bluetooth sensors, GPS recording | none | Nothing; sensors talk to the device |

Every host you contact sees your IP address. A restored backup never turns a switch on. A switch changes only when you click it: in Settings, or on the button the planner and the coach show beside the same host list when their switch is off. The AI service's base address and model id can also be typed on the coach card the first time you ask.

On GitHub Pages a Content-Security-Policy is the second wall behind the gate: inline scripts run only by hash, scripts load only from the two pinned library paths, map tiles only from tiles.openfreemap.org, and `connect-src` is `'self' https: http://localhost:* http://127.0.0.1:*`. An AI service address you type cannot be named in a fixed policy, so the policy fences connections to https and this computer and the gate picks the exact address (see SECURITY.md).

Tests: `web/net.test.mjs` checks that no network API appears outside the gate; the parity test checks the gate's refusal paths; `tests/test_no_network.py` opens the built page in headless Chromium, visits every view, imports GPX, FIT, an Apple Health zip, a daily CSV, a Strava zip and Whoop CSVs, and asserts zero requests; a second browser test serves the Pages build over http with its real CSP and checks the same, plus no CSP violations, the backup rule and export zip names.

## Limits

- Activity files up to 50 MB each; Health exports up to 200 MB (streamed); up to 5,000 activities; all-day heart rate keeps the last 120 days of the export; CSVs up to 50,000 rows.
- A file inside a zip may inflate to its declared size and at most 100 times its compressed size (zip bomb guard); a FIT file may hold up to 3 million messages; an Apple Health Record tag longer than 1 MB is skipped as malformed.
- A daily CSV separated by semicolons may use decimal commas (7,5).
- With 5,000 activities the Trends view takes about 0.4 s to draw (measured in headless Chromium); the other views under 50 ms.
- A time without a zone in a GPX or TCX file is read as UTC. GPX and TCX must be UTF-8. Any DOCTYPE or ENTITY declaration is refused (no entity is ever expanded). Apple's export carries a DTD; Pulse's scanner never processes it.
- A FIT file with several sessions is one activity with the first session's sport. 64-bit FIT fields are skipped.
- Haversine on a sphere differs from the ellipsoid by up to about 0.5 %. GPS noise lengthens tracks a little; Pulse does not snap to roads.
- With fewer than 14 baseline days an input has no usual range yet. Apple's HRV readings are short daytime and night recordings, noisier than a morning chest-strap reading.
- Strava's activities.csv: when there is one Distance column it is read as kilometres; manual entries have no samples.
- Whoop's own scores are not imported; Pulse computes its own values from the measurements Whoop exports. Whoop workouts and Strava manual entries are summaries without samples.
- Fitness age, VO2max, race times, energy, cycle phases, daytime stress and workout detection are estimates.
- The ECG view draws a recording and detects beats; it is not a diagnosis and is not validated on clinical databases.

## Validation

- Python: 154 tests (`pytest -q`), including FIT files written by a test encoder (compressed timestamps across rollovers, multiple definitions, big-endian, developer fields, 12-byte headers, bad CRC, truncation, chained files, hrv messages), GPX and TCX including malformed and DOCTYPE files, haversine, moving time, elevation, splits, fastest splits against brute force and a dense resample, TRIMP hand cases, exponentially weighted load, readiness rules on constructed series, a generated Apple Health zip (deflate, stored and ZIP64), the CLI, the example athlete, and every new module.
- Parity: `node web/parity.test.mjs` replays 238 Python cases (over 10,000 values) against the JS core within 1e-9, plus the network gate and CSV formula guard.
- Libraries in `web/lib` (recording, Bluetooth decoders, segments, privacy zones, routing, FHIR, ECG, report, coach, calendar): `node web/lib/test/run.mjs` (149 tests).
- Browser: `tests/test_no_network.py` (zero requests, imports end to end) and `tests/test_published_build.py` (the Pages build with the release fill, served under `/pulse/` with its CSP: every import through the one import field, settings read from data, records, report as text, FHIR and PDF, calendar file, exports, recording with a mocked GPS and strap, every network switch with mocked hosts, offline start, phone width). See TESTING.md.
- `tests/test_reference_checks.py`: load, form, rMSSD and the HRV baseline checked against their published definitions with independent arithmetic.

## Design notes

- Pulse stores your own data in your browser's IndexedDB on your device, with full export and delete-all.
- `web/app.html` is assembled by `web/build_pages.py` from `web/src/` (core, libraries, UI parts); CI checks the built files are current.
- File limits are 50 MB per activity file and 200 MB per Health export.
- Export uses the browser's save dialog where available, otherwise a standard download; where both are blocked, small exports are shown as text to copy.
- The GitHub Pages build self-hosts its three fonts (OFL licences in `docs/fonts/`) so the installed app works offline.
- The Pages Content-Security-Policy fences connections to https and this computer; the gate keeps every request off until a switch is on and then allows only that switch's hosts or configured address.

## Build on it

Pulse is a free web app on purpose. Anyone is welcome to take it further under the MIT licence, for example:

- iPhone and Android apps that wrap the web app, adding background GPS recording, automatic Apple Health and Health Connect sync, and Bluetooth on iPhone.
- An Apple Watch or Wear OS companion to start, pause and lap workouts from the wrist.
- Pulse Hub, the planned self-hosted social server.

The core math lives in `src/pulse` (Python) and the JS core in `web/src`, with parity tests that keep the two in step, so a native shell can reuse it as is.

## Licence

MIT, copyright 2026 Will Whitmire. Fonts: Bricolage Grotesque, Onest and Geist Mono under the SIL Open Font License.
