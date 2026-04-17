# Research: Guided-Smile Parameter Extraction POC

## 1. Goal

Prove that from the **guided-smile phase** of a daily capture we can extract the **Input A smile vector set** defined in the product plan (§7.2) with enough stability, repeatability, and confounder-awareness to feed the downstream state ontology (§6.1) and correlation engine (§9).

This POC is scoped to **guided-smile vectors only** (§7.2). Per the user note on this doc, neutral-phase vectors (§7.1) and Input B (press/release) are explicitly out of scope. A short neutral window is still *captured* — but only as the baseline reference that smile deltas are measured against, not as an extraction target in its own right.

The deliverable is a per-capture JSON of smile vectors + quality signals, plus a short write-up on which smile vectors are tractable now vs. which need more work.

## 2. What the product plan requires (smile only)

### Guided smile vectors (§7.2) — the focus of this POC
- eye aperture dynamic response
- cheek lift symmetry response
- nasolabial expression response proxies
- dynamic shadow redistribution
- movement symmetry / stiffness proxies
- dynamic fold visibility response (trend-gated)
- expression rebound tendency (if derivable)

#### Plain-language definitions

- **Eye aperture dynamic response** — how much the eye opening narrows from neutral to smile peak. A genuine (Duchenne) smile closes the eye via orbicularis oculi; a weak or "posed" smile moves mostly the mouth and barely changes the eye. Read as: *how much does the smile reach the eyes, and by how much on each side.*
- **Cheek lift symmetry response** — the vertical rise of each cheek apex from neutral to smile peak, compared left vs. right. Captures *how evenly the two sides of the face engage during a smile.* Asymmetry here is a candidate structural / neuromuscular signal when it persists across captures.
- **Nasolabial expression response** — how much the nasolabial line (crease running from nose-wing to mouth corner) lengthens and curves when the smile engages. Read as: *how pronounced the nasolabial fold becomes on smiling.* Change in length + curvature, not absolute fold presence.
- **Dynamic shadow redistribution** — the change in local brightness (LAB L\*) inside key ROIs (nasolabial, infraorbital) between neutral and smile peak. Smiling moves tissue, which moves where shadows fall. Read as: *where does light and shade shift on the face when the smile engages,* independent of pure landmark geometry.
- **Movement symmetry / stiffness** — two related but distinct features. *Symmetry:* per-landmark displacement magnitude compared left vs. right. *Stiffness:* how little the tissue (cheeks, skin) actually moves relative to how strong the smile expression is (blendshape intensity). High blendshape + low displacement = stiff tissue. Read as: *does the face move in proportion to the smile it's making, and does it move evenly on both sides.*
- **Dynamic fold visibility** — change in edge density (Canny/Sobel) inside nasolabial and under-eye ROIs from neutral to smile peak. Plan flags this as trend-gated because a single capture doesn't tell you much — it's useful only when tracked over time. Read as: *how visibly do folds appear when this person smiles, longitudinally.*
- **Expression rebound tendency** — how the face returns to neutral after the smile releases: time-to-baseline, and any overshoot/undershoot of cheek landmarks during release. Proxy for tissue elasticity / recovery speed. Read as: *after a smile, how quickly and cleanly does the face settle back.*

### Downstream states these feed (§6.1)
Primary: Face Stability (volatility/stiffness/symmetry). Secondary contributors: Under-eye Vitality (via smile-driven eye aperture and periocular shadow redistribution), Puffiness Load (via cheek-lift / nasolabial response shape). Redness and luminosity states are driven mostly by neutral-phase vectors and are therefore not a POC focus.

Note: In plain language if the beta were to just have smile dynamics how would the user experience look like?

#### Beta UX if scope = smile dynamics only

Stripped to only what smile vectors can honestly support, the beta becomes a **smile-based daily check-in** rather than a full FaceAge app. Plain-language walk-through:

**Daily (30 seconds)**
1. User opens the app. Single prompt: *"Relax your face… now smile and hold it… now relax."*
2. 5-second guided capture. On-device extraction — no upload required for inference.
3. Instant card:
   - **Today's smile, in three lines.** E.g. *"Your smile reached your eyes less than your 7-day average."* / *"Your left cheek lifted less than your right — bigger gap than usual."* / *"Your face settled back more slowly than your typical rebound."*
   - Each line has a confidence dot (low/medium/high) per §11.
   - One-tap *"why might this be?"* opens a short list of the usual suspects from §8 (sleep, alcohol, sodium, stress, travel) and asks a single adaptive question if today warrants one.

**Weekly (scroll, not task)**
- **Smile timeline.** A sparkline per smile vector — eye engagement, symmetry, stiffness, rebound — over the last 14 days.
- **What moved.** Plain-language callouts: *"Your smile stiffness has trended up this week. This often tracks with cumulative poor sleep or alcohol streaks — does that fit?"* (Hypothesis, not claim, per §9.8 and §20.1.)
- **One experiment to try.** A single suggestion the engine thinks will move one of today's flagged vectors — e.g. *"Two alcohol-free nights in a row; we'll check rebound on day 3."* (Layer-1 / Layer-2 correlation per §9.3–9.4, gated hard on confidence.)

**Monthly (Day-30 moment)**
- **Your smile, 30 days in.** A short report: which smile vectors are stable, which drift, which ones this user has enough signal on to trust.
- **Your triggers and protectors — smile edition.** Short list, each with confidence and maturity tag (*emerging / promising / validated*), per §11.3.
- **What this beta can't yet tell you.** Explicit: no FaceAge number, no structural ageing claim, no resilience score — those need neutral vectors and press/release (Input B) that this scope doesn't have. This honesty is the product's trust anchor (§1.3 / §19.3).

**What the user *does not* see in this scope**
- No FaceAge or age-delta display — decomposition requires SFA + RAB which depend on neutral-phase vectors.
- No Bio-Resilience Age proxy — requires Input B (press/release).
- No redness / luminosity / puffiness / under-eye *absolute* scores — these are neutral-phase vectors. Smile dynamics can only contribute *indirectly* to Face Stability and, weakly, Under-eye Vitality and Puffiness Load.
- No structural drift / velocity — requires ≥30 days of multi-vector data including neutral.

**What the user *does* get**
- A daily, honest, 30-second ritual.
- A weekly story about how their smile is changing, in their own data.
- A Day-30 reliability score: *"Of the predictions we made about your smile, here's how often we were right."* This is the Day-30 conversion trigger (§17.4) in this reduced scope.

**Positioning in one line**
*"A daily smile check-in that learns what makes your face move well — and what makes it stiff, uneven, or slow to settle."*

### Hard constraints from the plan
- §9.2 mandates a normalization pipeline (lighting / framing / distance / motion) and per-vector capture-quality gating before any vector is emitted.
- §19.2 gates high-cost inference on quality-eligible captures — POC must compute a per-capture quality score first.
- §20.1 forbids LLMs in vector extraction. Everything is deterministic CV/geometry/stats.

## 3. Capture format assumed for POC

- 5 s, 30 fps, front-facing camera, single face.
- Phase split: first ~2 s neutral hold (used only as the baseline reference frame), transition, last ~2 s held smile, short release tail.
- Auto-segmentation uses the `mouthSmileLeft + mouthSmileRight` blendshape rise/plateau/fall rather than wall-clock timing.
- Single subject, indoor lighting, no occlusion — we are not solving robustness yet, only signal existence.

## 4. Tooling stack (already present in repo)

- **MediaPipe FaceLandmarker** (`face_landmarker.task`) — 478 landmarks + 52 blendshapes + face transform matrix. Primary geometry + expression engine for the smile.
- OpenCV for frame I/O and color-space conversion where shadow-redistribution features are computed.
- NumPy for per-frame feature math.
- No ML training in POC. All vectors are hand-engineered proxies.


Why MediaPipe is sufficient for smile extraction:
- Blendshapes (`mouthSmileLeft/Right`, `cheekSquintLeft/Right`, `mouthDimpleLeft/Right`, `eyeBlinkLeft/Right`, `eyeSquintLeft/Right`) give a directly calibrated dynamic-expression signal without optical flow.
- Dense landmarks give stable ROIs for cheek apex, nasolabial line, and periocular contour — everything the smile vectors need.
- Face transform matrix enables cheap head-pose normalization so smile-driven displacement is separable from pose-driven displacement.

## 5. Neutral reference (used, not extracted)

A short neutral window is aggregated (median over low-motion, low-blink, in-pose frames) to produce a **single reference still** that every smile vector is differenced against. We do **not** emit neutral-phase vectors. The only reference quantities stored are:
- landmark positions in the face-normalized frame (IOD = 1.0)
- ROI pixel statistics needed for shadow-redistribution deltas (LAB means per ROI)
- blendshape values at rest (so `mouthSmile_peak` is a true delta, not an absolute)

## 6. Smile-phase extraction approach

Treat the smile as a controlled perturbation. Vectors are **trajectories and deltas** between the neutral reference and the smile peak (plus release where available), not absolute smile-frame values.

### 6.1 Phase segmentation
- `mouthSmileLeft + mouthSmileRight` rises past threshold → smile onset.
- Plateau region (derivative near zero, value near max) → smile hold.
- Drop back → release (used for rebound tendency if captured).

### 6.2 ROI definition for smile vectors

Expressed in the face-normalized frame. Used for shadow redistribution and fold visibility (color/edge features); movement vectors use landmarks directly.

| ROI | Landmarks (approx.) |
|---|---|
| Left cheek apex | 205, 207, 187, 147 |
| Right cheek apex | 425, 427, 411, 376 |
| Left nasolabial | 129, 203, 206, 216 |
| Right nasolabial | mirror |
| Left infraorbital | 230, 231, 232, 233, 128, 121 |
| Right infraorbital | mirror |
| Left periorbital ring | dilation of left eye contour minus eye interior |
| Right periorbital ring | mirror |

### 6.3 Vector → feature mapping

| Product-plan vector (§7.2) | Feature |
|---|---|
| eye aperture dynamic response | Δ(eye-contour vertical opening in IOD-normalized units) neutral → smile-peak, per eye; cross-checked against `eyeSquint*` / `eyeBlink*` blendshape Δ |
| cheek lift symmetry response | vertical displacement of cheek-apex landmarks in face-normalized frame, left vs right; symmetry = 1 − |L − R| / mean(L, R) |
| nasolabial expression response | length and curvature change of the nasolabial polyline (129→203→206→216 vs mirror) neutral → peak |
| dynamic shadow redistribution | ΔL\* per ROI neutral → smile plateau, especially nasolabial and infraorbital; forehead L\* used as intra-frame reference to partially cancel global lighting |
| movement symmetry / stiffness | stiffness = `mouthSmile_peak / max_cheek_displacement_normalized`; symmetry = per-landmark displacement L vs R, aggregated |
| dynamic fold visibility | edge-density increase (Canny/Sobel) inside nasolabial and under-eye ROIs, neutral → peak; plan flags this as trend-gated — POC emits the per-capture value but downstream must only use it longitudinally |
| expression rebound tendency | time from smile-peak back to `mouthSmile* < 0.15`; also overshoot/undershoot of cheek-apex landmarks during release |

### 6.4 Stiffness is the subtle one
Cheap version: `stiffness = mouthSmile_peak / max_cheek_displacement_normalized`. A real smile with low tissue movement → high stiffness → candidate signal for §6.3 slow/structural channel downstream. This is one of the more interesting things to validate in the POC.

## 7. Normalization layer

Per §9.2, every vector must be emitted with normalization metadata so rolling baselines (7d/30d) can be built later. POC computes and stores:
- inter-ocular distance (px) — scale
- head pose (yaw/pitch/roll) — pose correction / rejection
- forehead L\* (at neutral reference and at smile plateau) — intra-frame lighting reference for shadow-redistribution deltas
- camera timestamp + exposure if exposed by AVFoundation
- frame counts used for the neutral window, smile plateau, and release window

No cross-capture baselining happens in POC — that's engine territory.

## 8. Quality gating (per §9.2 / §19.2)

Per-capture quality score combines:
- head-pose yaw/pitch/roll within ±10° across the full capture (from face transform matrix)
- face bounding-box stability across both neutral and smile windows (IoU ≥ 0.95)
- blink fraction in neutral window < 20% (baseline must be eyes-open)
- `mouthSmile_peak` exceeds a floor — else phase segmentation failed / user didn't smile
- forehead L\* within a sane band at both neutral and smile-peak (not blown out / not crushed)
- sharpness via Laplacian variance threshold

If quality fails, POC emits vectors with a `quality: insufficient` tag rather than dropping them — downstream engine decides, not extractor.

## 9. Output schema (POC artifact)

Single JSON per capture:

```json
{
  "capture_id": "...",
  "quality": {"score": 0.82, "flags": []},
  "normalization": {
    "iod_px": 142,
    "yaw": 2.1, "pitch": -1.4, "roll": 0.8,
    "forehead_L_neutral": 67.2,
    "forehead_L_smile_peak": 66.9,
    "frames": {"neutral": 48, "plateau": 40, "release": 22}
  },
  "smile": {
    "eye_aperture_delta":     {"left": -0.22, "right": -0.19, "asymmetry": 0.03},
    "cheek_lift":             {"left": 0.11, "right": 0.09, "symmetry": 0.82},
    "nasolabial_response":    {"left_dLen": 0.08, "left_dCurv": 0.04, "right_dLen": 0.07, "right_dCurv": 0.05},
    "shadow_redistribution":  {"nasolabial_dL": {"left": -3.1, "right": -2.8}, "infraorbital_dL": {...}},
    "movement_symmetry":      0.88,
    "stiffness":              0.44,
    "fold_visibility_delta":  {"nasolabial": 0.17, "infraorbital": 0.06},
    "rebound_ms":             320,
    "rebound_overshoot":      0.02
  }
}
```

This is what the correlation engine would consume — POC's job is just to produce it reliably for the smile.

## 10. Open questions for the POC to answer

1. **Repeatability floor.** Same user, same lighting, 10 back-to-back captures — what's the within-session std for each smile vector? That's the noise band §9.2 references. Anything whose within-session std dominates plausible daily variation is not usable.
2. **Pose sensitivity curves.** At what yaw does cheek-lift asymmetry become dominated by pose rather than real asymmetry? Likely stricter than ±10°.
3. **Stiffness signal existence.** Is smile stiffness distinguishable from "small smile"? The `mouthSmile_peak` normalization must actually work or the feature collapses.
4. **Segmentation reliability.** Does blendshape-driven phase split work on weak/brief smiles, or do we need a UI cue ("hold the smile")?
5. **Rebound feasibility.** In a 5 s capture with a ~2 s plateau, is there enough tail to measure rebound, or does it need a longer capture / explicit release prompt?
6. **Shadow-redistribution signal floor.** Is ΔL\* on the nasolabial ROI from neutral to smile-peak large enough to exceed sensor noise at consumer webcam bit-depth?
7. **Which smile vectors are simply not tractable from monocular RGB in a one-shot capture?** Fold visibility trend (plan flags it trend-gated) and rebound overshoot without a high-fps release are likely candidates to mark as "longitudinal-only" or "needs capture-format change".

## 11. Proposed POC scope

**In scope**
- Record script: 5 s webcam capture with on-screen "relax / smile / hold / relax" cue, saves mp4 + per-frame MediaPipe results (landmarks, blendshapes, transform).
- Extractor: batch-processes the capture into the JSON schema in §9, covering all seven §7.2 vectors.
- Repeatability harness: runs the extractor on N back-to-back captures, reports per-vector mean/std.
- Short report: per-vector histograms + answers to §10 Q1–Q5.

**Out of scope**
- All neutral-phase vectors (§7.1) — per user note.
- Input B (press/release).
- Any cross-day baselining, correlation engine, state computation, FaceAge math.
- Multi-user data collection.
- Model training.
- Structural/deconfounded vectors (§7.5) — need ≥30d of captures, not a POC.

## 12. Success criteria

POC is successful if:
- ≥ 80% of captures under controlled conditions pass the quality gate.
- Every vector in §7.2 has a concrete extractor or is explicitly marked "needs longitudinal data / not POC-tractable" with reasoning.
- Within-session repeatability std is documented per smile vector, so the downstream team knows which smile vectors will carry signal vs. noise.
- Extractor runs end-to-end in < 3 s on a 5 s capture on CPU (keeps §19 compute-gating promise realistic).

## 13. Next step after POC

Feed the per-capture JSON into a minimal baseline store (7d rolling median + MAD per smile vector) and test whether Layer-1 lagged-delta correlation (§9.3) can be wired to a single exposure (`sleep_duration`) on a 2-week self-collected diary, focusing on Face Stability as the target state. That validates the smile extractor's output is actually correlation-engine-ready — separate plan.

