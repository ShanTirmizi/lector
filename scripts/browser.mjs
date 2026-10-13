// Shared by the test and QA scripts: starts Chromium with the built extension loaded.
import { chromium } from 'playwright-core';
import { readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dist = path.join(root, 'dist');

export async function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const builds = (await readdir(cache).catch(() => [])).filter((name) => /^chromium-\d+$/.test(name)).sort();
  if (builds.length === 0) throw new Error('No Playwright Chromium found. Run `npx playwright install chromium` or set CHROMIUM_PATH.');
  return path.join(cache, builds.at(-1), 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}

/**
 * Launches Chromium with the extension. The profile is kept between runs so the
 * voice model is downloaded only once.
 */
export async function launch({ profile = '.test-profile', headed = false, gpu = true, args = [], viewport = { width: 1280, height: 800 }, scale = 1 } = {}) {
  const dir = path.join(root, profile);
  // Chromium keeps a compiled copy of the extension's service worker in the profile and does not
  // notice when the file on disk changes. Without this, tests would run an old service worker.
  await rm(path.join(dir, 'Default/Service Worker/ScriptCache'), { recursive: true, force: true });
  await rm(path.join(dir, 'Default/Service Worker/Database'), { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: await findChromium(),
    headless: false,
    viewport,
    deviceScaleFactor: scale,
    args: [
      ...(headed ? [] : ['--headless=new']),
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--mute-audio',
      ...(gpu ? ['--enable-unsafe-webgpu'] : ['--disable-gpu', '--disable-features=WebGPU']),
      ...args,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  /** Sends a command to the active tab's content script, as the service worker does. */
  const command = (message) =>
    worker.evaluate(async (m) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tab.id, m);
    }, message);
  return { context, worker, command, extension: worker.url().split('/').slice(0, 3).join('/') };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
