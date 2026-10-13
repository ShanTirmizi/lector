// Shows what Lector would read on a page, without the voice. Fast, so it is
// the quickest way to see whether a site is being understood.
// Usage: node scripts/extract.mjs <url> [url ...]   (add --all to print every sentence)
//        node scripts/extract.mjs --test      (checks the pages in test/fixtures/structures)
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const chromiumBuild = (await readdir(cache)).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1);
const executablePath = process.env.CHROMIUM_PATH ?? path.join(cache, chromiumBuild, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

// The extraction code, bundled so it can be run inside any page.
const bundle = await build({
  stdin: { contents: "export { readPage } from './src/content/page'; export { DEFAULTS } from './src/shared/settings';", resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'iife',
  globalName: 'Lector',
  write: false,
  logLevel: 'warning',
});
const code = `${bundle.outputFiles[0].text};globalThis.Lector = Lector;`;

const browser = await chromium.launch({ executablePath });
async function read(url, wait = 2500) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(wait);
    await page.evaluate(code);
    return await page.evaluate(() => {
      const started = performance.now();
      const reading = Lector.readPage(Lector.DEFAULTS);
      return { ms: Math.round(performance.now() - started), blocks: reading.blocks.map((block) => ({ heading: block.heading, text: block.text })), units: reading.units.map((unit) => unit.spoken) };
    });
  } finally {
    await page.close();
  }
}

let failures = 0;
if (process.argv.includes('--test')) {
  const dir = path.join(root, 'test/fixtures/structures');
  const expectations = JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8'));
  for (const [file, want] of Object.entries(expectations)) {
    const { blocks } = await read(pathToFileURL(path.join(dir, file)).href, 100);
    const text = blocks.map((block) => block.text).join('\n');
    const problems = [];
    if (want.first && blocks[0]?.text !== want.first) problems.push(`starts with ${JSON.stringify(blocks[0]?.text.slice(0, 60))}, wanted ${JSON.stringify(want.first)}`);
    for (const piece of want.has ?? []) if (!text.includes(piece)) problems.push(`missing ${JSON.stringify(piece)}`);
    for (const piece of want.lacks ?? []) if (text.includes(piece)) problems.push(`should not read ${JSON.stringify(piece)}`);
    for (const heading of want.headings ?? []) if (!blocks.some((block) => block.heading && block.text === heading)) problems.push(`heading ${JSON.stringify(heading)} not recognised`);
    console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${file}  — ${want.about}${problems.length ? `\n      ${problems.join('\n      ')}` : ''}`);
    failures += problems.length ? 1 : 0;
  }
} else {
  const everything = process.argv.includes('--all');
  for (const url of process.argv.slice(2).filter((arg) => !arg.startsWith('--'))) {
    try {
      const { ms, blocks, units } = await read(url);
      const characters = units.reduce((sum, unit) => sum + unit.length, 0);
      console.log(`\n${url}\n${blocks.length} paragraphs, ${units.length} sentences, about ${Math.round(characters / 15.5 / 60)} min, found in ${ms} ms`);
      const show = (unit) => console.log(`   ${unit.slice(0, 110)}`);
      if (everything) units.forEach(show);
      else {
        units.slice(0, 6).forEach(show);
        if (units.length > 9) console.log('   …');
        units.slice(Math.max(6, units.length - 3)).forEach(show);
      }
    } catch (error) {
      console.log(`\n${url}\nFAILED: ${String(error.message).split('\n')[0]}`);
    }
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
