import { describe, expect, it } from 'vitest'
import { readPointerType, readPressure } from './pointerInput'

describe('readPointerType', () => {
  it('passes through the three known device types', () => {
    expect(readPointerType('mouse')).toBe('mouse')
    expect(readPointerType('pen')).toBe('pen')
    expect(readPointerType('touch')).toBe('touch')
  })

  it('maps anything unrecognised to "unknown" rather than trusting it', () => {
    expect(readPointerType('')).toBe('unknown')
    expect(readPointerType('gamepad')).toBe('unknown')
  })
})

describe('readPressure', () => {
  it('keeps genuine pressure reported by a stylus', () => {
    expect(readPressure('pen', 0.42)).toBe(0.42)
  })

  it('discards the constant 0.5 a mouse reports', () => {
    // The Pointer Events spec makes non-pressure devices report 0.5. Recording
    // that would put a fake measurement into the research data.
    expect(readPressure('mouse', 0.5)).toBeNull()
  })

  it('discards touch pressure, which is a constant on most digitizers', () => {
    expect(readPressure('touch', 0.5)).toBeNull()
  })

  it('discards a zero or non-finite reading', () => {
    expect(readPressure('pen', 0)).toBeNull()
    expect(readPressure('pen', Number.NaN)).toBeNull()
  })
})
