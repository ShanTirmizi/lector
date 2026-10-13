// Edge cases: the things that go wrong when a person uses it roughly.
import path from 'node:path';

const shots = path.resolve('test/shots');

export async function runEdge({ context, worker, command, check, waitFor, sleep, base }) {
  await worker.evaluate(() => chrome.storage.local.clear());
  const page = await context.newPage();
  await page.goto(`${base}/dark.html`);
  await page.bringToFront();
  const on = (p) => ({
    ui: (selector, options) => p.locator(`lector-ui ${selector}`, options),
    read: (name) =>
      p.evaluate((n) => {
        const highlight = CSS.highlights.get(n);
        return highlight ? [...highlight].map((range) => range.toString()).join(' ').replace(/\s+/g, ' ') : null;
      }, name),
    label: () => p.locator('lector-ui .play').getAttribute('aria-label').catch(() => null),
    status: () => p.locator('lector-ui .status').innerText().catch(() => ''),
  });
  const a = on(page);
  const playing = async (t, timeout = 60_000) => waitFor(async () => (await t.label()) === 'Pause' && (await t.read('lector-word')), timeout, 'playback');
  const setSettings = (patch) => worker.evaluate(async (p) => chrome.storage.local.set({ settings: { ...((await chrome.storage.local.get('settings')).settings ?? {}), ...p } }), patch);

  await sleep(1200);
  await command({ type: 'toggle' });
  await playing(a);
  await sleep(600);
  await page.screenshot({ path: path.join(shots, 'edge-01-dark.png') });
  check('reads on a dark page', (await a.read('lector-sentence')) === 'Notes from the observatory', await a.read('lector-sentence'));

  // Keyboard shortcuts.
  await page.keyboard.press('Alt+Period');
  await waitFor(async () => (await a.read('lector-sentence'))?.startsWith('The dome opens'), 15_000, 'Alt+. to move on');
  await page.keyboard.press('Alt+Comma');
  await waitFor(async () => (await a.read('lector-sentence')) === 'Notes from the observatory', 15_000, 'Alt+, to go back');
  await page.keyboard.press('Alt+Equal');
  await waitFor(async () => (await a.ui('.chip.speed').innerText()) === '1.1×', 5_000, 'Alt+= to speed up');
  await page.keyboard.press('Alt+Minus');
  await waitFor(async () => (await a.ui('.chip.speed').innerText()) === '1×', 5_000, 'Alt+- to slow down');
  await page.keyboard.press('Alt+Shift+Period');
  await waitFor(async () => (await a.read('lector-sentence'))?.startsWith('The dome opens'), 15_000, 'Alt+Shift+. to jump a paragraph');
  check('keyboard shortcuts work', true);

  // Hammering "next" must not confuse it.
  for (let i = 0; i < 6; i++) await a.ui('button[aria-label="Next sentence"]').click({ delay: 20 }).catch(() => {});
  await playing(a);
  const afterBurst = await a.read('lector-sentence');
  await sleep(1500);
  check('rapid skipping settles and keeps playing', (await a.label()) === 'Pause' && !(await a.ui('.status.problem').count()), afterBurst?.slice(0, 60));

  // Settings apply while playing.
  await setSettings({ highlightWord: false });
  await waitFor(async () => (await a.read('lector-word')) === null, 5_000, 'word highlight to switch off');
  await setSettings({ highlightWord: true });
  await waitFor(async () => (await a.read('lector-word')) !== null, 8_000, 'word highlight to switch on');
  check('settings apply while playing', true);

  // A very long sentence with no punctuation, started from its paragraph button.
  await page.locator('#d4').hover();
  await a.ui('.spot.on').click();
  await waitFor(async () => (await a.read('lector-sentence'))?.startsWith('This sentence has no punctuation'), 30_000, 'long sentence');
  await setSettings({ rate: 3.5 });
  const pieces = new Set();
  let scrolledTo = false;
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const sentence = await a.read('lector-sentence');
    if (sentence) pieces.add(sentence);
    if (sentence?.startsWith('By morning')) {
      await sleep(1500);
      const box = await page.locator('#d5').boundingBox();
      scrolledTo = !!box && box.y > 0 && box.y < 800 * 0.75;
      break;
    }
    await sleep(60);
  }
  const all = [...pieces];
  check('an unpunctuated 500-character sentence is read in pieces', all.filter((s) => !s.startsWith('By morning')).length >= 2 && all.some((s) => s.endsWith('finally stops')), `${all.length - 1} pieces`);
  check('symbols-only paragraph is skipped', !all.some((s) => s.includes('★')));
  check('auto-scroll brings the next paragraph into view', scrolledTo);

  // The end.
  await waitFor(async () => (await a.status()) === 'Finished', 30_000, 'the end');
  check('reaches the end and says so', (await a.label()) === 'Read again');
  await setSettings({ rate: 1 });
  await a.ui('.play').click();
  await waitFor(async () => (await a.read('lector-sentence')) === 'Notes from the observatory', 20_000, 'restart');
  check('"Read again" starts from the top', true);

  // Scrolling away by hand.
  await playing(a);
  await sleep(1300); // let the automatic scroll settle
  await page.mouse.wheel(0, 900);
  await a.ui('.back').waitFor({ state: 'visible', timeout: 5_000 });
  await page.screenshot({ path: path.join(shots, 'edge-02-back-to-text.png') });
  await a.ui('.back').click();
  await waitFor(async () => (await page.evaluate(() => window.scrollY)) < 200, 5_000, 'scroll back');
  check('scrolling away offers "Back to the text"', (await a.ui('.back').count()) === 0);

  // Two tabs: the newer one takes over, the older one can take it back.
  const second = await context.newPage();
  await second.goto(`${base}/article.html`);
  await second.bringToFront();
  const b = on(second);
  await sleep(1200);
  await command({ type: 'toggle' });
  await playing(b);
  await waitFor(async () => (await a.label()) === 'Play', 5_000, 'first tab to pause');
  check('a second tab takes over and the first one pauses', true);
  await page.bringToFront();
  await a.ui('.play').click();
  await playing(a);
  await waitFor(async () => (await b.label()) === 'Play', 5_000, 'second tab to pause');
  check('the first tab can take playback back', true);
  await second.close();

  // A selection inside a text box.
  await page.evaluate(() => {
    const box = document.getElementById('box');
    box.scrollIntoView();
    box.focus();
    box.select();
  });
  await command({ type: 'read-selection' });
  await waitFor(async () => (await a.label()) === 'Pause' && !(await a.ui('.player').getAttribute('data-busy')), 30_000, 'text box selection');
  check('text selected in a text box is read', (await a.read('lector-sentence')) === null);

  // The player on a small window, and after being dragged.
  await page.setViewportSize({ width: 430, height: 700 });
  await sleep(400);
  let box = await a.ui('.player').boundingBox();
  await page.screenshot({ path: path.join(shots, 'edge-03-narrow.png') });
  check('player fits a narrow window', box.x >= 0 && box.x + box.width <= 430, `${Math.round(box.x)}..${Math.round(box.x + box.width)} of 430`);
  await a.ui('.chip.speed').click();
  const panel = await a.ui('.panel').boundingBox();
  check('panels fit a narrow window', panel.x >= 0 && panel.x + panel.width <= 430 && panel.y >= 0);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(300);
  box = await a.ui('.player').boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 250, box.y - 400, { steps: 8 });
  await page.mouse.up();
  await sleep(500);
  const moved = await a.ui('.player').boundingBox();
  check('player can be dragged', Math.abs(moved.x - (box.x - 262)) < 40 && Math.abs(moved.y - (box.y - 400)) < 40, `${Math.round(moved.x)},${Math.round(moved.y)}`);
  await a.ui('button[aria-label="Reading options"]').click();
  const below = await a.ui('.panel').boundingBox();
  check('panel opens on screen wherever the player is', below.y >= 0 && below.y + below.height <= 800 && below.x >= 0);
  await page.keyboard.press('Escape');
  await page.reload();
  await sleep(1200);
  await command({ type: 'toggle' });
  await a.ui('.player').waitFor({ state: 'visible' });
  const kept = await a.ui('.player').boundingBox();
  check('player position is remembered', Math.abs(kept.x - moved.x) < 30 && Math.abs(kept.y - moved.y) < 30);

  // Hiding the buttons on a site.
  await a.ui('button[aria-label="Reading options"]').click();
  await a.ui('.links button', { hasText: 'Hide buttons' }).click();
  await a.ui('button[aria-label="Close the player"]').click();
  await sleep(600);
  await page.locator('#d1').hover();
  await sleep(500);
  check('"Hide buttons on this site" hides them', !(await a.ui('.launcher').isVisible()) && (await a.ui('.spot.on').count()) === 0);
  await command({ type: 'toggle' });
  await playing(a);
  check('the shortcut still works on a hidden site', true);
  await a.ui('button[aria-label="Close the player"]').click();
  await worker.evaluate(() => chrome.storage.local.clear());

  // The engine stays ready after a quiet spell.
  await sleep(40_000);
  const wake = Date.now();
  await command({ type: 'toggle' });
  await playing(a);
  check('starts quickly after 40 quiet seconds', Date.now() - wake < 4_000, `${((Date.now() - wake) / 1000).toFixed(1)}s`);

  // Reloading mid-read leaves nothing behind.
  await page.reload();
  await sleep(1500);
  check('reloading while reading clears the page', (await a.read('lector-sentence')) === null && !(await a.ui('.player').isVisible()));
  await page.close();

  // Pages with nothing to read, and text Lector cannot speak.
  const empty = await context.newPage();
  await empty.goto(`${base}/empty.html`);
  await empty.bringToFront();
  await sleep(800);
  await command({ type: 'toggle' });
  await empty.locator('lector-ui .toast').waitFor({ state: 'visible', timeout: 5_000 });
  check('a page with no text says so', (await empty.locator('lector-ui .toast').innerText()).includes('no text'));
  await empty.close();

  const foreign = await context.newPage();
  await foreign.goto(`${base}/chinese.html`);
  await foreign.bringToFront();
  await sleep(800);
  await command({ type: 'toggle' });
  await foreign.locator('lector-ui .toast').waitFor({ state: 'visible', timeout: 5_000 });
  check('a page in another script is refused politely', (await foreign.locator('lector-ui .toast').innerText()).includes('English') && !(await foreign.locator('lector-ui .player').isVisible()));
  await foreign.close();
}
