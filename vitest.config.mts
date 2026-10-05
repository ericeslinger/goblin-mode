import { defineConfig } from 'vitest/config';

// Units for shared and functions. The frontend runs its own through
// `ng test` (Angular's builder), see package.json test:unit.
export default defineConfig({
  resolve: {
    alias: {
      '@goblin/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    projects: [
      { extends: true, test: { name: 'shared', include: ['packages/shared/src/**/*.spec.ts'] } },
      {
        extends: true,
        test: { name: 'functions', include: ['packages/functions/src/**/*.spec.ts'] },
      },
      { extends: true, test: { name: 'worker', include: ['infra/worker/src/**/*.spec.ts'] } },
      { extends: true, test: { name: 'rules', include: ['packages/e2e/rules/**/*.spec.ts'] } },
    ],
  },
});
