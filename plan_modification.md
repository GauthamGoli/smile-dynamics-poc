# Plan: Move Guided Smile Instructions Over the Eyes

> Saved as `plan_modification.md` rather than `plan.md` because `plan.md` already exists (product plan, gitignored) and would be destroyed.

## Goal
Reposition the guided-capture banner (phase action + subtext + progress bar) so it anchors over the user's eyes instead of floating at the top-center of the frame. Intent: keep the user's gaze near the camera lens while they read the cue, reducing the eyes-drifting-down behavior caused by a top banner.

## Where the banner lives today
Rendered by `drawPhaseBanner(ctx, display, w, h)` in `poc/draw.js:109`, called from `render(...)` at `poc/draw.js:188`.

Current placement (`poc/draw.js:116-120`):
```js
const boxW = Math.round(Math.min(w * 0.7, 620 * dpr));
const boxH = actionPx + subtextPx + pad * 3 + (progress != null ? 10 * dpr : 0);
const boxX = (w - boxW) / 2;
const boxY = pad;
```
The overlay canvas is horizontally mirrored (selfie view), so the banner counter-mirrors its text with `ctx.translate(w/2, 0); ctx.scale(-1, 1)` (`poc/draw.js:126-127`).

The render call site (`poc/main.js:205`) already passes `landmarks` into `render`:
```js
drawOverlay(landmarks, ctx, overlay.width, overlay.height, snap, getDisplay());
```
`render` just doesn't forward them to `drawPhaseBanner` today.

## Target placement
Anchor the banner over the eye region, centered horizontally between the eye corners and vertically centered on the upper-eyelid line. Landmarks of interest (already used elsewhere in the code):
- `33` — left eye outer corner (`poc/hud.js:159`)
- `263` — right eye outer corner
- `159` — left upper eyelid
- `386` — right upper eyelid

Compute anchor in canvas pixels (landmarks are normalized 0–1):
```js
const L = landmarks[33], R = landmarks[263];
const UL = landmarks[159], UR = landmarks[386];
const cx = ((L.x + R.x) / 2) * w;
const cy = ((UL.y + UR.y) / 2) * h;
const eyeSpanPx = Math.abs(R.x - L.x) * w;  // interocular distance in px
```

Size the box relative to interocular distance so it scales with face-to-camera distance. The lower bound is derived from `ctx.measureText` on the widest subtext at the minimum legible font size — no hand-tuned magic number:
```js
// compute the floor once (or whenever dpr changes) from the widest subtext string
const MIN_SUBTEXT_PX = 11;  // CSS px, the smallest legible size we'll use
const SUBTEXTS = Object.values(PHASE_DISPLAY).map(d => d.subtext);  // import from capture.js
ctx.font = `${MIN_SUBTEXT_PX * dpr}px ui-monospace, Menlo, monospace`;
const widestSubtextPx = Math.max(...SUBTEXTS.map(s => ctx.measureText(s).width));
const minBoxW = widestSubtextPx + pad * 2;   // text + horizontal padding

const boxW = Math.max(minBoxW, Math.min(w * 0.9, eyeSpanPx * 2.2));
// boxH still determined by text metrics
const boxX = cx - boxW / 2;
const boxY = cy - boxH / 2;           // centered on the eye line
// clamp inside canvas
const boxX_c = Math.max(0, Math.min(w - boxW, boxX));
const boxY_c = Math.max(0, Math.min(h - boxH, boxY));
```
Cache `minBoxW` across frames and invalidate it only when `dpr` changes. This way the floor self-adjusts if subtext strings are ever edited in `capture.js`.

## Fallback when no landmarks
`drawPhaseBanner` runs every frame, including during `countdown` and `done` where the face may momentarily be missing. If `landmarks` is null, fall back to the existing top-centered layout so the user still sees the cue.

```js
function drawPhaseBanner(ctx, display, w, h, landmarks) {
  if (!display || display.phase === "idle") return;
  const anchor = landmarks ? anchorOverEyes(landmarks, w, h) : anchorTopCenter(w, h);
  drawBannerAt(ctx, display, anchor, w, h);
}
```

## Jitter damping
Raw landmark positions jitter frame-to-frame; a banner tracking them exactly will shake. Add a lightweight exponential smoother in module scope inside `poc/draw.js`:
```js
let smoothedAnchor = null;
function smoothAnchor(next, alpha = 0.2) {
  if (!smoothedAnchor) { smoothedAnchor = { ...next }; return smoothedAnchor; }
  smoothedAnchor.cx   = smoothedAnchor.cx   * (1 - alpha) + next.cx   * alpha;
  smoothedAnchor.cy   = smoothedAnchor.cy   * (1 - alpha) + next.cy   * alpha;
  smoothedAnchor.boxW = smoothedAnchor.boxW * (1 - alpha) + next.boxW * alpha;
  return smoothedAnchor;
}
```
Reset `smoothedAnchor = null` when `display.phase === "idle"` so stale state doesn't carry across captures.

## Mirror-transform update
Today the banner draws centered on `x=0` after `ctx.translate(w/2, 0); ctx.scale(-1, 1)`. With an arbitrary anchor `cx`, translate to the mirrored x of the anchor instead:
```js
ctx.translate(w - cx, 0);
ctx.scale(-1, 1);
ctx.textAlign = "center";
ctx.fillText(action,  0, boxY_c + pad);
ctx.fillText(subtext, 0, boxY_c + pad + actionPx + pad / 2);
```
The background rect and progress bar are drawn in unmirrored space (same as today), using `boxX_c`/`boxY_c`.

## Text scaling
Current font sizes (`30px` action, `14px` subtext × dpr) may overflow the narrower eye-anchored box at typical laptop camera distances. Scale proportionally to `boxW` with a floor so cues stay readable on small boxes:
```js
const actionPx  = Math.max(18 * dpr, Math.min(30 * dpr, boxW * 0.11));
const subtextPx = Math.max(11 * dpr, Math.min(14 * dpr, boxW * 0.055));
```
Drop progress-bar height from `4*dpr` to `3*dpr`.

## Visual concerns and mitigations
1. **Banner covers eyes in preview.** Acceptable tradeoff — actual analysis runs on the raw camera frame (blink/squint/landmark detection is unaffected; the overlay is a separate canvas layer on top). Only the user's *self-view* of their eyes is partially occluded.
2. **Readability against skin/background.** Keep `rgba(0,0,0,0.72)` fill; bump to `0.80` if contrast is weak during testing.
3. **Distraction from head-tracked motion.** Smoothing (above) should keep motion subtle. If it still feels jumpy, increase smoothing window or switch to only updating position every ~100 ms.
4. **Phases where landmarks aren't reliable.** `countdown` and `done` fall back to top-center banner; `idle` skips drawing entirely (unchanged).

## Proposed code changes

### `poc/draw.js`
1. Change signature: `drawPhaseBanner(ctx, display, w, h, landmarks)`.
2. Add `anchorOverEyes(landmarks, w, h)` and `anchorTopCenter(w, h)` helpers returning `{ cx, cy, boxW }`.
3. Add module-scope `smoothedAnchor` + reset when `display.phase === "idle"`.
4. Replace fixed `boxX = (w - boxW) / 2; boxY = pad;` block with anchor-driven positioning + canvas clamp.
5. Update mirror translate from `w/2` to `w - cx`.
6. Scale font sizes from `boxW`.
7. Update `render` at `poc/draw.js:188` to forward landmarks:
   ```js
   drawPhaseBanner(ctx, display, w, h, landmarks);
   ```

### No changes to
- `poc/main.js` — already passes landmarks into `render`.
- `poc/capture.js` — phase/display logic unchanged.
- `poc/hud.js` — side-panel readouts unchanged.
- `poc/quality.js` / `poc/features.js` — analysis is on raw frames, not the overlay.

## Test plan
1. Start `python3 poc/serve.py`; open `http://localhost:8765/`.
2. Run a full capture with face centered: verify banner follows head smoothly, stays centered over eyes during `countdown`, `neutral`, `smile`, `release`, `relax`, `done`.
3. Move head side-to-side mid-capture: banner should track without jitter; text should stay legible.
4. Move close / far from camera: `boxW` should scale with interocular distance and not overflow canvas at close range (clamp kicks in).
5. Cover the face briefly during `countdown`: banner should snap to top-center fallback, then return to eye-anchor when the face reappears.
6. Confirm side-HUD `mouthSmileLeft/Right` and blink readouts still update in real time (proves overlay change is cosmetic — analysis path untouched).
7. Save a session and diff `quality_json` structure against a prior saved session; no new flags should appear.

## Rollback
Single file, single function. If the eye-anchored placement is worse in practice, revert `poc/draw.js` to use the top-center `boxX`/`boxY`. The `landmarks` parameter can stay as an unused argument or be removed — the `main.js` call site passes it harmlessly either way.

---

# Plan: Render All POIs as Points Except Nasolabial

## Goal
Replace the polygon / segment rendering for the ROI overlays with simple filled dots at each landmark, so the user sees discrete "points on face" markers. Keep **nasolabial** as a polyline because the line traces the fold direction and loses meaning as isolated dots.

## Where the rendering lives today
`poc/draw.js:11-17`:
```js
export const ROI_GROUPS = [
  { key: "cheek",        label: "cheeks",        color: "#ff3b3b", kind: "polygon",  sets: [LEFT_CHEEK_APEX, RIGHT_CHEEK_APEX] },
  { key: "nasolabial",   label: "nasolabial",    color: "#ffcc00", kind: "polyline", sets: [LEFT_NASOLABIAL, RIGHT_NASOLABIAL] },
  { key: "infraorbital", label: "infraorbital",  color: "#00c3ff", kind: "polygon",  sets: [LEFT_INFRAORBITAL, RIGHT_INFRAORBITAL] },
  { key: "forehead",     label: "forehead ref",  color: "#9ef28f", kind: "polygon",  sets: [FOREHEAD_REF] },
  { key: "eyes",         label: "eye aperture",  color: "#c78bff", kind: "segments", sets: [[[159, 145]], [[386, 374]]] },
];
```

Dispatch in `render(...)` (`poc/draw.js:178-185`):
```js
for (const set of group.sets) {
  if (group.kind === "polygon")  drawPolygon(ctx, landmarks, set, group.color, w, h);
  if (group.kind === "polyline") drawPolyline(ctx, landmarks, set, group.color, w, h);
  if (group.kind === "segments") drawSegments(ctx, landmarks, set, group.color, w, h);
}
```

## Target behavior
For every group except `nasolabial`, draw each referenced landmark as a small filled circle with the group's color. Nasolabial stays as a polyline (unchanged).

Target `ROI_GROUPS`:
```js
export const ROI_GROUPS = [
  { key: "cheek",        label: "cheeks",        color: "#ff3b3b", kind: "points",   sets: [LEFT_CHEEK_APEX, RIGHT_CHEEK_APEX] },
  { key: "nasolabial",   label: "nasolabial",    color: "#ffcc00", kind: "polyline", sets: [LEFT_NASOLABIAL, RIGHT_NASOLABIAL] },
  { key: "infraorbital", label: "infraorbital",  color: "#00c3ff", kind: "points",   sets: [LEFT_INFRAORBITAL, RIGHT_INFRAORBITAL] },
  { key: "forehead",     label: "forehead ref",  color: "#9ef28f", kind: "points",   sets: [FOREHEAD_REF] },
  { key: "eyes",         label: "eye aperture",  color: "#c78bff", kind: "points",   sets: [[159, 145, 386, 374]] },
];
```
Note the `eyes` entry shape changes: it flattens from `[[[159,145]],[[386,374]]]` (segment pairs) to `[[159,145,386,374]]` (a single index list) so it uses the same shape contract as every other `points` group.

## New draw primitive
Add to `poc/draw.js`:
```js
function drawPoints(ctx, landmarks, indices, color, w, h) {
  const dpr = devicePixelRatio || 1;
  const r = 3 * dpr;                     // 3 CSS-px dot, DPR-scaled
  ctx.fillStyle = color;
  for (const i of indices) {
    const p = toPx(landmarks[i], w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // subtle outline for contrast on skin
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  for (const i of indices) {
    const p = toPx(landmarks[i], w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}
```
Two passes (fill then stroke) avoid per-point `beginPath` cost being doubled by `ctx.save`/`restore`; keeps it simple and readable.

## Dispatch update
Add `points` to the dispatcher in `render`:
```js
if (group.kind === "polygon")  drawPolygon(ctx, landmarks, set, group.color, w, h);
if (group.kind === "polyline") drawPolyline(ctx, landmarks, set, group.color, w, h);
if (group.kind === "segments") drawSegments(ctx, landmarks, set, group.color, w, h);
if (group.kind === "points")   drawPoints(ctx, landmarks, set, group.color, w, h);
```
The existing `segments` branch can stay (unused but harmless) or be removed since no group references it anymore. Recommend removing both `drawSegments` and the `segments` dispatch line to keep the file tight — it's dead code after this change.

## What this affects elsewhere

### UI toggles (`poc/ui.js`, `poc/index.html`)
The ROI toggle checkboxes key off `ROI_GROUPS[].key` — unchanged. The labels shown stay the same (`cheeks`, `nasolabial`, `infraorbital`, `forehead ref`, `eye aperture`). No UI code change needed.

Verification: grep confirms `toggleState` is keyed by `group.key`, not `group.kind`.

### Feature extraction (`poc/features.js`, `poc/pixels.js`, `poc/rois.js`)
These modules import the landmark **index arrays** (`LEFT_CHEEK_APEX`, etc.) directly from `rois.js` — they don't depend on `ROI_GROUPS[].kind`. Changing `kind` values in `draw.js` has zero effect on pixel sampling, ΔI features, or any saved `vectors_json`. This is a pure overlay-rendering change.

### Annotation labels
`drawAnnotations` (`poc/draw.js:95-107`) places text labels at specific landmark indices (205, 425, 159, 386, 61, 291, 10). That's independent of `ROI_GROUPS`. Unchanged.

## Visual concerns
1. **Eye aperture loses the top↔bottom connecting line.** The user asked for points, so this is intentional. The two eyelid points per eye still show; the aperture is visually inferred from their vertical gap.
2. **Overlapping dots on dense regions (infraorbital has 6 pts per side).** At 3 CSS-px radius, adjacent landmarks separated by 4–5 px on a 720p feed may touch. If that looks muddy in practice, drop radius to `2 * dpr`.
3. **Color contrast on light skin.** The black 0.55-alpha outline handles this; no extra change needed.
4. **Forehead hexagon.** Today the six forehead points form a visible hexagon via polygon fill; as points they'll look like a sparse constellation. Visually less obvious but matches the "points on face" intent.

## Proposed code changes

### `poc/draw.js`
1. Change `kind` of `cheek`, `infraorbital`, `forehead` from `polygon` to `points`.
2. Change `eyes` from `segments` with paired-list shape `[[[159,145]],[[386,374]]]` to `points` with index-list shape `[[159,145,386,374]]`.
3. Add `drawPoints(ctx, landmarks, indices, color, w, h)` helper.
4. Add `if (group.kind === "points") drawPoints(...)` to the dispatcher in `render`.
5. Remove `drawSegments` and its dispatch line (dead code after the eyes change).
6. Keep `drawPolygon` — even though no group uses it now, leaving it doesn't hurt; or remove it too for cleanliness. **Recommendation: remove** both `drawPolygon` and `drawSegments` since nothing references them, keeping the file honest.

### No changes to
- `poc/rois.js` — landmark index constants unchanged.
- `poc/features.js`, `poc/pixels.js`, `poc/quality.js` — analysis unaffected.
- `poc/ui.js`, `poc/index.html` — toggle wiring unaffected.
- `poc/main.js` — overlay is already a pure render call.

## Test plan
1. Start `python3 poc/serve.py`; open `http://localhost:8765/`.
2. Visually confirm:
   - cheek landmarks appear as red dots (no filled polygon).
   - nasolabial still draws as yellow polylines on each side.
   - infraorbital appears as cyan dots (no polygon fill).
   - forehead appears as six green dots (no hexagon).
   - eyes appear as four purple dots (no vertical segments).
3. Toggle each group off/on via the existing checkboxes — all dots for that group should disappear/reappear.
4. Run a full capture — saved `vectors_json` should match what a capture produced before this change (overlay-only). Spot-check one dimension like `cheekL_y.mean` across a pre-change and post-change session to confirm bit-identical up to frame-timing jitter.
5. Move close to camera — dots scale with DPR but not with face size; confirm they don't visually overwhelm the face. If they do, drop `r = 3 * dpr` to `2 * dpr`.

## Rollback
Single file. Revert `poc/draw.js` `ROI_GROUPS` and dispatcher to the prior version. No data migration, no state to clean up.

---

# Todo List

Both modifications touch only `poc/draw.js`, so they can be delivered together in one pass. The todo list below is ordered to keep the file compilable at every step and to stage the simpler change (ROI dots) before the more structural one (eye-anchored banner).

## Phase 1 — ROI overlays → points (except nasolabial)
- [x] In `poc/draw.js`, add `drawPoints(ctx, landmarks, indices, color, w, h)` helper (fill pass + black-outline stroke pass, `r = 3 * dpr`).
- [x] Add `if (group.kind === "points") drawPoints(...)` to the dispatcher in `render(...)`.
- [x] Update `ROI_GROUPS`:
  - [x] `cheek`: `kind: "polygon"` → `"points"`.
  - [x] `infraorbital`: `kind: "polygon"` → `"points"`.
  - [x] `forehead`: `kind: "polygon"` → `"points"`.
  - [x] `eyes`: `kind: "segments"` → `"points"`, and flatten `sets` from `[[[159,145]],[[386,374]]]` to `[[159,145,386,374]]`.
  - [x] `nasolabial`: leave unchanged (`polyline`).
- [x] Delete now-unused `drawSegments` and its dispatch line.
- [x] Delete now-unused `drawPolygon` and its dispatch line.
- [ ] Smoke test: reload browser, confirm all five groups render correctly (cheek/infraorbital/forehead/eyes as dots, nasolabial as polyline). *(manual)*
- [ ] Toggle each group's checkbox off/on; confirm per-group hide/show still works. *(manual)*
- [ ] Run one full capture; save a session; confirm `vectors_json` structure is unchanged vs. a previously-saved session (overlay change should not affect analysis). *(manual)*

## Phase 2 — Banner anchored over eyes
- [x] In `poc/draw.js`, add `anchorOverEyes(landmarks, w, h, ctx, dpr, pad)` returning `{ cx, cy, boxW }` computed from landmarks 33, 263, 159, 386. `boxW` floor derived from `ctx.measureText` on the widest `PHASE_DISPLAY.subtext` (cached, invalidated on `dpr` change).
- [x] Fallback to legacy top-centered anchor when landmarks are null (inlined in `drawPhaseBanner`).
- [x] Add module-scope `smoothedAnchor` + `smoothAnchor(next, alpha=0.2)` exponential smoother.
- [x] Reset `smoothedAnchor = null` whenever `display.phase === "idle"` or landmarks are absent.
- [x] Change `drawPhaseBanner` signature to `(ctx, display, w, h, landmarks)`.
- [x] Inside `drawPhaseBanner`:
  - [x] Pick anchor from landmarks (smoothed) or fall back to top-center when missing.
  - [x] Compute `boxH` from text metrics.
  - [x] Compute `boxX = cx - boxW/2; boxY = overEyes ? (cy - boxH/2) : pad;` then clamp to `[0, w - boxW]` × `[0, h - boxH]`.
  - [x] Mirror translate `ctx.translate(effectiveCx, 0); ctx.scale(-1,1);` with `effectiveCx = boxX + boxW/2` (post-clamp box center).
  - [x] Scale fonts from `boxW`: `actionPx = clamp(18*dpr, 30*dpr, boxW*0.11)`, `subtextPx = clamp(11*dpr, 14*dpr, boxW*0.055)`.
  - [x] Reduce progress-bar height to `3 * dpr`.
- [x] Update `render(...)` call to forward landmarks: `drawPhaseBanner(ctx, display, w, h, landmarks)`.

## Phase 3 — Manual QA *(to be run by user in browser)*
- [ ] Full capture with face centered: banner stays on/near eyes across all phases (`countdown` → `done`), follows head smoothly.
- [ ] Head side-to-side: no visible jitter; text stays legible.
- [ ] Close-to / far-from camera: `boxW` scales with interocular distance; banner never overflows the canvas at close range.
- [ ] Cover face briefly during `countdown`: banner snaps to top-center, then returns to eye anchor on re-acquisition.
- [ ] Confirm every ROI group still renders as expected (dots for four, polyline for nasolabial) while the banner is moving.
- [ ] Side-HUD `mouthSmileLeft/Right`, `eyeBlinkLeft/Right` readouts update in real time — proves analysis path is untouched.
- [ ] Save a session; compare `quality_json` fields against a pre-change session — no new flags, no structural changes.

## Phase 4 — Cleanup
- [x] Verify no leftover references to `drawPolygon` / `drawSegments` in code (`Grep` confirms only plan docs mention them).
- [x] Verify `ROI_GROUPS` shape is internally consistent (every group's `sets` is an array of index arrays, including the flattened `eyes`).
- [ ] If banner motion feels jittery, raise smoothing `alpha` from `0.2` → `0.12`, or throttle anchor updates to every ~100 ms. *(defer until manual QA)*
- [ ] Visually confirm the final overall look matches the intent: "points on face, plus nasolabial lines, plus an eye-anchored instruction banner". *(manual)*

---

# Follow-on tweaks (shipped after initial implementation)

While reviewing the first build, these further trims were applied — all overlay-only, no impact on `features.js` / `pixels.js` / saved `vectors_json`:

- [x] **Forehead → single dot.** `sets` reduced from `[FOREHEAD_REF]` (6 landmarks) to `[[10]]` (top-center only). Landmark 9 (between brows) intentionally excluded.
- [x] **Cheek → single dot per side.** `sets` reduced from `[LEFT_CHEEK_APEX, RIGHT_CHEEK_APEX]` (4 pts per side) to `[[205], [425]]` — the apex landmarks used by `cheekL_y` / `cheekR_y` features.
- [x] **Infraorbital overlay removed.** The `infraorbital` entry was deleted from `ROI_GROUPS` (also removes its UI toggle). `LEFT_INFRAORBITAL` / `RIGHT_INFRAORBITAL` are still imported in `pixels.js` for ΔI sampling, so analysis is untouched.
- [x] **Eye aperture line restored.** `eyes` changed from `kind: "points"` back to `kind: "segments"`, shape `[[[159,145]],[[386,374]]]`. The `drawSegments` helper was re-added and now draws both the connecting line *and* a dot at each endpoint, so the vertical aperture line is visible again alongside the POI dots.
- [x] Unused imports in `poc/draw.js` trimmed (`LEFT_CHEEK_APEX`, `RIGHT_CHEEK_APEX`, `LEFT_INFRAORBITAL`, `RIGHT_INFRAORBITAL`, `FOREHEAD_REF` no longer imported there — still re-used from `rois.js` by `pixels.js`).
- [x] `deno check poc/draw.js` → exit 0.
