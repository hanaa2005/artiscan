# Week 1A — manual Chrome verification checklist

## Execution status: NOT RUN

This environment has no browser and no access to a dev server, so **no manual
Chrome result in this document may be treated as PASS**. Nothing below has been
observed. Automated coverage was run instead and is listed at the end.

Run `npm run dev` and work through the scenarios below. For each one record:

```text
Input:
Expected:
Observed:
Pass/Fail:
Evidence (JSON excerpt / screenshot):
Console errors:
```

Where a scenario says "check the JSON", export the session (free-drawing lab) or
the trial result and inspect the file — the debug panel is a convenience, the
file is the evidence.

---

## A. Duplicate sample protection

Watch the three debug-panel rows: **نمونه‌های خام دریافتی**, **تکراری قطعی
(حذف‌شده)**, **توقف اشاره‌گر (حفظ‌شده)**.

| # | Input | Expected |
| --- | --- | --- |
| A1 | Draw a fast scribble with the mouse | Smooth line; "تکراری قطعی" may be > 0; no visible gaps |
| A2 | Draw very slowly | Many points; "تکراری قطعی" typically 0 |
| A3 | Press and hold the pointer still for ~3 s, then release | Points keep accruing; **"توقف اشاره‌گر" rises**; "تکراری قطعی" stays 0 |
| A4 | Draw fast on a high-refresh display (coalesced events) | Point count higher than the pointermove count; no duplicate pairs in the JSON |
| A5 | Export the JSON from A1–A4 | **No two adjacent points share the same `timeMs` AND the same `x`/`y`** |
| A6 | Check `sequence` in the same file | Strictly increasing with **no gaps** across points and actions |
| A7 | Repeat A1 with a touchscreen | Same behaviour |
| A8 | Repeat A1 with a pen/stylus | Same behaviour; `pressure` non-null; `hasPressureSamples` true |
| A9 | Release and press again at exactly the same spot | The second stroke records its first point (filter resets per stroke) |

## B. Width slider

| # | Input | Expected |
| --- | --- | --- |
| B1 | Single click on the slider at a new value | Exactly **one** `width_change`, `from` = old, `to` = new |
| B2 | Long slow drag across many values, then release | Exactly **one** `width_change`, `from` = value before the drag, `to` = final |
| B3 | Drag, move the pointer off the slider, release outside | Exactly one `width_change`; no extra action from the outside release |
| B4 | Drag, then click elsewhere to blur | Still exactly one `width_change` (commit is idempotent) |
| B5 | Drag away from the start value and back to it, release | **Zero** `width_change` actions |
| B6 | Tab to the slider, press arrow keys three times, then blur | Exactly one `width_change`, `from` = focus value, `to` = final |
| B7 | Drag the slider then immediately start a stroke without releasing focus | One `width_change` whose `sequence` is **lower** than the stroke's first point; stroke drawn at the new width |
| B8 | Three separate drags in a row | Exactly three `width_change` actions, chained (`to` of one = `from` of the next) |
| B9 | Reload after a drag | Slider reopens at the **committed** width, not an intermediate one |

## C. Colour picker (regression only)

| # | Input | Expected |
| --- | --- | --- |
| C1 | Open the picker, choose a colour directly | One `color_change` |
| C2 | Open the picker, drag through several colours, confirm | One `color_change`, `to` = final colour |
| C3 | Open the picker and close it without changing anything | **Zero** `color_change` |
| C4 | Change colour, then blur | Still one action |
| C5 | Pick a colour then immediately start a stroke | One `color_change` at a lower `sequence` than the stroke's first point; stroke uses the new colour |
| C6 | Three separate colour selections | Exactly three chained actions |
| C7 | Reload | Reopens with the committed colour |
| C8 | Interleave a colour pick and a width drag | One action each; both preferences correct after reload |

## D. Canvas geometry

| # | Input | Expected |
| --- | --- | --- |
| D1 | Draw in the middle of the canvas | All `x` within `0..canvas.width`; `normalizedX` strictly between 0 and 1 |
| D2 | Draw exactly along the right/bottom edge | `x == canvas.width` possible; `normalizedX == 1`; no clamping of `x` |
| D3 | Start a stroke inside and drag well outside the canvas | Stroke continues; **raw `x` exceeds `canvas.width`**; `normalizedX == 1`; nothing deleted |
| D4 | Drag out past the **left/top** edge | Raw `x`/`y` **negative**; normalized clamped to 0 |
| D5 | Click once outside the canvas (not a drag) | **No stroke created**, no action logged |
| D6 | Resize the window mid-stroke | Stroke stays continuous; drawing does not jump |
| D7 | Resize between two strokes, then export | Note the known limitation: `canvas` is stamped at **export** time (see policy §4) |
| D8 | Resize, then reload and restore | Drawing replays correctly at the new size (normalized coordinates) |
| D9 | Browser zoom 50%, 100%, 200% | Coordinates stay in CSS pixels; drawing tracks the cursor |
| D10 | DPR 1 / 1.25 / 2 / 3 (different monitors or devtools emulation) | `canvas.devicePixelRatio` recorded; coordinates unaffected |

## E. Trial result persistence

| # | Input | Expected |
| --- | --- | --- |
| E1 | Complete a trial | Result appears; status line reads **«نتیجه در حافظه محلی مرورگر ذخیره شد»** only after the write lands |
| E2 | Reload the page | Banner offers the stored result; **the result is not lost** |
| E3 | Click «نمایش نتیجه ذخیره‌شده» | Result shown, labelled as restored; features recomputed from the session |
| E4 | Export JSON from the restored result | File is valid and re-importable |
| E5 | Dismiss the banner instead, then reload | Banner returns — **dismissing deletes nothing** |
| E6 | Complete two trials in a row | The newer result is offered on reload; both rows exist |
| E7 | Cancel a trial | Nothing new stored; any previously stored row untouched |
| E8 | Try to complete a trial with no strokes | Refused with the empty-trial message; nothing stored |
| E9 | Block storage (devtools → Application → clear/deny, or private mode with IndexedDB off) | Status reads «ذخیره محلی در دسترس نیست…»; app keeps working; export still available |
| E10 | Force a write failure (fill the quota), then press «تلاش دوباره» | Error state shown honestly; retry succeeds once space is available |
| E11 | Switch workspace to «رسم آزاد» and back mid-trial | Confirmation appears; no duplicate or lost result |
| E12 | Check devtools → Application → IndexedDB → `artiscan` | Two stores: `drawingSessions` and `trialResults`; existing sessions intact after the v1 → v2 upgrade |

## F. Storage accumulation

| # | Input | Expected |
| --- | --- | --- |
| F1 | Open the app five times without drawing | `drawingSessions` stays **empty** |
| F2 | Draw one stroke, reload, repeat three times | One row per session that was drawn in |
| F3 | Confirm no automatic deletion | Older sessions still present; nothing removed on startup |

---

## Automated coverage run in place of the above

All of the following were executed in this environment and passed:

- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm run test` — **33 files, 571 tests, all passing** (baseline was 24 / 470)
- `npm run build` — PASS

The automated suites cover the logic behind sections A–F: duplicate
classification and filtering (mouse/touch/pen, definite vs. suspected, stroke
boundaries, no sequence gaps), the width contract end-to-end through a real
`<input type="range">` (including a red-before-green reproduction of the
15-action bug), the colour regression matrix, the canvas coordinate contract
across DPR 1/1.25/2/3 and both out-of-bounds directions, trial result
persistence with deterministic out-of-order writes, the full complete → unmount
→ remount → restore cycle through the real `TrialPage`, and storage accumulation
across simulated launches.

What automated tests **cannot** substitute for, and what section A–F therefore
still needs a real Chrome run for:

- genuine `getCoalescedEvents()` behaviour on a high-refresh display;
- real pen pressure and tilt from a stylus digitizer;
- real `setPointerCapture` behaviour outside the canvas;
- real device-pixel-ratio and browser-zoom rendering;
- real IndexedDB timing, quota exhaustion and private-mode behaviour;
- frame rate and dropped-sample rate, which are **not measured or claimed
  anywhere** in this phase.
