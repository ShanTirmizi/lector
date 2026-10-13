// End-to-end check: loads the built extension in Chromium and drives it on a
// local test page. Run `npm run build` first. Usage: node scripts/e2e.mjs [--headed]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, root, sleep } from './browser.mjs';

const headed = process.argv.includes('--headed');

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

const { context, worker, command, extension } = await launch({ headed });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}
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
  // Start every run from default settings.
  await worker.evaluate(() => chrome.storage.local.clear());

  const page = await context.newPage();
  const engineLog = [];
  page.on('console', (message) => {
    if (message.text().startsWith('[lector]')) engineLog.push(message.text());
  });
  await page.goto(`${base}/article.html`);
  await page.bringToFront();

  const tools = { page, context, worker, command, check, waitFor, sleep, engineLog, base, extension };
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  if (only !== 'edge') await (await import('./e2e-steps.mjs')).run(tools);
  if (only !== 'main') await (await import('./e2e-edge.mjs')).runEdge(tools);
} catch (error) {
  console.log('FAIL  uncaught:', error.message);
  failures++;
} finally {
  await context.close();
  server.close();
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
