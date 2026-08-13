// Provides an in-memory IndexedDB implementation for tests.
// jsdom has no IndexedDB of its own, so without this the repository tests
// would only ever exercise the "storage unavailable" fallback path.
import 'fake-indexeddb/auto'

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
