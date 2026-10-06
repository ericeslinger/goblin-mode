import { defineConfig } from 'vitest/config';

// Units for schema, editor, functions and the worker, plus the rules
// tests (run only from npm run e2e, against the emulator). The frontend
// runs its own through `ng test` (Angular's builder); see package.json
// test:unit.
export default defineConfig({
  resolve: {
    alias: {
      '@goblin/schema': new URL('./packages/schema/src/index.ts', import.meta.url).pathname,
      '@goblin/editor/grammar': new URL('./packages/editor/src/grammar/index.ts', import.meta.url)
        .pathname,
      '@goblin/editor': new URL('./packages/editor/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    projects: [
      { extends: true, test: { name: 'schema', include: ['packages/schema/src/**/*.spec.ts'] } },
      {
        extends: true,
        test: { name: 'functions', include: ['packages/functions/src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'editor',
          environment: 'jsdom',
          include: ['packages/editor/src/**/*.spec.ts'],
        },
      },
      { extends: true, test: { name: 'worker', include: ['infra/worker/src/**/*.spec.ts'] } },
      {
        extends: true,
        test: { name: 'rules', include: ['packages/rules-tests/src/**/*.spec.ts'] },
      },
    ],
  },
});
