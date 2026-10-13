// The checks themselves. Kept apart from the harness so they can grow with the features.
import path from 'node:path';

const shots = path.resolve('test/shots');

export async function run({ page, context, worker, command, check, waitFor, sleep, base, extension }) {
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

  // Carrying on where the listener stopped.
  await page.reload();
  await ui('.launcher').waitFor({ state: 'visible', timeout: 10_000 });
  await command({ type: 'toggle' });
  await ui('.toast').waitFor({ state: 'visible', timeout: 15_000 });
  await shot('08b-carry-on');
  const resumed = await highlighted('lector-sentence');
  check('a later visit carries on where it stopped', resumed !== 'The Quiet Return of the Night Train', resumed);
  await ui('.toast button').click();
  await waitFor(async () => (await highlighted('lector-sentence')) === 'The Quiet Return of the Night Train', 15_000, 'start from the top');
  check('"Start from the top" goes back to the beginning', true);
  await ui('button[aria-label="Close the player"]').click();

  // ---------------------------------------------------------------- settings
  const options = await context.newPage();
  await options.goto(`${extension}/options.html`);
  await options.locator('#voice').waitFor();
  await options.screenshot({ path: path.join(shots, '09-settings.png'), fullPage: true });
  await options.locator('input[data-key="skipCaptions"]').uncheck();
  await sleep(300);
  const stored = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  check('settings page saves changes', stored.skipCaptions === false && stored.highlightColor === 'mint', JSON.stringify({ skipCaptions: stored.skipCaptions, color: stored.highlightColor }));
  await options.locator('input[data-key="skipCaptions"]').check();
  await options.close();

  // --------------------------------------------------------------------- PDF
  const pdf = await context.newPage();
  await pdf.goto(`${extension}/pdf.html?file=${encodeURIComponent(`${base}/report.pdf`)}`);
  await pdf.bringToFront();
  const pdfUi = (selector) => pdf.locator(`lector-ui ${selector}`);
  const pdfRead = (name) =>
    pdf.evaluate((n) => {
      const highlight = CSS.highlights.get(n);
      return highlight ? [...highlight].map((range) => range.toString()).join(' ').replace(/\s+/g, ' ') : null;
    }, name);
  await pdf.locator('.page').nth(2).waitFor({ timeout: 20_000 });
  check('PDF pages are drawn', (await pdf.locator('.page').count()) === 3);
  await pdfUi('.launcher').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  await worker.evaluate(() => chrome.storage.local.set({ settings: { rate: 3 } }));
  await sleep(400);
  await command({ type: 'toggle' }); // goes through the service worker, as the toolbar button does
  await pdfUi('.player').waitFor({ state: 'visible', timeout: 10_000 });
  const pdfSentences = [];
  const pdfUntil = Date.now() + 45_000;
  while (Date.now() < pdfUntil) {
    const sentence = await pdfRead('lector-sentence');
    if (sentence && pdfSentences.at(-1) !== sentence) pdfSentences.push(sentence);
    if ((await pdfUi('.status').innerText().catch(() => '')) === 'Finished') break;
    await sleep(50);
  }
  await pdf.screenshot({ path: path.join(shots, '10-pdf.png') });
  const pdfText = pdfSentences.join(' | ');
  console.log(pdfSentences.map((s, i) => `   ${i + 1}. ${s}`).join('\n'));
  check('PDF is read to the end', pdfText.includes('The sleeper is back'));
  check('running header and page numbers are skipped', !pdfText.includes('Night Train Review') && !/\| [123] \|/.test(pdfText));
  check('a paragraph that crosses a page is kept together', pdfSentences.some((s) => s.includes('across the break') && s.includes('onto the following page')));
  check('PDF headings are read on their own', pdfSentences.includes('Costs') && pdfSentences.includes('Conclusion'));
  await pdf.close();
  await worker.evaluate(() => chrome.storage.local.clear());

  // ------------------------------------------------------------ document view
  await worker.evaluate(() =>
    chrome.storage.session.set({
      'document:test': {
        title: 'Trip notes',
        source: 'https://docs.google.com/document/d/abc/edit',
        html: '<p class="c1 title"><span>Trip notes</span></p><p onclick="window.hacked=1"><span class="c2">We left after dinner and woke up in the mountains.</span> <a href="javascript:window.hacked=2">A link</a></p><script>window.hacked=3</script><img src="x" onerror="window.hacked=4"><ul><li><span>Bring a jumper.</span></li></ul>',
      },
    }),
  );
  const doc = await context.newPage();
  await doc.goto(`${extension}/document.html?key=document:test`);
  await doc.bringToFront();
  await doc.locator('article h1').waitFor();
  await waitFor(async () => (await doc.locator('lector-ui .play').getAttribute('aria-label').catch(() => null)) === 'Pause', 60_000, 'document to start reading');
  await sleep(1500);
  await doc.screenshot({ path: path.join(shots, '11-document.png') });
  check('document view starts reading by itself', true);
  const clean = await doc.evaluate(() => ({ hacked: window.hacked ?? null, scripts: document.querySelectorAll('article script, article img, article [onclick]').length, link: document.querySelector('article a')?.getAttribute('href') ?? null, h1: document.querySelector('article h1').textContent }));
  check('document view strips anything active', clean.hacked === null && clean.scripts === 0 && clean.link === null && clean.h1 === 'Trip notes', JSON.stringify(clean));
  await doc.close();
}
