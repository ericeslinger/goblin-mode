// Bundles packages/functions into lib/index.js with esbuild. Runtime
// dependencies stay external and are installed by the deploy from the
// functions manifest; workspace code (@goblin/shared) is bundled in.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

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
});
