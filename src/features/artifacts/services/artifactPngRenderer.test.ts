/**
 * WEEK 1C - PNG artifacts, tested honestly.
 *
 * SCOPE LIMIT, STATED UP FRONT
 *
 * jsdom implements no 2D canvas context, so NOTHING in this file can verify a
 * pixel. Making it able to would mean adding the native `canvas` package - a
 * heavy dependency pulled in purely to test rendering, which the week's
 * constraints rule out.
 *
 * So this file tests exactly what is testable without pixels: the render POLICY
 * (sizes, scale rule, versioning), the file names, and - usefully - that a
 * missing canvas context produces a clean Persian error instead of a crash,
 * which is the real behaviour on a locked-down browser too.
 *
 * Pixel appearance, marker placement and mask two-tone purity are verified by
 * the manual Chrome checklist in docs/week-1c-manual-test-checklist.md, and are
 * reported as NOT RUN until someone runs them.
 */

import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_PNG_RENDERER_VERSION,
  buildCriticalPngFileName,
  buildMaskFileName,
  renderCriticalTrajectoryPng,
  renderReconstructionMaskPng,
} from './artifactPngRenderer'
import { buildCriticalTrajectory } from './criticalTrajectory'
import { makePoint, makeSession, makeStroke } from '../../drawing/testing/sessionFixture'
import type { DrawingSession } from '../../drawing/types/drawing.types'

const CANVAS = { width: 800, height: 400, devicePixelRatio: 1 }

function sampleSession(): DrawingSession {
  const points = Array.from({ length: 20 }, (_, i) =>
    makePoint({
      sequence: i + 1,
      timeMs: (i + 1) * 10,
      x: 50 + i * 12,
      y: 200 + Math.sin(i / 3) * 50,
      normalizedX: (50 + i * 12) / 800,
      normalizedY: (200 + Math.sin(i / 3) * 50) / 400,
    }),
  )
  return makeSession({
    canvas: CANVAS,
    strokes: [makeStroke({ id: 'a', order: 0, startedAtMs: 10, endedAtMs: 200, points })],
    actions: [],
  })
}

describe('the jsdom limitation is real and handled', () => {
  it('reports a Persian error rather than crashing when no 2D context exists', async () => {
    /*
      This is not merely a test-environment quirk: a browser that refuses a 2D
      context (canvas blocked, memory exhausted) hits exactly this path, and the
      user must get a message rather than an unhandled rejection.
    */
    const session = sampleSession()
    const artifact = buildCriticalTrajectory(session)

    await expect(renderReconstructionMaskPng(artifact, session)).rejects.toThrow(
      'امکان ساخت بوم خروجی وجود ندارد.',
    )
    await expect(renderCriticalTrajectoryPng(artifact)).rejects.toThrow(
      'امکان ساخت بوم خروجی وجود ندارد.',
    )
  })
})

describe('file naming', () => {
  it('names the mask distinctly from every other artifact', () => {
    expect(buildMaskFileName('abcdef12-3456-4789-8abc-def012345678', '1405-05-27')).toBe(
      'artiscan-reconstruction-mask-abcdef12-1405-05-27.png',
    )
  })

  it('names the diagnostic image distinctly', () => {
    expect(buildCriticalPngFileName('abcdef12-3456-4789-8abc-def012345678', '1405-05-27')).toBe(
      // UPDATED for the same reason as the JSON name: the mode disambiguates.
      'artiscan-full-process-graph-abcdef12-1405-05-27.png',
    )
  })

  it('gives the mask and the diagnostic image different names', () => {
    const id = 'abcdef12-3456-4789-8abc-def012345678'
    expect(buildMaskFileName(id, 'x')).not.toBe(buildCriticalPngFileName(id, 'x'))
  })
})

describe('renderer versioning', () => {
  it('exposes a version string that can be recorded in a sidecar', () => {
    expect(ARTIFACT_PNG_RENDERER_VERSION).toMatch(/\S/)
  })
})

describe('the artifact carries what the mask renderer needs', () => {
  it('records the logical canvas, so the mask never guesses a size', () => {
    const artifact = buildCriticalTrajectory(sampleSession())
    expect(artifact.canvas).toEqual({ width: 800, height: 400 })
  })

  it('records the mask renderer version used for the quality numbers', () => {
    // The IoU in the quality block comes from the pure rasterizer, not from a
    // browser canvas, and the artifact says which one.
    const artifact = buildCriticalTrajectory(sampleSession())
    expect(artifact.algorithm.maskRendererVersion).toMatch(/\S/)
  })

  it('groups nodes by stroke so the mask can reconstruct each path', () => {
    const artifact = buildCriticalTrajectory(sampleSession())
    const strokeIds = new Set(artifact.nodes.map((node) => node.strokeId))

    expect(strokeIds.size).toBe(1)
    expect(strokeIds.has('a')).toBe(true)
  })
})
