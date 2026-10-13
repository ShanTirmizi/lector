// Messages that travel between the page (content script), the service worker
// and the offscreen document that owns the voice engine and the audio.

export const ENGINE_PORT = 'lector-engine';

/** One piece of text to speak, normally a sentence. */
export interface ChunkSpec {
  text: string;
  /** Extra silence after the chunk in seconds, used at paragraph ends. */
  pauseAfter?: number;
}

/** Where a spoken word sits in the chunk text and when it starts in the audio. */
export interface WordMark {
  /** Start offset in the chunk text. */
  cs: number;
  /** End offset in the chunk text. */
  ce: number;
  /** Start time in seconds from the beginning of the chunk audio. */
  t: number;
}

export type PlayState = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export type ToEngine =
  | { type: 'load'; chunks: ChunkSpec[]; index: number; voice: string; rate: number; autoplay: boolean }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; index: number }
  | { type: 'rate'; rate: number }
  | { type: 'voice'; voice: string }
  | { type: 'preview'; voice: string }
  | { type: 'stop' };

export type FromEngine =
  | { type: 'model'; phase: 'download' | 'load' | 'ready' | 'error'; progress?: number; device?: string; message?: string }
  | { type: 'state'; state: PlayState; index: number; message?: string }
  | { type: 'chunk'; index: number; duration: number; words: WordMark[] }
  | { type: 'time'; index: number; t: number; rate: number; playing: boolean; at: number }
  | { type: 'displaced' };

/** One-off messages handled by the service worker. */
export type ToBackground =
  | { type: 'ensure-engine' }
  | { type: 'open-options' }
  | { type: 'open-pdf'; url: string }
  | { type: 'open-document'; title: string; html: string; source: string };

/** Commands the service worker sends to a tab. */
export type ToContent =
  | { type: 'toggle' }
  | { type: 'read-selection' }
  | { type: 'read-from-here' }
  | { type: 'stop' };
