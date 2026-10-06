# Graph & Mask — manual Chrome verification checklist

**STATUS: `MANUAL CHROME TEST: NOT RUN`**

Nothing below has been executed. **No item may be reported as PASS** until
someone runs it in a real Chrome against a running localhost. A green automated
suite is **not** a substitute for this file, and no claim about a PNG's pixels
has any support until §C, §D and §E have been done by eye.

Record every scenario as:

```
Input
Expected
Observed
Pass/Fail
Evidence (filename / screenshot)
Console errors
```

Any console error, warning or React key/StrictMode complaint is a **FAIL** for
that scenario even if the file downloaded correctly.

## What automated testing covered, and what it could not

| Area | Automated | Why not more |
|---|---|---|
| Stroke status derivation (visible / cleared / undone) | ✅ full | pure function |
| Stable `S01` numbering across modes and rebuilds | ✅ full | asserted on the artifact |
| Start/end pairing, direction from point order, no cross-stroke edge | ✅ full | asserted on the artifact |
| Full-process vs final-visible divergence | ✅ full | three fixtures, all seven outputs |
| Mask bytes contain only `0`/`255` | ✅ full | asserted on the exact bytes handed to `putImageData` |
| `json.gz` round-trip, corruption, Unicode, v1 migration | ✅ full | — |
| IndexedDB storage form, growth, error path | ✅ full | `fake-indexeddb` |
| **PNG pixels: labels, markers, arrows, legend, crowding** | ❌ **none** | jsdom has no 2D canvas context; the native `canvas` package is an excluded dependency |
| **Grey fringe on the exported mask file** | ❌ **none** | needs a real PNG encoder; the *bytes* are tested, the *file* is not |
| **Real IndexedDB quota behaviour** | ❌ **none** | `fake-indexeddb` has no quota |
| **UI responsiveness during export of a large session** | ❌ **none** | needs a real main thread |

---

## A — Setup

1. `npm run dev`, open in Chrome, open DevTools → Console and keep it visible
   for every scenario below.
2. Note the Chrome version in the evidence column.

> **Device emulation is not a touchscreen and not a pen.** If DevTools device
> emulation is used for any scenario, say so explicitly in Observed. An emulated
> pointer does **not** demonstrate physical stylus or touch capture.

---

## B — The fifteen scenarios

### 1. A normal drawing
Draw three separate strokes, nothing undone.
- **Expected:** three strokes on the canvas; no console error.

### 2. Undo, left undone
Draw three strokes, undo the last one.
- **Expected:** two strokes visible; the third is gone from the canvas but is
  still counted in the session's stroke total in the debug panel.

### 3. Undo then redo
Undo a stroke, then redo it.
- **Expected:** the stroke returns, looking exactly as it did.

### 4. Repeated undo/redo of the same stroke
Undo and redo the same stroke four times.
- **Expected:** final state matches the last action; no duplicated stroke; no
  console error.

### 5. Clear, then draw again
Draw two strokes, Clear, draw two more.
- **Expected:** only the last two are on the canvas.

### 6. Export the two graphs
With the session from scenario 5, export `خروجی گراف JSON` and
`تصویر گراف PNG` once with **محدوده خروجی = فرآیند کامل** and once with
**نمای نهایی**.
- **Expected:** four distinct files, two named `...full-process-graph...` and
  two named `...final-visible-graph...`. Nothing overwrote anything.

### 7. Export the two masks
Same session, export `ماسک باینری PNG` in both scopes.
- **Expected:** two files, `...full-process-binary-mask...` and
  `...final-visible-binary-mask...`.

### 8. Export `json.gz`
Export `خروجی فشرده JSON.GZ`.
- **Expected:** the notice states a size reduction; the file opens with `gunzip`.

### 9. Re-import the `json.gz`
Import the file from scenario 8 back into the app.
- **Expected:** identical canvas, identical stroke count, identical undo/redo
  availability. Derived features are **recomputed**, not read from the file.

### 10. Import a `.json.gz` that is really plain JSON
Rename a plain export to `.json.gz` and import it.
- **Expected:** it imports. The reader decides by content, not by name.

### 11. Import a deliberately corrupted `.gz`
Truncate a `.gz` in a hex editor and import it.
- **Expected:** a specific Persian error naming the decompression failure — not
  a blank screen, not a generic "bad file", not a thrown console exception.

### 12. Points recorded outside the canvas
Start a stroke inside the canvas and drag well outside it, then release.
- **Expected:** the raw session keeps the outside coordinates with their signs
  (check the exported JSON); the mask shows them **clipped**, with the canvas
  still at its exact original pixel dimensions.

### 13. A long session
Draw continuously for at least 60 seconds / 2,000+ points, then export every
artifact.
- **Expected:** every export completes; the button shows
  `در حال آماده‌سازی...` while it works; the page never becomes unresponsive for
  more than a moment. **Record the actual wait for each export** — these are the
  only real browser timings this project has.

### 14. Double-click an export button
Double-click `خروجی فشرده JSON.GZ` quickly.
- **Expected:** exactly **one** file downloads.

### 15. Storage growth and quota
Complete and save at least ten trials. In DevTools → Application → Storage,
record the reported usage. Then try to find the point at which a write fails.
- **Expected:** ten rows in `trialResults`; nothing deleted behind the user. If a
  write does fail, a Persian error must appear on screen.
- **This is the one open question** the automated suite could not answer. If the
  quota is not reached, record that plainly — do not guess a limit.

---

## C — Look at the graph PNGs

For each of the four PNGs from scenario 6:

1. **Labels legible.** Every stroke carries its `S01`-style label, readable
   against the path behind it.
2. **Numbering canonical.** The final-visible PNG of scenario 5 shows `S03` and
   `S04`, **not** `S01` and `S02`.
3. **Start and end correctly paired.** Each stroke has exactly one green disc and
   one red square, and they are on *that* stroke. Confirm the green disc sits
   where you began the stroke, not merely at its left end.
4. **Arrows follow the pen.** Arrow heads point in the direction you actually
   drew. Draw one stroke deliberately right-to-left and confirm.
5. **Not overcrowded.** Arrow heads and labels do not obscure the paths. Note
   honestly if a dense session is hard to read.
6. **Strokes are not joined.** No line connects the end of one stroke to the
   start of the next. Check this specifically on two strokes drawn close
   together in quick succession.
7. **Statuses distinguishable.** In the full-process PNG, visible / cleared /
   undone are told apart at a glance — and still apart when the image is viewed
   in greyscale.
8. **Legend clear.** The legend names the mode and lists only the statuses that
   actually appear, plus the start, end and direction keys.
9. **The two modes differ.** The full-process and final-visible PNGs of scenario
   5 are visibly different images.

## D — Look at the mask PNGs

For each of the two masks from scenario 7:

1. Open in an image editor and use the colour picker along a stroke **edge** at
   400% zoom.
   - **Expected:** every sampled pixel is `0,0,0` or `255,255,255`. **A single
     intermediate value is a FAIL.**
2. Check the histogram.
   - **Expected:** exactly two spikes, at 0 and 255. Nothing between them.
3. Check the image dimensions against the canvas dimensions in the exported
   JSON.
   - **Expected:** identical.
4. Check for transparency.
   - **Expected:** none; alpha is 255 everywhere.
5. Compare the two masks.
   - **Expected:** the final-visible mask's ink is a subset of the
     full-process mask's. It never has ink the other lacks.

## E — Look at the clean drawing PNG

1. Export the clean image.
   - **Expected:** **no** node marker, label, arrow, legend or graph edge
     appears in it. The diagnostic overlay belongs only to the graph PNGs.

---

## F — Sign-off

This file may only be marked complete by someone who ran it. Fill in:

```
Chrome version:
OS:
Date:
Scenarios passed:        / 15
Section C (graph PNGs):  PASS / FAIL
Section D (mask PNGs):   PASS / FAIL
Section E (clean PNG):   PASS / FAIL
Console errors seen:
Open questions:
```
