import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      all: true,
      reporter: [['text', { skipFull: false }], 'json-summary', 'lcov'],
      thresholds: {
        branches: 60,
        functions: 90,
        lines: 80,
        statements: 80,
      },
    },
  },
});
