// Tries the built extension on a real page and reports what it read.
// Usage: node scripts/try.mjs <url> [seconds] [--headed]
import { chromium } from 'playwright-core';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const [url, secondsArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seconds = Number(secondsArg ?? 20);
const headed = process.argv.includes('--headed');
if (!url) throw new Error('Usage: node scripts/try.mjs <url> [seconds] [--headed]');

const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const build = (await readdir(cache)).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1);
const executablePath = process.env.CHROMIUM_PATH ?? path.join(cache, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const context = await chromium.launchPersistentContext(path.join(root, '.test-profile'), {
  executablePath,
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [...(headed ? [] : ['--headless=new']), `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--mute-audio', '--enable-unsafe-webgpu'],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(() => chrome.storage.local.clear());
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.bringToFront();
  await sleep(2500);
  const ui = (selector) => page.locator(`lector-ui ${selector}`);
  const read = (name) =>
    page.evaluate((n) => {
      const highlight = CSS.highlights.get(n);
      return highlight ? [...highlight].map((range) => range.toString()).join('').replace(/\s+/g, ' ') : null;
    }, name);

  console.log('launcher:', (await ui('.launcher').isVisible()) ? (await ui('.launcher').innerText()).replace(/\n/g, ' ') : 'not shown');
  const started = Date.now();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  });
  let firstWord = 0;
  let busy = 0;
  let samples = 0;
  const sentences = [];
  const words = new Set();
  while (Date.now() - started < seconds * 1000) {
    const sentence = await read('lector-sentence');
    const word = await read('lector-word');
    if (word && !firstWord) firstWord = Date.now() - started;
    if (sentence && sentences.at(-1) !== sentence) sentences.push(sentence);
    if (word) words.add(`${sentences.length}:${word}`);
    if (firstWord) {
      samples++;
      if (await ui('.player').getAttribute('data-busy').catch(() => null)) busy++;
    }
    await sleep(60);
  }
  console.log(`first word after ${(firstWord / 1000).toFixed(1)}s; waiting ${samples ? Math.round((busy / samples) * 100) : 0}% of the time after that; ${words.size} words highlighted`);
  console.log('status:', await ui('.status').innerText().catch(() => '(no player)'));
  sentences.forEach((sentence, i) => console.log(`${String(i + 1).padStart(2)}. ${sentence.slice(0, 160)}`));
  const name = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-');
  await page.screenshot({ path: path.join(root, 'test/shots', `try-${name}.png`) });
} finally {
  await context.close();
}
