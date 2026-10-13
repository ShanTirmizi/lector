// Web worker that hosts the voice engine, so that synthesis never blocks the
// document that plays the audio.

import { env } from '@huggingface/transformers';
import { Engine, SAMPLE_RATE, type Device } from './engine';
import type { WordMark } from '../shared/protocol';

export type WorkerRequest = { type: 'synth'; id: number; text: string; voice: string };
export type WorkerResponse =
  | { type: 'model'; phase: 'download' | 'load' | 'ready' | 'error'; progress?: number; device?: string; message?: string }
  | { type: 'result'; id: number; pcm: Float32Array; sampleRate: number; words: WordMark[] }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

// Everything executable is loaded from the extension package, never from a CDN.
env.backends.onnx.wasm!.wasmPaths = new URL('./ort/', scope.location.href).href;
env.allowLocalModels = false;

async function loadVoice(voice: string): Promise<Float32Array> {
  const response = await fetch(new URL(`./voices/${voice}.bin`, scope.location.href));
  if (!response.ok) throw new Error(`Voice "${voice}" is not bundled`);
  return new Float32Array(await response.arrayBuffer());
}

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** True when the model weights for this device are already in the browser cache. */
async function isCached(target: Device): Promise<boolean> {
  try {
    const cache = await caches.open('transformers-cache');
    const file = target === 'webgpu' ? '/onnx/model.onnx' : '/onnx/model_quantized.onnx';
    return (await cache.keys()).some((request) => request.url.includes('Kokoro') && request.url.endsWith(file));
  } catch {
    return false;
  }
}

let engine: Promise<Engine> | null = null;
let device: Device = 'wasm';

async function start(preferred: Device): Promise<Engine> {
  device = preferred;
  post({ type: 'model', phase: 'load', device });
  // Reading the model back from the cache also reports progress; only a real download is shown.
  const downloading = !(await isCached(device));
  let lastPercent = -1;
  return Engine.create({
    device,
    loadVoice,
    onProgress: (fraction) => {
      const percent = Math.floor(fraction * 100);
      if (!downloading || percent === lastPercent) return;
      lastPercent = percent;
      post({ type: 'model', phase: 'download', progress: fraction, device });
    },
  }).then((ready) => {
    post({ type: 'model', phase: 'ready', device });
    return ready;
  });
}

async function getEngine(): Promise<Engine> {
  if (!engine) {
    engine = (async () => {
      if (await hasWebGpu()) {
        try {
          return await start('webgpu');
        } catch (error) {
          console.warn('[lector] WebGPU start failed, using WebAssembly', error);
        }
      }
      return start('wasm');
    })();
    engine.catch((error) => {
      engine = null;
      post({ type: 'model', phase: 'error', message: String(error?.message ?? error) });
    });
  }
  return engine;
}

async function synth(request: WorkerRequest): Promise<void> {
  try {
    let speech;
    try {
      speech = await (await getEngine()).speak(request.text, request.voice);
    } catch (error) {
      if (device !== 'webgpu') throw error;
      // The GPU path can fail at run time on some drivers. Fall back once.
      console.warn('[lector] WebGPU synthesis failed, switching to WebAssembly', error);
      engine = start('wasm');
      speech = await (await engine).speak(request.text, request.voice);
    }
    post({ type: 'result', id: request.id, pcm: speech.pcm, sampleRate: SAMPLE_RATE, words: speech.words }, [speech.pcm.buffer]);
  } catch (error) {
    post({ type: 'error', id: request.id, message: String((error as Error)?.message ?? error) });
  }
}

// One request at a time: the model is not re-entrant.
let queue: Promise<void> = Promise.resolve();
scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === 'synth') queue = queue.then(() => synth(event.data));
};
