import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', include: ['packages/shared/test/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'server',
          include: ['packages/server/test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      { test: { name: 'client', include: ['packages/client/test/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
