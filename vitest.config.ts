import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest config for the SC Prism client. jsdom + Testing Library, globals off
// (tests import { describe, it, expect, vi } from 'vitest' explicitly). CSS is
// skipped so component imports of '*.css' resolve to no-ops.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
