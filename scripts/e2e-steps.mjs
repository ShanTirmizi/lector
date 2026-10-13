// The checks themselves. Kept apart from the harness so they can grow with the features.
import path from 'node:path';

const shots = path.resolve('test/shots');

export async function run({ page, command, check, waitFor, sleep }) {
  const ui = (selector, options) => page.locator(`lector-ui ${selector}`, options);
  const highlighted = (name) =>
    page.evaluate((n) => {
      const highlight = CSS.highlights.get(n);
      return highlight ? [...highlight].map((range) => range.toString()).join('').replace(/\s+/g, ' ') : null;
    }, name);
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

  // The launcher appears on an article.
  await ui('.launcher').waitFor({ state: 'visible', timeout: 10_000 });
  check('launcher appears on an article', true, await ui('.launcher').innerText());
  await ui('.launcher').hover();
  await sleep(350);
  await shot('01-launcher');

  // Read the whole article.
  const started = Date.now();
  await command({ type: 'toggle' });
  await ui('.player').waitFor({ state: 'visible' });
  await shot('02-loading');
  await waitFor(async () => (await ui('.play').getAttribute('aria-label')) === 'Pause' && (await highlighted('lector-word')), 600_000, 'speech to start');
  check('article starts playing', true, `${((Date.now() - started) / 1000).toFixed(1)}s to first word`);
  check('starts with the headline', (await highlighted('lector-sentence')) === 'The Quiet Return of the Night Train', await highlighted('lector-sentence'));

  // Words light up one after another, in reading order.
  const seen = [];
  const sentences = new Set();
  const until = Date.now() + 14_000;
  while (Date.now() < until) {
    const word = await highlighted('lector-word');
    if (word && seen.at(-1) !== word) seen.push(word);
    sentences.add(await highlighted('lector-sentence'));
    await sleep(40);
  }
  await shot('03-playing');
  const text = await page.evaluate(() => document.querySelector('article').innerText.replace(/\s+/g, ' '));
  let cursor = 0;
  let inOrder = 0;
  for (const word of seen) {
    const at = text.indexOf(word, cursor);
    if (at >= 0 && at - cursor < 60) {
      inOrder++;
      cursor = at + word.length;
    }
  }
  check('words are highlighted in reading order', seen.length > 15 && inOrder >= seen.length - 2, `${seen.length} words: ${seen.slice(0, 14).join(' ')} …`);
  const spoken = [...sentences].filter(Boolean).join(' | ');
  check('citation markers are not read', !spoken.includes('[1]'), spoken.slice(0, 200));
  check('navigation is not read', !spoken.includes('Subscribe') && !spoken.includes('Most read'));

  // Transport.
  const before = await highlighted('lector-sentence');
  await ui('button[aria-label="Next sentence"]').click();
  await waitFor(async () => (await highlighted('lector-sentence')) !== before, 20_000, 'next sentence');
  check('next jumps a sentence', true, await highlighted('lector-sentence'));
  await ui('.play').click();
  await waitFor(async () => (await ui('.play').getAttribute('aria-label')) === 'Play', 5_000, 'pause');
  const frozen = await highlighted('lector-word');
  await sleep(700);
  check('pause holds the highlight still', (await highlighted('lector-word')) === frozen);
  await ui('.play').click();
  await waitFor(async () => (await ui('.play').getAttribute('aria-label')) === 'Pause', 5_000, 'resume');

  // Speed.
  await ui('.chip.speed').click();
  await ui('.panel').waitFor({ state: 'visible' });
  await shot('04-speed');
  await ui('.presets button', { hasText: /^2×$/ }).click();
  await waitFor(async () => (await ui('.chip.speed').innerText()) === '2×', 3_000, 'speed chip');
  check('speed changes', true, await ui('.chip.speed').innerText());
  const fastSeen = new Set();
  const fastUntil = Date.now() + 4_000;
  while (Date.now() < fastUntil) {
    fastSeen.add(await highlighted('lector-word'));
    await sleep(30);
  }
  check('highlighting keeps up at 2×', fastSeen.size > 12, `${fastSeen.size} words in 4s`);
  await ui('.presets button', { hasText: /^1×$/ }).click();

  // Voice.
  await ui('.chip.voice').click();
  await shot('05-voices');
  await ui('.voice-row .pick', { hasText: 'George' }).click();
  await waitFor(async () => (await ui('.chip.voice').innerText()).includes('George'), 3_000, 'voice chip');
  await waitFor(async () => (await ui('.play').getAttribute('aria-label')) === 'Pause' && !(await ui('.player').getAttribute('data-busy')), 60_000, 'new voice to speak');
  check('voice changes mid-read', true);

  // Options.
  await ui('button[aria-label="Reading options"]').click();
  await shot('06-options');
  await ui('.swatches button[aria-label="Mint"]').click();
  await page.mouse.click(300, 300);
  check('panel closes on outside click', (await ui('.panel').count()) === 0);

  // Play button beside a paragraph.
  await page.locator('#p4').hover();
  await ui('.spot.on').waitFor({ state: 'visible', timeout: 5_000 });
  await shot('07-paragraph-button');
  await ui('.spot.on').click();
  await waitFor(async () => (await highlighted('lector-sentence'))?.startsWith('Not everyone'), 30_000, 'paragraph to start');
  check('paragraph button starts from that paragraph', true);

  // Listen to a selection.
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p2'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.evaluate(() => document.getElementById('p2').scrollIntoView({ block: 'center' }));
  await ui('.listen').waitFor({ state: 'visible', timeout: 5_000 });
  await shot('08-selection-button');
  await ui('.listen').click();
  await waitFor(async () => (await highlighted('lector-sentence'))?.startsWith('Dr. Elena Marsh'), 30_000, 'selection to start');
  check('selection is read and highlighted', true, await highlighted('lector-sentence'));

  // Close.
  await ui('button[aria-label="Close the player"]').click();
  await sleep(300);
  check('closing clears the page', (await highlighted('lector-sentence')) === null && (await ui('.player').isHidden()));
}
