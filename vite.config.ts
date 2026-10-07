/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    globals: true,
    // The default suite. Strictly functional: no timing assertions live here, because
    // a perf gate that can be perturbed by a busy CI runner is a gate that will
    // eventually be ignored. See ADR-003.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'perf',
          environment: 'node',
          include: ['tests/perf/**/*.perf.test.ts'],
          setupFiles: ['./tests/setup.ts'],
          // A timing measurement cannot share a CPU with another worker.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
