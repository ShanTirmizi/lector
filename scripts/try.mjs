// Tries the built extension on a real page and reports what it read.
// Usage: node scripts/try.mjs <url> [seconds] [--headed]
// Put "pdf:" in front of a PDF's address to open it in Lector's PDF view.
import path from 'node:path';
import { launch, root, sleep } from './browser.mjs';

const [url, secondsArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seconds = Number(secondsArg ?? 20);
const headed = process.argv.includes('--headed');
if (!url) throw new Error('Usage: node scripts/try.mjs <url> [seconds] [--headed]');

const { context, worker, extension } = await launch({ headed });
try {
  await worker.evaluate(() => chrome.storage.local.clear());
  const page = await context.newPage();
  const target = url.startsWith('pdf:') ? `${extension}/pdf.html?file=${encodeURIComponent(url.slice(4))}` : url;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.bringToFront();
  await sleep(2500);
  if (url.startsWith('pdf:')) await page.locator('lector-ui .launcher').waitFor({ state: 'visible', timeout: 90_000 }).catch(() => console.log('page status:', page.locator('#status').innerText()));
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
  const name = new URL(url.replace(/^pdf:/, '')).hostname.replace(/[^a-z0-9]+/gi, '-') + (url.startsWith('pdf:') ? '-pdf' : '');
  await page.screenshot({ path: path.join(root, 'test/shots', `try-${name}.png`) });
} finally {
  await context.close();
}
