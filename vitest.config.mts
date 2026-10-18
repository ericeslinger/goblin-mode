import { defineConfig } from 'vitest/config';

// Units for schema, editor, functions and the worker, plus the rules
// tests and the functions' Firestore tests (both run only from npm run
// e2e, against the emulator). The frontend
// runs its own through `ng test` (Angular's builder); see package.json
// test:unit.
export default defineConfig({
  resolve: {
    alias: {
      '@mossgoblin/schema': new URL('./packages/schema/src/index.ts', import.meta.url).pathname,
      '@mossgoblin/editor/grammar': new URL(
        './packages/editor/src/grammar/index.ts',
        import.meta.url,
      ).pathname,
      '@mossgoblin/editor': new URL('./packages/editor/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    projects: [
      { extends: true, test: { name: 'schema', include: ['packages/schema/src/**/*.spec.ts'] } },
      {
        extends: true,
        test: {
          name: 'functions',
          include: ['packages/functions/src/**/*.spec.ts'],
          exclude: ['**/*.emulator.spec.ts'],
        },
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
      {
        extends: true,
        test: {
          name: 'functions-emulator',
          include: ['packages/functions/src/**/*.emulator.spec.ts'],
          // The Google client libraries look for a GCP metadata server
          // before their first call; off GCP that times out after seconds,
          // which once pushed a test past its 5 s limit, and its late write
          // then landed in the next test (2026-10-18). The emulator needs
          // no metadata server.
          env: { METADATA_SERVER_DETECTION: 'none' },
        },
      },
    ],
  },
});
