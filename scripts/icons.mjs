// Renders the PWA's PNG icons from packages/frontend/public/icons/icon.svg,
// the one source of the Mossgoblin mark (#26). Run after changing the
// SVG: `npm run icons`. The PNGs are committed, so builds never render.
//
// The art keeps everything that matters inside the central 80% circle,
// so the same picture serves as the maskable icon.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const icons = join(dirname(fileURLToPath(import.meta.url)), '../packages/frontend/public/icons');
const svg = readFileSync(join(icons, 'icon.svg')).toString('base64');
const sizes = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };

// In a cloud container, use the preinstalled Chromium (see the e2e config).
const preinstalled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(preinstalled) ? preinstalled : undefined,
});
try {
  for (const [file, size] of Object.entries(sizes)) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0}</style>` +
        `<img src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}">`,
    );
    await page.screenshot({ path: join(icons, file) });
    await page.close();
    console.log(`${file} (${size}px)`);
  }
} finally {
  await browser.close();
}
