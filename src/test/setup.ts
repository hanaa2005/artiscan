import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

/*
  Testing Library only auto-cleans when Vitest runs with `globals: true`, and
  this project deliberately imports its test helpers explicitly instead. Without
  this, every rendered component stays in the document and the next test finds
  two of every button.
*/
afterEach(() => {
  cleanup()
})

// Provides an in-memory IndexedDB implementation for tests.
// jsdom has no IndexedDB of its own, so without this the repository tests
// would only ever exercise the "storage unavailable" fallback path.
import 'fake-indexeddb/auto'

/*
  jsdom implements no layout engine and therefore no ResizeObserver, so a
  component that measures its own container throws on mount.

  The stub deliberately does NOTHING beyond satisfying the interface: jsdom
  reports every element as 0x0 anyway, so a callback that fired would only
  deliver fictional measurements. Tests here assert on behaviour and markup, and
  anything that depends on real geometry is verified in a real browser instead.
*/
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    writable: true,
  })
}

// jsdom has no crypto.randomUUID in some versions; provide a deterministic-enough
// fallback so id generation does not throw during tests.
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: {}, writable: true })
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  let counter = 0
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: (): `${string}-${string}-${string}-${string}-${string}` => {
      counter += 1
      const hex = counter.toString(16).padStart(12, '0')
      return `00000000-0000-4000-8000-${hex}`
    },
    writable: true,
  })
}
