/**
 * The Konva line settings that make a stroke look like ink rather than wire.
 *
 * Kept in its own module, away from any component, so the live canvas, the
 * replay canvas and the shared StrokeLine can all import it without a
 * component file having to export a constant.
 *
 * `tension: 0` matters for fidelity rather than taste: Konva's smoothing would
 * invent curvature between recorded samples, so the picture would stop being a
 * faithful drawing of the points that were actually captured.
 */
export const LINE_STYLE = {
  lineCap: 'round',
  lineJoin: 'round',
  tension: 0,
  perfectDrawEnabled: false,
} as const
