# Graph & Mask stabilization — the contract

This document is the contract for the graph, the binary mask and the lossless
`json.gz` path. It states what each file means, what it guarantees, and what it
must never be read as.

It supersedes nothing in [week-1c-artifacts.md](week-1c-artifacts.md); it
narrows and corrects it where that document was ambiguous. Where the two differ,
this one is current.

## 0. The one rule everything below depends on

The canonical `DrawingSession` is the record. **Every** graph, mask and PNG in
this document is a **derived, lossy** artifact. None of them is a source of
truth, none replaces the raw recording, and the mask in particular is not
lossless — see §5.

---

## 1. The two scopes: full process and final visible

Every graph and every mask is produced in exactly one of two scopes, and the
scope is written into both the filename and the file.

| Scope | `mode` value | Question it answers | Contains |
|---|---|---|---|
| Full process | `full_process` | *What happened during the session?* | **Every** stroke ever completed — visible, cleared and undone alike |
| Final visible | `final_visible` | *What was on the canvas at the end?* | Only strokes still visible at the last event |

**`full_process` is the default**, everywhere: in `buildCriticalTrajectory`, in
the export panel's selector, and in the filename slug. The reason is one-way
risk. A full-process file presented as the final drawing is obviously wrong to
anyone who looks at it, because erased strokes are drawn dashed and grey and the
legend names them. A final-visible file mistaken for the whole process silently
*omits* work the participant did, and nothing in the image reveals the omission.

A graph artifact without a `mode` field is rejected unless it declares
`artifactSchemaVersion: 1`, in which case it is read as `full_process` — which
is what v1 always was.

## 2. Stroke status

Status is derived in exactly one place, `computeStrokeStatuses` in
`src/features/drawing/utils/strokeVisibility.ts`, which is the same function the
canvas itself uses to decide what to render. There is deliberately no second
implementation: a graph that disagreed with the canvas about what is visible
would be worse than no graph.

| Status | Meaning | Drawn as |
|---|---|---|
| `visible` | still on the canvas at the end of the session | solid blue, full opacity |
| `cleared` | removed by a `clear` event | dashed orange, 50% opacity |
| `undone` | removed by an `undo` that was never redone | dotted grey, 50% opacity |

Three consequences worth stating, because each is a bug someone will otherwise
introduce:

- A stroke undone and then **redone** is `visible`. The undo was taken back, and
  reporting it as undone would report an event the user cancelled.
- A stroke that was **already undone** when a later `clear` ran keeps `undone`.
  It did not leave the canvas because of the clear; it had already left.
- A stroke drawn **after** a clear is `visible`. A clear is an event at a point
  in time, not a property of the session.

## 3. Stroke numbering, start and end

**Labels are canonical.** A stroke's label is `S` plus its index in the complete
stroke history, 1-based and zero-padded to two digits (`S01`, `S02`, … `S100`).
It is computed from `order` in the full history, never from the stroke's position
in the file being written.

So `S03` names the same stroke in the full-process graph, in the final-visible
graph, and in a graph exported an hour later. A final-visible graph whose only
strokes are the third and fourth ever drawn reads `S03`, `S04` — it does **not**
renumber them to `S01`, `S02`, because that would claim the session began with
them.

**Start and end** come from the stroke's own first and last recorded samples, in
`sequence` order — not from the leftmost or topmost point, and not from the first
node the simplifier happened to keep. They are drawn with different **shapes**,
not merely different colours:

| Marker | Shape | Why |
|---|---|---|
| Start | filled green **disc** | distinguishable in greyscale, on a printout, and to a colour-blind reader |
| End | red **square** | — |

Each stroke's start belongs to that stroke only. Nothing pairs one stroke's
start with another stroke's end.

**Direction** is shown with arrow heads placed along the path, taken from the
recorded point order. At most three arrows are drawn per stroke, and no arrow is
drawn on a segment shorter than 14 px, because a short stroke crowded with
arrow heads is less legible than one with none.

**No edge is ever drawn between two strokes.** Each stroke is rendered inside its
own `beginPath()`. A line joining the end of `S01` to the start of `S02` would
depict a pen movement that never happened — the pen was lifted.

## 4. Pause is not a temporal gap

These were conflated, and are now separate concepts with separate names and
separate numbers.

| | Pause | Temporal gap |
|---|---|---|
| Constant | `PAUSE_THRESHOLD_MS = 500` | `TEMPORAL_GAP_BOUNDARY_MS = 120` |
| Measured between | two **strokes** | two **samples inside one stroke** |
| Pen state | up | down |
| Used by | drawing statistics | the graph's point-selection |
| Node reason | — | `temporal_gap_boundary` |

The graph node reason formerly called `pause_boundary` is now
`temporal_gap_boundary`. The old name asserted a pause on evidence four times
weaker than the project's own definition of one, and on the wrong pen state
entirely.

**Neither number is a scientific fact.** Both are engineering thresholds chosen
to produce a readable artifact; they are recorded in the artifact's
`algorithm.thresholds` block precisely so that a reader can see what was assumed
and disagree with it. Nothing in this project infers anything psychological or
clinical from either.

## 5. The binary mask

Two masks, one per scope: `artiscan-full-process-binary-mask-*.png` and
`artiscan-final-visible-binary-mask-*.png`.

**The guarantee:** every channel of every pixel is exactly `0` or exactly `255`.
Nothing in between ever appears.

This holds **by construction, not by thresholding**:

- The mask is rasterized by `rasterizeStrokes`, a pure centre-sample capsule
  rasterizer. A pixel is either covered or it is not; there is no coverage
  fraction to round.
- The bytes are written with `context.putImageData`, which copies them verbatim.
  No path is ever drawn, so the browser's anti-aliaser is never involved.
- The image is never scaled. Resampling is exactly the step that would
  reintroduce intermediate values.
- Alpha is `255` everywhere. The file has no transparency at all, so no viewer
  can composite a soft edge onto it.

| | Value |
|---|---|
| Foreground (ink) | `255` in R, G and B |
| Background | `0` in R, G and B |
| Alpha | `255` everywhere |
| Dimensions | exactly the session's logical canvas, always |
| Anti-aliasing | none |
| Out-of-canvas geometry | clipped to the canvas, never resized to fit |

Two further points of policy:

- The mask is built from the **raw strokes**, not from the simplified graph
  nodes. The mask is a geometric statement about where the pen went, and running
  it through point reduction first would quietly narrow that answer.
- **Eraser strokes count as ink.** A mask answers "where did the pen go", and an
  eraser stroke is somewhere the pen went. What the drawing *looks like* is
  answered by the clean PNG, which composites properly.

The older `artiscan-reconstruction-mask-*.png` still exists and is **not**
binary: it is drawn from the simplified nodes with ordinary canvas paths and has
soft edges. It is labelled as such in the UI. Do not threshold it and call the
result a binary mask.

## 6. Artifact versioning

Three version numbers, deliberately independent, because they describe three
things that change for different reasons.

| Constant | Value | Describes |
|---|---|---|
| `CURRENT_SCHEMA_VERSION` | `2` | the `DrawingSession` recording format |
| `CURRENT_RESULT_SCHEMA_VERSION` | `2` | the `DrawingTrialResult` wrapper |
| `CRITICAL_TRAJECTORY_SCHEMA_VERSION` | `2` | the **graph artifact** |

The graph artifact moved from 1 to 2 because its *meaning* changed: it now
declares a `mode`, carries a `strokes` summary array, records its thresholds, and
renamed `pause_boundary` to `temporal_gap_boundary`. Version 1 files are still
read (see §1) and are presented as `full_process` with status `visible`; the
tool, colour and width of a v1 stroke summary are filled with neutral
placeholders that are **documented as placeholders, not guessed values**.

Recordings did not change in this milestone, so `CURRENT_SCHEMA_VERSION` stayed
at `2`. **Gzip is a transport encoding and never a schema change.**

## 7. `raw-session.json.gz` — lossless

`gzipCodec.ts` compresses the exact string `serializeSession()` produces, and
decompresses to that same string, character for character. It operates on the
**string**, never on the object, so no key is reordered and no float re-rounded.

It uses the platform's `CompressionStream` / `DecompressionStream`. No new
dependency. Where the browser lacks them, the export button is **not rendered**;
an explanation is shown in its place.

**Import** (`sessionFileReader.ts`, wired into the app's import control) decides
by **content, not filename**: it checks the gzip magic bytes. So a `.json` file
that is really gzip still imports, and a `.json.gz` that is really plain text
still imports. It also strips a UTF-8 BOM, which would otherwise fail
`JSON.parse`.

The round-trip is tested for deep equality, not just for a successful parse, and
specifically over: undo/redo/clear histories, colour and width actions,
coordinates recorded **outside** the canvas with their signs, `pressure: null`
staying `null` rather than becoming `0`, real pressure and tilt at full float
precision, Persian and other Unicode text, a v1→v2 migrated session together
with its Persian provenance note, and a second round trip with no drift.

Failures are distinguished from each other rather than collapsed into "bad file":
empty file, truncated gzip, non-gzip bytes with a `.gz` name, gzip that
decompresses to broken JSON, and valid JSON that is not a session.

## 8. Local storage — what was found, and what was changed

**Nothing was changed.** Section 15 of the milestone was an investigation, and
the findings did not justify a format change. They are recorded in
`indexedDbInvestigation.test.ts`, which measures rather than asserts from
memory.

- A raw session is stored as **one row per session id**, as a **live object
  graph** via `structuredClone` — not as a JSON string. No stringify happens on
  the write path and no parse on the read path.
- Because the key path is the session id, autosave **replaces** a row rather
  than appending one. This is why the stale-write guard in `indexedDb.ts` exists.
- A read returns a **detached copy**; mutating it cannot corrupt the stored row.
- Structured clone is *stricter* than JSON, and that is a feature here: a value
  it cannot clone makes the write **reject**, where `JSON.stringify` would have
  dropped the key and stored a row that looked fine.
- Growth is one row per completed trial, and nothing ages out on its own. An
  abandoned trial is never stored at all.
- A refused write produces a **rejected promise with a message**, never a
  resolved "saved".

**What could not be measured here:** the real browser quota. `fake-indexeddb` is
an in-memory store with no quota, so the size at which Chrome begins refusing
writes is an open question and sits on the manual checklist. The error *path* is
tested; the threshold is not known.

Timings printed by the test suite are Node/jsdom numbers and are labelled as
such. They are not browser benchmarks.

## 9. Known limitations

1. **PNG pixels are not covered by automated tests.** jsdom has no 2D canvas
   context, and the native `canvas` package is a heavy dependency this project
   excludes. Everything up to the encoder is tested — the artifact the image is
   rendered from, and the exact bytes handed to `putImageData` — but the images
   themselves are verified by eye in Chrome.
2. **Label crowding on dense sessions is a judgement call.** At three arrows per
   stroke and one label per stroke, a session with many short strokes will still
   look busy. There is no automated legibility metric.
3. **The IndexedDB quota threshold is unknown**, per §8.
4. **The graph's thresholds are engineering choices**, per §4. They are recorded
   in the file so they can be argued with.
5. The reconstruction mask remains non-binary, per §5.

## 10. Verification

- Automated: `graphStabilization.test.ts`, `binaryMaskPng.test.ts`,
  `fixtureArtifacts.test.ts`, `strokeStatus.test.ts`,
  `criticalTrajectoryValidator.test.ts`, `sessionFileReader.test.ts`,
  `indexedDbInvestigation.test.ts`, `artifactBenchmark.test.ts`.
- Manual: [graph-mask-manual-test-checklist.md](graph-mask-manual-test-checklist.md).
  Automated tests do **not** substitute for it.
