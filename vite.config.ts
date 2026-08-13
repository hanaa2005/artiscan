// defineConfig comes from vitest/config (not 'vite') so the `test` block below
// is type-checked. It is a superset of Vite's own defineConfig.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom gives the tests a browser-like environment (document, window, ...).
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // fake-indexeddb provides an in-memory IndexedDB so the repository layer
    // can be tested without a real browser.
    setupFiles: ['./src/test/setup.ts'],
  },
})
