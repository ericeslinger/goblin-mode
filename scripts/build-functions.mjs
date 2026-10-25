// Bundles packages/functions into lib/index.js with esbuild. Runtime
// dependencies stay external and are installed by the deploy from the
// functions manifest; workspace code (@mossgoblin/schema) is bundled in.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The emulator build (scripts/emulators.sh, scripts/e2e.sh) swaps in
// modules the emulator alone needs, each marked EMULATOR_ONLY; the deploy
// builds without this and its dry run fails if the marker got in.
const emulatorBuild = process.env.MOSSGOBLIN_EMULATOR_BUILD === '1';
const emulatorModules = {
  plugins: [
    {
      name: 'emulator-only',
      setup(b) {
        b.onResolve({ filter: /\/stand-in$/ }, (args) => ({
          path: resolve(args.resolveDir, `${args.path}.emulator.ts`),
        }));
      },
    },
  ],
};

const pkg = JSON.parse(readFileSync('packages/functions/package.json', 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]);

await build({
  entryPoints: ['packages/functions/src/index.ts'],
  outfile: 'packages/functions/lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  tsconfig: 'packages/functions/tsconfig.json',
  external,
  logLevel: 'warning',
  ...(emulatorBuild ? emulatorModules : {}),
});
