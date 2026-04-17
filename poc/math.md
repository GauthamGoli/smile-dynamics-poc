# Math behind the smile-dynamics extractor

One page per feature. Each block: **what is computed**, **why**, and **what the output number means** when you stare at it in the capture JSON.

Source of every formula: `poc/features.js`, `poc/pixels.js`, `poc/quality.js`, `poc/hud.js`.

---

## 0. Preliminaries

### 0.1 Landmark coordinates

MediaPipe returns 478 3-D facial landmarks with `(x, y, z)` in normalized image coordinates — `x, y ∈ [0, 1]` across the image frame, `z` ≈ depth in the same normalized units. All geometry below is 2-D in `(x, y)` unless noted.

### 0.2 Inter-ocular distance (IOD)

```
IOD = ||landmark[33] − landmark[263]||₂
```

Landmarks 33 and 263 are the outer eye corners. IOD is the natural per-face scale: it grows/shrinks with camera distance and face size, and is rotation-invariant for small roll. We divide every length by IOD so vectors are comparable across captures with different distances/faces.

Output: `normalization.iodNeutral`, `normalization.iodPeak` (pixel values in the face-normalized frame; included for debugging/repeatability, not for direct interpretation).

### 0.3 Neutral reference and smile-peak frame

- **Neutral reference**: per-landmark **median** across all RELAX-phase frames.
  ```
  neutral[i] = median_k(relaxFrames[k].landmarks[i])
  ```
  The median rejects single-frame outliers (momentary blink, detection glitch) while still giving a per-coordinate position. Used as the denominator/subtrahend for every Δ in §2.

- **Smile-peak frame**: the single HOLD-phase frame where the raw `mouthSmile = (mouthSmileLeft + mouthSmileRight) / 2` is maximal (falls back to SMILING frames if hold is empty).
  Used for stiffness (needs the instantaneous blendshape + landmark pair).

- **Plateau median**: per-landmark median across HOLD-phase frames. Stable geometric reference for the smile; used for eye/cheek/nasolabial deltas.

---

## 1. Geometric smile vectors

Face-normalized coordinates are used throughout: `p_norm = p.y / IOD`. Subtracting y-values gives a number in units of "fraction of IOD".

### 1.1 Eye aperture dynamic response — §7.2 bullet 1

**Why.** A genuine (Duchenne) smile recruits orbicularis oculi, narrowing the eye. A posed smile barely touches the eye. Measuring the Δ opening neutral → peak captures *how much the smile reaches the eyes*.

**Formula** (per side):
```
opening = |upperLidY − lowerLidY| / IOD        (landmarks 159/145 left, 386/374 right)
Δopening = opening_peak − opening_neutral
asymmetry = |Δleft − Δright|
```

**Output** (`smile.eyeApertureDelta`): `{ left, right, asymmetry }`.

**Interpretation.** Negative values = eye closed more during smile (expected for a real smile). Magnitudes ≈ 0.01–0.04 (roughly 1–4% of IOD). `asymmetry` near 0 means both eyes engage equally.

---

### 1.2 Cheek lift symmetry response — §7.2 bullet 2

**Why.** Cheek apex rise is the core tissue-motion signature of a smile. Comparing left vs right isolates the *evenness* of engagement.

**Formula:**
```
lift = (y_neutral − y_peak) / IOD              (landmark 205 left, 425 right)
symmetry = 1 − |left − right| / max(|mean|, ε)
```

Image y grows downward, so `lift > 0` when cheek rose.

**Output** (`smile.cheekLift`): `{ left, right, symmetry }`.

**Interpretation.** `left`/`right` typically 0.08–0.20 (IOD fractions). `symmetry` ranges `[−∞, 1]`; 1 = identical L/R, 0.95+ = clean smile, < 0.85 = visibly lopsided. `symmetry` is the POC's most repeatable vector (CV ≈ 0.02 in our 10-run session) because numerator and denominator covary.

---

### 1.3 Nasolabial expression response — §7.2 bullet 3

**Why.** The nasolabial fold (nose-wing → mouth-corner crease) visibly elongates and curves when a smile engages. Change in length + curvature captures how pronounced the fold becomes.

**Formula** — polyline of indices `I = [129, 203, 206, 216]` (left; mirror for right):

Length (face-normalized):
```
L(I) = (Σ_{k=1..n-1} ||p_{I[k]} − p_{I[k-1]}||) / IOD
```

Turning-angle sum (total curvature):
```
C(I) = Σ_{k=1..n-2} arccos( v̂_k · v̂_{k+1} )
   where v_k = p_{I[k]} − p_{I[k-1]}
```

Per-side deltas neutral → peak:
```
dLength = L_peak − L_neutral
dCurvature = C_peak − C_neutral
```

**Output** (`smile.nasolabialResponse`): `{ left:{dLength,dCurvature}, right:{dLength,dCurvature} }`.

**Interpretation.** Expect `dLength` slightly **negative** (the polyline shortens as the mouth corner rises toward the nose) and `dCurvature` **positive** (the line bends more when the crease activates). Magnitudes are small; sign and consistency carry the signal.

---

### 1.4 Movement symmetry and stiffness — §7.2 bullet 5

Two distinct but related numbers, both computed from the `(neutral → peak)` landmark displacement field over a wider set of landmarks.

**Symmetry** — over `LEFT = [205,207,187,147,61,91,57,212]` and matched `RIGHT`:
```
S_side = Σ_i ||p_peak[i] − p_neutral[i]|| / IOD
movementSymmetry = 1 − |S_left − S_right| / max((S_left + S_right) / 2, ε)
```

**Stiffness** — how much tissue moved *per unit of smile-blendshape intensity*:
```
mouthSmilePeak = (mouthSmileLeft + mouthSmileRight) / 2        (at peak frame)
maxCheek = max(|cheekDyLeft|, |cheekDyRight|) / IOD
stiffness = mouthSmilePeak / max(maxCheek, 1e-4)
```

**Output** (`smile.movementSymmetry`, `smile.stiffness`, `smile.cheekDisplacement`, `smile.smilePeak`).

**Interpretation.**
- `movementSymmetry ∈ [−∞, 1]`, 1 = perfectly symmetric displacement. Typical clean smile ≥ 0.9.
- `stiffness` has units `blendshape / IOD-fraction`. Higher = more expression-intensity per unit of tissue movement = stiffer / less mobile face. Low = face moves a lot for the smile it's making.
- Caveat: `stiffness` inherits noise from `maxCheek` (which was the red CV offender in our repeatability run); don't trust a single capture's absolute value without baselining.

---

### 1.5 Expression rebound tendency — §7.2 bullet 7

**Why.** After the smile releases, how fast and cleanly the face returns to neutral is a proxy for tissue elasticity / recovery speed.

**Formula.**

Rebound time:
```
reboundMs = min{ t − t_peak : t > t_peak, frame at t is in RELEASE phase, smile(t) < 0.15 }
```
If no release frame crosses 0.15, returns `null` (smile never fully dropped inside the captured window).

Overshoot:
```
baselineY = (neutral[205].y + neutral[425].y) / (2 · IOD)
for each release frame f:
    y_f = (f.landmarks[205].y + f.landmarks[425].y) / (2 · IOD_f)
    delta_f = y_f − baselineY          // positive = cheek above baseline = overshoot
overshoot = max_f(|delta_f|), signed
```

**Output** (`smile.rebound`): `{ reboundMs, overshoot }`.

**Interpretation.** `reboundMs` typically 200–600 ms for a quick release; in a longer guided capture the value is dominated by when the user chose to relax, so read it as relative-across-captures rather than absolute. `overshoot` is usually near zero; a positive value means the cheek dipped *below* baseline before settling.

---

### 1.6 Eye-squint blendshape cross-check

**Why.** A sanity check that the geometric eye-aperture measurement agrees with MediaPipe's own `eyeSquintLeft/Right` blendshape. Divergence between them would suggest either the eye-lid landmarks are drifting or the blendshape is mis-calibrated.

**Formula.**
```
baselineSquint_side = mean_k(relaxFrames[k].blendshapes.eyeSquint_side)
squintDelta_side = peakFrame.blendshapes.eyeSquint_side − baselineSquint_side
```

**Output** (`smile.eyeSquintCrossCheck`): `{ squintDeltaLeft, squintDeltaRight }`.

**Interpretation.** Should be positive during a real smile (squint increases). Correlates roughly with the inverse of `eyeApertureDelta` if everything is consistent.

---

## 2. Pixel-dependent smile vectors (§7.2 bullets 4, 6)

Pixel features are sampled **once at the end of the relax phase** (neutral snapshot) and **once at the start of the release cue** (peak snapshot), not every frame. Two full-video-frame reads per capture.

### 2.1 sRGB → LAB (D65) — color-conversion helper

Required because LAB's `L*` channel approximates human lightness perception far better than any RGB component. Used for shadow redistribution.

```
linearize: c' = c/12.92 if c ≤ 0.04045 else ((c+0.055)/1.055)^2.4

[X Y Z] = M · [R' G' B']   with D65 sRGB matrix M (features.js srgbToLab)
xr = X/0.95047,  yr = Y/1.0,  zr = Z/1.08883
f(t) = cbrt(t) if t > 216/24389 else (t·24389/27 + 16)/116

L = 116·f(yr) − 16          (0..100, perceptual lightness)
a = 500·(f(xr) − f(yr))     (−128..127, green–red)
b = 200·(f(yr) − f(zr))     (−128..127, blue–yellow)
```

We use only `L` in the POC.

### 2.2 ROI sampling

For each of the 7 ROIs (`cheek_left/right`, `nasolabial_left/right`, `infraorbital_left/right`, `forehead`), build the polygon in video-pixel coordinates from the landmark list, compute its bounding box, and scan that bbox. For each pixel:
- **Point-in-polygon** (ray casting): include only pixels strictly inside the polygon.
- Convert to LAB once, accumulate `L` into the mean and the Sobel gradient into the edge-density sum.

Output per ROI: `{ meanL, edgeDensity, n }` where `n` is the number of inside-polygon pixels.

### 2.3 Dynamic shadow redistribution — §7.2 bullet 4

**Why.** Smiling moves tissue, which moves where shadows fall. A brightening/darkening of the nasolabial ROI neutral → peak is a direct reading of *where light and shade shifted on the face*, independent of landmark geometry.

**Formula (per ROI):**
```
dMeanL = peak.meanL − neutral.meanL
```

**Output** (`smile.shadowRedistribution[<roi>].dMeanL`).

**Interpretation.** Units of LAB L* (0..100). Expect:
- Nasolabial ROIs **negative** (crease darkens as the fold deepens).
- Cheek ROIs **slightly positive** (cheek apex gets lit up as it rises).
- Forehead near 0 (doesn't move during a smile).
Magnitudes a few L* units; direction and cross-capture consistency matter more than the absolute value.

### 2.4 Dynamic fold visibility — §7.2 bullet 6

**Why.** Fold visibility = how prominent the crease edge is. We approximate this with Sobel edge density on the L channel inside each ROI; the delta neutral → peak reports how much *more* edge the smile created.

**Formula (per pixel inside the ROI):**
```
Gx = 3×3 Sobel-x applied to L
Gy = 3×3 Sobel-y applied to L
edge(x,y) = |Gx| + |Gy|
edgeDensity = mean_{inside polygon} edge(x,y)
dEdgeDensity = peak.edgeDensity − neutral.edgeDensity
```

**Output** (`smile.foldVisibility[<roi>].dEdgeDensity`).

**Interpretation.** Positive = fold becomes more visible during the smile. Nasolabial ROIs typically spike the most (10+ units). Plan §7.2 flags this as *trend-gated* — a single capture's value is noisy and only longitudinal trends are trustworthy.

---

## 3. Quality gate (non-pixel)

All checks run on `capture.frames`. Each produces one of {`pose_excess`, `frame_shift`, `blinky_neutral`, `weak_smile`, `smile_dropped_in_hold`, `pose_drift`, `face_missing`, `no_relax`, `no_hold`, `no_release`}. Score = `1 − #flags / 10`, clamped at 0.

### 3.1 Head pose from the facial transformation matrix

MediaPipe's 4×4 face-to-canonical matrix, column-major. Standard Euler extraction:
```
yaw   = atan2(M[0,2], M[2,2]) · 180/π
pitch = asin(clamp(−M[1,2], −1, 1)) · 180/π
roll  = atan2(M[1,0], M[1,1]) · 180/π
```

**poseRange** per axis = `max − min` across all capture frames. Any axis range > `poseRangeDeg` limit → `pose_excess`. Default 15°; overridden by calibration baseline.

### 3.2 Bounding-box IoU per phase

For each phase (`relax`, `hold`, `release`), take `bbox(landmarks)` of the first phase frame and compute IoU with every subsequent frame of the same phase. The minimum IoU *within the worst phase* must exceed `bboxIouMin` (default 0.88; calibrated from your resting drift). Below → `frame_shift`.

Rationale: the face bbox legitimately widens during a smile (mouth expands), so we never compare across phases. This catches actual head displacement without punishing the smile itself.

### 3.3 Blink fraction in relax

```
blinkFraction = (1 / |relax|) · Σ 1{(eyeBlinkLeft + eyeBlinkRight)/2 > blinkThreshold}
```
Must be ≤ 0.25. Calibrated `blinkThreshold` floors at 0.5 and uses `restingBlinkMax + 0.15` if you've calibrated.

### 3.4 Smile peak and sustain

```
smilePeak = max over HOLD frames of frame.smile        (≥ 0.35 or weak_smile)
holdFloor = max(0.25, smilePeak · 0.6)
smileDropFracInHold = fraction of HOLD frames where smile < holdFloor   (≤ 0.30 or smile_dropped_in_hold)
```

Catches weak smiles and smiles that you couldn't sustain through the hold window.

### 3.5 Pose drift (relax → hold)

Mean pose per phase; drift = max across axes of `|meanHold − meanRelax|`. Must be ≤ 8°. Above → `pose_drift`. Catches leaning-into-smile — the common subtle failure mode where users unconsciously tilt as they smile.

### 3.6 Face presence

```
missingFaceFrac = 1 − (frames_with_any_landmarks / total_frames)    (≤ 0.05 or face_missing)
```

---

## 4. Calibration thresholds (per-user limits)

Run `calibration.js` on a 4-second rest window. For each baseline sample: pose, bbox, blink, smile. The limits that feed `quality.gate`:

```
poseRangeDeg    = max(10, poseMax_observed + 6)
bboxIouMin      = clamp(0.7, 0.95, bboxIoU_observed − 0.05)
blinkThreshold  = max(0.5, restingBlinkMax + 0.15)
```

Margins are additive safety bands: tolerate your *resting* noise plus a buffer before flagging as bad.

---

## 5. Repeatability statistics (across N captures)

Per vector leaf path `k`, over the subset of runs with `quality.flags == []`:

```
μ_k = (1/n) Σ x_i
σ_k = sqrt( (1/(n-1)) Σ (x_i − μ_k)² )
CV_k = σ_k / |μ_k|   if |μ_k| > 1e-9, else undefined
```

Color bands (§17 & repeatability table): green `CV < 0.10`, amber `0.10 ≤ CV < 0.25`, red `CV ≥ 0.25`, grey for undefined (near-zero mean).

### 5.1 What CV means operationally

`σ` is the 1-sigma spread. Assuming roughly normal noise, ~68% of repeated captures fall within `μ ± σ`, ~95% within `μ ± 2σ`. So a vector with `CV = 0.10` needs a **≥ 20% change from baseline** to call a new reading "different from noise" with 95% confidence.

Therefore:
- `CV < 0.05` → resolves ~10% daily changes
- `CV ≈ 0.10` → resolves ~20% daily changes (good enough for sleep/alcohol signals)
- `CV > 0.25` → only resolves > 50% changes — marginal
- `CV > 0.50` → signal buried in noise

### 5.2 Near-zero-mean trap

When a vector's true mean is ~0 (forehead dMeanL, asymmetry metrics, rebound overshoot), the denominator `|μ|` goes to zero and CV explodes. This is a CV *artifact*, not a measurement problem. Trust `σ` directly for those features: σ tells you the raw spread in the vector's native units.

---

## 6. HUD live statistics (real-time sidebar)

### 6.1 Ring buffer

Per metric: `Float32Array` of size 1800 (≈ 60 s at 30 fps). `push(key, raw)` writes at `buf[i]`, advances `i = (i+1) mod 1800`, clamps `n ≤ 1800`.

### 6.2 Running stats (over the 60 s window)

```
mean   = (1/n) Σ v_k      (NaN entries skipped)
sigma  = sqrt( (1/(n-1)) Σ (v_k − mean)² )
min,max across valid v_k
```

Used to anchor the sparkline's y-axis (min/max over 60 s) and the ±1σ band around the mean.

### 6.3 Display trace (last 5 s)

```
displayLen = min(n, 150)     (≈ 5 s @ 30 fps)
start = (i − displayLen + 1800) mod 1800
```

Iterates `displayLen` samples chronologically to draw the trace.

### 6.4 Minimum y-span floor

Without a floor, auto-scaling to `[min, max]` makes micro-noise fill the canvas and look alarmingly twitchy. We enforce `span ≥ minSpan_class`:

```
span = max(max − min, minSpan_class, ε·|mean|)
```

`minSpan_class`:
- blendshapes (0..1 range): `0.10`
- pose (degrees): `5.0`
- face-normalized geometry: `0.02`

This keeps tiny wiggles looking tiny and still lets genuine motion fill the plot.
