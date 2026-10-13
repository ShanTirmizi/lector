// The voice engine: text in, speech samples and word timings out.
// Runs Kokoro through kokoro-js / transformers.js. It has no dependency on
// extension APIs so it can run in a worker (and in Node for checks).

import { KokoroTTS } from 'kokoro-js';
import { Tensor } from '@huggingface/transformers';
import type { WordMark } from '../shared/protocol';
import { alignWords } from './align';

export const SAMPLE_RATE = 24000;
// A timestamped export of Kokoro: besides audio it returns how long each phoneme lasts.
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
const STYLE_SIZE = 256;
const MAX_PHONEMES = 480;
const LEAD_KEPT = 0.05;
const TAIL_KEPT = 0.14;

export type Device = 'webgpu' | 'wasm' | 'cpu';

export interface Speech {
  pcm: Float32Array;
  words: WordMark[];
}

export interface EngineOptions {
  device: Device;
  loadVoice: (voice: string) => Promise<Float32Array>;
  onProgress?: (fraction: number) => void;
}

export class Engine {
  private voices = new Map<string, Float32Array>();
  private wordPhonemes = new Map<string, string>();

  private constructor(
    private tts: KokoroTTS,
    private options: EngineOptions,
  ) {}

  static async create(options: EngineOptions): Promise<Engine> {
    const files = new Map<string, { loaded: number; total: number }>();
    const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      // Quantised weights misbehave on WebGPU, so the GPU gets full precision.
      dtype: options.device === 'webgpu' ? 'fp32' : 'q8',
      device: options.device,
      progress_callback: (event) => {
        if (event.status !== 'progress' || !event.file.endsWith('.onnx')) return;
        files.set(event.file, { loaded: event.loaded, total: event.total });
        let loaded = 0;
        let total = 0;
        for (const file of files.values()) {
          loaded += file.loaded;
          total += file.total;
        }
        if (total > 0) options.onProgress?.(loaded / total);
      },
    });
    return new Engine(tts, options);
  }

  /** Phoneme string for a piece of text, as the model expects it. */
  private phonemize(text: string, voice: string): Promise<string> {
    // kokoro-js keeps its phonemiser private. Its public generate() runs
    // phonemise -> tokenise -> synthesise, so calling it with stand-ins for the
    // last two steps hands back the phoneme string.
    const probe = {
      _validate_voice: (v: string) => this.tts._validate_voice(v),
      tokenizer: (phonemes: string) => ({ input_ids: phonemes }),
      generate_from_ids: (phonemes: string) => phonemes,
    };
    return KokoroTTS.prototype.generate.call(probe, text, { voice: voice as never }) as unknown as Promise<string>;
  }

  private async phonemizeWord(word: string, voice: string): Promise<string> {
    const key = voice[0] + word;
    let phonemes = this.wordPhonemes.get(key);
    if (phonemes === undefined) {
      phonemes = await this.phonemize(word, voice);
      if (this.wordPhonemes.size > 20000) this.wordPhonemes.clear();
      this.wordPhonemes.set(key, phonemes);
    }
    return phonemes;
  }

  private async style(voice: string, tokenCount: number): Promise<Tensor> {
    let data = this.voices.get(voice);
    if (!data) {
      data = await this.options.loadVoice(voice);
      this.voices.set(voice, data);
    }
    // A voice file holds one style vector per utterance length.
    const offset = STYLE_SIZE * Math.min(Math.max(tokenCount - 2, 0), 509);
    return new Tensor('float32', data.slice(offset, offset + STYLE_SIZE), [1, STYLE_SIZE]);
  }

  async speak(text: string, voice: string): Promise<Speech> {
    const phonemes = await this.phonemize(text, voice);
    if ([...phonemes].length > MAX_PHONEMES) {
      const cut = splitPoint(text);
      if (cut > 0) {
        const first = await this.speak(text.slice(0, cut), voice);
        const second = await this.speak(text.slice(cut), voice);
        return joinSpeech(first, second, cut);
      }
    }
    if (!/\S/.test(phonemes)) return { pcm: new Float32Array(SAMPLE_RATE * 0.1), words: [] };

    const { input_ids } = this.tts.tokenizer(phonemes, { truncation: true });
    const tokenCount: number = input_ids.dims.at(-1);
    const output = await this.tts.model({
      input_ids,
      style: await this.style(voice, tokenCount),
      speed: new Tensor('float32', [1], [1]),
    });
    const samples = output.waveform.data as Float32Array;
    const durations = Array.from(output.durations.data as Float32Array, Number);

    // Which phoneme characters became tokens. The first and last token are padding.
    const vocabulary = (this.tts.tokenizer as unknown as { model: { tokens_to_ids: Map<string, number> } }).model.tokens_to_ids;
    const chars = [...phonemes].filter((ch) => vocabulary.has(ch));
    const usable = durations.length === tokenCount && chars.length + 2 === tokenCount;

    const seconds = samples.length / SAMPLE_RATE;
    const charStart = new Float64Array(chars.length + 1);
    let lead = 0;
    let tail = 0;
    if (usable) {
      const scale = seconds / durations.reduce((a, b) => a + b, 0);
      let t = durations[0] * scale;
      lead = t;
      for (let i = 0; i < chars.length; i++) {
        charStart[i] = t;
        t += durations[i + 1] * scale;
      }
      charStart[chars.length] = t;
      tail = seconds - t;
    } else {
      // No trustworthy durations: spread the phonemes evenly.
      for (let i = 0; i <= chars.length; i++) charStart[i] = (seconds * i) / Math.max(chars.length, 1);
    }

    // The model pads both ends with silence. Keep only a breath of it, and
    // never cut into sound: the padding estimate is checked against the samples.
    const firstSound = firstLoud(samples, 1);
    const lastSound = firstLoud(samples, -1);
    const cutStart = Math.max(0, Math.min(Math.floor((lead - LEAD_KEPT) * SAMPLE_RATE), firstSound - Math.floor(LEAD_KEPT * SAMPLE_RATE)));
    const keepUntil = Math.min(samples.length, Math.max(Math.floor((seconds - tail + TAIL_KEPT) * SAMPLE_RATE), lastSound + Math.floor(TAIL_KEPT * SAMPLE_RATE)));
    const pcm = samples.slice(cutStart, Math.max(keepUntil, cutStart + 1));
    const shift = cutStart / SAMPLE_RATE;

    const words = await alignWords(text, chars, charStart, (word) => this.phonemizeWord(word, voice));
    for (const word of words) word.t = Math.max(0, word.t - shift);
    return { pcm, words };
  }
}

/** Index of the first sample that is clearly not silence, scanning forwards (1) or backwards (-1). */
function firstLoud(samples: Float32Array, direction: 1 | -1): number {
  const threshold = 0.012;
  if (direction === 1) {
    for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > threshold) return i;
    return samples.length;
  }
  for (let i = samples.length - 1; i >= 0; i--) if (Math.abs(samples[i]) > threshold) return i;
  return 0;
}

/** A place to cut an over-long sentence, preferring punctuation near the middle. */
function splitPoint(text: string): number {
  const middle = text.length / 2;
  let best = -1;
  let bestScore = Infinity;
  for (const match of text.matchAll(/\s+/g)) {
    const index = match.index + match[0].length;
    if (index <= 0 || index >= text.length) continue;
    const afterPunctuation = /[,;:—–)]$/.test(text.slice(0, match.index));
    const score = Math.abs(index - middle) - (afterPunctuation ? text.length * 0.15 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

function joinSpeech(first: Speech, second: Speech, textOffset: number): Speech {
  const pcm = new Float32Array(first.pcm.length + second.pcm.length);
  pcm.set(first.pcm);
  pcm.set(second.pcm, first.pcm.length);
  const timeOffset = first.pcm.length / SAMPLE_RATE;
  return {
    pcm,
    words: [...first.words, ...second.words.map((w) => ({ cs: w.cs + textOffset, ce: w.ce + textOffset, t: w.t + timeOffset }))],
  };
}
