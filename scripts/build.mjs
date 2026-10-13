// Builds the extension into dist/. Run with --watch to rebuild on change.
import { build, context } from 'esbuild';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

// Voices shipped with the extension. The files come from the kokoro-js package.
const VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'af_aoede', 'af_kore', 'af_sarah', 'af_nova',
  'am_michael', 'am_fenrir', 'am_puck', 'am_echo',
  'bf_emma', 'bf_isabella', 'bm_george', 'bm_fable',
];

const common = {
  bundle: true,
  target: 'chrome116',
  logLevel: 'info',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const entries = [
  { entryPoints: { background: 'src/background/index.ts' }, format: 'esm' },
  { entryPoints: { content: 'src/content/index.ts' }, format: 'iife' },
  { entryPoints: { offscreen: 'src/offscreen/index.ts' }, format: 'esm' },
  { entryPoints: { options: 'src/options/index.ts' }, format: 'esm' },
  { entryPoints: { pdf: 'src/pdf/index.ts' }, format: 'esm' },
  { entryPoints: { document: 'src/document/index.ts' }, format: 'esm' },
  {
    entryPoints: { 'engine-worker': 'src/offscreen/worker.ts' },
    format: 'esm',
    platform: 'browser',
    conditions: ['browser'],
    // kokoro-js probes for Node's fs at runtime; in the browser it must find nothing.
    alias: { 'fs/promises': path.join(root, 'scripts/empty.mjs'), path: path.join(root, 'scripts/empty.mjs') },
  },
].map((e) => ({ ...common, ...e, outdir: dist, absWorkingDir: root }));

async function copyStatic() {
  await cp(path.join(root, 'static'), dist, { recursive: true });

  // ONNX Runtime's WebAssembly files must be served from the extension itself.
  const ortDist = path.dirname(require.resolve('onnxruntime-web', { paths: [require.resolve('@huggingface/transformers')] }));
  await mkdir(path.join(dist, 'ort'), { recursive: true });
  for (const file of await readdir(ortDist)) {
    if (/^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(file)) await cp(path.join(ortDist, file), path.join(dist, 'ort', file));
  }

  // pdf.js: its worker, plus the character maps, fonts and decoders some PDFs need.
  const pdfjs = path.join(root, 'node_modules/pdfjs-dist');
  await mkdir(path.join(dist, 'pdfjs'), { recursive: true });
  await cp(path.join(pdfjs, 'build/pdf.worker.min.mjs'), path.join(dist, 'pdfjs/pdf.worker.min.mjs'));
  for (const dir of ['cmaps', 'standard_fonts', 'wasm']) await cp(path.join(pdfjs, dir), path.join(dist, 'pdfjs', dir), { recursive: true });

  const voiceDir = path.join(root, 'node_modules/kokoro-js/voices');
  await mkdir(path.join(dist, 'voices'), { recursive: true });
  for (const voice of VOICES) await cp(path.join(voiceDir, `${voice}.bin`), path.join(dist, 'voices', `${voice}.bin`));
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyStatic();

if (watch) {
  for (const options of entries) await (await context(options)).watch();
  console.log('watching…');
} else {
  await Promise.all(entries.map((options) => build(options)));
}
