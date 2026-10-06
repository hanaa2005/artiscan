# Week 1C — Manual Chrome verification checklist

**STATUS: `MANUAL CHROME TEST: NOT RUN`**

The development environment for week 1C had no access to Chrome or a running
localhost. Nothing below has been executed, and **no item may be reported as
PASS** until someone runs it in a real browser.

What automated testing *did* cover, and what it could not:

| Area | Automated | Why not more |
|---|---|---|
| Gzip round-trip, corruption, Persian text | ✅ full | — |
| RDP, mandatory points, determinism, purity | ✅ full | — |
| Mask IoU, quality metrics, NaN safety | ✅ full | pure rasterizer, no canvas needed |
| Graph structure, validator, cross-rejection | ✅ full | — |
| Export panel labels, errors, double-click | ✅ full | — |
| **PNG pixels, markers, mask two-tone purity** | ❌ **none** | jsdom has no 2D canvas context, and the native `canvas` package is a heavy dependency the week's constraints exclude |
| **UI freeze / progress on large sessions** | ❌ **none** | needs a real main thread |

Record each item as:

```
Input
Expected
Observed
Pass/Fail
Evidence
```

---

## A — Gzip

1. Record a real trial with at least 1,000 points.
2. Export both `خروجی خام JSON` and `خروجی فشرده JSON.GZ`.
3. Compare the two file sizes.
   - **Expected:** the `.gz` is roughly 85% smaller (see benchmark).
4. Decompress the `.gz` outside the app (`gunzip`) and diff it against the raw
   JSON.
   - **Expected:** byte-identical.
5. Import the decompressed file.
   - **Expected:** session, replay and final image identical to before.

## B — Critical JSON

1. Export `خروجی مسیر نقاط ضروری JSON`.
2. Confirm `"lossy": true` is present.
3. Compare `quality.rawPointCount` with `quality.criticalPointCount`.
4. Pick three nodes at random; confirm each `sourcePointSequence` exists in the
   raw session with **identical** `x`, `y` and `timeMs`.
5. Try to import the critical JSON through the raw-session import control.
   - **Expected:** refused with a Persian message telling you it is not a
     session file.

## C — Graph PNG

1. Open `artiscan-critical-trajectory-*.png`.
2. Start and end markers visible and distinguishable.
3. Stroke order discernible.
4. Legend readable; colours match the reasons present.
5. Open the clean PNG and confirm it contains **no** markers, ids or legend.

## D — Mask PNG

1. Open `artiscan-reconstruction-mask-*.png`.
2. Only black background and white path — no text, no marker, no legend.
3. The original shape is recognisable.
4. Dimensions equal the session's logical canvas.
5. Aspect ratio matches the source.

## E — Fidelity across profiles

1. Export the critical JSON at `high`, `balanced` and `compact`.
2. Compare each `quality` block.
   - **Expected:** `high` keeps the most points and has the highest `maskIoU`.
3. Draw and test each of: a straight line, a smooth curve, a zigzag, a loop.
4. Confirm corners survive at every profile.

## F — Large session

1. Record several thousand points.
2. Export each artifact.
   - **Expected:** the "در حال آماده‌سازی..." state appears; the tab does not
     freeze for a noticeable period.
3. Double-click an export button rapidly.
   - **Expected:** exactly one file per intent.
4. Console shows zero errors.

## G — Integrity

1. After every export, re-export the raw JSON.
   - **Expected:** byte-identical to the raw JSON taken before the exports —
     deriving an artifact must not modify the session.
2. Replay still plays correctly after exporting.
