# Week 1A — Capture Stabilization: policies and evidence

This document records the decisions made in Week 1A, the evidence each one
rests on, and what was deliberately **not** changed.

The governing rule throughout: the canonical `DrawingSession` is raw evidence.
No change in this phase deletes a valid point, alters the meaning of a recorded
field, or bumps a schema version. `schemaVersion` remains **2**;
`resultSchemaVersion` remains **2**.

---

## 1. Duplicate sample protection

### Observation

Real exported sessions contain adjacent point pairs identical in every field
except `sequence`:

```text
sequence 101 and 102
timeMs      1505.7
x           248.8
y           220.6
pressure    null
tiltX/tiltY null
pointerType mouse
```

### Root cause

`DrawingCanvas` unpacked every `pointermove` with `getCoalescedEvents()` and
appended all of them. In Chrome the coalesced list can overlap the native event
that carried it, so the same raw sample reaches the recorder twice in one tick —
which is why both points share `timeMs`, not merely coordinates.

### Why blind deduplication would have been wrong

`PointSample` values are **rounded on the way in**: `x`/`y` to 0.01 px,
`timeMs` to 0.1 ms. Two genuinely distinct samples from a fast digitizer can
round onto each other. Removing "identical-looking" points would therefore
delete real evidence of how the hand moved.

### Policy implemented

Deduplication runs **before** rounding, **before** `PointSample` construction
and **before** `sequence` assignment, against unrounded native event fields
(`pointerId`, `pointerType`, `timeStamp`, `clientX`, `clientY`, `pressure`,
`tiltX`, `tiltY`). Two categories are treated differently:

| Category      | Condition                                            | Action                 |
| ------------- | ---------------------------------------------------- | ---------------------- |
| **Definite**  | identical to the immediately preceding accepted sample, **including `timeStamp`** | dropped, counted |
| **Suspected** | same position and sensor readings, **`timeStamp` advanced** | **kept**, counted only |

A suspected duplicate is a *stationary pointer* — a pause, a hesitation, a
press-and-hold. That is exactly the temporal evidence this project exists to
record, so it is never removed and no behavioural interpretation is attached to
it.

Comparison is against the **last accepted sample only**, so a genuine return to
an earlier position is preserved. The filter is reset at every stroke boundary,
so a new press at the same coordinates is always recorded.

### Guarantees

- **No sequence gaps.** The drop happens before `sequence` is assigned.
- **Lossless with respect to distinct samples.** Only provable re-deliveries of
  the same raw sample are removed.
- **Same x/y with a different timestamp is preserved.**
- **Mouse, touch and pen** follow one identical policy (covered by tests).
- **Measurable.** `receivedSampleCount`, `droppedDuplicateCount` and
  `suspectedDuplicateCount` are shown in the debug panel.

### Schema impact

**None.** The counters are debug-only state passed by callback to the debug
panel. They are never written into `DrawingSession` and never exported.

**Files:** `src/features/drawing/utils/duplicateSamples.ts` (new),
`components/DrawingCanvas.tsx`, `components/DrawingDebugPanel.tsx`, `src/App.tsx`.

---

## 2. Width drag integrity

### Observation

One slider drag produced fifteen `width_change` actions:

```text
29 → 14 → 13 → 12 → 11 → 10 → 9 → 12 → 9 → 11 → 8 → 10 → 7 → 9 → 8
```

### Root cause

`<input type="range">` fires `change` on every step the thumb crosses, and the
toolbar routed each one straight to `setWidth`, which logs an action
unconditionally. The intended record is a single decision: `29 → 8`.

A second latent defect: `setWidth` read its `from` value from `settingsRef`,
which mirrors React state and is therefore a render **behind** whenever several
calls land in one batch — precisely what a drag produces.

### Policy implemented

The colour architecture (already correct) was extended to width, unchanged in
shape:

```ts
beginWidthInteraction()   // idempotent; captures the starting width
previewWidth(value)       // paints only — no action, no preferences write
commitWidthInteraction()  // idempotent; records at most ONE action
```

- `from` is read from `currentWidthRef`, the authoritative ref, never from
  mirrored state.
- `pointerup`, `blur` and a late `change` for one interaction yield **one**
  action, because commit is idempotent.
- A drag returning to its starting value records **nothing**.
- Starting a stroke commits any open interaction first, so the `width_change`
  always sits at a **lower sequence** than the stroke's first point — the log
  can never contradict the ink.
- A direct/scripted `setWidth` settles any open interaction first, then records
  its own action.
- Preferences store only the **committed** value.
- Keyboard use is covered: focus opens the interaction, arrow keys preview,
  blur (or the first stroke) commits one action.

`persistPreferences()` now reads tool, colour and width from their authoritative
refs, so one interaction can no longer persist another's stale value.

### Verified red-before-green

Re-wiring the end-to-end test to the pre-fix path reproduces the defect exactly:
**15 actions** for that drag, versus 2 after the fix (one for the setup change
`4 → 29`, one for the drag `29 → 8`).

### Schema impact

**None.** `width_change` keeps its `{ from, to }` payload. Existing files remain
valid; they simply contain more actions than a new recording would.

**Files:** `hooks/useDrawingSession.ts`, `components/DrawingToolbar.tsx`,
`src/App.tsx`, `features/trial/components/TrialPage.tsx`.

---

## 3. Colour interaction

**Not rewritten.** The architecture was already correct — a real exported
session shows three picker interactions producing exactly three
`color_change` actions.

Because colour and width now share the same begin/preview/commit shape, the same
`persistPreferences` helper and the same commit-on-stroke-start hook, a
regression suite was added so a future change to one cannot silently damage the
other. It covers: many previews with one commit, pointerup + blur, repeated
commit, return to the starting colour, stroke started with the picker open,
consecutive interactions, direct set after commit, React batching, preferences
persistence, and colour/width independence.

---

## 4. Canvas dimension integrity

### Observation

```text
session.canvas.width = 718
point.x              = 721.6
point.normalizedX    = 1
```

### Root cause — proven, not assumed

Five candidate mechanisms were tested. Two produce this shape; three do not.

| Mechanism | Verdict |
| --- | --- |
| Pointer capture recording outside the canvas | **Confirmed — sufficient on its own** |
| Canvas resized between capture and export | **Confirmed — a second, independent mechanism** |
| Drawing mid-canvas | Not a cause |
| Point exactly on the boundary | Not a cause (`x == width`, not `>`) |
| Browser zoom / DPR 1, 1.25, 2, 3 | Not a cause |

**Mechanism 1.** `toNormalized()` clamps to `[0, 1]`; raw `x`/`y` are stored
unclamped. Under `setPointerCapture` the pointer keeps delivering events after
it leaves the surface, so a pointer 3.6 px past a 718 px edge records exactly
`x = 721.6, normalizedX = 1`. DPR is irrelevant here: `clientX` and
`getBoundingClientRect()` are both in CSS pixels, so their difference is
DPR-independent.

**Mechanism 2.** `buildSession()` stamps the canvas size at **export** time. A
point captured inside a 900 px canvas is paired with a 718 px descriptor if the
window shrank before export, and reads as "outside" although the pointer never
left the surface. The raw data is undamaged — `normalizedX` was computed against
the capture-time size and still replays correctly — but the *raw-pixel ↔
descriptor pairing* is only trustworthy when no resize occurred.

### Policy (documented, tested, no code or schema change)

- **Raw `x`/`y` are authoritative and are never clamped or deleted**, in any
  direction (negative values included).
- **`normalizedX`/`normalizedY` are clamped and therefore lossy.** They exist to
  drive rendering at any canvas size; a value of 1.8 would paint off-surface.
  They must never be used to answer "was the pointer outside?".
- **Out-of-bounds remains recoverable** from raw coordinates against
  `session.canvas` — which is exactly what `outsideCanvasPointCount` and the
  `raw*` versus `inCanvas*` feature split already do.
- **A click outside the canvas creates no stroke:** `pointerdown` is bound to
  the overlay element only.
- **Pointer capture outside the canvas stays recorded**, and the stroke is not
  truncated.

### Known limitation (Confirmed risk, deliberately not "fixed" in 1A)

Mechanism 2 means a mid-session resize leaves raw pixels paired with a
descriptor from a different moment. Mitigating it properly means either fixing
canvas dimensions for the duration of a trial, recording resize events, or
storing capture-space metadata — all of which touch either layout behaviour or
the schema. Per the Week 1A rules no schema change was made without a migration
analysis. **Recommended for Week 1B: fix the canvas size for the duration of a
trial** (lowest risk, no schema change, no migration).

**Files:** `utils/canvasDimensionIntegrity.test.ts` (new, evidence only — no
production code changed for this item).

---

## 5. Trial result persistence

### Problem

A completed `DrawingTrialResult` lived only in React state. Reload, crash or an
accidental tab close before the user clicked "export JSON" destroyed the
recording — the one artefact the system exists to produce was the only thing
never persisted.

### Implemented

A dedicated IndexedDB store, `trialResults`, with:

```text
saveTrialResult · getTrialResult · listTrialResults · getLatestTrialResult
deleteTrialResult · clearExpiredTrialResults · clearTrialResults
```

The database moves from version 1 to **version 2**, adding the new store. The
upgrade creates missing stores defensively and **never touches existing
`drawingSessions` rows**. Connection, version and the stale-write guard now live
in one shared module (`services/indexedDb.ts`) used by both repositories, since
one database cannot be opened at two versions at once.

Guarantees:

- The **complete** result is stored, canonical session included.
- Features are **recomputed** from the embedded session on restore, via the same
  validator the file importer uses — a stale or tampered feature block can never
  be presented as measurement.
- **Incomplete results are refused**, not stored: status must be `completed`,
  `completedAt` non-null, and `durationMs` finite and non-negative.
- **Stale writes cannot win**: per-trial write queue plus an epoch-scoped
  revision high-water mark.
- **A failed write does not block a retry**: the revision claim is released, so
  a retry at a higher revision gets through.
- **Remount is safe**: revisions are only compared within one epoch.
- A `structuredClone` failure becomes a **promise rejection**, not a synchronous
  throw.
- The UI reports save state **honestly** — `saved` only after the write resolves
  — and offers an explicit retry on failure.
- On startup a stored result is **offered**, never auto-loaded; dismissing the
  banner deletes nothing.

### Storage metadata

The stored row is an envelope — `{ id, createdAt, updatedAt, result }` — so
`DrawingTrialResult` and `DrawingSession` gain **no fields**. Storage metadata is
not research data and must not leak into the exported schema.

**Files:** `services/indexedDb.ts` (new),
`features/trial/services/trialResultRepository.ts` (new),
`services/drawingSessionRepository.ts` (rewritten as a thin layer, public API
unchanged), `TrialPage.tsx`, `TrialResultSummary.tsx`, `TrialPage.module.css`.

---

## 6. Session completion policy

**No schema change proposed or made.**

The existing metadata was checked against the requirement and found sufficient:
`trial.status`, `trial.timing.completedAt` and `trial.timing.durationMs`
together determine whether a trial finished, when, and how long it took.
`isCompleteTrialResult()` enforces exactly that triple.

Trial lifecycle therefore stays **outside** the canonical `DrawingSession`,
where the Week 2 layering rule already puts it. No `DrawingSession` field was
added, and none is needed.

---

## 7. Storage cleanup

### Measured finding

The worry was that repeated app launches leave abandoned session rows behind.
**They do not.** `useAutoSave` skips revision 0 — the untouched initial session —
so five consecutive launches with no drawing leave the store with **zero rows**
(measured, `storageAccumulation.test.ts`). Rows appear only once something is
actually drawn.

### Policy

- **Drawing sessions are never deleted automatically.** There is no age-based
  sweep: nothing is accumulating, and deleting real recordings on a timer would
  be worse than the problem it would solve. Removal requires an explicit call.
- **Trial results have an explicit, caller-stated expiry policy.**
  `clearExpiredTrialResults({ maxAgeMs })` has **no default age and is never
  called automatically** — not on startup, not on a timer. It returns the number
  of rows removed so a caller can report it honestly.
- A row with an **unparseable `updatedAt` is kept**: deleting research data
  because a timestamp failed to parse would destroy a recording on the strength
  of a bug.
- Write failures (quota included) surface as **rejections**, and the trial UI
  shows the failure rather than a false "saved".

Batch point storage, binary formats and compression are explicitly **out of
scope** for Week 1A. Full-snapshot-per-stroke remains acceptable — see the
measurements below.

---

## 8. Performance — measured values only

Measured in **jsdom with fake-indexeddb**, not Chrome.

**Meaningful regardless of runtime** (properties of the design and the data):

| Metric | Value |
| --- | --- |
| React commits added by `beginStroke` | 1 |
| React commits added by **150 `extendStroke` calls** | **0** |
| React commits added by `endStroke` | 1 |
| Total React commits per stroke | **2** |
| Total commits at 50 / 500 / 5000 points | 1 / 1 / 1 (identical) |
| Stroke count / point count of the test session | 20 / 3000 |
| Session JSON size | 458,672 bytes (447.9 KB) |
| Bytes per point | 153 |

**Indicative only — NOT browser measurements:**

| Metric | Value |
| --- | --- |
| `JSON.stringify` of the 3000-point session (jsdom) | 2.74 ms |
| IndexedDB write (fake-indexeddb shim) | 13.76 ms |

The capture loop holds the required shape: pointer movement performs no React
state update, no IndexedDB write, no serialization, no feature extraction and no
compression. The live stroke lives in a ref and is drawn imperatively; React
state is touched once per committed stroke; persistence is debounced at 500 ms.

**Not measured:** frame rate and dropped-sample rate. These require a real
browser and are not claimed.

---

## 9. Compatibility summary

| Aspect | Status |
| --- | --- |
| `DrawingSession.schemaVersion` | **2** — unchanged |
| `resultSchemaVersion` | **2** — unchanged |
| Legacy v1 session import | unchanged, still explicit and separate |
| Old files | still import; still round-trip |
| New files | round-trip verified by the existing validator suites |
| IndexedDB | v1 → **v2**, additive; existing session rows untouched |
| Lossy changes to raw data | **none** |

The only removal introduced anywhere in Week 1A is the definite-duplicate drop
described in §1, which by construction removes only re-deliveries of a sample
that is already recorded.
