# Method sources

Why each Pulse method is what it is, and where it comes from. Written from published, peer-reviewed or openly documented sources. Pulse's methods are its own: no other app was decompiled, no private API was called, and no proprietary model or data set was used. Direct quotes are kept under 15 words. Bracketed tags point to the reference list at the end.

Naming rule for the app: describe features in generic words ("training load", "long-term load", "short-term load", "fastest splits", "readiness inputs", "sleep vs need"), never with another company's feature names or branded scores.

---

## 1. The open science behind each method

### 1.1 Banister impulse-response (fitness and fatigue)

- Model: predicted performance on day n equals a baseline, plus a gain k1 times the sum of past daily loads each decayed by exp(-(n-i)/tau1), minus a gain k2 times the same sum decayed by exp(-(n-i)/tau2) [O1]. Original: Banister, Calvert, Savage, Bach 1975, Aust J Sports Med 7:57-61, as cited in [O1].
- Time constants are individual. In Busso's six untrained men, fitness tau was about 31 to 41 days and fatigue tau about 9 to 17 days [O1].
- Common coaching practice uses an exponentially weighted average of daily load with time constants of 42 days (long-term) and 7 days (short-term), with balance as yesterday's long-term minus yesterday's short-term value.
- Recommendation: implement daily EWMA with tau 42 and 7 as defaults, user-editable, and optionally fit k and tau to the user's own race or test results later.

### 1.2 Banister exponential TRIMP

- TRIMP = minutes x HRr x 0.64 x e^(1.92 x HRr) for men, where HRr = (HRexercise - HRrest)/(HRmax - HRrest) [O3][O4b]. Women use 0.86 x e^(1.67 x HRr) [O3].
- Origin is Banister's work and Morton, Fitz-Clarke and Banister 1990, "Modeling human performance in running", J Appl Physiol [O2]. The coefficients match every secondary reproduction we found [O3][O4b]; the primary texts were not available to us.
- Compute it second-by-second (sum over samples) rather than from average HR, so intervals are not understated.

### 1.3 Edwards zone TRIMP

- Minutes in 50-60, 60-70, 70-80, 80-90 and 90-100% of HRmax multiplied by 1, 2, 3, 4, 5 and summed [O4].
- Not validated against a physiological response, but widely used and simple to explain [O4].

### 1.4 Lucia TRIMP

- Three zones from ventilatory thresholds: below VT1 weight 1, between VT1 and VT2 weight 2, above VT2 weight 3 [O4]. Original: Lucia, Hoyos, Santalla, Earnest, Chicharro 2003, Med Sci Sports Exerc 35(5):872-878 [O5].
- Use only when the user enters lab or field thresholds.

### 1.5 Session RPE (fallback when there is no HR)

- Foster's method: CR-10 rating of the whole session x duration in minutes, in arbitrary units [O4].
- Correlations with HR methods across studies: Edwards TRIMP r about 0.54 to 0.98, Banister TRIMP about 0.50 to 0.90, Lucia TRIMP about 0.59 to 0.94 depending on sport [O4].

### 1.6 rMSSD vs SDNN

- rMSSD is the root mean square of successive RR differences and is the main time-domain index of vagal (parasympathetic) activity [O8].
- SDNN is the standard deviation of normal RR intervals and reflects both branches, though in short resting recordings it is driven mostly by respiratory sinus arrhythmia [O8].
- Short-term norms (about 5 min, 21,438 adults): SDNN mean 50 ms, rMSSD mean 42 ms [O8].
- rMSSD remains valid from very short recordings (10 to 60 s), while SDNN needs longer windows and short SDNN tracks 5-minute SDNN poorly [O8].
- They are not interchangeable numbers. Apple Health historically exposes SDNN [A1], and Apple's docs now list an rMSSD type available from iOS 27 [A2]. Beat-by-beat timestamps are available from HKHeartbeatSeriesSample since iOS 13 [A3], and FIT files can carry an hrv message with RR intervals [A4].
- Recommendation: compute rMSSD ourselves from RR data where available; store Apple SDNN as a separate series and never mix it into an rMSSD baseline.

### 1.7 HRV-guided training (Kiviniemi, Plews)

- Kiviniemi et al. 2007 (Eur J Appl Physiol 101(6):743-751): 26 men, 4 weeks. Hard sessions when morning HRV was stable or rising, easy or rest when it fell below the 10-day mean minus one SD or declined two days running. The HRV-guided group improved max running speed more than the fixed-plan group (P=0.048) and raised VO2peak from 56 to 60 ml/kg/min [O9].
- Plews thesis 2014: use ln rMSSD, a 7-day rolling average beats single-day values (r 0.72 with aerobic speed change vs trivial for single days), interpret changes against the individual smallest worthwhile change, and watch the CV of the rolling mean [O10].
- Plews et al. 2014 (IJSPP 9(5):784-791): at least 3 valid days per week are needed; benefits plateau at 3 to 4 days [O11].
- Recommendation: readiness band = 7-day mean ln rMSSD vs a 30 to 60 day baseline with a normal range of baseline mean +/- 0.5 SD (the smallest worthwhile change convention used by Plews et al.). Require 3+ valid nights in the week before showing a trend.

### 1.8 Grade adjusted pace (open replacement)

- Minetti et al. 2002 (J Appl Physiol 93:1039-1046) fit the energy cost of running vs gradient i as Cr(i) = 155.4i^5 - 30.4i^4 - 43.3i^3 + 46.3i^2 + 19.5i + 3.6 J/kg/m, valid from -45% to +45% [O17]. Signs checked against the original PDF in review.
- GAP multiplier = Cr(i)/Cr(0), from published physiology rather than from aggregate data of other athletes.

### 1.9 Sleep need and sleep debt

- AASM and SRS consensus: adults should regularly sleep 7 or more hours; more than 9 may suit young adults, people recovering from sleep debt, or illness; needs vary by person [O14].
- Van Dongen et al. 2003 (Sleep 26(2)): 6 h or less per night for 14 days produced deficits comparable to up to two nights of total deprivation, while people's own sleepiness ratings plateaued, so they underrated their impairment [O15].
- Mah et al. 2011 (Sleep 34(7):943-950): basketball players extending to at least 10 h in bed (about 110 min more sleep) improved sprint time from 16.2 to 15.5 s and free throws from 7.9 to 8.8 of 10 [O16].
- Recommendation: sleep need = user baseline (default 8 h, editable, or learned from free-schedule nights) + a fraction of rolling sleep debt + an optional, clearly labeled load adjustment - nap time. Show each term. There is no published equation for "extra sleep per unit of training load", so keep that term small, optional and transparent.

### 1.10 Sleep staging on device

- An open, ODC-By licensed dataset of Apple Watch HR and motion with PSG labels for 31 people exists (Walch et al. 2019, Sleep) [O18]. Open implementations of the Cole-Kripke actigraphy sleep/wake algorithm also exist [O19].
- Given that every consumer device scores only moderate four-stage agreement [V1], the tool should import device-scored stages when present (Apple Health sleep analysis, FIT sleep data) and only compute sleep vs wake itself.

### 1.11 ACWR controversy

- Impellizzeri et al. 2020 (IJSPP 15(6):907-913) argue ACWR is unsuitable as a causal injury predictor, that its statistical properties add noise and artifacts, and that no evidence supports using it in load-management systems to reduce injury [O12].
- Windt and Gabbett (BJSM 53:988) note the classic coupled ratio shares the latest week in numerator and denominator, creating a spurious correlation of about 0.5 (Lolli et al. found r 0.52), and suggest uncoupled ratios as the minimum fix [O13].
- Recommendation: do not show an injury-risk light. If a ratio is shown, label it descriptive ("this week vs your usual"), uncoupled, and do not color it as danger.

### 1.12 Power metrics

- Weighted power follows the published description in Allen and Coggan, Training and Racing with a Power Meter: a 30 s rolling mean, raised to the fourth power, averaged, fourth root. Pulse uses generic names ("weighted power", "power load") in the UI.
- Mean-maximal power curve (best average power for each duration) is a sliding window over the power stream and needs no proprietary model.

### 1.13 Segment matching (independent design)

- Pulse's own design: user-defined start and end gates as short line segments; detect ordered crossings by line intersection on the GPS polyline; confirm the path between crossings stays within a corridor (for example 25 m) of the reference polyline for at least a set share of its length using point-to-polyline distance; time = interpolated crossing timestamps (elapsed).

---

---

## 2. Method decisions (summary)

1. Default per-activity load: Banister exponential TRIMP computed per sample, with Edwards as a simple mode and session RPE as fallback [O3][O4].
2. Long-term and short-term load: daily EWMA, 42 and 7 days default, editable; no claim that these match any other service [O1].
3. Drop injury-risk ACWR styling; at most an uncoupled, descriptive "this week vs usual" ratio [O12][O13].
4. HRV: ln rMSSD from RR data only; never mix with Apple SDNN; 7-day rolling mean vs personal baseline with smallest-worthwhile-change bands; require 3+ valid nights per week [O8][O10][O11][A1][A2][A3].
5. Readiness: transparent multi-input panel instead of a single branded score; optional composite with visible weights.
6. Sleep need: editable baseline plus debt minus naps, with any load-based term explicitly labeled as a heuristic [O14][O15].
7. Sleep stages: import from device; compute only sleep vs wake ourselves [V1][O18].
8. GAP: Minetti polynomial, not aggregate-data modeling [O17].
9. Elevation: barometric first, show raw vs corrected; DEM only as an optional offline download
10. Segments: independent gate-and-corridor design, personal history only.
11. Verification status (review, 2026-10-22): Minetti polynomial checked against the primary PDF; TRIMP coefficients, FRIEND norms and the Plews band checked against secondary reproductions; every equation recomputed independently and compared with the Python and JS code.

---

---

## References

- [V1] Miller DJ, Sargent C, Roach GD. A validation of six wearable devices for estimating sleep, heart rate and heart rate variability in healthy adults. Sensors 2022;22(16):6317. https://doi.org/10.3390/s22166317 (PDF: https://mdpi-res.com/d_attachment/sensors/sensors-22-06317/article_deploy/sensors-22-06317.pdf)
- [O1] Busso T. Variable dose-response relationship between exercise training and performance. Med Sci Sports Exerc 2003;35(7):1188-1195 (restates Banister 1975). https://www.paulogentil.com/pdf/Variable%20dose-response%20relationship%20between%20exercise%20training%20and%20performance.pdf
- [O2] Morton RH, Fitz-Clarke JR, Banister EW. Modeling human performance in running. J Appl Physiol 1990. https://pubmed.ncbi.nlm.nih.gov/2246166/
- [O3] KS Endurance Training, Training load: an individualized approach (TRIMP coefficients, secondary). https://ksendurancetrainingenglish.substack.com/p/training-load-an-individualized-approach
- [O4b] intervals.icu forum, TRIMP formula thread (secondary). https://forum.intervals.icu/t/trimp-formula-required/68634
- [O4] Haddad M, Stylianides G, Djaoui L, Dellal A, Chamari K. Session-RPE method for training load monitoring. Front Neurosci 2017;11:612. https://www.frontiersin.org/articles/10.3389/fnins.2017.00612/full
- [O5] Lucia A, Hoyos J, Santalla A, Earnest C, Chicharro JL. Tour de France versus Vuelta a Espana: which is harder? Med Sci Sports Exerc 2003;35(5):872-878. https://investiga.upo.es/documentos/5df8a7902999525886b6fe3b?lang=en
- [O8] Shaffer F, Ginsberg JP. An overview of heart rate variability metrics and norms. Front Public Health 2017;5:258. https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2017.00258
- [O9] Kiviniemi AM, et al. Endurance training guided individually by daily heart rate variability measurements. Eur J Appl Physiol 2007;101(6):743-751. https://lida.sport-iat.de/ta/Record/4021912
- [O10] Plews D. The practical application of heart rate variability: monitoring training adaptation in world class athletes. PhD thesis, AUT, 2014. https://openrepository.aut.ac.nz/items/d7b41d29-e92e-4acf-90ea-ed68d84d6c73
- [O11] Plews DJ, et al. Monitoring training with heart-rate variability: how much compliance is needed for valid assessment? IJSPP 2014;9(5):784-791. DOI 10.1123/IJSPP.2013-0455. https://lida.sport-iat.de/ta/Record/4033163?lng=en
- [O12] Impellizzeri FM, Tenan MS, Kempton T, Novak A, Coutts AJ. Acute:chronic workload ratio: conceptual issues and fundamental pitfalls. IJSPP 2020;15(6):907-913. https://opus.lib.uts.edu.au/handle/10453/141898
- [O13] Windt J, Gabbett TJ. Is it all for naught? What does mathematical coupling mean for acute:chronic workload ratios? Br J Sports Med 53:988. https://bjsm.bmj.com/content/53/16/988
- [O14] Watson NF, et al. Recommended amount of sleep for a healthy adult: AASM and SRS joint consensus statement, 2015. https://www.aasm.org/resources/pdf/adultsleepdurationconsensus.pdf
- [O15] Van Dongen HPA, Maislin G, Mullington JM, Dinges DF. The cumulative cost of additional wakefulness. Sleep 2003;26(2). https://ntrs.nasa.gov/citations/20040087752
- [O16] Mah CD, Mah KE, Kezirian EJ, Dement WC. The effects of sleep extension on the athletic performance of collegiate basketball players. Sleep 2011;34(7):943-950. https://www.sciencedaily.com/releases/2011/07/110701083513.htm
- [O17] Minetti AE, Moia C, Roi GS, Susta D, Ferretti G. Energy cost of walking and running at extreme uphill and downhill slopes. J Appl Physiol 2002;93:1039-1046. https://iris.unibs.it/retrieve/ddc633e4-3c03-4e2e-e053-3705fe0a4c80/Minetti%20JAP%202002.pdf
- [O18] Walch O, Huang Y, Forger D, Goldstein C. Sleep stage prediction with raw acceleration and PPG heart rate from a consumer wearable. Sleep 2019; dataset on PhysioNet, ODC-By 1.0. https://www.physionet.org/content/sleep-accel/
- [O19] BioPsyKit, Cole/Kripke sleep/wake detection module (open implementation). https://biopsykit.readthedocs.io/en/latest/api/biopsykit.sleep.sleep_wake_detection.algorithms.cole_kripke.html
- [A1] Apple Developer, HKQuantityTypeIdentifier (heartRate, restingHeartRate, heartRateVariabilitySDNN, respiratoryRate, oxygenSaturation, appleSleepingWristTemperature, cyclingPower, runningPower, vo2Max). https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
- [A2] Apple Developer, heartRateVariabilityRMSSD (listed for iOS 27 and later). https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilityrmssd
- [A3] Apple Developer, HKHeartbeatSeriesSample (iOS 13 and later). https://developer.apple.com/documentation/healthkit/hkheartbeatseriessample
- [A4] Garmin FIT SDK forum, RR intervals in FIT hrv messages. https://forums.garmin.com/developer/fit-sdk/f/discussion/440840/how-to-get-rr-intervals-from-fit-hr-messages-fit-file-message-132
