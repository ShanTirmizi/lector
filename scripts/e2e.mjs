// End-to-end check: loads the built extension in Chromium and drives it on a
// local test page. Run `npm run build` first. Usage: node scripts/e2e.mjs [--headed]
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const headed = process.argv.includes('--headed');

async function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const builds = (await readdir(cache)).filter((name) => /^chromium-\d+$/.test(name)).sort();
  if (builds.length === 0) throw new Error('No Playwright Chromium found. Set CHROMIUM_PATH.');
  return path.join(cache, builds.at(-1), 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}

const TYPES = { '.html': 'text/html', '.pdf': 'application/pdf', '.js': 'text/javascript' };
const server = http.createServer(async (request, response) => {
  try {
    const file = path.join(root, 'test/fixtures', decodeURIComponent(new URL(request.url, 'http://x').pathname));
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(path.join(root, '.test-profile'), {
  executablePath: await findChromium(),
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [
    ...(headed ? [] : ['--headless=new']),
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--mute-audio',
    '--enable-unsafe-webgpu',
  ],
});

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeout, label) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(200);
  }
}

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const command = (message) =>
    worker.evaluate(async (m) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tab.id, m);
    }, message);

  // Start every run from default settings.
  await worker.evaluate(() => chrome.storage.local.clear());

  const page = await context.newPage();
  const engineLog = [];
  page.on('console', (message) => {
    if (message.text().startsWith('[lector]')) engineLog.push(message.text());
  });
  await page.goto(`${base}/article.html`);
  await page.bringToFront();

  const { run } = await import('./e2e-steps.mjs');
  await run({ page, context, worker, command, check, waitFor, sleep, engineLog, base, extension: worker.url().split('/').slice(0, 3).join('/') });
} catch (error) {
  console.log('FAIL  uncaught:', error.message);
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
