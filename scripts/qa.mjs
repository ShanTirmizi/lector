// Runs the built extension over a list of real pages and reports, for each,
// what it chose to read and how playback behaved. A quick way to spot pages
// where extraction or styling goes wrong.
// Usage: node scripts/qa.mjs [url ...]   (with no URLs, a built-in list is used)
import { chromium } from 'playwright-core';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const DEFAULT = [
  'https://en.wikipedia.org/wiki/Sleeping_car',
  'https://paulgraham.com/hwh.html',
  'https://simonwillison.net/2024/Dec/31/llms-in-2024/',
  'https://slatestarcodex.com/2014/07/30/meditations-on-moloch/',
  'https://blog.cloudflare.com/how-we-built-pingora-the-proxy-that-connects-cloudflare-to-the-internet/',
  'https://www.propublica.org/article/how-the-irs-was-gutted',
  'https://plato.stanford.edu/entries/consciousness/',
  'https://github.com/huggingface/transformers.js',
  'https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API',
  'https://news.ycombinator.com/item?id=39000000',
  'https://www.gutenberg.org/files/1342/1342-h/1342-h.htm',
  'https://react.dev/learn/thinking-in-react',
  'https://arxiv.org/abs/1706.03762',
];
const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = urls.length ? urls : DEFAULT;
const seconds = Number(process.env.QA_SECONDS ?? 14);

const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const build = (await readdir(cache)).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1);
const executablePath = process.env.CHROMIUM_PATH ?? path.join(cache, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const context = await chromium.launchPersistentContext(path.join(root, '.test-profile'), {
  executablePath,
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--mute-audio', '--enable-unsafe-webgpu'],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(() => chrome.storage.local.clear());
  for (const url of list) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /lector|chrome-extension/i.test(m.text() + (m.location()?.url ?? ''))) errors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => /lector/i.test(e.stack ?? '') && errors.push(String(e).slice(0, 200)));
    console.log(`\n=== ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.bringToFront();
      await sleep(3000);
      const ui = (selector) => page.locator(`lector-ui ${selector}`);
      const read = (name) =>
        page.evaluate((n) => {
          const highlight = CSS.highlights.get(n);
          return highlight ? [...highlight].map((range) => range.toString()).join(' ').replace(/\s+/g, ' ') : null;
        }, name);
      const launcher = (await ui('.launcher').isVisible().catch(() => false)) ? (await ui('.launcher').innerText()).replace(/\n/g, ' ') : 'no';
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
        const sentence = await read('lector-sentence').catch(() => null);
        const word = await read('lector-word').catch(() => null);
        if (word && !firstWord) firstWord = Date.now() - started;
        if (sentence && sentences.at(-1) !== sentence) sentences.push(sentence);
        if (word) words.add(`${sentences.length}:${word}`);
        if (firstWord) {
          samples++;
          if (await ui('.player').getAttribute('data-busy').catch(() => null)) busy++;
        }
        await sleep(70);
      }
      const look = await page.evaluate(() => {
        const host = document.querySelector('lector-ui');
        const player = host?.shadowRoot?.querySelector('.player');
        const rect = player?.getBoundingClientRect();
        const sheet = document.querySelector('style[data-lector]');
        return {
          player: player ? getComputedStyle(player).backgroundColor : null,
          size: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : null,
          highlightRules: sheet?.sheet?.cssRules.length ?? (document.adoptedStyleSheets?.length ? 'adopted' : 0),
          hostParent: host?.parentElement?.tagName ?? null,
        };
      });
      const toast = await ui('.toast').innerText().catch(() => '');
      console.log(`launcher: ${launcher} | first word ${(firstWord / 1000).toFixed(1)}s | waiting ${samples ? Math.round((busy / samples) * 100) : 0}% | words ${words.size} | status "${(await ui('.status').innerText().catch(() => '-')).replace(/\n/g, ' ')}"`);
      console.log(`look: ${JSON.stringify(look)}${toast ? ` | toast "${toast.replace(/\n/g, ' ')}"` : ''}${errors.length ? ` | ERRORS ${JSON.stringify(errors.slice(0, 3))}` : ''}`);
      sentences.slice(0, 7).forEach((sentence, i) => console.log(`  ${i + 1}. ${sentence.slice(0, 150)}`));
      const name = new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-');
      await page.screenshot({ path: path.join(root, 'test/shots', `qa-${name}.png`) });
    } catch (error) {
      console.log(`FAILED: ${String(error.message).split('\n')[0]}`);
    }
    await page.close();
  }
} finally {
  await context.close();
}
