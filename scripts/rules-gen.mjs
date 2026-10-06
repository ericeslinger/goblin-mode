// Writes the generated shape validators into firestore.rules, or with
// --check fails if the committed rules are stale (part of npm run gate).
// A script rather than a build step because it must bundle the
// TypeScript schema package to read the zod contract. See
// packages/schema/src/rules.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const check = args.includes('--check');
for (const arg of args) {
  if (arg !== '--check') {
    console.error(`error: unknown argument: ${arg}`);
    process.exit(2);
  }
}

const bundled = await build({
  entryPoints: ['packages/schema/src/rules/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'warning',
});
const source = bundled.outputFiles[0].text;
const { renderRulesBlock, spliceGenerated } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

const { block, warnings } = renderRulesBlock();
if (warnings.length > 0) {
  for (const w of warnings) console.error(`error: ${w}`);
  process.exit(1);
}

const path = 'firestore.rules';
const current = readFileSync(path, 'utf8');
const next = spliceGenerated(current, block);
if (check) {
  if (next !== current) {
    console.error('error: firestore.rules is stale; run `npm run rules:gen`');
    process.exit(1);
  }
  console.log('firestore.rules validators are up to date');
} else if (next !== current) {
  writeFileSync(path, next);
  console.log('firestore.rules validators regenerated');
} else {
  console.log('firestore.rules validators already up to date');
}
