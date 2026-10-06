# Week 1C — Derived artifacts, compression and the critical trajectory

This document is the contract for everything added in week 1C. It states what
each file is, what it guarantees, and — just as importantly — what it does not.

## 1. The artifact family

The canonical `DrawingSession` remains the single source of truth. Nothing here
replaces it, summarises it in place, or is accepted as a substitute for it.

| Artifact | Kind | Replaces raw data? |
|---|---|---|
| `artiscan-raw-session-*.json` | Lossless / canonical | — it *is* the raw data |
| `artiscan-raw-session-*.json.gz` | Lossless / canonical-equivalent | No |
| `artiscan-critical-trajectory-*.json` | **Lossy** / derived | **No** |
| `artiscan-critical-trajectory-*.png` | **Lossy** / diagnostic | **No** |
| `artiscan-reconstruction-mask-*.png` | **Lossy** / derived | **No** |
| `artiscan-drawing-*.png` (clean) | Derived visual | **No** |

The clean PNG is **unchanged** by week 1C. No marker, node id, legend or graph
edge is drawn into it. Diagnostic overlay lives only in the two new images.

## 2. Gzip — the only lossless addition

`gzipCodec.ts` compresses the exact string `serializeSession()` produces and
decompresses back to that same string, character for character. It operates on
the **string**, never on the object, so no key can be reordered and no float
re-rounded.

- Uses the platform's `CompressionStream` / `DecompressionStream`. **No new
  dependency.** A gzip library would ship tens of kilobytes to duplicate
  something already present.
- Capability is detected. On a browser without it the export button is not
  rendered at all — an explanation is shown instead.
- Corrupt, truncated and non-gzip files are rejected with distinct Persian
  messages. The codec never throws at a caller; it returns a `ParseResult`.

## 3. Critical trajectory — explicitly lossy

`CriticalTrajectoryArtifactV1` has its own `artifactSchemaVersion`, independent
of `DrawingSession.schemaVersion`. **The canonical session schema is unchanged
by week 1C.**

`lossy: true` is a required literal, not a boolean — a file that omits it cannot
typecheck and is rejected by the validator.

### Traceability

Every node carries `sourcePointSequence` and `sourcePointIndex`, and copies
`x`, `y`, `normalizedX`, `normalizedY` and `timeMs` **verbatim** from a real
sample. No point is interpolated or synthesised. Any claim the graph makes can
be checked against the canonical session.

### Mandatory points — never removed at any tolerance

- first and last sample of every stroke
- the single sample of a one-point stroke (a tap is an observation)
- both sides of a gap longer than `PAUSE_BOUNDARY_MS` (120 ms)
- turns sharper than `DIRECTION_CHANGE_DEGREES` (45°)
- pressure moves of at least `PRESSURE_CHANGE_DELTA` (0.25), **only** where both
  samples carry real pressure — `null` is an absence, never a reading of zero
- canvas entry and exit

Undo, redo and clear are **actions, not points**. They become `actionNodes` with
`sourceActionSequence`, in a separate array so they can never be mistaken for
places the pen was.

### Reasons that are deliberately absent

`speed_extremum`, `acceleration_extremum`, `intersection` and `region_revisit`
are **not implemented and not reserved in the type**. They need a motion engine
that does not exist yet. Reserving their names would let a reader assume a file
was checked for something it never was.

### Edges

`temporal_path` joins consecutive kept points **within one stroke**.
`action_transition` joins an action node to its timeline neighbours.

There is **no edge between points of two different strokes**: the pen was
lifted, so a line there would assert travel that never happened on the surface.
Pen-up distance is never counted as path length.

## 4. Quality profiles — initial engineering thresholds

> **These are `Hypothesis` / initial engineering thresholds, not scientific
> truth.** They were chosen to be conservative and may move once there is
> benchmark evidence from real recordings.

| Profile | Min mask IoU | Max deviation px | Max path-length err | Max bbox err |
|---|---:|---:|---:|---:|
| `high` (default) | 0.98 | 1.5 | 0.02 | 0.01 |
| `balanced` | 0.95 | 3.0 | 0.05 | 0.02 |
| `compact` | 0.90 | 6.0 | 0.10 | 0.04 |

Tolerance is chosen by a deterministic search over a fixed ladder, stopping at
the largest tolerance that still meets the profile — the fewest points of
adequate quality. If no tolerance meets it, **every point is kept and the
failure is reported** in `quality.qualityFailureReason`. Quality is never traded
away for size, and a failure is never hidden.

## 5. Measurement is reproducible

`maskIoU` is computed by a **pure rasterizer** (`utils/rasterMask.ts`), not by a
browser canvas. A browser's anti-aliasing differs between machines, so the same
session would otherwise score differently on different hardware. The coverage
model is centre-sampled capsules — round caps and joins, matching the renderer —
and is versioned as `MASK_RENDERER_VERSION`.

Empty-mask policy, stated explicitly: both empty → IoU 1; exactly one empty →
IoU 0; different sizes → `null`, never a fabricated number.

## 6. Mask PNG policy

The mask renders at the logical canvas size by default (`scalePolicy:
'identity'`). A different output size is **explicit** and recorded in the
returned `MaskRenderPolicy` together with `sourceCanvasSize`, `outputMaskSize`,
`strokeWidthPolicy`, `rendererVersion`, `lineCap`, `lineJoin` and
`antiAliasing`. Nothing is ever silently resized or normalised.

Scaling is uniform, so the shape is never distorted.

## 7. What week 1C did not change

- `DrawingSession` schema — untouched
- clean PNG — untouched
- replay — untouched; raw replay is not replaced by critical replay
- no new npm dependency
- no backend, no ML, no motion events, no psychological interpretation
