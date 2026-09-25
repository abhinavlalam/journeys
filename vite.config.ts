import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    // Node by default: `vault.ts`'s own rules have no DOM dependency. A file that
    // needs one opts in with a `/** @vitest-environment jsdom */` docblock.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // One async budget for every `waitFor` in the suite — see the file itself.
    setupFiles: ['src/__tests__/setup.ts'],
  },
})
