# Plan: Browser-Based Smile-Dynamics POC (Repeatability Validation)

## 1. What we're building and why

A **single-page browser app** that:
1. Opens the webcam.
2. Runs MediaPipe FaceLandmarker (Tasks for Web) on each frame in real time.
3. Draws live annotations for the smile-phase Points of Interest (POIs) defined in `research.md` — cheek apexes, nasolabial polylines, infraorbital / periorbital ROIs, eye-aperture segments, and live numeric overlays for blendshapes and per-vector features.
4. Guides the user through a **5 s neutral → smile → release** capture, extracts the seven §7.2 smile vectors, and logs them to a JSON.
5. Runs **N back-to-back captures** (repeatability harness) and reports per-vector mean / std / coefficient-of-variation **plus a per-vector progression plot across captures** (see §11.1) so we can visually confirm whether numbers are stable, drifting, or jumping.

**Only goal of this POC: validate repeatability.** Not the engine, not the UX, not storage, not auth, not longitudinal baselines. If the extractor can produce stable numbers across back-to-back captures on the same face, the research direction is confirmed. If it can't, we fix the extractor — not the app around it.

Browser was chosen because:
- Zero install; user can run the POC on any laptop with a webcam.
- MediaPipe Tasks for Web gives the same landmarker + 52 blendshapes + face transform matrix as the Python binding, so features port cleanly later.
- Live canvas overlay is drastically faster to iterate on than a Python/OpenCV GUI.

## 2. Scope

**In scope**
- Local-only web app (`index.html` + `main.js` + `features.js` + `repeatability.js`), no backend.
- Real-time annotation of POIs from research.md §6.2 over the video feed.
- Live numeric HUD for `mouthSmileLeft/Right`, `eyeBlinkLeft/Right`, cheek-lift L/R, stiffness, symmetry — updated every frame.
- Capture workflow: user presses **Start**, sees a timed "Relax → Smile → Hold → Release" cue, a 5 s clip is buffered (per-frame landmarks + blendshapes + transform, no video upload), extractor runs, JSON written to an in-page log and downloadable.
- Repeatability mode: runs N (default 10) back-to-back captures with a 5 s rest between, aggregates results.
- Per-capture quality gating per research.md §8; failing captures are tagged `insufficient` but kept in the log.

**Out of scope**
- Neutral-phase vectors (§7.1).
- Any server / storage / sync / auth.
- Multi-user collection.
- Mobile layout polish (desktop Chrome/Safari is enough).
- Training, longitudinal baselining, correlation engine, states, FaceAge.

## 3. File layout

```
smile_dynamics/
├── research.md              # already exists
├── plan.md                  # this file
└── poc/
    ├── index.html           # UI skeleton
    ├── main.js              # camera, MediaPipe init, render loop, capture controller
    ├── draw.js              # canvas overlay (POIs, HUD)
    ├── rois.js              # landmark index constants → ROI polygons
    ├── features.js          # per-frame + per-capture smile-vector extraction
    ├── quality.js           # per-capture quality gating
    ├── repeatability.js     # N-capture harness + aggregate stats
    └── vendor/
        ├── vision_bundle.mjs        # @mediapipe/tasks-vision
        └── face_landmarker.task     # model asset
```

No build step. Everything is ESM, served by `python -m http.server` or similar.

## 4. Tech choices

- **MediaPipe Tasks for Web** (`@mediapipe/tasks-vision`), `FaceLandmarker` with `outputFaceBlendshapes: true` and `outputFacialTransformationMatrixes: true`, `runningMode: "VIDEO"`, 1 face.
- **Canvas 2D** for overlay (no WebGL needed at POC scale).
- **Plain ESM + TS-flavored JSDoc**; no framework.
- **IndexedDB or just `localStorage` + JSON download** for session logs — whichever is smaller to write. Default: JSON download button; in-memory array is source of truth.

## 5. UI layout

```
┌──────────────────────────────────────────────────────────────┐
│  [ Start capture ]  [ Start repeatability (N=10) ]  [ Save ] │
│                                                              │
│  ┌────────────────────────────┐  ┌────────────────────────┐  │
│  │                            │  │ Live HUD               │  │
│  │    <video> + <canvas>      │  │ mouthSmile L/R         │  │
│  │    (POI overlay, labels,   │  │ eyeBlink L/R           │  │
│  │     phase banner)          │  │ cheek lift L/R         │  │
│  │                            │  │ symmetry / stiffness   │  │
│  └────────────────────────────┘  │ quality flags          │  │
│                                  └────────────────────────┘  │
│                                                              │
│  Capture log (last 10):                                      │
│  #3  smile_peak=0.81  stiffness=0.41  sym=0.87  quality=ok   │
│  #2  smile_peak=0.78  stiffness=0.44  sym=0.85  quality=ok   │
│  ...                                                          │
│                                                              │
│  Repeatability summary (after N runs):                       │
│  stiffness: mean=0.43  std=0.03  cv=0.07   ← tight           │
│  rebound_ms: mean=312  std=98   cv=0.31   ← noisy            │
└──────────────────────────────────────────────────────────────┘
```

## 6. MediaPipe setup

```js
// main.js
import { FaceLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";

const filesetResolver = await FilesetResolver.forVisionTasks("./vendor");
const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
  baseOptions: { modelAssetPath: "./vendor/face_landmarker.task" },
  runningMode: "VIDEO",
  numFaces: 1,
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  minFaceDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});

const video = document.getElementById("cam");
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1280, height: 720, frameRate: 30 },
  audio: false,
});
video.srcObject = stream;
await video.play();
```

Per-frame loop (drives both the live overlay and the capture buffer):

```js
function tick() {
  const now = performance.now();
  const result = landmarker.detectForVideo(video, now);
  if (result.faceLandmarks.length) {
    const frame = {
      t: now,
      landmarks: result.faceLandmarks[0],
      blendshapes: toMap(result.faceBlendshapes[0].categories),
      transform: result.facialTransformationMatrixes[0].data,
    };
    draw.render(frame);              // live annotation
    hud.update(frame);                // live HUD
    capture.push(frame);              // no-op unless a capture is active
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

## 7. POI overlay (`draw.js`, `rois.js`)

`rois.js` is just landmark-index constants from research.md §6.2:

```js
// rois.js
export const LEFT_CHEEK_APEX  = [205, 207, 187, 147];
export const RIGHT_CHEEK_APEX = [425, 427, 411, 376];
export const LEFT_NASOLABIAL  = [129, 203, 206, 216];
export const RIGHT_NASOLABIAL = [358, 423, 426, 436];
export const LEFT_INFRAORBITAL  = [230, 231, 232, 233, 128, 121];
export const RIGHT_INFRAORBITAL = [450, 451, 452, 453, 357, 350];
// eye contours + forehead reference — use MediaPipe's built-in connection sets
export const FOREHEAD_REF = [10, 67, 109, 108, 151, 337, 338];
```

`draw.js` draws polygons + labels on the canvas:

```js
export function render(frame) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawPolygon(ctx, frame.landmarks, LEFT_CHEEK_APEX,   "#ff3b3b", "L cheek");
  drawPolygon(ctx, frame.landmarks, RIGHT_CHEEK_APEX,  "#ff3b3b", "R cheek");
  drawPolyline(ctx, frame.landmarks, LEFT_NASOLABIAL,  "#ffcc00", "L nasolabial");
  drawPolyline(ctx, frame.landmarks, RIGHT_NASOLABIAL, "#ffcc00", "R nasolabial");
  drawPolygon(ctx, frame.landmarks, LEFT_INFRAORBITAL, "#00c3ff", "L infraorbital");
  drawPolygon(ctx, frame.landmarks, RIGHT_INFRAORBITAL,"#00c3ff", "R infraorbital");
  drawPhaseBanner(ctx, captureState.phase); // "relax" | "smile" | "hold" | "release"
}
```

Coordinates: MediaPipe returns normalized `[0, 1]` landmark coords — multiply by canvas width/height. Overlay canvas is sized to the video's displayed pixels so nothing mis-aligns on resize.

## 8. Capture controller

State machine driven by wall-clock plus `mouthSmile` blendshape:

```
IDLE ── click Start ──> RELAX (1.0s)
RELAX ── cue+time ──> SMILING (detect mouthSmile rise)
SMILING ── plateau (~1.5s at peak) ──> HOLD
HOLD ── cue ──> RELEASE (0.5s tail for rebound)
RELEASE ──> DONE (run extractor on buffered frames) ──> IDLE
```

Phase segmentation uses the blendshape signal as the primary cue; wall-clock is a fallback upper bound so bad smiles don't hang the capture. Buffer is an array of the frame objects from §6 — no video frames stored.

## 9. Feature extraction (`features.js`)

All seven §7.2 vectors. The extractor takes the full frame array plus the segmented phase indices and returns the JSON schema from research.md §9.

Key helpers:

```js
// Face-normalized 2D coordinates: divide by inter-ocular distance.
function normalize(landmarks) {
  const L_EYE = 33, R_EYE = 263;
  const iod = dist2d(landmarks[L_EYE], landmarks[R_EYE]);
  return landmarks.map(p => ({ x: p.x / iod, y: p.y / iod, z: p.z / iod }));
}

function medianLandmarks(frames) { /* per-index median over window */ }
function meanBlendshape(frames, key) { /* ... */ }
```

### 9.1 Eye aperture dynamic response

```js
function eyeApertureDelta(neutralFrame, peakFrame) {
  // upper/lower eyelid midpoints
  const L_UP = 159, L_LOW = 145, R_UP = 386, R_LOW = 374;
  const dL_n = yDist(neutralFrame, L_UP, L_LOW);
  const dL_p = yDist(peakFrame,    L_UP, L_LOW);
  const dR_n = yDist(neutralFrame, R_UP, R_LOW);
  const dR_p = yDist(peakFrame,    R_UP, R_LOW);
  return {
    left:  dL_p - dL_n,                  // negative = eye closed more
    right: dR_p - dR_n,
    asymmetry: Math.abs((dL_p - dL_n) - (dR_p - dR_n)),
  };
}
```

Cross-checked against `eyeSquintLeft/Right` blendshape Δ as a sanity signal.

### 9.2 Cheek lift symmetry

```js
function cheekLift(neutral, peak) {
  const L = 205, R = 425; // cheek apex landmarks (single point each)
  const dyL = neutral[L].y - peak[L].y;  // up is negative y in image coords
  const dyR = neutral[R].y - peak[R].y;
  const mean = (dyL + dyR) / 2;
  const symmetry = 1 - Math.abs(dyL - dyR) / Math.max(Math.abs(mean), 1e-6);
  return { left: dyL, right: dyR, symmetry };
}
```

### 9.3 Nasolabial response

Polyline length + curvature (sum of turning angles) change, per side.

### 9.4 Dynamic shadow redistribution

Requires pixel sampling. We draw the ROI polygon to an **offscreen canvas**, read back `getImageData`, convert sRGB → LAB per pixel, take the mean L\*. Do this at neutral-median time and smile-plateau time.

```js
function meanLInROI(canvas, videoFrame, polyPts) {
  // videoFrame drawn once into an offscreen canvas; polyPts are pixel coords.
  const imgData = sampleInsidePolygon(videoFrame, polyPts);
  let sum = 0, n = 0;
  for (let i = 0; i < imgData.length; i += 4) {
    const [L] = srgbToLab(imgData[i], imgData[i+1], imgData[i+2]);
    sum += L; n++;
  }
  return sum / n;
}
```

Forehead ROI used as intra-frame lighting reference: we store `(roi_L − forehead_L)` rather than raw `roi_L`.

### 9.5 Movement symmetry / stiffness

```js
function stiffness(peakFrame, peakBlendshape, neutralMedian) {
  const mouthSmilePeak = (peakBlendshape.mouthSmileLeft + peakBlendshape.mouthSmileRight) / 2;
  const cheekDisp = Math.max(
    Math.abs(neutralMedian[205].y - peakFrame.landmarks[205].y),
    Math.abs(neutralMedian[425].y - peakFrame.landmarks[425].y),
  );
  return mouthSmilePeak / Math.max(cheekDisp, 1e-4);
}
```

Symmetry: aggregate per-landmark displacement over a cheek + mouth landmark set, compare L vs R sums.

### 9.6 Dynamic fold visibility

Sobel on the ROI pixels (same offscreen-canvas route as 9.4). Report (edge_density_peak − edge_density_neutral) per ROI. Marked trend-gated per plan.

### 9.7 Expression rebound tendency

```js
function rebound(frames, peakIdx, peakValue) {
  const threshold = 0.15;
  for (let i = peakIdx; i < frames.length; i++) {
    const v = (frames[i].blendshapes.mouthSmileLeft + frames[i].blendshapes.mouthSmileRight) / 2;
    if (v < threshold) return frames[i].t - frames[peakIdx].t;
  }
  return null; // release not observed
}
```

Overshoot: compare cheek-apex y at the release minimum vs neutral median; positive = overshoot past neutral.

## 10. Quality gating (`quality.js`)

Per research.md §8. Runs on each finished capture before the extractor is trusted:

```js
export function gate(capture) {
  const flags = [];
  if (maxPoseDelta(capture) > 10)          flags.push("pose_excess");
  if (bboxIoU(capture) < 0.95)             flags.push("frame_shift");
  if (blinkFraction(capture.neutral) > 0.2) flags.push("blinky_neutral");
  if (capture.smilePeak < 0.4)              flags.push("weak_smile");
  if (!foreheadLInBand(capture))           flags.push("lighting_bad");
  if (laplacianVar(capture) < LAPLACE_MIN) flags.push("blurry");
  const score = 1 - flags.length / 6;
  return { score, flags };
}
```

Insufficient captures are **kept** with a flag, not dropped — repeatability stats are computed on the `ok` subset, full log is preserved.

## 11. Repeatability harness (`repeatability.js`)

```js
export async function runRepeatability({ n = 10, restMs = 5000, onProgress }) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    onProgress({ i, phase: "countdown" });
    await countdown(3);
    const capture = await runSingleCapture();   // 5s guided capture
    runs.push(capture);
    onProgress({ i, phase: "rest", capture });
    await sleep(restMs);
  }
  return summarize(runs);
}

function summarize(runs) {
  const ok = runs.filter(r => r.quality.flags.length === 0);
  const keys = flattenVectorKeys(ok[0].smile); // dotted paths, e.g. "cheek_lift.symmetry"
  const stats = {};
  for (const k of keys) {
    const xs = ok.map(r => getPath(r.smile, k)).filter(Number.isFinite);
    const mean = avg(xs);
    const std = stdev(xs, mean);
    stats[k] = { mean, std, cv: std / Math.abs(mean), n: xs.length };
  }
  return { runs, stats, ok_count: ok.length, total: runs.length };
}
```

The summary is rendered as a sortable table with CV color-coded (green < 0.1, amber 0.1–0.25, red > 0.25).

### 11.1 Progression plot (required part of the report)

Alongside the CV table, the harness renders one **line chart per vector** showing the value across capture index 1…N. A handful of vectors are plotted on the same chart when their scales match (e.g. `cheek_lift.left`, `cheek_lift.right`, `cheek_lift.symmetry`); the rest get their own chart.

Purpose: CV alone doesn't distinguish *random scatter* from *systematic drift* (e.g. user getting tired, lighting slowly changing, face warming up). Eyeballing the progression catches that.

Implementation: dead-simple inline SVG — no chart library needed.

```js
function renderProgression(container, label, values) {
  const w = 320, h = 80, pad = 6;
  const min = Math.min(...values), max = Math.max(...values);
  const x = i => pad + i * (w - 2*pad) / (values.length - 1);
  const y = v => h - pad - ((v - min) / (max - min || 1)) * (h - 2*pad);
  const d = values.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${y(v)}`).join(" ");
  container.insertAdjacentHTML("beforeend", `
    <figure>
      <figcaption>${label}  min=${min.toFixed(3)} max=${max.toFixed(3)}</figcaption>
      <svg viewBox="0 0 ${w} ${h}">
        <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5"/>
      </svg>
    </figure>`);
}
```

Both the CV table and the progression plots together **are the POC's deliverable** — they must be exportable as an HTML snapshot alongside the raw session JSON.

## 12. Success criteria (matches research.md §12 in POC terms)

- ≥ 80% of controlled back-to-back captures pass the quality gate.
- Per-vector CV table produced for a single user across ≥ 10 back-to-back captures.
- At least 4 of the 7 smile vectors show CV < 0.15 (tight-enough to carry daily signal after baselining).
- Extractor end-to-end latency < 300 ms per capture in-browser (Chrome, mid-range laptop).
- One-click JSON export of the full session (captures + summary) for offline inspection.

## 13. Risks / things to watch

- **Canvas pixel reads are slow.** If LAB / Sobel on large ROIs drops FPS below 15, move shadow/fold features to a Web Worker or use a WebGL shader. Start simple; optimize only if it bites.
- **Blendshape noise at the tails.** `mouthSmile*` can flicker; smooth over a 5-frame window before driving phase segmentation.
- **Pose leakage into "asymmetry".** Cheek-lift asymmetry will correlate with tiny head yaw drifts. We mitigate by normalizing landmark positions using the face transform matrix before cheek-lift math; if residual correlation remains, note it.

## 13.1 Why lighting shows up at all (and where we can drop it)

Fair challenge: we are capturing **dynamics**, so why is lighting normalization even on the table? Answer: five of the seven §7.2 vectors are **pure geometry** and are lighting-independent. Only two touch pixels.

| Vector | Depends on pixels? | Lighting-sensitive? |
|---|---|---|
| eye aperture dynamic response | No — landmark Δ only | No |
| cheek lift symmetry response | No — landmark Δ only | No |
| nasolabial expression response | No — landmark polyline geometry | No |
| movement symmetry / stiffness | No — landmark Δ / blendshape | No |
| expression rebound tendency | No — blendshape trajectory + landmarks | No |
| **dynamic shadow redistribution** | **Yes — mean LAB L\* in ROI** | **Yes, partially** |
| **dynamic fold visibility** | **Yes — edge density in ROI** | **Yes, partially** |

For shadow redistribution and fold visibility, we still only ever emit a **neutral → smile-peak delta inside the same 5 s capture**. Since lighting is effectively constant across 5 s in a fixed setup, most of the lighting contribution cancels in the delta. We do **not** need cross-capture lighting normalization for the POC.

**Concrete consequences for the plan:**
- Drop `foreheadLInBand` from the quality gate in §10 (keep a weak sanity check: ROI not blown out / not crushed, but no forehead-reference math).
- Drop the `forehead_L_neutral` / `forehead_L_smile_peak` fields from the output normalization block in research.md §9. Internal to the extractor we still compute a single forehead reference if it's free (it is), but it's no longer a headline quality signal.
- Shadow redistribution stays as `Δ(mean L*)` within the capture — no cross-capture lighting correction applied.
- If back-to-back-capture CV for shadow redistribution or fold visibility is high, the prime suspect is **tissue measurement noise / ROI clipping**, not lighting (lighting can't drift meaningfully between two captures taken seconds apart). The POC report should call that out rather than default-blaming lighting.

Exposure auto-adjust on the webcam is the one lighting concern that doesn't cancel — the camera may re-expose between captures. Mitigation: lock exposure via `MediaStreamTrack.applyConstraints({ advanced: [{ exposureMode: "manual" }] })` when the browser supports it, otherwise note it as an uncontrolled variable.

## 14. Build order

1. `index.html` shell + camera feed + bare MediaPipe loop (no features yet). Verify 30 fps.
2. `rois.js` + `draw.js` overlay; confirm POIs track the face cleanly.
3. Live HUD wiring (blendshapes + simple geometric features).
4. Capture state machine with phase banner.
5. `features.js` for §9.1 (eye) and §9.2 (cheek lift) — simplest, no pixel reads.
6. `quality.js` gate + single-capture JSON output.
7. `features.js` for §9.5 stiffness + §9.7 rebound.
8. Offscreen canvas + LAB conversion for §9.4 shadow redistribution.
9. Sobel for §9.6 fold visibility.
10. `repeatability.js` harness + summary table + JSON export.
11. Run the harness on self, read the CV table, iterate on any vector with CV > 0.25 before declaring POC done.

## 15. What's explicitly not in this plan

- No plan for the correlation engine, baselines, states, FaceAge, or any of the "what the user sees" surfaces from research.md §"Beta UX if scope = smile dynamics only". Those come after repeatability is validated.
- No neutral-phase vectors.
- No cross-session / cross-day storage.
- No model training or fine-tuning.

## 16. Todo list (phased)

Expansion of §14's build order into concrete, individually completable tasks. Each phase ends in a checkpoint the POC-runner can demo before moving on — if a phase's checkpoint fails, fix it before proceeding, don't stack work on a broken layer.

**Review protocol (applies to every checkpoint):** the implementer stops work at each `**Checkpoint:**` line, serves the app locally (`python3 -m http.server 8000` in `smile_dynamics/poc/`), and **hands off to the user to open the browser and eyeball the result**. Only after the user explicitly confirms the checkpoint does the next phase begin. If the user flags an issue, it gets fixed within the current phase — no forward progress while a checkpoint is outstanding. This is a hard gate, not a suggestion.

### Phase 0 — Project skeleton
- [x] Create `smile_dynamics/poc/` directory with subfolder `vendor/`.
- [x] Download `@mediapipe/tasks-vision` ESM bundle into `vendor/vision_bundle.mjs`.
- [x] Copy existing `face_landmarker.task` from repo root into `vendor/face_landmarker.task`.
- [x] Create empty module stubs: `main.js`, `draw.js`, `rois.js`, `features.js`, `quality.js`, `repeatability.js` (+ `ui.js` helper).
- [x] Write minimal `index.html` that loads `main.js` as ESM and has a `<video>` + `<canvas>` + controls placeholder.
- [x] Add a one-line serve command to the top of `index.html` as a comment (`python3 -m http.server 8000`).
- **Checkpoint (browser review required):** page loads, no console errors, no functionality yet. **— awaiting user review.**

### Phase 1 — Camera + MediaPipe loop
- [x] In `main.js`, request `getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } })`.
- [x] Handle permission-denied + no-camera cases with a visible error.
- [x] Initialize `FaceLandmarker` with `outputFaceBlendshapes`, `outputFacialTransformationMatrixes`, `runningMode: "VIDEO"`.
- [x] Run `requestAnimationFrame` loop calling `detectForVideo`.
- [x] Log per-second FPS to the page (not console).
- [x] Attempt `applyConstraints({ advanced: [{ exposureMode: "manual" }] })` where supported; log support status.
- **Checkpoint (browser review required):** sustained ≥ 25 fps detection on the target laptop in Chrome. **— awaiting user review.**

### Phase 2 — POI overlay
- [x] Fill `rois.js` with the landmark-index constants listed in §7 (cheek apex, nasolabial, infraorbital, periorbital, forehead).
- [x] Implement `drawPolygon` and `drawPolyline` helpers in `draw.js` with color + label args (+ `drawSegments` for eye aperture).
- [x] Size overlay canvas to match the rendered video size on load and on window resize.
- [x] Render all ROIs per frame from `draw.render(frame)`.
- [x] Add ROI visibility toggle checkboxes in the HTML (debug affordance).
- **Checkpoint (browser review required):** ROIs stay glued to the correct face regions during head motion, smiling, and blinking. **— awaiting user review.**

### Phase 3 — Live HUD
- [x] Implement `toBlendshapeMap(blendshapes)` helper (array-of-category → keyed object).
- [x] Render live values: `mouthSmileLeft/Right`, `eyeBlinkLeft/Right`, `eyeSquintLeft/Right`, head yaw/pitch/roll from the transform matrix.
- [x] Render live geometric readouts: cheek-apex y per side (face-normalized), eye-contour vertical opening per side.
- [x] Add a 5-frame moving average to each HUD value so it isn't jittery to read.
- **Checkpoint (browser review required):** HUD values move sensibly when the user smiles, blinks, and rotates the head. **— awaiting user review.**

### Phase 4 — Capture state machine
- [x] Define the state machine (`IDLE → RELAX → SMILING → HOLD → RELEASE → DONE`) in `capture.js`.
- [x] Draw a phase banner at top of canvas ("Relax", "Smile", "Hold the smile", "Release").
- [x] Drive RELAX → SMILING by `mouthSmile` rising above 0.2 OR a 2 s wall-clock fallback.
- [x] Drive SMILING → HOLD on plateau detection (derivative magnitude < 0.01 over 200 ms, value > 0.4).
- [x] Drive HOLD → RELEASE after 1.5 s of plateau.
- [x] Drive RELEASE → DONE after 0.5 s tail OR `mouthSmile` dropping below 0.15.
- [x] Buffer per-frame `{t, landmarks, blendshapes, transform, phase}` during the whole capture.
- [x] Tag each frame with the phase it belongs to.
- **Checkpoint (browser review required):** a full capture produces a buffer with correctly partitioned RELAX / HOLD / RELEASE frames. **— awaiting user review.**

### Phase 5 — Geometric features (no pixels yet)
- [x] In `features.js`, implement `normalize(landmarks)` (IOD = 1.0 using landmarks 33 and 263).
- [x] Implement `medianLandmarks(frames)` over the neutral window.
- [x] Implement §9.1 `eyeApertureDelta` using landmarks 159/145/386/374.
- [x] Implement §9.2 `cheekLift` using landmarks 205/425, return `{left, right, symmetry}`.
- [x] Implement §9.3 `nasolabialResponse` (polyline length + turning-angle-sum deltas per side).
- [x] Implement §9.5 `stiffness` and aggregate movement symmetry.
- [x] Implement §9.7 `rebound` time-to-threshold + overshoot using the RELEASE segment.
- [x] Cross-check eye-aperture Δ against `eyeSquintLeft/Right` Δ; log correlation (per-capture squint Δ recorded in `eyeSquintCrossCheck`).
- **Checkpoint (browser review required):** extractor produces numeric values for all five geometric vectors on a real capture. **— awaiting user review.**

### Phase 6 — Quality gate + single-capture JSON
- [x] In `quality.js`, implement non-pixel checks from §10 (pose, bbox IoU, blink fraction, smile peak, missing phases).
- [ ] Add an "ROI-not-clipped" check: forehead ROI mean L\* within [25, 235] on 8-bit. *(deferred to Phase 7 — requires pixel sampling)*
- [x] Attach `{quality: {score, flags, metrics}}` to every extractor output.
- [x] Render a per-capture JSON block in the capture log UI (pretty-printed, collapsible).
- [x] Add a "Download capture JSON" button. *(already wired in Phase 4/5)*
- [x] Added guided capture flow: countdown + per-phase action/subtext banner + phase progress bar.
- [x] Added **Calibrate** button and `calibration.js`: samples 4 s of user at rest, derives per-user pose/bbox/blink limits, persists to localStorage, threaded into `quality.gate`.
- [x] Fixed post-capture "zoom" regression: stage now uses `align-self: start` + `object-fit: cover`, overlay canvas re-sizes via `ResizeObserver`.
- **Checkpoint (browser review required):** running a deliberately bad capture (big head turn, no smile, hand over camera) produces the expected `flags`, calibrated captures hit `quality ≈ 1.0` on clean runs, no zoom/stretch after capture. **— awaiting user review.**

### Phase 7 — Pixel-dependent features
- [x] Create a scratch canvas sized to video resolution (`willReadFrequently: true`).
- [x] Implement `pointInPolygon` + `sampleOneROI` extracting pixels inside each ROI polygon.
- [x] Implement `srgbToLab(r, g, b)` (standard D65 conversion).
- [x] Implement §9.4 `shadowRedistribution`: Δ(mean L\*) per ROI, neutral snapshot vs peak snapshot (sampled at phase boundaries, not every frame).
- [x] Implement §9.6 `foldVisibility`: Sobel edge density inside each ROI; report Δ neutral → peak.
- [x] Measure per-snapshot pixel-sample latency; logged per capture.
- [ ] If latency budget blown, move pixel features into a Web Worker. *(deferred; current latency logged to confirm budget before optimizing)*
- **Checkpoint (browser review required):** extractor output now covers all seven §7.2 vectors; latency logged for review. **— awaiting user review.**

### Phase 8 — Repeatability harness
- [x] In `repeatability.js`, implement `runRepeatability({ n, restMs, runSingleCapture, showRest, hideRest, onProgress })` driving N back-to-back captures.
- [x] Implement on-screen rest countdown between captures (reuses phase banner).
- [x] Implement `flattenVectorKeys` (dotted paths over the smile vector tree).
- [x] Implement `summarize(runs)` → per-key `{mean, std, cv, n}` over the `quality.flags == []` subset (falls back to all runs if none pass).
- [x] Render summary table with CV color-coding (green < 0.1, amber 0.1–0.25, red > 0.25).
- [x] Implement `renderProgressionPlots` inline-SVG plots (§11.1) for every key.
- [x] Add a "Download session JSON" button.
- [x] Add a "Download report (HTML)" button that exports a standalone HTML snapshot of the table + plots.
- **Checkpoint (browser review required):** a 10-run repeatability session produces both the table and N plots; both exportable. **— awaiting user review.**

### Phase 9 — Self-run + iterate
- [ ] Run repeatability N=10 on self, controlled lighting, controlled framing.
- [ ] Inspect table + plots; for every vector with CV > 0.25 or visible drift, open an issue in `plan.md` §17 (new scratch section) with a hypothesis and a fix.
- [ ] Re-run after fix; keep iterating until ≥ 4/7 vectors have CV < 0.15 (success criterion from §12).
- [ ] Run a deliberately-bad session (changing expression, moving head) and confirm the harness distinguishes it from the clean one.
- **Checkpoint (browser review required):** §12 success criteria met on a self-captured session; exported report committed alongside `plan.md` as `poc_repeatability_run.html` + `.json`.

### Phase 10 — Writeup
- [ ] Add a short `poc/RESULTS.md` summarizing: which vectors passed CV < 0.15, which failed, observed drift patterns, exposure-lock availability on the test browser, and the one-sentence "ship / don't ship" call on each §7.2 vector.
- [ ] Link the HTML report + JSON from `RESULTS.md`.
- [ ] Update `research.md` §10 open questions with the answers the POC produced, or mark them still-open with reasons.
- **Checkpoint (browser review required):** a reader who has only seen `research.md` can open `RESULTS.md` and know exactly which smile vectors are ready to feed the correlation engine next.

## 17. Modification: shrink stage + live time-series noise plots

**Motivation.** Two tweaks to make the live noisiness of each HUD value visible while we stare at our own face, without running a full repeatability harness:

1. The video stage is larger than needed — crowds the sidebar and pushes interesting numbers off the first fold.
2. Today you can only see noise *after* a capture, via the CV table / progression plot. We want a rolling live-updating sparkline per metric so you can watch variance in real time.

### 17.1 Shrink the stage

Current layout (`poc/index.html`): `main { grid-template-columns: 1fr 320px }` with the stage filling the `1fr` column. On a wide screen the stage ends up 900+ px wide — bigger than any actual use of it.

Change: cap the stage width and give the extra room to the sidebar.

```css
/* index.html */
main { display: grid; grid-template-columns: minmax(480px, 720px) 1fr; gap: 14px; padding: 14px; }
.stage { max-width: 720px; }
aside  { min-width: 280px; }
```

This keeps aspect-ratio 16:9, makes the stage at most 720 px wide (= 405 px tall), and lets the sidebar grow to house the new live-plots panel. The already-added `align-self: start` + `ResizeObserver` wiring (from Phase 6) will keep the canvas pixel buffer correct at the new size.

### 17.2 Live time-series sparkline panel

Architecture: each HUD row in `hud.js` already produces a smoothed value per frame. Extend `hud.update` so that in addition to updating the numeric cell, it pushes the raw (un-smoothed) value and the smoothed value into a ring buffer, and redraws a small `<canvas>` next to the row.

**Ring buffer.** One buffer per HUD key, size 150 (≈ 5 s at 30 fps). Pre-allocated `Float32Array`.

```js
// hud.js — new helper
const RING_SIZE = 150;
const rings = new Map();

function push(key, v) {
  let r = rings.get(key);
  if (!r) { r = { buf: new Float32Array(RING_SIZE), i: 0, n: 0, min: Infinity, max: -Infinity }; rings.set(key, r); }
  r.buf[r.i] = Number.isFinite(v) ? v : NaN;
  r.i = (r.i + 1) % RING_SIZE;
  if (r.n < RING_SIZE) r.n++;
  return r;
}
```

**Per-row sparkline layout.** Rework `ensureRows` so each row becomes:

```html
<div class="hud-row">
  <span class="hud-label">smile L</span>
  <canvas class="hud-spark" width="160" height="28"></canvas>
  <span class="hud-val" id="hud-mouthSmileLeft">—</span>
</div>
```

Grid row uses `grid-template-columns: 76px 1fr 60px` so label + sparkline + value align neatly.

**Sparkline draw.** Draw every frame on the `<canvas class="hud-spark">` assigned to that row:

```js
function drawSpark(canvas, ring) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (ring.n < 2) return;

  // visible window in chronological order
  const start = ring.n < RING_SIZE ? 0 : ring.i;
  const len = ring.n;

  // compute visible min/max (re-scan is fine at n=150, 60 fps)
  let mn = Infinity, mx = -Infinity;
  for (let k = 0; k < len; k++) {
    const v = ring.buf[(start + k) % RING_SIZE];
    if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
  }
  if (mn === Infinity) return;
  const span = (mx - mn) || 1e-6;

  // 1σ band (optional)
  let s = 0, n = 0;
  for (let k = 0; k < len; k++) {
    const v = ring.buf[(start + k) % RING_SIZE];
    if (Number.isFinite(v)) { s += v; n++; }
  }
  const mu = s / n;
  let ss = 0;
  for (let k = 0; k < len; k++) {
    const v = ring.buf[(start + k) % RING_SIZE];
    if (Number.isFinite(v)) ss += (v - mu) * (v - mu);
  }
  const sigma = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;

  const y = (v) => h - 2 - ((v - mn) / span) * (h - 4);
  const x = (k) => (k * (w - 2)) / Math.max(1, len - 1) + 1;

  // sigma band
  ctx.fillStyle = "rgba(122,209,255,0.10)";
  ctx.fillRect(0, y(mu + sigma), w, Math.max(1, y(mu - sigma) - y(mu + sigma)));

  // mean line
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.beginPath(); ctx.moveTo(0, y(mu)); ctx.lineTo(w, y(mu)); ctx.stroke();

  // trace
  ctx.strokeStyle = "#7ad1ff";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let k = 0; k < len; k++) {
    const v = ring.buf[(start + k) % RING_SIZE];
    if (!Number.isFinite(v)) { started = false; continue; }
    if (!started) { ctx.moveTo(x(k), y(v)); started = true; }
    else ctx.lineTo(x(k), y(v));
  }
  ctx.stroke();
}
```

**Running CV readout.** Add a tiny "cv ≈ X.XXX" tag next to each row (computed from the same `mu` and `sigma` above — drops the noisiness right into view without waiting for a repeatability run):

```js
const cvText = (Math.abs(mu) > 1e-9) ? (sigma / Math.abs(mu)).toFixed(3) : "—";
row.querySelector(".hud-cv").textContent = `cv ${cvText}`;
```

Color the `cv` text using the same thresholds as the repeatability table (green < 0.10 / amber < 0.25 / red).

**Hooking in.** `hud.update(host, { blendshapes, pose, geom })` is called every frame from the render loop. Modify it to:
1. Compute the raw value and smoothed value for each row (already done).
2. Call `push(key, rawValue)` → update ring buffer.
3. Call `drawSpark(row.canvas, ring)` once per row per frame.
4. Update the numeric cell and the live-cv tag.

One extra DOM op per row per frame (13 rows × ~60 fps ≈ 780 canvas draws/s). All canvases are tiny (160×28 px ≈ 4480 px each). Budget is comfortable; if it bites, switch to one shared canvas with a vertical stack of sparklines and draw them in a single pass.

### 17.3 Scope of this modification

**In scope**
- `poc/index.html`: layout CSS changes (stage max-width, sidebar min-width, HUD-row grid with sparkline cell).
- `poc/hud.js`: ring buffers, sparkline rendering, live-CV tag per row.
- Minor: `main.js` doesn't need changes — `hud.update` already receives everything it needs.

**Out of scope**
- Any capture / extractor / repeatability logic — this is purely live-HUD work.
- Per-ROI pixel-feature live plots (shadow redistribution, fold visibility) — those are only computed at phase boundaries, not per frame, so there's nothing to spark.
- Downloadable sparkline snapshots — transient by design.

### 17.4 Success criteria

- Video stage is visibly smaller (≤ 720 px wide regardless of window size).
- Each HUD metric row shows a live rolling trace of the last ~5 s with a ±1σ band and a running CV readout.
- CV readouts for steady/neutral face on the noisy blendshapes (`eyeBlink`, `mouthSmile`) visibly rise when you wiggle your face and drop when you hold still — lets you calibrate which vectors are intrinsically jittery before a real capture.
- No measurable FPS drop vs. the current build (should still sustain ≥ 25 fps).

### 17.5 Build order

1. CSS: cap stage width, re-balance grid, tighten HUD-row grid to make room for a sparkline cell.
2. `hud.js`: add ring buffer + running-stats helpers. Verify numbers update via `console.log` on one row.
3. Wire `drawSpark` to draw per row every frame.
4. Add live-CV tag and color-coding.
5. Eyeball FPS; if stable, done.

No state machine, no capture, no phase changes involved. Single-session visual tweak.

### 17.6 Todo list (phased)

Same review-gate rules as §16: each phase ends in a browser-review checkpoint. Implementer stops, user eyeballs the tab, user confirms → next phase.

#### Phase M0 — Layout: shrink the stage
- [x] In `poc/index.html`, change `main` grid from `1fr 320px` to `minmax(480px, 720px) 1fr`.
- [x] Add `.stage { max-width: 720px; }` and `aside { min-width: 280px; }` to the `<style>` block.
- [x] Confirm the existing `align-self: start` on `.stage` and `aside` is still present (verified).
- [ ] Reload, resize browser window from narrow → wide, confirm stage never exceeds 720 px and sidebar absorbs the rest.
- **Checkpoint (browser review required):** stage is noticeably smaller, no clipping of overlays (banner, POI labels), ROIs still track during head motion, FPS unchanged. **— awaiting user review.**

#### Phase M1 — HUD row layout with sparkline cell
- [x] Add CSS for a 4-column HUD row (`68px 1fr 52px 44px`) as `.hud-row-dyn` (keeps the simple `.hud-row` for static fps / face-detected rows).
- [x] Add CSS for `.hud-spark` (mini canvas, 24px tall, dark bg + subtle border) and `.hud-cv` (small right-aligned tag, 10px, tabular-nums).
- [x] Update `ensureRows` in `poc/hud.js` to emit label + canvas + numeric + cv-tag cells per row.
- [x] Each row's canvas gets a stable `id="spark-<key>"` and starts at `width=160 height=28` (dpr scaling deferred to M3 first-draw).
- **Checkpoint (browser review required):** 13 HUD rows now show label + empty-but-sized canvas + value. Layout stable, no overflow in the narrowed sidebar. **— awaiting user review.**

#### Phase M2 — Ring buffer + running stats
- [x] Add `RING_SIZE = 150` constant and a `rings` `Map<string, {buf, i, n}>` at module scope in `hud.js`.
- [x] Implement `push(key, rawValue)` returning the ring object.
- [x] Implement `runningStats(ring)` returning `{ count, min, max, mean, sigma }` (single pass over the valid range of the buffer; two-pass for σ but both short).
- [x] Hook `push` into `hud.update` so every visible row pushes its raw value each frame.
- [x] Expose `rings` on `window.__rings` for dev inspection; log once when first ring fills.
- **Checkpoint (browser review required):** nothing visible yet; dev-console confirms the ring for one key is accumulating 30 samples/s. **— awaiting user review.**

#### Phase M3 — Sparkline draw
- [x] Implement `drawSpark(canvas, ring, stats, color)`: chronological traversal, visible min/max, ±1σ band, dim mean line, trace.
- [x] Handle NaN gaps in the trace by breaking the path (no straight lines across missing values).
- [x] Call `drawSpark` once per row per frame from `hud.update` (added DOM-cache to avoid per-frame `querySelector`).
- [x] Honor `devicePixelRatio` via `ensureCanvasSized` on first draw (and auto-resizes if sidebar width changes).
- **Checkpoint (browser review required):** each HUD row shows a rolling live trace of its last ~5 s with a light-blue band behind and a dim mean line. Traces move in real time when you smile / blink / turn head. **— awaiting user review.**

#### Phase M4 — Live CV readout + color coding
- [ ] Add a `.hud-cv` span to each row (from M1) and populate it every frame: `cv = sigma / max(|mean|, 1e-9)` when `|mean| > 1e-6`, else `—`.
- [ ] Color the cv tag: green `#9ef28f` if `cv < 0.10`, amber `#ffcc66` if `cv < 0.25`, red `#ff6a6a` otherwise, grey `#888` if mean-near-zero.
- [ ] Optionally: also color the sparkline trace to match the cv band (nice visual cue; keep band+trace readable together).
- [ ] Sanity test: hold perfectly still with neutral face → blendshape rows show green CV; wiggle face → same rows jump to amber/red then settle back when you hold still.
- **Checkpoint (browser review required):** CV tag updates live, color-codes correctly, matches expectation (`yaw/pitch/roll` are typically green when still; `mouthSmile*` is green at rest, rises to amber/red during active smiling as expected for a changing signal — both behaviors are correct). **— awaiting user review.**

#### Phase M5 — Perf + polish
- [ ] Measure fps with sparklines running. Target ≥ 25 fps sustained on the target laptop.
- [ ] If < 25 fps: collapse to a single shared tall canvas with 13 stacked sparkline bands drawn in one pass; or drop render rate to 15 Hz (render every 2nd frame) — sparklines don't need full frame rate to be useful.
- [ ] Ensure the sparkline canvas sizes re-scale via the existing `ResizeObserver` on the stage (no-op: sparklines live in the sidebar, but they should still respond if sidebar width changes).
- [ ] Clear ring buffers when the page is hidden / camera pauses so reopening doesn't show a stale trace.
- **Checkpoint (browser review required):** FPS unchanged vs. pre-M0 build, sparklines look clean across window resizes, no visual artifacts. **— awaiting user review.**

#### Phase M6 — Commit
- [ ] Once all five checkpoints are green, the modification is done.
- [ ] No RESULTS.md / research.md updates required — this is a debugging UX change, not a POC deliverable.
- [ ] Leave `plan.md` §17 in place so the decision log stays readable.

## 18. Modification: silent save to `poc/results/` with timestamped filenames

### 18.1 What we're changing and why

Right now every download (capture JSON, session JSON, HTML report) hits `~/Downloads/` with a browser prompt. That is fine for one-offs, annoying for repeatability runs where the user does 10 captures + wants 5 snapshots, and makes the artifacts live *outside* the repo — so they can't be committed or diff'ed.

Three asks:
1. Save artifacts into `smile_dynamics/poc/results/`, not `~/Downloads/`.
2. UI should not pop anything — just show a transient **"Saved!"** affordance in place of the normal button label.
3. Filenames must include an ISO-ish timestamp so nothing gets overwritten across saves.

### 18.2 Why the current approach can't just be tweaked

Browsers cannot silently write to an arbitrary local directory. The `<a download>` trick always goes to the browser's Downloads folder and always shows a browser UI (either a dialog or a shelf). The two viable paths:

**A. File System Access API** (`showDirectoryPicker()`). Zero server changes; user picks `poc/results/` once, subsequent saves go silent. Works in Chromium-based browsers. Safari 15.2+ has `showSaveFilePicker` but not `showDirectoryPicker`. Each page reload the directory handle evaporates — needs re-pick or IndexedDB persistence.

**B. Swap the static server for a tiny Python server** that also accepts `POST /save`. Universal (any browser), permanent (no permission prompt ever), and writing to `poc/results/` is trivial. The only cost is the user runs `python3 poc/serve.py` instead of `python3 -m http.server 8000`.

**Recommendation: option B.** Simpler, more reliable, single command switch for the user, no browser quirks to debug. A future hosted-deployment will need a real backend for saves anyway — this is the minimal version of that. Option A is listed in §18.7 as an alternative if the user prefers zero-server.

### 18.3 Files touched

**New**
- `smile_dynamics/poc/serve.py` — static + save server.
- `smile_dynamics/poc/results/` — output directory, auto-created on first save (gitignored by default — add `.gitkeep` if you want the empty dir tracked).

**Modified**
- `smile_dynamics/poc/main.js` — `downloadJson` / `downloadText` become `saveJson` / `saveText`, posting to `/save`. All three save buttons (capture JSON, session JSON, HTML report) switch over.
- Button affordance — transient "Saved!" label for ~1.5 s on success.

**Unchanged**
- Everything else: state machine, extractor, repeatability harness, HUD.

### 18.4 Server (`poc/serve.py`)

Minimal extension of `SimpleHTTPRequestHandler`. Serves the `poc/` directory as before; adds one `POST /save` handler that writes `poc/results/<filename>`. Rejects any filename that tries to escape `results/` (defence in depth; this is only bound to localhost, but still).

```python
#!/usr/bin/env python3
"""Serve the POC directory and accept POST /save to write into ./results/."""
import json
import os
import re
from http.server import SimpleHTTPRequestHandler, HTTPServer

PORT = 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(ROOT, "results")
SAFE_NAME = re.compile(r"^[A-Za-z0-9._\-]+$")

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        if self.path != "/save":
            self.send_error(404, "unknown endpoint")
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw)
            name = str(payload["filename"])
            body = str(payload["content"])
        except Exception as e:
            self.send_error(400, f"bad payload: {e}")
            return
        if not SAFE_NAME.match(name):
            self.send_error(400, "illegal filename")
            return
        os.makedirs(RESULTS_DIR, exist_ok=True)
        path = os.path.join(RESULTS_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "path": os.path.relpath(path, ROOT)}).encode())

    def log_message(self, fmt, *args):
        pass  # quieter than the default

if __name__ == "__main__":
    print(f"serve.py on http://localhost:{PORT}/  writing results to {RESULTS_DIR}")
    HTTPServer(("", PORT), Handler).serve_forever()
```

The server lives under `poc/` so `cd smile_dynamics/poc && python3 serve.py` and the open-in-browser URL simplifies from `http://localhost:8000/smile_dynamics/poc/` to `http://localhost:8000/`. The URL change is a nice side effect — simpler to share.

### 18.5 Client: `saveJson` / `saveText` + button affordance

Replace the two download helpers in `main.js`:

```js
async function saveText(filename, text, mime) {
  const res = await fetch("/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content: text, mime }),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.path;
}

function saveJson(filename, obj) {
  return saveText(filename, JSON.stringify(obj, null, 2), "application/json");
}
```

Transient-label helper (reused for all three buttons):

```js
function flashSaved(btn, label = "Saved!") {
  const original = btn.dataset.originalLabel ?? btn.textContent;
  btn.dataset.originalLabel = original;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
    delete btn.dataset.originalLabel;
  }, 1500);
}
```

Each of the three save-button click handlers changes shape from "build blob → trigger download" to "build payload → POST → flash":

```js
saveBtn.addEventListener("click", async () => {
  if (!state.lastCapture) return;
  const name = `capture_${timestampSlug()}.json`;
  try {
    await saveJson(name, {
      capture: serializeCapture(state.lastCapture.capture),
      vectors: state.lastCapture.vectors,
      baseline: state.baseline,
    });
    flashSaved(saveBtn);
    log(`saved → results/${name}`);
  } catch (err) {
    showError(String(err));
  }
});
```

### 18.6 Timestamp format

Filesystem-safe, lexicographically sortable, readable. `new Date().toISOString()` gives `2026-04-16T14:23:09.123Z`; colons are allowed on macOS/Linux but painful in shells, so strip them:

```js
function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace(/Z$/, "");
}
```

Produces `2026-04-16_14-23-09-123`. Resulting filenames:
- `capture_2026-04-16_14-23-09-123.json` (single capture)
- `repeatability_session_2026-04-16_14-23-09-123.json` (10-run session)
- `repeatability_report_2026-04-16_14-23-09-123.html` (HTML report)

Names match `SAFE_NAME` regex on the server side.

### 18.7 Alternative (for the record): File System Access API

If you'd rather not run the tiny server, the browser-native path is:

```js
let resultsDirHandle = null;
async function saveToDirectory(filename, text) {
  if (!resultsDirHandle) resultsDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  const file = await resultsDirHandle.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}
```

Caveats: first click triggers a one-time directory-picker prompt (user picks `poc/results/`). Handle is lost on page reload unless persisted to IndexedDB. Chromium-only. We don't recommend this unless the user explicitly doesn't want a local server.

### 18.8 Scope

**In**
- `poc/serve.py` (new).
- `poc/main.js`: replace download helpers, switch three save handlers, add `flashSaved` + `timestampSlug`.
- README-style note: "run `python3 serve.py` from `smile_dynamics/poc/` then open `http://localhost:8000/`."

**Out**
- No extractor / HUD / capture / repeatability logic changes.
- No results-folder UI inside the app (no list, no delete, no preview).
- No .gitignore changes — up to the user whether they want to commit artifacts.
- No HTTPS / authentication — server is bound to localhost, only the local user reaches it. If that ever changes, this endpoint would be replaced by a proper API.

### 18.9 Success criteria

- Start `python3 poc/serve.py`; open `http://localhost:8000/`; app loads identically to before.
- Click Save after a capture → button flashes **"Saved!"** for ~1.5 s → console log `saved → results/capture_2026-04-16_14-23-09-123.json` → file exists at `smile_dynamics/poc/results/` with correct content.
- No browser download dialog, no `~/Downloads/` write.
- Two further saves in quick succession produce distinct timestamped filenames (nothing overwritten).
- Start repeatability, download session JSON + HTML report via their buttons → both land in `results/` with matching timestamps, each button flashes "Saved!".
- If the server is killed mid-save, the button shows an error (red banner) instead of silently failing.
- Trying a malicious filename like `../../etc/passwd` in a manual fetch hits `400 illegal filename` and doesn't escape the results dir.

### 18.10 Todo list (phased, browser-review-gated)

Same rules as §16 and §17.6: each checkpoint stops for user review.

#### Phase S0 — Server skeleton
- [x] Create `smile_dynamics/poc/serve.py` as specified in §18.4.
- [x] Make it executable (`chmod +x`). Verified `python3 serve.py` runs without error.
- [x] Killed the old `python3 -m http.server 8000` background task; started the new server from `smile_dynamics/poc/`.
- [x] **Port change:** 8000 was already occupied by `faceage/` uvicorn, so this POC server now binds **:8765**. New URL: **`http://localhost:8765/`**. Plan §18.4 / §18.9 / §18.10 wording kept at 8000 for historical context; runtime reality is 8765.
- [ ] Confirm the new URL serves `poc/index.html` cleanly (app loads, camera works, HUD updates).
- **Checkpoint (browser review required):** app loads at the new URL, no regressions vs. prior build. **— awaiting user review.**

#### Phase S1 — Client save helpers
- [x] In `poc/main.js`, add `saveText`, `saveJson`, `flashSaved`, `timestampSlug` helpers.
- [x] Leave the old `downloadJson` / `downloadText` in place temporarily so nothing else breaks until S2 swaps call sites.
- [x] Exposed `__saveJson`, `__saveText`, `__timestampSlug` on `window` for devtools smoke-testing.
- [x] Endpoint smoke-tested via curl: `POST /save {filename,content}` wrote `results/debug_smoke.json` successfully.
- **Checkpoint (browser review required):** manual save from console succeeds and writes to `results/`. Nothing in the UI has changed yet. **— awaiting user review.**

#### Phase S2 — Swap the three save buttons
- [x] `btn-save` (single capture JSON) → `saveJson`, `capture_<ts>.json`, `flashSaved`.
- [x] `btn-session-json` (repeatability session) → `saveJson`, `repeatability_session_<ts>.json`, `flashSaved`.
- [x] `btn-report` (HTML report) → `saveText(..., html, "text/html")`, `repeatability_report_<ts>.html`, `flashSaved`.
- [x] Deleted the old `downloadJson` / `downloadText` helpers (no remaining references).
- [x] Logs `saved → results/<name>` on success; errors route through `showError`.
- **Checkpoint (browser review required):** each of the three save buttons writes silently to `poc/results/` with a timestamped name, UI flashes "Saved!" for ~1.5 s, no browser download prompt appears. **— awaiting user review.**

#### Phase S3 — Error handling + small polish
- [x] Added `flashError(btn, "Error")`: swaps label, tints red, disables for 2 s; `showError` banner also surfaces the server body.
- [x] All three handlers disable their button immediately on click (not just via the flash-helper) and short-circuit if already disabled — hard guard against double-clicks / double-fires from fast reruns.
- [x] Updated HTML comment at the top of `poc/index.html` with the new run instructions (`cd smile_dynamics/poc && python3 serve.py`, open `http://localhost:8765/`) and a one-liner describing the save endpoint.
- **Checkpoint (browser review required):** kill `serve.py`, click a save button, see red "Error" + red banner, restart the server, click again and see "Saved!". **— awaiting user review.**

#### Phase S4 — Commit
- [x] S0–S3 all green.
- [x] `poc/results/.gitignore` added: ignores everything in the directory except itself, so git tracks the folder but not the artifacts (reproducible, large, per-user).

## 19. Modification: per-person + per-session output layout + neutral image

### 19.1 What we're changing and why

Current save flow drops everything into one flat `poc/results/` directory. That's fine for a solo user, but we're now collecting side-by-side data for two real people (Sameen, GG) and want:

1. **Per-person subdirectory** so Sameen's and GG's artifacts don't mix.
2. **Per-session subdirectory inside that**, so each capture (or each repeatability run) lives in its own folder — makes sharing ("here's the data from my session") a single-folder zip.
3. **Person prefix on every filename** so files remain self-identifying even if someone pulls one out of its directory.
4. **A still image of the neutral phase** saved alongside each capture, so every numeric JSON has a visual ground-truth reference ("what did the face look like while we were measuring this?"). Critical for future debugging when a vector looks off — we want to eyeball the ROIs on the actual frame.
5. **A two-option picker** between the existing capture buttons and the capture itself, so the person label is chosen per-capture explicitly rather than via a global dropdown.

### 19.2 Directory layout

```
poc/results/
├── Sameen/
│   ├── 2026-04-16_22-30-12-345/            ← single-capture session (Start capture)
│   │   ├── Sameen_capture.json
│   │   └── Sameen_neutral.jpg
│   └── 2026-04-16_22-35-01-234/            ← repeatability session (Start repeatability)
│       ├── Sameen_capture_01.json
│       ├── Sameen_neutral_01.jpg
│       ├── Sameen_capture_02.json
│       ├── Sameen_neutral_02.jpg
│       …
│       ├── Sameen_repeatability_session.json
│       └── Sameen_repeatability_report.html
└── GG/
    └── …
```

**Session definition.** A session starts when you click *Start capture* or *Start repeatability* and pick a person. Session ID = ISO timestamp slug at that moment. Single-capture sessions contain one JSON + one image. Repeatability sessions contain N JSON+image pairs plus the aggregate session + HTML report.

Filenames stay short because the directory already encodes person + timestamp; the person prefix is redundant-but-intentional so a file lifted out of its directory stays identifiable.

### 19.3 Files touched

**Modified**
- `poc/serve.py` — accept `person`, `sessionId`, `encoding` in the POST body; build `results/<person>/<sessionId>/<filename>`; decode base64 for binary uploads; validate all path components.
- `poc/main.js` — person picker UI; session ID tracking; neutral-frame image capture; `saveToSession(filename, content, opts)` wrapper; wire all four save actions (single capture, each repeatability capture, session JSON, HTML report) through the new path.
- `poc/capture.js` — no state-machine change, but pixel hooks need to fire `onNeutralJpeg(blobOrDataUrl)` in addition to `onNeutral(landmarks)`.
- `poc/pixels.js` or a small new helper — add `grabVideoFrameJpeg(video, quality=0.9)` using the existing scratch canvas + `canvas.toDataURL("image/jpeg", quality)`.
- `poc/index.html` — the person-picker overlay and its CSS.
- `poc/results/.gitignore` — still ignores everything inside, unchanged.

**New (optional)**
- `poc/results/Sameen/.gitkeep`, `poc/results/GG/.gitkeep` — if we want the two top-level dirs pre-created and tracked. Simpler: let the server create them on first save.

**Unchanged**
- Extractor, HUD, repeatability harness math, calibration logic. **Note**: calibration baselines still live in a single localStorage key shared across both people. If Sameen and GG share one device their baselines will stomp on each other. Out of scope for this modification; flagged in §19.9.

### 19.4 Server changes (`poc/serve.py`)

Extend payload schema:

```json
{
  "filename":  "Sameen_capture.json",
  "content":   "<json string or base64-encoded binary>",
  "encoding":  "utf8" | "base64",
  "person":    "Sameen" | "GG",
  "sessionId": "2026-04-16_22-30-12-345"
}
```

Path construction and validation:

```python
SAFE_NAME   = re.compile(r"^[A-Za-z0-9._\-]+$")
SAFE_PERSON = re.compile(r"^(Sameen|GG)$")
SAFE_SESSION = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$")

def do_POST(self):
    ...
    name      = str(payload["filename"])
    body      = str(payload["content"])
    encoding  = str(payload.get("encoding", "utf8"))
    person    = str(payload["person"])
    session   = str(payload["sessionId"])

    if not SAFE_NAME.match(name):      return self.send_error(400, "illegal filename")
    if not SAFE_PERSON.match(person):  return self.send_error(400, "illegal person")
    if not SAFE_SESSION.match(session):return self.send_error(400, "illegal sessionId")
    if encoding not in ("utf8", "base64"): return self.send_error(400, "illegal encoding")

    dir_path = os.path.join(RESULTS_DIR, person, session)
    os.makedirs(dir_path, exist_ok=True)
    full = os.path.join(dir_path, name)

    if encoding == "base64":
        with open(full, "wb") as f:
            f.write(base64.b64decode(body))
    else:
        with open(full, "w", encoding="utf-8") as f:
            f.write(body)
    ...
```

Three explicit regexes prevent path traversal; `os.path.join` with `os.makedirs(exist_ok=True)` handles directory creation.

### 19.5 Client: person picker

Two capture trigger buttons remain (`Start capture`, `Start repeatability (N=10)`). Instead of firing the capture directly, each now opens an **inline overlay over the video stage** with two large buttons: *Sameen* and *GG*. Clicking one closes the overlay and starts the original flow.

```html
<div id="person-picker" class="picker hidden" role="dialog">
  <div class="picker-card">
    <div class="picker-title">Who's capturing?</div>
    <button data-person="Sameen">Sameen</button>
    <button data-person="GG">GG</button>
    <button class="picker-cancel">Cancel</button>
  </div>
</div>
```

```css
.picker.hidden { display: none; }
.picker { position: absolute; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 10; }
.picker-card { background: #17171c; border: 1px solid #333; padding: 20px;
  display: flex; flex-direction: column; gap: 10px; min-width: 240px; }
.picker-card button { padding: 14px; font-size: 16px; }
```

The picker is mounted inside `.stage` so it sits above the video + canvas. JS glue:

```js
function pickPerson() {
  return new Promise((resolve, reject) => {
    const picker = document.getElementById("person-picker");
    picker.classList.remove("hidden");
    const onPick = (e) => {
      const p = e.target.dataset.person;
      picker.classList.add("hidden");
      cleanup(); resolve(p);
    };
    const onCancel = () => { picker.classList.add("hidden"); cleanup(); reject("cancelled"); };
    const cleanup = () => {
      picker.querySelectorAll("[data-person]").forEach(b => b.removeEventListener("click", onPick));
      picker.querySelector(".picker-cancel").removeEventListener("click", onCancel);
    };
    picker.querySelectorAll("[data-person]").forEach(b => b.addEventListener("click", onPick));
    picker.querySelector(".picker-cancel").addEventListener("click", onCancel);
  });
}

captureBtn.addEventListener("click", async () => {
  let person;
  try { person = await pickPerson(); } catch { return; }
  const sessionId = timestampSlug();
  state.currentSession = { person, sessionId, type: "single" };
  state.activeController = capture;
  capture.start();
});
```

Repeatability flow is analogous but `type: "repeatability"`.

### 19.6 Neutral-frame image capture

We already sample pixel ROIs at the relax→smile transition via the `pixelHooks.onNeutral` callback. Reuse that moment to also grab the full video frame as a JPEG.

In `pixels.js`:

```js
export function grabVideoFrameJpeg(video, canvas, ctx, quality = 0.9) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  canvas.width = w; canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}
```

In `main.js`, extend the onNeutral hook:

```js
onNeutral: (landmarks) => {
  if (state.activeController !== capture) return;
  const snap = sampleAllROIs(video, landmarks, video.videoWidth, video.videoHeight, scratch.canvas, scratch.ctx);
  const jpegDataUrl = grabVideoFrameJpeg(video, scratch.canvas, scratch.ctx);
  state.pixelSnapshots.neutral = snap;
  state.neutralJpeg = jpegDataUrl;   // data: URL
  log(`neutral snap + jpeg (${formatBytes(jpegDataUrl?.length ?? 0)})`);
},
```

The data URL looks like `data:image/jpeg;base64,/9j/4AAQ…`. We strip the prefix before uploading (server expects pure base64 in `content`).

### 19.7 Upload wrapper

Replace `saveJson` / `saveText` calls in the button handlers with a session-aware helper:

```js
async function saveToSession({ filename, content, encoding = "utf8" }) {
  if (!state.currentSession) throw new Error("no active session");
  const { person, sessionId } = state.currentSession;
  const res = await fetch("/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content, encoding, person, sessionId }),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text()}`);
  return (await res.json()).path;
}

function dataUrlToBase64(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
```

Single-capture save becomes:

```js
const person = state.currentSession.person;
const paths = [];
paths.push(await saveToSession({
  filename: `${person}_capture.json`,
  content: JSON.stringify({
    capture: serializeCapture(state.lastCapture.capture),
    vectors: state.lastCapture.vectors,
    baseline: state.baseline,
  }, null, 2),
}));
if (state.neutralJpeg) {
  paths.push(await saveToSession({
    filename: `${person}_neutral.jpg`,
    content: dataUrlToBase64(state.neutralJpeg),
    encoding: "base64",
  }));
}
```

### 19.8 Repeatability flow changes

Each of the N captures needs its own neutral image. The repeatability harness already calls `runSingleCapture()` N times; each run already populates `state.neutralJpeg` via the pixel hook. The harness now captures that jpeg per run into the runs array:

```js
state.lastSession.runs.forEach((r, i) => {
  r._neutralJpeg = state.capturedJpegsPerRun[i];
});
```

or simpler: change `runRepeatability` to capture both the vectors **and** the jpeg at the end of each capture into a parallel array.

On session-JSON save, also loop through each run and save its neutral image:

```js
// Session JSON (main artifact)
await saveToSession({
  filename: `${person}_repeatability_session.json`,
  content: JSON.stringify(state.lastSession, null, 2),
});

// Per-capture images (numbered 01..N)
for (let i = 0; i < state.lastSession.runs.length; i++) {
  const jpeg = state.capturedJpegsPerRun[i];
  if (!jpeg) continue;
  await saveToSession({
    filename: `${person}_neutral_${String(i + 1).padStart(2, "0")}.jpg`,
    content: dataUrlToBase64(jpeg),
    encoding: "base64",
  });
}
```

HTML report save remains single-file:
```js
await saveToSession({
  filename: `${person}_repeatability_report.html`,
  content: buildReportHtml(state.lastSession),
  encoding: "utf8",
});
```

Note we intentionally *don't* save each run's individual JSON to disk (the aggregate session JSON already contains all `runs[i].vectors`). The N images are the only per-run artifacts.

### 19.9 Out-of-scope / known tradeoffs

- **Calibration baseline is still global.** `localStorage["smile_poc_baseline_v1"]` has one entry, not per-person. If Sameen calibrates then GG captures, GG's quality gate uses Sameen's thresholds. Easy follow-up: add `__<person>` suffix to the storage key. Not doing it here to keep the diff tight; flag in the status log when a capture is using someone else's calibration.
- **Cancel flow.** The person picker has a Cancel button. No capture starts; buttons stay enabled. No session is created.
- **Person typo / new person.** Only "Sameen" and "GG" are accepted, server-side and client-side. Adding a third person requires editing `SAFE_PERSON` in `serve.py` and the two picker buttons in HTML.
- **Image size.** Full 1280×720 JPEG at quality 0.9 is ~100–200 KB. A 10-run repeatability session produces ~1–2 MB of images — acceptable on localhost, something to reconsider for cloud storage later.
- **Calibration captures no image.** The Calibrate flow (`calibration.js`) doesn't save anything today; keeping it that way.

### 19.10 Success criteria

- **Layout**: `ls poc/results/` after one Sameen single-capture and one GG repeatability shows exactly two top-level dirs (`Sameen/`, `GG/`), each with one timestamped subdir containing the expected files.
- **Filenames**: every file in `Sameen/.../ ` begins with `Sameen_`; every file in `GG/.../ ` begins with `GG_`.
- **Image**: opening `Sameen_neutral.jpg` in an image viewer shows the face mid-capture during the relax phase, before the user smiled.
- **Picker flow**: clicking *Start capture* briefly dims the video and shows the person picker; clicking *Sameen* or *GG* launches the capture; clicking *Cancel* closes the picker with no side effect.
- **Quality**: existing quality checks, HUD, sparklines, progression plots all unaffected.
- **Error path**: if the server is down, the Save button flashes red/"Error"; if a valid payload tries a bad person name (tamper via console), server returns 400 and client surfaces the error.

### 19.11 Todo list (phased, browser-review-gated)

#### Phase P0 — Server: accept person + sessionId + encoding
- [x] Added `SAFE_PERSON` (`Sameen|GG`), `SAFE_SESSION` (ISO timestamp slug) regexes to `poc/serve.py`.
- [x] Extended `do_POST` to parse and validate `person`, `sessionId`, `encoding`; builds nested path under `results/<person>/<sessionId>/`.
- [x] Supports `encoding: "base64"` (validated decode, `wb` file mode). Base64 roundtrip verified (`SGVsbG8gYmluYXJ5` → "Hello binary").
- [x] Smoke-tested: utf8 save ✓ (200), base64 save ✓ (200), bad person → 400, path-traversal → 400, bad sessionId → 400.
- **Checkpoint (browser review required):** curl outputs verified; see §19.11 comments. **— awaiting user review.**

#### Phase P1 — Client: person picker UI
- [x] Added `#person-picker` overlay inside `.stage` + styles in `poc/index.html`.
- [x] Added `pickPerson(titleText)` helper in `poc/main.js` returning `Promise<"Sameen"|"GG">`; rejects on Cancel.
- [x] Wired `captureBtn` and `repeatBtn` click handlers to `pickPerson()` first; Cancel is a no-op.
- [x] Stashes `state.currentSession = { person, sessionId, type }` on successful pick; also logs `session → <person>/<sessionId>`.
- [x] Added `currentSession`, `neutralJpeg`, `capturedJpegsPerRun` placeholders to state (populated in P2-P5).
- **Checkpoint (browser review required):** clicking either Start button shows the overlay; Sameen / GG launches the flow; Cancel closes cleanly. **— awaiting user review.**

#### Phase P2 — Client: neutral-frame JPEG capture
- [x] Added `grabVideoFrameJpeg(video, canvas, ctx, quality)` to `poc/pixels.js`.
- [x] Extended `onNeutral` hook in `main.js` to grab the JPEG data URL into `state.neutralJpeg`.
- [x] Reset `state.neutralJpeg` on `countdown` phase entry alongside `pixelSnapshots`.
- [x] Log line `neutral snap (X.X ms) — … + jpeg ~180KB` on each capture.

#### Phase P3 — Client: `saveToSession` + single-capture save rewiring
- [x] Added `saveToSession({ filename, content, encoding, person, sessionId })` and `dataUrlToBase64` helpers in `main.js`.
- [x] Rewrote `saveBtn` handler to save `${person}_capture.json` + `${person}_neutral.jpg` (base64-encoded) to the current session dir.
- [x] Rewrote the repeatability `reportBtn` + `sessionJsonBtn` handlers to session-aware paths too (covered P5's single-file saves; per-run jpeg fan-out still pending in P4+P5).
- [x] `flashSaved` / `flashError` wired; each path logged.
- [x] Replaced `window.__saveJson` / `__saveText` debug exports with `__saveToSession`.
- **Checkpoint (browser review required):** after a single capture with picker → Sameen, clicking Save writes `Sameen_capture.json` + `Sameen_neutral.jpg` into `results/Sameen/<sessionId>/`. Opening the JPG shows your neutral face. **— awaiting user review.**

#### Phase P4 — Client: repeatability harness captures per-run jpegs
- [ ] In `main.js`, maintain `state.capturedJpegsPerRun = []` during a repeatability run.
- [ ] On each `runSingleCapture` resolution, push `state.neutralJpeg` into that array.
- [ ] Clear the array at the start of a new repeatability run.
- [ ] Verify `state.capturedJpegsPerRun.length === N` at end of run.
- **Checkpoint (browser review required):** devtools console confirms `state.capturedJpegsPerRun.length === 10` after a 10-run session; preview a mid-array entry with `new Image().src = state.capturedJpegsPerRun[5]`.

#### Phase P5 — Client: repeatability save fan-out
- [ ] Rewrite `sessionJsonBtn` click handler: save `${person}_repeatability_session.json` + loop `i=0..N-1` saving `${person}_neutral_<NN>.jpg`.
- [ ] Rewrite `reportBtn` click handler: save `${person}_repeatability_report.html`.
- [ ] Both handlers use the same `state.currentSession.person`/`sessionId` — the session dir already exists on the server from earlier capture writes, so we're just appending.
- **Checkpoint (browser review required):** after a 10-run run, clicking both save buttons results in one dir under `results/<person>/<sessionId>/` containing 10 JPGs + 1 session JSON + 1 HTML report, all prefixed with the person name.

#### Phase P4 — Client: repeatability harness captures per-run jpegs
- [ ] In `main.js`, maintain `state.capturedJpegsPerRun = []` during a repeatability run.
- [ ] On each `runSingleCapture` resolution, push `state.neutralJpeg` into that array.
- [ ] Clear the array at the start of a new repeatability run.
- [ ] Verify `state.capturedJpegsPerRun.length === N` at end of run.
- **Checkpoint (browser review required):** devtools console confirms `state.capturedJpegsPerRun.length === 10` after a 10-run session; preview a mid-array entry with `new Image().src = state.capturedJpegsPerRun[5]`.

#### Phase P5 — Client: repeatability save fan-out
- [ ] Rewrite `sessionJsonBtn` click handler: save `${person}_repeatability_session.json` + loop `i=0..N-1` saving `${person}_neutral_<NN>.jpg`.
- [ ] Rewrite `reportBtn` click handler: save `${person}_repeatability_report.html`.
- [ ] Both handlers use the same `state.currentSession.person`/`sessionId` — the session dir already exists on the server from earlier capture writes, so we're just appending.
- **Checkpoint (browser review required):** after a 10-run run, clicking both save buttons results in one dir under `results/<person>/<sessionId>/` containing 10 JPGs + 1 session JSON + 1 HTML report, all prefixed with the person name.

#### Phase P6 — Commit
- [ ] All phases green; no regressions on the single-capture flow.
- [ ] Leave calibration as-is with a note in the log panel when a capture runs under a calibration that was performed by the *other* person (this is just a `state.baseline.calibratedFor` field added opportunistically; optional).
- [ ] Keep `results/.gitignore` wildcard-ignore as-is; per-person subdirs are covered automatically.

## 20. Modification: simplified 4-phase capture flow

### 20.1 What we're changing and why

Current state machine has 6 recording phases (plus countdown + done) with multiple transition heuristics (smile onset threshold, plateau detection). This creates fragile transitions that hang if detection flickers. The user wants a simpler, purely time-based 4-phase flow:

```
COUNTDOWN  →  NEUTRAL  →  SMILE  →  RELEASE  →  RELAX  →  DONE
(not recorded)  (record)   (record)   (record)    (record)
```

### 20.2 Phase mapping (old → new)

| Old phases | New phase | Purpose |
|---|---|---|
| `relax` | **NEUTRAL** | Capture neutral-face baseline frames + pixel snapshot + JPEG |
| `smiling` + `hold` | **SMILE** | Capture smile-peak frames — merged into one phase, 2× current duration |
| `release_cue` + `release` | **RELEASE** | Capture face returning from smile |
| *(new)* | **RELAX** | Post-release settling phase, 2× current neutral duration |

### 20.3 Duration table

| Phase | Old duration(s) | New duration | Rationale |
|---|---|---|---|
| countdown | 2500 ms | 2500 ms | unchanged — prep time |
| **NEUTRAL** | 1500 ms (`relaxMs`) | **1500 ms** | unchanged — enough for ~45 neutral frames |
| **SMILE** | ~2900 ms (`smileWaitFallback` + `hold`) | **2750 ms** | purely time-based — no onset detection, no plateau detection |
| **RELEASE** | ~2000 ms (`releaseCue` + `release`) | **1200 ms** | keep existing release duration; cue merged in |
| **RELAX** | *(didn't exist)* | **3000 ms** (2 × old neutral) | doubled; captures full rebound/settling |

Total recording time: 1500 + 2750 + 1200 + 3000 = **8450 ms** (previously ~7400 ms).
Total with countdown: ~11.5 s per capture.

### 20.4 State machine simplification

All transitions are **pure wall-clock**. No blendshape thresholds, no plateau detection, no fallback timers. Every phase advances after its fixed duration expires. This eliminates the class of "hang" bugs entirely.

```js
const CFG = {
  countdownMs: 2500,
  neutralMs: 1500,
  smileMs: 2750,
  releaseMs: 1200,
  relaxMs: 3000,
};

// Feed body (after countdown):
if (phase === "neutral")      { if (sinceStart >= CFG.neutralMs)  setPhase("smile", t); }
else if (phase === "smile")   { if (sinceStart >= CFG.smileMs)    setPhase("release", t); }
else if (phase === "release") { if (sinceStart >= CFG.releaseMs)  setPhase("relax", t); }
else if (phase === "relax")   { if (sinceStart >= CFG.relaxMs)    finish(t, "ok"); }
```

### 20.5 Pixel hook timing

| Hook | Old trigger | New trigger |
|---|---|---|
| `onNeutral` (pixel snapshot + JPEG) | `relax → smiling` transition | `neutral → smile` transition |
| `onPeak` (pixel snapshot) | `hold → release_cue` transition | `smile → release` transition |

No change in what's captured — just which phase-boundary name triggers each hook.

### 20.6 Banner display

| Phase | Action text | Subtext | Color | Progress bar |
|---|---|---|---|---|
| countdown | Get ready · N | face the camera, relaxed | white | yes |
| **neutral** | Neutral | stay still, neutral face | white | yes |
| **smile** | Smile · N | big natural smile and hold | yellow | yes, countdown |
| **release** | Release | let the smile drop | green | yes |
| **relax** | Relax · N | face back to neutral | green | yes, countdown |
| done | Done | processing… | white | no |

### 20.7 Feature extractor impact

`features.js` uses `framesInPhase(capture, "<name>")`. Update the phase names:
- `"relax"` → `"neutral"` (neutral reference)
- `"hold"` → `"smile"` (smile peak)
- `"release"` → `"release"` (unchanged name)
- Add `"relax"` frames to the rebound/settling analysis (NEW data — longer tail than before)

`quality.js` — update `byPhase()` calls to new names. Drop `no_hold` flag (hold is gone); the `smile_dropped_in_hold` check becomes `smile_dropped_in_smile`.

### 20.8 Files touched

- `poc/capture.js` — complete rewrite of CFG, PHASE_DURATIONS_MS, PHASE_DISPLAY, and the `feed()` body.
- `poc/main.js` — update pixel-hook phase-boundary names (`"neutral" → "smile"`, `"smile" → "release"`).
- `poc/features.js` — update `framesInPhase` calls: `"relax"` → `"neutral"`, `"hold"` → `"smile"`, add `"relax"` to rebound analysis.
- `poc/quality.js` — update `byPhase` calls to new names.
- `poc/draw.js` — `release_cue` color case removed (no longer exists).

### 20.9 Todo list (phased, browser-review-gated)

#### Phase F0 — Rewrite capture.js state machine
- [x] Replaced CFG with `{ countdownMs: 2500, neutralMs: 1500, smileMs: 2750, releaseMs: 1200, relaxMs: 3000 }`.
- [ ] Update PHASE_DURATIONS_MS, PHASE_DISPLAY, PHASES for the 4 recording phases.
- [ ] Rewrite `feed()` body: pure wall-clock transitions, no blendshape checks.
- [ ] Update `getDisplay()` countdown text for smile + relax phases.
- [ ] Update `cloneLandmarks` frame tagging (remove `release_cue` remapping).
- **Checkpoint (browser review required):** capture flows through all 4 phases with correct timings and banner text. Log shows phase transitions matching the new names.

#### Phase F1 — Update pixel hooks + draw.js
- [ ] In `main.js`, change pixel-hook phase-boundary detection from `prevPhase === "relax" && curPhase === "smiling"` to `prevPhase === "neutral" && curPhase === "smile"`.
- [ ] Change peak hook from `prevPhase === "hold" && curPhase === "release_cue"` to `prevPhase === "smile" && curPhase === "release"`.
- [ ] In `draw.js`, remove the `release_cue` flash color case; update `smile`/`hold` → `smile` mapping.
- **Checkpoint (browser review required):** neutral pixel snapshot + JPEG fires at neutral→smile boundary; peak snapshot fires at smile→release boundary. Log confirms both.

#### Phase F2 — Update features.js + quality.js
- [ ] In `features.js`, rename phase references: `framesInPhase(capture, "relax")` → `"neutral"`, `"hold"` → `"smile"`.
- [ ] Extend rebound analysis to include `"relax"` phase frames (longer settling tail).
- [ ] In `quality.js`, update all `byPhase()` calls. Rename `no_hold` → remove (always present now). Rename `smile_dropped_in_hold` → `smile_dropped_in_smile`.
- **Checkpoint (browser review required):** run a capture, click Save, inspect the JSON — vectors populate correctly, quality checks pass on a clean capture.

#### Phase F3 — Commit
- [ ] All phases green, no regressions.
- [ ] Update `math.md` §0.3 to reflect the new phase names.

