// Checks the voice the way a listener would, without ears: speaks sentences
// with the engine inside the built extension, then transcribes the audio with
// a speech recogniser and compares the words. Also reports how fast synthesis
// runs. Usage: node scripts/voice-check.mjs [--no-gpu]
import { chromium } from 'playwright-core';
import { pipeline } from '@huggingface/transformers';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const noGpu = process.argv.includes('--no-gpu');
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const build = (await readdir(cache)).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1);
const executablePath = process.env.CHROMIUM_PATH ?? path.join(cache, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const SAMPLES = [
  ['af_heart', 'Sleeper trains were supposed to be finished, but something changed.'],
  ['bm_george', 'A night on a train costs about ninety dollars, and it replaces both a flight and a hotel room.'],
  ['am_michael', 'Critics point out that the carriages are old and the timetables are thin.'],
  ['bf_emma', 'Still, it is hard not to feel that something worth keeping has come back.'],
];

const context = await chromium.launchPersistentContext(path.join(root, noGpu ? '.test-profile/no-gpu' : '.test-profile'), {
  executablePath,
  headless: false,
  args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--mute-audio', ...(noGpu ? ['--disable-gpu', '--disable-features=WebGPU'] : ['--enable-unsafe-webgpu'])],
});
let results;
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(`${worker.url().split('/').slice(0, 3).join('/')}/options.html`);
  results = await page.evaluate(async (samples) => {
    const engine = new Worker('engine-worker.js', { type: 'module' });
    let device = '';
    const waiting = new Map();
    engine.onmessage = ({ data }) => {
      if (data.type === 'model') device = data.device ?? device;
      else waiting.get(data.id)?.(data);
    };
    const out = [];
    for (const [i, [voice, text]] of samples.entries()) {
      const started = performance.now();
      const reply = await new Promise((resolve) => {
        waiting.set(i, resolve);
        engine.postMessage({ type: 'synth', id: i, text, voice });
      });
      if (reply.type === 'error') throw new Error(reply.message);
      out.push({ voice, text, ms: performance.now() - started, pcm: Array.from(reply.pcm), words: reply.words });
    }
    return { device, out };
  }, SAMPLES);
} finally {
  await context.close();
}

console.log(`engine device: ${results.device}`);
const recognise = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', { dtype: 'q8' });
const words = (text) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
let failures = 0;
for (const [i, sample] of results.out.entries()) {
  // 24 kHz to the 16 kHz the recogniser expects.
  const source = Float32Array.from(sample.pcm);
  const audio = new Float32Array(Math.floor((source.length * 2) / 3));
  for (let k = 0; k < audio.length; k++) {
    const at = k * 1.5;
    const a = Math.floor(at);
    audio[k] = source[a] + (source[Math.min(a + 1, source.length - 1)] - source[a]) * (at - a);
  }
  const heard = (await recognise(audio)).text.trim();
  const want = words(sample.text);
  const got = new Set(words(heard));
  const matched = want.filter((word) => got.has(word)).length / want.length;
  const seconds = source.length / 24000;
  // The first sample includes loading the model, so its speed says nothing.
  const speed = i === 0 ? 'includes model load' : `${(seconds / (sample.ms / 1000)).toFixed(1)}× real time`;
  const ok = matched >= 0.85;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${sample.voice}  ${Math.round(matched * 100)}% of words heard back  ${seconds.toFixed(1)}s audio in ${Math.round(sample.ms)}ms (${speed})`);
  console.log(`      heard: ${heard}`);
}
process.exit(failures ? 1 : 0);
