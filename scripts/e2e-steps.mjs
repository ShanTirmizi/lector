// The checks themselves. Kept apart from the harness so they can grow with the features.

export async function run({ page, command, check, waitFor, engineLog }) {
  // Step 1: read a selection aloud.
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p1'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const events = [];
  await page.exposeFunction('__lectorEvent', (event) => events.push(event));
  await command({ type: 'read-selection' });
  const started = Date.now();
  await waitFor(() => engineLog.some((line) => line.includes('playing')), 600_000, 'speech to start');
  check('selection is spoken', true, `${((Date.now() - started) / 1000).toFixed(1)}s to first audio`);
  console.log(engineLog.slice(0, 12).join('\n'));
}
