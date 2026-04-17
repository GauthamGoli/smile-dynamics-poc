# Plan V2: Triple-trial sessions + SQLite history + personal baselining

## 1. What we're building and why

Three changes that transform the POC from a "run N captures and eyeball a CV table" tool into a **daily-use smile tracker** with built-in noise reduction and personal context:

1. **Triple-trial median per session.** Every "Start capture" runs the 4-phase flow three times back-to-back and reports the **median** of each smile vector across the three trials. This cuts random measurement noise by ~40% (median of 3 is robust to a single outlier trial) with zero algorithm changes — same extractor, same quality gate, just three passes and a median.

Note: make sure user will be told before starting the session that it will repeat thrice 

2. **SQLite session history.** Every completed session (3-trial median vectors + quality + neutral images + person + timestamp) is persisted into a local SQLite database. A "Session history" panel in the sidebar shows all past sessions for the selected person, with smile vector summaries, sortable by date.

3. **Personal baselining.** Every vector is displayed not just as an absolute value but also as a **z-score**: `z = (value − personalMedian) / personalσ`, where `personalMedian` and `personalσ` are computed over *all* accumulated sessions for that person (not a fixed 14-day window — we use everything we have, whether that's 3 sessions or 300). This differential measurement cancels every noise source constant for a given user (their phone, their lighting, their baseline face).

## 2. UX flow (new)

```
[Start capture] → person picker (Sameen / GG) → 
  Trial 1: Neutral → Smile → Release → Relax → Done
  (brief 3s rest, banner "Trial 2 of 3")
  Trial 2: Neutral → Smile → Release → Relax → Done
  (brief 3s rest, banner "Trial 3 of 3")
  Trial 3: Neutral → Smile → Release → Relax → Done
→ compute median vectors across 3 trials
→ display session result card:
    - median smile vectors (absolute values)
    - personal z-scores per vector (vs all-time baseline)
    - quality summary (how many trials passed gate)
    - neutral image from the best-quality trial
→ auto-save to SQLite (no manual Save click needed)
→ session appears in Session History panel
```

The "Start repeatability (N=10)" button is **hidden**. It's been superseded by the 3-trial median built into every capture.

## 3. Architecture

### 3.1 Data flow

```
Browser                              Server (serve.py)
───────                              ─────────────────
3 captures → median vectors    POST /session
  + neutral JPEGs             ──────────────►  SQLite INSERT
  + quality per trial                          results/<person>/<sessionId>/

                               GET /sessions?person=GG
Session history panel         ◄──────────────  SELECT * FROM sessions
                                               WHERE person = ?

                               GET /baseline?person=GG
Personal baseline display     ◄──────────────  SELECT vectors FROM sessions
                                               WHERE person = ?
                                               → compute median + σ
```

### 3.2 SQLite schema

One database file: `poc/data/smile.db` (auto-created on first write).

```sql
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,    -- sessionId (timestamp slug)
    person      TEXT NOT NULL,       -- 'Sameen' | 'GG'
    created_at  TEXT NOT NULL,       -- ISO 8601
    trials      INTEGER NOT NULL,   -- number of trials (usually 3)
    trials_passed INTEGER NOT NULL, -- trials that passed quality gate
    vectors_json TEXT NOT NULL,      -- JSON: median smile vectors
    quality_json TEXT NOT NULL,      -- JSON: per-trial quality summaries
    baseline_json TEXT,              -- JSON: z-scores at time of capture (snapshot)
    notes       TEXT                 -- optional user notes (future)
);

CREATE INDEX IF NOT EXISTS idx_sessions_person ON sessions(person);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
```

Neutral images stay on disk at `results/<person>/<sessionId>/` (not in SQLite — blobs are large and we already have the file-save path). The `id` column links the DB row to the image directory.

### 3.3 Server endpoints

#### `POST /session` — save a completed session

Request body:
```json
{
  "sessionId": "2026-04-17_10-30-00-123",
  "person": "Sameen",
  "trials": 3,
  "trialsPassed": 3,
  "vectors": { ... median smile vectors ... },
  "quality": [ { ... trial 1 quality ... }, ... ],
  "baseline": { ... z-scores ... },
  "images": [
    { "filename": "Sameen_neutral_01.jpg", "content": "<base64>", "encoding": "base64" },
    { "filename": "Sameen_neutral_02.jpg", "content": "<base64>", "encoding": "base64" },
    { "filename": "Sameen_neutral_03.jpg", "content": "<base64>", "encoding": "base64" }
  ]
}
```

Server:
1. Validates person + sessionId (same regexes as before).
2. Writes images to `results/<person>/<sessionId>/`.
3. Inserts row into `sessions` table.
4. Returns `{ ok: true, id: sessionId }`.

#### `GET /sessions?person=Sameen` — list all sessions for a person

Returns:
```json
{
  "sessions": [
    {
      "id": "2026-04-17_10-30-00-123",
      "person": "Sameen",
      "created_at": "2026-04-17T10:30:00.123Z",
      "trials": 3,
      "trials_passed": 3,
      "vectors": { ... },
      "quality": [ ... ],
      "baseline": { ... }
    },
    ...
  ]
}
```

Ordered by `created_at DESC`. No pagination needed at POC scale.

#### `GET /baseline?person=Sameen` — compute personal baseline from all history

Server computes:
```python
all_vectors = [json.loads(row["vectors_json"]) for row in sessions_for_person]
for each vector leaf path:
    values = [get_path(v, path) for v in all_vectors if is_finite(get_path(v, path))]
    median = numpy_free_median(values)
    sigma  = stdev(values, median)  # or MAD * 1.4826 for robust σ
baseline[path] = { median, sigma, n: len(values) }
```

Returns `{ baseline: { "<path>": { median, sigma, n }, ... }, sessionCount: N }`.

Uses MAD (Median Absolute Deviation) × 1.4826 instead of standard deviation because MAD is robust to the occasional bad session that slipped through quality gating. This is the right σ estimator for a personal-baseline system.

### 3.4 Client: triple-trial session driver

Replace the single-capture flow with a 3-trial loop. Reuses the existing `createCaptureController` + pixel hooks unchanged — just calls them 3 times.

```js
async function runTripleSession(person) {
  const sessionId = timestampSlug();
  const trials = [];
  const jpegs = [];

  for (let i = 0; i < 3; i++) {
    if (i > 0) await showRestBanner(3000, `Trial ${i + 1} of 3`);
    const vectors = await runSingleCapture();
    trials.push(vectors);
    jpegs.push(state.neutralJpeg);
  }

  const passedTrials = trials.filter(t => t.quality?.flags?.length === 0);
  const pool = passedTrials.length >= 2 ? passedTrials : trials;
  const medianVectors = computeMedianVectors(pool);

  // fetch personal baseline, compute z-scores
  const baseline = await fetchBaseline(person);
  const zScores = computeZScores(medianVectors, baseline);

  // auto-save to server
  await postSession({
    sessionId, person,
    trials: trials.length,
    trialsPassed: passedTrials.length,
    vectors: medianVectors,
    quality: trials.map(t => t.quality),
    baseline: zScores,
    images: jpegs.map((jpeg, i) => ({
      filename: `${person}_neutral_${String(i + 1).padStart(2, "0")}.jpg`,
      content: dataUrlToBase64(jpeg),
      encoding: "base64",
    })),
  });

  return { sessionId, medianVectors, zScores, trials, passedTrials };
}
```

### 3.5 Median computation

For each leaf path in the smile-vectors tree, collect the value from each trial, take the median.

```js
function computeMedianVectors(trials) {
  const keys = flattenVectorKeys(trials[0].smile);
  const result = {};
  for (const k of keys) {
    const values = trials
      .map(t => getPath(t.smile, k))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    setPath(result, k, values.length ? median(values) : null);
  }
  return result;
}
```

### 3.6 Z-score computation

```js
function computeZScores(medianVectors, baseline) {
  if (!baseline || !baseline.baseline) return null;
  const z = {};
  for (const [path, stats] of Object.entries(baseline.baseline)) {
    const val = getPath(medianVectors, path);
    if (!Number.isFinite(val) || !Number.isFinite(stats.sigma) || stats.sigma < 1e-9) {
      z[path] = null;
      continue;
    }
    z[path] = {
      value: val,
      personalMedian: stats.median,
      personalSigma: stats.sigma,
      z: (val - stats.median) / stats.sigma,
      n: stats.n,
    };
  }
  return z;
}
```

**Interpretation of z-scores:**
- `z ≈ 0` → today's value is at your personal median (normal for you)
- `|z| < 1` → within your typical variation (nothing noteworthy)
- `1 < |z| < 2` → noticeably different from your baseline
- `|z| > 2` → statistically unusual for you — worth investigating (sleep? alcohol? stress?)

With MAD-based σ, z > 2 corresponds to roughly the 5th/95th percentile of your personal distribution — a strong signal that something changed.

### 3.7 Session result card (replaces the old session panel)

After a triple-trial session completes, the sidebar shows:

```
┌─────────────────────────────────────────────┐
│ Session: Sameen · 2026-04-17 10:30          │
│ Trials: 3/3 passed quality gate             │
│─────────────────────────────────────────────│
│ Smile vectors (median of 3 trials)          │
│                                             │
│ cheekLift.symmetry  0.974   z = +0.12  ●    │
│ nasolabial.L.dLen  -0.056   z = -1.34  ▲    │
│ movementSymmetry    0.941   z = +0.05  ●    │
│ stiffness           7.24    z = +2.10  ▲▲   │
│ eyeAperture.L      -0.028   z = +0.44  ●    │
│ rebound.reboundMs   2172    z = -0.67  ●    │
│ ...                                         │
│─────────────────────────────────────────────│
│ ● normal  ▲ notable (|z|>1)  ▲▲ unusual    │
│           (|z|>2)                           │
│                                             │
│ Baseline: 12 sessions accumulated           │
└─────────────────────────────────────────────┘
```

Z-score indicators:
- `●` green — `|z| < 1`
- `▲` amber — `1 ≤ |z| < 2`
- `▲▲` red — `|z| ≥ 2`

### 3.8 Session history panel

New panel below the session result card. Shows all past sessions for the currently-active person (from the last picker choice). Each row is a summary:

```
┌─────────────────────────────────────────────┐
│ Session History — Sameen (12 sessions)       │
│─────────────────────────────────────────────│
│ 2026-04-17 10:30  3/3  sym=0.97  stiff=7.2 │
│ 2026-04-16 22:15  3/3  sym=0.95  stiff=6.8 │
│ 2026-04-16 18:00  2/3  sym=0.96  stiff=7.5 │
│ ...                                         │
│─────────────────────────────────────────────│
│ Click a row to expand full vectors + z-scores│
└─────────────────────────────────────────────┘
```

Fetched via `GET /sessions?person=Sameen` on page load and after each new session completes.

## 4. Files touched

### New
- `poc/data/` directory (auto-created; gitignored).
- `poc/data/smile.db` — SQLite database (auto-created on first `POST /session`).
- `poc/session.js` — triple-trial driver, median computation, z-score computation, session result card rendering, session history panel rendering.
- `poc/baseline.js` — `fetchBaseline(person)`, `computeZScores(vectors, baseline)`.

### Modified
- `poc/serve.py` — add `POST /session`, `GET /sessions`, `GET /baseline` endpoints; `import sqlite3`; add DB init.
- `poc/main.js` — replace capture-button flow with `runTripleSession`; hide repeatability button; add session-history panel refresh; remove old `saveBtn` / `sessionJsonBtn` / `reportBtn` handlers (auto-save replaces manual save).
- `poc/index.html` — hide repeatability button; add session-history container; add session-result-card container; CSS for both.
- `poc/repeatability.js` — keep the `flattenVectorKeys` / `getPath` / `summarize` exports (reused by session.js); the `runRepeatability` function is no longer called but stays for reference.

### Unchanged
- `poc/capture.js` — the 4-phase state machine is untouched. It runs 3 times per session now, but from the state machine's perspective it's 3 independent single captures.
- `poc/features.js` — extractor is untouched. Each trial produces its own vectors object; the median is computed *outside* the extractor.
- `poc/quality.js` — quality gate is untouched. Each trial gets its own quality assessment.
- `poc/pixels.js` — pixel sampling + JPEG grab unchanged.
- `poc/hud.js` — sparklines + live CV tags unchanged.
- `poc/draw.js` — overlay unchanged.
- `poc/calibration.js` — calibration unchanged (still per-device, not per-person; flagged as a known limitation).

## 5. Why MAD instead of standard deviation for personal σ

Standard deviation is sensitive to outliers. If one of your 12 sessions had a bad capture that slipped through quality gating (e.g., you moved during the smile phase but not enough to trigger `pose_excess`), that session's vector values are off. SD will inflate σ, making all your z-scores look artificially small (harder to detect real changes).

MAD (Median Absolute Deviation) is the median of `|x_i − median(x)|`. Multiplied by 1.4826, it's a consistent estimator of σ for normal distributions but breaks down gracefully for non-normal ones. It ignores up to 50% outlier contamination.

```python
def robust_sigma(values):
    med = median(values)
    mad = median([abs(v - med) for v in values])
    return mad * 1.4826
```

This is the right estimator for a personal-baseline system where the occasional bad session is inevitable.

## 6. Success criteria

- A single "Start capture" click runs 3 trials back-to-back with rest banners between them, then shows a session result card with median vectors + z-scores.
- The session is auto-saved to SQLite — no manual Save click.
- Session history panel shows all accumulated sessions for the selected person.
- Z-scores are computed from ALL past sessions (not a fixed 14-day window).
- After 5+ sessions for one person, the z-score indicators start becoming meaningful (σ stabilizes).
- First 2-3 sessions: z-scores show "—" or grey (insufficient baseline, n < 3).
- No regressions on the HUD, sparklines, quality gate, or the capture state machine itself.

## 7. Todo list (phased, browser-review-gated)

### Phase T0 — Server: SQLite + endpoints
- [ ] Add `import sqlite3, base64` to `serve.py`.
- [ ] On startup, init `data/smile.db` with the `sessions` table + indices.
- [ ] Implement `POST /session` endpoint (validate, write images, INSERT row).
- [ ] Implement `GET /sessions?person=X` endpoint (SELECT, return JSON array).
- [ ] Implement `GET /baseline?person=X` endpoint (SELECT all vectors, compute per-path median + MAD-σ, return JSON).
- [ ] Keep the existing `POST /save` endpoint for backwards compatibility (single-file saves still work).
- [ ] Smoke-test all three endpoints via curl.
- **Checkpoint (browser review required):** curl outputs confirm DB creation, insert, query, and baseline computation.

### Phase T1 — Client: triple-trial session driver
- [ ] Create `poc/session.js` with `runTripleSession(person)`, `computeMedianVectors(trials)`, `fetchBaseline(person)`, `computeZScores(vectors, baseline)`.
- [ ] Import and reuse `flattenVectorKeys` / `getPath` from `repeatability.js`.
- [ ] Add `setPath(obj, dottedPath, value)` helper for building the median-vectors tree.
- [ ] In `main.js`, replace the capture-button click handler: call `pickPerson()` → `runTripleSession(person)`.
- [ ] Show a "Trial N of 3" banner between captures (reuse the rest-banner mechanism from repeatability).
- [ ] Hide the repeatability button in HTML (`display: none`).
- [ ] Remove the manual Save button (auto-save replaces it).
- **Checkpoint (browser review required):** clicking Start capture → pick person → 3 trials run automatically → console shows the median vectors object. No save to DB yet (that's T0's endpoint, wired in T2).

### Phase T2 — Client: wire auto-save to POST /session
- [ ] After `runTripleSession` completes, POST the session to `/session` (vectors + quality + images).
- [ ] On success, log `session saved → <person>/<sessionId> (3 trials, 3 passed)`.
- [ ] On failure, show error banner.
- [ ] Verify: `ls poc/data/smile.db` exists after first capture; `sqlite3 poc/data/smile.db "SELECT id, person, trials FROM sessions"` shows the row.
- **Checkpoint (browser review required):** complete a triple-trial session → check the DB has the row, results dir has the images.

### Phase T3 — Client: session result card with z-scores
- [ ] Add `renderSessionCard(container, { medianVectors, zScores, trials, passedTrials })` to `session.js`.
- [ ] Display each vector leaf: name, absolute value, z-score, indicator (● / ▲ / ▲▲).
- [ ] Show "baseline: N sessions accumulated" at the bottom.
- [ ] If n < 3 for a vector's baseline, show z as "—" (insufficient history).
- [ ] Add CSS for the card (dark theme, tabular-nums, colored indicators).
- [ ] Wire into `main.js`: after `runTripleSession`, render the card into the session container.
- **Checkpoint (browser review required):** after a few sessions, z-scores appear with colored indicators. First 1-2 sessions show "—"; by session 3-4, z-scores populate.

### Phase T4 — Client: session history panel
- [ ] Add `renderSessionHistory(container, sessions)` to `session.js`.
- [ ] Each row: date, trials passed, key vector summaries (symmetry, stiffness), expand on click to show full vectors + z-scores.
- [ ] On page load, call `GET /sessions?person=<lastPerson>` and render.
- [ ] After each new session, refresh the history.
- [ ] Add a person-toggle at the top of the history panel (Sameen / GG tabs) that re-fetches.
- [ ] Add the panel to `index.html` below the session result card.
- **Checkpoint (browser review required):** history shows accumulated sessions, clicking a row expands it, switching person tabs loads the other person's history.

## 8. Modification: delete sessions + trend visualisation + rolling baseline

### 8.1 What we're adding

1. **Delete session** — each row in Session history gets a delete button (🗑). Clicking it:
   - Confirms via a small inline "are you sure? yes / cancel" prompt (no browser `confirm()` — keeps the dark theme).
   - Calls `DELETE /session/<id>?person=<person>` on the server.
   - Server deletes the SQLite row AND removes `results/<person>/<sessionId>/` directory (images + any JSON).
   - History panel refreshes automatically.

2. **Trend chart per smile vector** — a new "Trends" view (toggled from inside the history panel) that shows one time-series line chart per smile vector leaf path across all sessions for the selected person. X-axis = session date, Y-axis = absolute value. Data comes from the already-fetched sessions list (no new endpoint needed).

3. **Rolling baseline overlay on trend charts** — each trend chart also draws:
   - A **rolling median** line (computed over all sessions up to that point in time, expanding window — same as the server's baseline but visualised progressively).
   - A **±1 MAD-σ band** shaded around the median.
   - The most recent session's z-score is annotated on the rightmost point.

   This gives a visual story: "here's where my value is today relative to where it's been." The rolling baseline matches what the z-score engine uses, so the chart is the visual explanation of the number.

### 8.2 Server: `DELETE /session/<id>?person=<person>`

New endpoint. Validates `person` + `id` (same regexes). Deletes:
1. SQLite row: `DELETE FROM sessions WHERE id = ? AND person = ?`
2. Results directory: `shutil.rmtree(results/<person>/<id>/)` if it exists.

Returns `{ ok: true, deleted: id }` or `404` if not found.

```python
def _handle_delete_session(self):
    from urllib.parse import urlparse, parse_qs
    parts = self.path.split("/")  # /session/<id>?person=X
    path_part = "/".join(parts[:3])  # /session/<id>
    session_id = parts[2].split("?")[0] if len(parts) >= 3 else ""
    qs = parse_qs(urlparse(self.path).query)
    person = qs.get("person", [None])[0]

    if not session_id or not SAFE_SESSION.match(session_id):
        self.send_error(400, "invalid sessionId"); return
    if not person or not SAFE_PERSON.match(person):
        self.send_error(400, "invalid person"); return

    conn = get_db()
    cur = conn.execute("DELETE FROM sessions WHERE id = ? AND person = ?", (session_id, person))
    conn.commit()
    conn.close()

    if cur.rowcount == 0:
        self.send_error(404, "session not found"); return

    dir_path = os.path.join(RESULTS_DIR, person, session_id)
    if os.path.isdir(dir_path):
        import shutil
        shutil.rmtree(dir_path)

    self._json_response({"ok": True, "deleted": session_id})
```

Route in `do_DELETE`:
```python
def do_DELETE(self):
    if self.path.startswith("/session/"):
        self._handle_delete_session()
    else:
        self.send_error(404, "unknown endpoint")
```

### 8.3 Client: delete button per history row

In `session.js`'s `renderSessionHistory`, each row gets a delete button:

```js
<button class="btn-delete-session" data-id="${s.id}" data-person="${s.person}"
  style="margin-left:auto;font-size:10px;padding:2px 6px;opacity:0.6">🗑</button>
```

Click handler flow:
1. Replace button text with "sure? yes / cancel" (two small inline links).
2. On "yes": `fetch(\`/session/${id}?person=${person}\`, { method: "DELETE" })`.
3. On success: remove the DOM row + refresh history.
4. On "cancel": restore the 🗑 button.

No browser `confirm()` dialog — stays in theme.

### 8.4 Client: trend view

A "Trends" toggle button in the history panel header (next to Sameen / GG tabs). Clicking it switches the history panel body from the session-list to a chart grid.

**Data source.** The sessions are already fetched via `GET /sessions?person=X`. Each session has `.vectors` (the median vectors from that triple-trial session). Flatten each session's vectors, collect per-path arrays across sessions sorted by `created_at`.

**Chart rendering.** Inline SVG (same approach as the repeatability progression plots from §11.1, but with time on x-axis and the rolling baseline overlay).

Per vector leaf path:
```
┌────────────────────────────────────────────┐
│ cheekLift.symmetry              z = +0.12  │
│                                            │
│        ·  ·  ·     ·                       │
│   ────────────── rolling median ─────────  │
│  ░░░░░░░░░░░░░░ ±1σ band ░░░░░░░░░░░░░░░  │
│  ·        ·         ·  ·                   │
│                                            │
│ apr 10   apr 12   apr 14   apr 16   apr 17 │
└────────────────────────────────────────────┘
```

Each chart is an SVG element ~full-width, ~90px tall.

**Rolling baseline computation (client-side):**
```js
function rollingBaseline(values) {
  // values is sorted by time
  const medians = [];
  const bands = [];
  for (let i = 0; i < values.length; i++) {
    const window = values.slice(0, i + 1);  // expanding window
    const med = median(window);
    const mad = median(window.map(v => Math.abs(v - med))) * 1.4826;
    medians.push(med);
    bands.push({ upper: med + mad, lower: med - mad });
  }
  return { medians, bands };
}
```

The expanding window matches the server's `GET /baseline` logic (all-time, not fixed 14-day), so the chart's rolling median at the rightmost point equals the z-score denominator the user sees in the session card.

### 8.5 Layout in the history panel

```
┌─────────────────────────────────────────────────────┐
│ Session history                                      │
│ [Sameen] [GG]     [List view] [Trends]    [Back]    │
│─────────────────────────────────────────────────────│
│                                                      │
│  (either session list with delete buttons            │
│   OR trend charts with rolling baselines)            │
│                                                      │
└─────────────────────────────────────────────────────┘
```

Toggle between "List view" and "Trends" swaps the panel body. Both use the same fetched `sessions` array.

### 8.6 Files touched

**Modified**
- `poc/serve.py` — add `do_DELETE` + `_handle_delete_session`.
- `poc/session.js` — add delete button + confirm flow to `renderSessionHistory`; add `deleteSession(id, person)` fetch helper; add `renderTrendCharts(container, sessions)` with rolling baseline SVG; add `rollingBaseline(values)` computation.
- `poc/index.html` — add Trends toggle button + CSS for the chart grid.
- `poc/main.js` — wire the Trends toggle + delete-triggered refresh.

**Unchanged**
- Everything else (capture, extractor, quality, HUD, sparklines, calibration).

### 8.7 Todo list (phased)

#### Phase D0 — Server: DELETE endpoint
- [x] Added `do_DELETE` + `_handle_delete_session` to `serve.py`. Validates person + sessionId, DELETEs from SQLite, `shutil.rmtree`s the results dir.
- [x] Smoke-tested: delete → 200, re-delete → 404, dir gone.

#### Phase D1 — Client: delete button in session list
- [x] 🗑 button per history row with inline "sure? yes / cancel" confirm.
- [x] `deleteSession(id, person)` helper in `session.js`.
- [x] On confirm-yes: calls DELETE endpoint, row removed, history refreshes.
- [x] `renderSessionHistory` accepts `{ onDelete }` callback; main.js passes a refresh trigger.

#### Phase D2 — Client: trend charts with rolling baseline
- [x] `rollingBaseline(values)` — expanding-window median + MAD-σ per point.
- [x] `renderTrendCharts(container, sessions)` — 2-col grid of SVGs per vector path: blue dots (sessions), green dashed rolling-median line, green ±1σ shaded band, z-score annotation on rightmost point, x-axis date labels.
- [x] "List" / "Trends" view-tab toggle in history panel header; both share the same cached sessions array.
- [x] View toggle wired in main.js; switching person re-fetches + re-renders current view.

#### Phase D3 — Commit
- [x] All phases green.

### Phase T5 — Polish + commit
- [ ] Ensure the old `POST /save` endpoint still works (the single-capture Save button is gone, but the endpoint should stay for any scripts or future use).
- [ ] Clear the session result card when starting a new capture (so the user doesn't confuse old and new results).
- [ ] Handle the edge case: if all 3 trials fail quality gate, still save the session but show a warning ("all trials had quality issues — median may be unreliable").
- [ ] Add `poc/data/.gitignore` with `*` + `!.gitignore` (same pattern as results).
- **Checkpoint (browser review required):** full end-to-end: fresh DB, 3 sessions for Sameen, 2 for GG, history shows both, z-scores compute correctly, switching tabs works, no regressions.
