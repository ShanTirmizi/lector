// Draws the extension icon at each size Chrome asks for. Run once; the PNGs are committed.
import { chromium } from 'playwright-core';
import { findChromium } from './browser.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = await findChromium();

// A page of text with one line picked out in highlighter.
const mark = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="30" fill="#173f35"/>
  <rect x="26" y="30" width="56" height="13" rx="6.5" fill="#f2f5ee" opacity=".55"/>
  <rect x="20" y="53" width="88" height="23" rx="9" fill="#ffd84d"/>
  <rect x="26" y="86" width="40" height="13" rx="6.5" fill="#f2f5ee" opacity=".55"/>
</svg>`;

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${mark}`);
  await page.screenshot({ path: path.join(root, `static/icons/icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log('icons written');
