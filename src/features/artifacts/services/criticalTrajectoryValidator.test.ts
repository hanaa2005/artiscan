/**
 * The two files must reject each other.
 *
 * The most important assertions in this file are the cross-rejection ones: a
 * lossy derived artifact must never be usable where canonical evidence is
 * expected, in either direction.
 */

import { describe, expect, it } from 'vitest'
import {
  deserializeCriticalTrajectory,
  serializeCriticalTrajectory,
  validateCriticalTrajectory,
} from './criticalTrajectoryValidator'
import { buildCriticalTrajectory } from './criticalTrajectory'
import { validateSession } from '../../drawing/services/drawingValidator'
import { makePoint, makeSession, makeStroke } from '../../drawing/testing/sessionFixture'
import type { CriticalTrajectoryArtifactV2 } from '../types/criticalTrajectory.types'
import type { DrawingSession } from '../../drawing/types/drawing.types'

const CANVAS = { width: 800, height: 400, devicePixelRatio: 1 }

function sampleSession(): DrawingSession {
  const points = Array.from({ length: 30 }, (_, i) =>
    makePoint({
      sequence: i + 1,
      timeMs: (i + 1) * 10,
      x: 50 + i * 8,
      y: 200 + Math.sin(i / 4) * 60,
      normalizedX: (50 + i * 8) / 800,
      normalizedY: (200 + Math.sin(i / 4) * 60) / 400,
    }),
  )
  return makeSession({
    canvas: CANVAS,
    strokes: [
      makeStroke({
        id: 'a',
        order: 0,
        startedAtMs: 10,
        endedAtMs: 300,
        points,
      }),
    ],
    actions: [],
  })
}

function sampleArtifact(): CriticalTrajectoryArtifactV2 {
  return buildCriticalTrajectory(sampleSession(), { now: () => '2026-08-18T09:00:00.000Z' })
}

/** A deep copy, so a test can break one field without affecting the others. */
function clone(artifact: CriticalTrajectoryArtifactV2): CriticalTrajectoryArtifactV2 {
  return JSON.parse(JSON.stringify(artifact)) as CriticalTrajectoryArtifactV2
}

describe('accepting a genuine artifact', () => {
  it('accepts what the builder produces', () => {
    expect(validateCriticalTrajectory(sampleArtifact()).ok).toBe(true)
  })

  it('round-trips through JSON', () => {
    const artifact = sampleArtifact()
    const parsed = deserializeCriticalTrajectory(serializeCriticalTrajectory(artifact))

    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value).toEqual(artifact)
  })
})

describe('the two file kinds reject each other', () => {
  it('refuses a canonical session', () => {
    // The whole point: a raw session must not be readable as a graph artifact.
    const result = validateCriticalTrajectory(sampleSession())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('مسیر نقاط ضروری')
  })

  it('the session validator refuses a critical trajectory', () => {
    /*
      And the reverse, which is the dangerous direction: importing a lossy
      summary as if it were the recording would silently replace evidence with
      a derivative of it.
    */
    expect(validateSession(sampleArtifact()).ok).toBe(false)
  })
})

describe('required fields', () => {
  it('rejects a missing artifactType', () => {
    const artifact = clone(sampleArtifact()) as unknown as Record<string, unknown>
    delete artifact['artifactType']
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects an unsupported schema version', () => {
    const artifact = clone(sampleArtifact()) as unknown as Record<string, unknown>
    artifact['artifactSchemaVersion'] = 99
    const result = validateCriticalTrajectory(artifact)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('99')
  })

  it('rejects an artifact that does not declare itself lossy', () => {
    const artifact = clone(sampleArtifact()) as unknown as Record<string, unknown>
    artifact['lossy'] = false
    const result = validateCriticalTrajectory(artifact)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('کاسته‌شده')
  })

  it('rejects a missing source session id', () => {
    const artifact = clone(sampleArtifact()) as unknown as Record<string, unknown>
    artifact['sourceSessionId'] = ''
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a missing algorithm block', () => {
    const artifact = clone(sampleArtifact()) as unknown as Record<string, unknown>
    delete artifact['algorithm']
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a missing algorithm version', () => {
    const artifact = clone(sampleArtifact())
    ;(artifact.algorithm as Record<string, unknown>)['version'] = ''
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a canvas with no size', () => {
    const artifact = clone(sampleArtifact())
    artifact.canvas = { width: 0, height: 400 }
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })
})

describe('node integrity', () => {
  it('rejects a duplicate node id', () => {
    const artifact = clone(sampleArtifact())
    const first = artifact.nodes[0]
    const second = artifact.nodes[1]
    if (first === undefined || second === undefined) throw new Error('fixture')
    second.id = first.id

    const result = validateCriticalTrajectory(artifact)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('بیش از یک بار')
  })

  it('rejects a node with no source sequence', () => {
    const artifact = clone(sampleArtifact()) as unknown as {
      nodes: Array<Record<string, unknown>>
    }
    delete artifact.nodes[0]!['sourcePointSequence']
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a negative or fractional source sequence', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const artifact = clone(sampleArtifact())
      artifact.nodes[0]!.sourcePointSequence = bad
      expect(validateCriticalTrajectory(artifact).ok).toBe(false)
    }
  })

  it('rejects a node with no reasons', () => {
    const artifact = clone(sampleArtifact())
    artifact.nodes[0]!.reasons = []
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a node with a non-finite coordinate', () => {
    const artifact = clone(sampleArtifact()) as unknown as {
      nodes: Array<Record<string, unknown>>
    }
    artifact.nodes[0]!['x'] = 'not a number'
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a node with a negative time', () => {
    const artifact = clone(sampleArtifact())
    artifact.nodes[0]!.timeMs = -5
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a node that belongs to no stroke', () => {
    const artifact = clone(sampleArtifact())
    artifact.nodes[0]!.strokeId = ''
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })
})

describe('edge integrity', () => {
  it('rejects an edge pointing at a node that is not in the file', () => {
    const artifact = clone(sampleArtifact())
    const edge = artifact.edges[0]
    if (edge === undefined) throw new Error('fixture')
    edge.to = 'no-such-node'

    const result = validateCriticalTrajectory(artifact)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('ناموجود')
  })

  it('rejects a duplicate edge id', () => {
    const artifact = clone(sampleArtifact())
    const first = artifact.edges[0]
    const second = artifact.edges[1]
    if (first === undefined || second === undefined) throw new Error('fixture')
    second.id = first.id

    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('rejects a non-finite measurement on an edge', () => {
    const artifact = clone(sampleArtifact()) as unknown as {
      edges: Array<Record<string, unknown>>
    }
    artifact.edges[0]!['directDistancePx'] = 'far'
    expect(validateCriticalTrajectory(artifact).ok).toBe(false)
  })

  it('accepts null measurements, which are legitimate', () => {
    // An action transition has no geometry; null says so honestly.
    const artifact = clone(sampleArtifact())
    const edge = artifact.edges[0]
    if (edge === undefined) throw new Error('fixture')
    edge.directDistancePx = null
    edge.sourcePathLengthPx = null

    expect(validateCriticalTrajectory(artifact).ok).toBe(true)
  })
})

describe('malformed input', () => {
  it('rejects text that is not JSON', () => {
    const result = deserializeCriticalTrajectory('{ not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('JSON')
  })

  it.each([null, 42, 'text', []])('rejects %p', (value) => {
    expect(validateCriticalTrajectory(value).ok).toBe(false)
  })

  it('never throws on arbitrary input', () => {
    const inputs = [undefined, null, 0, '', [], {}, { artifactType: 'critical_trajectory' }]
    for (const input of inputs) {
      expect(() => validateCriticalTrajectory(input)).not.toThrow()
    }
  })
})
