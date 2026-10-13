// Offscreen document: owns the voice engine worker and the audio element.
// A page connects with a port, hands over the sentences to read, and receives
// playback state, word timings and a running clock in return.

import { ENGINE_PORT, type ChunkSpec, type FromEngine, type PlayState, type ToEngine, type WordMark } from '../shared/protocol';
import { voiceById } from '../shared/voices';
import { encodeWav } from './wav';
import type { WorkerRequest, WorkerResponse } from './worker';

interface Clip {
  url: string;
  duration: number;
  words: WordMark[];
}

// How much audio to prepare ahead of the listener.
const LOOKAHEAD_SECONDS = 40;
const LOOKAHEAD_MIN_CHUNKS = 2;
const CACHE_LIMIT = 80;
const CLOCK_INTERVAL_MS = 120;

// ---------------------------------------------------------------- synthesis

const worker = new Worker(new URL('./engine-worker.js', location.href), { type: 'module' });
const pending = new Map<number, { resolve: (clip: Clip) => void; reject: (error: Error) => void; pauseAfter: number }>();
const clips = new Map<string, Clip>();
let nextRequestId = 1;
let lastModelMessage: FromEngine | null = null;

const clipKey = (voice: string, chunk: ChunkSpec) => `${voice}|${chunk.pauseAfter ?? 0}|${chunk.text}`;

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  if (message.type === 'model') {
    lastModelMessage = message;
    session?.send(message);
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.type === 'error') return request.reject(new Error(message.message));
  const blob = encodeWav(message.pcm, message.sampleRate, request.pauseAfter);
  request.resolve({
    url: URL.createObjectURL(blob),
    duration: message.pcm.length / message.sampleRate + request.pauseAfter,
    words: message.words,
  });
};

function synthesize(voice: string, chunk: ChunkSpec): Promise<Clip> {
  const key = clipKey(voice, chunk);
  const cached = clips.get(key);
  if (cached) {
    // Refresh its place in the least-recently-used order.
    clips.delete(key);
    clips.set(key, cached);
    return Promise.resolve(cached);
  }
  return new Promise<Clip>((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject, pauseAfter: chunk.pauseAfter ?? 0 });
    worker.postMessage({ type: 'synth', id, text: chunk.text, voice } satisfies WorkerRequest);
  }).then((clip) => {
    clips.set(key, clip);
    for (const [oldKey, old] of clips) {
      if (clips.size <= CACHE_LIMIT) break;
      if (old.url === session?.playingUrl) continue;
      URL.revokeObjectURL(old.url);
      clips.delete(oldKey);
    }
    return clip;
  });
}

// ----------------------------------------------------------------- playback

class Session {
  private chunks: ChunkSpec[] = [];
  private index = 0;
  private voice = '';
  private rate = 1;
  private wantPlaying = false;
  private state: PlayState = 'idle';
  private audio: HTMLAudioElement | null = null;
  private preview: HTMLAudioElement | null = null;
  /** Bumped whenever the plan changes, so late results from an old plan are ignored. */
  private generation = 0;
  private synthesizing = false;
  private clock = 0;
  private closed = false;
  /** Chunks that could not be synthesised, so the look-ahead does not retry them forever. */
  private failed = new Set<string>();
  playingUrl = '';

  constructor(private port: chrome.runtime.Port) {
    port.onMessage.addListener((message: ToEngine) => this.handle(message));
    port.onDisconnect.addListener(() => this.close(false));
    if (lastModelMessage) this.send(lastModelMessage);
  }

  send(message: FromEngine): void {
    if (this.closed) return;
    try {
      this.port.postMessage(message);
    } catch {
      this.close(false);
    }
  }

  /** Ends the session. `displaced` tells the page another tab took over. */
  close(displaced: boolean): void {
    if (this.closed) return;
    if (displaced) this.send({ type: 'displaced' });
    this.closed = true;
    this.generation++;
    this.dropAudio();
    this.stopPreview();
    clearInterval(this.clock);
    if (session === this) session = null;
    if (displaced) this.port.disconnect();
  }

  private handle(message: ToEngine): void {
    switch (message.type) {
      case 'load':
        this.chunks = message.chunks;
        this.voice = message.voice;
        this.rate = message.rate;
        this.wantPlaying = message.autoplay;
        this.goTo(message.index);
        break;
      case 'play':
        this.stopPreview();
        this.wantPlaying = true;
        if (this.state === 'ended') this.goTo(0);
        else if (this.audio) void this.resume();
        else this.goTo(this.index);
        break;
      case 'pause':
        this.stopPreview();
        this.wantPlaying = false;
        this.audio?.pause();
        if (this.audio) this.setState('paused');
        break;
      case 'seek':
        this.goTo(message.index);
        break;
      case 'rate':
        this.rate = message.rate;
        if (this.audio) this.audio.playbackRate = this.rate;
        this.tick();
        break;
      case 'voice':
        if (message.voice !== this.voice) {
          this.voice = message.voice;
          this.goTo(this.index);
        }
        break;
      case 'preview':
        void this.playPreview(message.voice);
        break;
      case 'stop':
        this.wantPlaying = false;
        this.generation++;
        this.dropAudio();
        this.setState('idle');
        break;
    }
  }

  private setState(state: PlayState, message?: string): void {
    this.state = state;
    this.send({ type: 'state', state, index: this.index, message });
    clearInterval(this.clock);
    if (state === 'playing') this.clock = setInterval(() => this.tick(), CLOCK_INTERVAL_MS) as unknown as number;
  }

  private tick(): void {
    if (!this.audio) return;
    this.send({
      type: 'time',
      index: this.index,
      t: this.audio.currentTime,
      rate: this.rate,
      playing: !this.audio.paused,
      at: Date.now(),
    });
  }

  private dropAudio(): void {
    if (!this.audio) return;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.onpause = null;
    this.audio.onplay = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio = null;
    this.playingUrl = '';
  }

  /** Moves by whole chunks, for the media keys. */
  step(delta: number): void {
    if (this.chunks.length > 0) this.goTo(this.index + delta);
  }

  private goTo(index: number): void {
    this.generation++;
    this.dropAudio();
    this.index = Math.max(0, Math.min(index, this.chunks.length - 1));
    if (this.chunks.length === 0) return this.setState('ended');
    this.setState(lastModelMessage?.type === 'model' && lastModelMessage.phase === 'ready' ? 'buffering' : 'loading');
    void this.startCurrent();
    this.fillAhead();
  }

  private async startCurrent(): Promise<void> {
    const generation = this.generation;
    const index = this.index;
    let clip: Clip;
    try {
      clip = await synthesize(this.voice, this.chunks[index]);
    } catch (error) {
      if (generation === this.generation) this.setState('error', (error as Error).message);
      return;
    }
    if (generation !== this.generation) return;

    const audio = new Audio(clip.url);
    audio.preservesPitch = true;
    audio.playbackRate = this.rate;
    audio.onended = () => this.advance();
    audio.onerror = () => this.setState('error', 'The audio could not be played.');
    // Media keys and the browser's own media controls act on the element directly.
    audio.onpause = () => {
      if (audio !== this.audio || audio.ended || !this.wantPlaying || this.state !== 'playing') return;
      this.wantPlaying = false;
      this.setState('paused');
    };
    audio.onplay = () => {
      if (audio !== this.audio || this.wantPlaying) return;
      this.wantPlaying = true;
      this.setState('playing');
      this.tick();
    };
    this.audio = audio;
    this.playingUrl = clip.url;
    this.send({ type: 'chunk', index, duration: clip.duration, words: clip.words });
    if (this.wantPlaying) await this.resume();
    else this.setState('paused');
    this.fillAhead();
  }

  private async resume(): Promise<void> {
    const audio = this.audio;
    if (!audio) return;
    try {
      await audio.play();
    } catch (error) {
      if (audio !== this.audio) return;
      return this.setState('error', (error as Error).message);
    }
    if (audio !== this.audio) return;
    this.setState('playing');
    this.tick();
  }

  private advance(): void {
    if (this.index >= this.chunks.length - 1) {
      this.dropAudio();
      this.wantPlaying = false;
      return this.setState('ended');
    }
    this.generation++;
    this.dropAudio();
    this.index++;
    if (!clips.has(clipKey(this.voice, this.chunks[this.index]))) this.setState('buffering');
    void this.startCurrent();
  }

  /** Prepares the next few chunks so that playback never waits. */
  private fillAhead(): void {
    if (this.synthesizing || this.closed) return;
    let seconds = 0;
    for (let i = this.index + 1; i < this.chunks.length; i++) {
      const clip = clips.get(clipKey(this.voice, this.chunks[i]));
      if (clip) {
        seconds += clip.duration;
        if (seconds > LOOKAHEAD_SECONDS && i - this.index >= LOOKAHEAD_MIN_CHUNKS) return;
        continue;
      }
      const key = clipKey(this.voice, this.chunks[i]);
      if (this.failed.has(key)) continue;
      this.synthesizing = true;
      synthesize(this.voice, this.chunks[i])
        .catch(() => void this.failed.add(key))
        .finally(() => {
          this.synthesizing = false;
          // Start again from wherever the listener is now.
          this.fillAhead();
        });
      return;
    }
  }

  private stopPreview(): void {
    this.preview?.pause();
    this.preview = null;
  }

  private async playPreview(voice: string): Promise<void> {
    this.stopPreview();
    const wasPlaying = this.wantPlaying && !!this.audio;
    this.audio?.pause();
    if (wasPlaying) this.setState('paused');
    const name = voiceById(voice).name;
    try {
      const clip = await synthesize(voice, { text: `Hi, I'm ${name}. This is how I sound when I read to you.` });
      if (this.closed) return;
      const preview = new Audio(clip.url);
      this.preview = preview;
      preview.onended = () => {
        if (this.preview !== preview) return;
        this.preview = null;
        if (wasPlaying && this.wantPlaying) void this.resume();
      };
      await preview.play();
    } catch {
      /* a preview that fails is not worth interrupting the listener for */
    }
  }
}

let session: Session | null = null;

// Hardware media keys: play, pause, and skip by sentence.
if ('mediaSession' in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Reading aloud', artist: 'Lector' });
  navigator.mediaSession.setActionHandler('nexttrack', () => session?.step(1));
  navigator.mediaSession.setActionHandler('previoustrack', () => session?.step(-1));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ENGINE_PORT) return;
  // One voice at a time: a new reader takes over from the previous one.
  session?.close(true);
  session = new Session(port);
});
