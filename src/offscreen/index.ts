// Offscreen document: owns the voice engine worker and the audio element.
// A page connects with a port, hands over the sentences to read, and receives
// playback state, word timings and a running clock in return.

import { ENGINE_PORT, SAMPLE_PORT, type ChunkSpec, type FromEngine, type PlayState, type ToEngine, type WordMark } from '../shared/protocol';
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

/** Thrown for a request that was dropped because the listener moved elsewhere. */
class Cancelled extends Error {}

interface Job {
  key: string;
  voice: string;
  chunk: ChunkSpec;
  /** A voice sample; not tied to a place in the text, so a jump does not cancel it. */
  sample: boolean;
  resolve: (clip: Clip) => void;
  reject: (error: Error) => void;
}

const worker = new Worker(new URL('./engine-worker.js', location.href), { type: 'module' });
const clips = new Map<string, Clip>();
/** Requests that have been asked for and not finished, so the same text is never spoken twice. */
const inFlight = new Map<string, Promise<Clip>>();
/** Requests waiting for the worker, most urgent first. The worker does one at a time. */
const waiting: Job[] = [];
let running: Job | null = null;
let lastModelMessage: FromEngine | null = null;

const clipKey = (voice: string, chunk: ChunkSpec) => `${voice}|${chunk.pauseAfter ?? 0}|${chunk.text}`;

function pump(): void {
  if (running) return;
  const job = waiting.shift();
  if (!job) return;
  running = job;
  worker.postMessage({ type: 'synth', id: 0, text: job.chunk.text, voice: job.voice } satisfies WorkerRequest);
}

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  if (message.type === 'model') {
    lastModelMessage = message;
    session?.send(message);
    return;
  }
  const job = running;
  running = null;
  if (job) {
    if (message.type === 'error') job.reject(new Error(message.message));
    else {
      const pauseAfter = job.chunk.pauseAfter ?? 0;
      job.resolve({
        url: URL.createObjectURL(encodeWav(message.pcm, message.sampleRate, pauseAfter)),
        duration: message.pcm.length / message.sampleRate + pauseAfter,
        words: message.words,
      });
    }
  }
  pump();
};

worker.onerror = () => {
  // The worker itself failed (out of memory, a crashed GPU process). Fail what was running and carry on.
  const job = running;
  running = null;
  job?.reject(new Error('The voice engine stopped unexpectedly. Press play to try again.'));
  pump();
};

/**
 * Speech for a chunk. `urgent` puts it ahead of everything that is waiting,
 * for the sentence the listener is about to hear.
 */
function synthesize(voice: string, chunk: ChunkSpec, urgent: boolean, sample = false): Promise<Clip> {
  const key = clipKey(voice, chunk);
  const cached = clips.get(key);
  if (cached) {
    // Refresh its place in the least-recently-used order.
    clips.delete(key);
    clips.set(key, cached);
    return Promise.resolve(cached);
  }
  const existing = inFlight.get(key);
  if (existing) {
    const at = waiting.findIndex((job) => job.key === key);
    if (urgent && at > 0) waiting.unshift(...waiting.splice(at, 1));
    return existing;
  }
  const promise = new Promise<Clip>((resolve, reject) => {
    const job: Job = { key, voice, chunk, sample, resolve, reject };
    if (urgent) waiting.unshift(job);
    else waiting.push(job);
  })
    .then((clip) => {
      clips.set(key, clip);
      for (const [oldKey, old] of clips) {
        if (clips.size <= CACHE_LIMIT) break;
        if (old.url === session?.playingUrl) continue;
        URL.revokeObjectURL(old.url);
        clips.delete(oldKey);
      }
      return clip;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  pump();
  return promise;
}

/** Drops every request for the text that has not started yet. Called when the listener jumps. */
function cancelWaiting(): void {
  for (let i = waiting.length - 1; i >= 0; i--) {
    if (waiting[i].sample) continue;
    const [job] = waiting.splice(i, 1);
    job.reject(new Cancelled());
  }
}

// ------------------------------------------------------------------ samples

// A voice sample plays on its own audio element. While it plays, the reading waits.
let sampleAudio: HTMLAudioElement | null = null;
let sampleToken = 0;

function stopSample(): void {
  sampleToken++;
  sampleAudio?.pause();
  sampleAudio = null;
}

async function playSample(voice: string): Promise<void> {
  stopSample();
  const token = sampleToken;
  session?.hold();
  const finish = () => {
    if (token !== sampleToken) return;
    sampleAudio = null;
    session?.release();
  };
  try {
    const clip = await synthesize(voice, { text: `Hi, I'm ${voiceById(voice).name}. This is how I sound when I read to you.` }, true, true);
    if (token !== sampleToken) return;
    const audio = new Audio(clip.url);
    sampleAudio = audio;
    audio.onended = finish;
    audio.onerror = finish;
    await audio.play();
  } catch {
    // A sample that fails is not worth interrupting the listener for.
    finish();
  }
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
  /** True while a voice sample plays; `resumeAfterHold` is what the listener wanted before it. */
  private held = false;
  private resumeAfterHold = false;
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
    if (this.held) stopSample();
    clearInterval(this.clock);
    if (session === this) session = null;
    if (displaced) this.port.disconnect();
  }

  /** Pauses the reading for a voice sample, remembering whether it was playing. */
  hold(): void {
    if (this.held) return;
    this.held = true;
    this.resumeAfterHold = this.wantPlaying;
    this.wantPlaying = false;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
      this.setState('paused');
      this.tick();
    }
  }

  /** Called when the sample ends: carry on if the reading was playing before it. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    if (!this.resumeAfterHold) return;
    this.wantPlaying = true;
    // If the sentence is not ready yet, it starts by itself once it is.
    if (this.audio) void this.resume();
  }

  /** Any command from the listener ends a sample and puts their earlier intent back first. */
  private endHold(): void {
    if (!this.held) return;
    this.held = false;
    this.wantPlaying = this.resumeAfterHold;
    stopSample();
  }

  private handle(message: ToEngine): void {
    if (message.type !== 'preview' && message.type !== 'rate') this.endHold();
    switch (message.type) {
      case 'load':
        this.chunks = message.chunks;
        this.voice = message.voice;
        this.rate = message.rate;
        this.wantPlaying = message.autoplay;
        this.failed.clear();
        this.goTo(message.index);
        break;
      case 'play':
        this.wantPlaying = true;
        if (this.state === 'ended') this.goTo(0);
        else if (this.audio) void this.resume();
        else this.goTo(this.index);
        break;
      case 'pause':
        this.wantPlaying = false;
        this.audio?.pause();
        // Also while the first sentence is still being prepared, so the button answers at once.
        if (this.chunks.length > 0 && this.state !== 'ended') this.setState('paused');
        this.tick();
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
        void playSample(message.voice);
        break;
      case 'stop':
        this.wantPlaying = false;
        this.generation++;
        cancelWaiting();
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
    // Whatever was queued for the old position is no longer wanted.
    cancelWaiting();
    this.dropAudio();
    this.index = Math.max(0, Math.min(index, this.chunks.length - 1));
    if (this.chunks.length === 0) return this.setState('ended');
    if (this.wantPlaying) this.setState(lastModelMessage?.type === 'model' && lastModelMessage.phase === 'ready' ? 'buffering' : 'loading');
    else this.setState('paused');
    void this.startCurrent();
    this.fillAhead();
  }

  private async startCurrent(): Promise<void> {
    const generation = this.generation;
    const index = this.index;
    let clip: Clip;
    try {
      clip = await synthesize(this.voice, this.chunks[index], true);
    } catch (error) {
      if (generation === this.generation && !(error instanceof Cancelled)) this.setState('error', (error as Error).message);
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
      // A pause that lands while play() is still starting rejects it; that is not a failure.
      if (audio !== this.audio || (error as DOMException).name === 'AbortError') return;
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
    this.fillAhead();
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
      synthesize(this.voice, this.chunks[i], false)
        .catch((error) => {
          if (!(error instanceof Cancelled)) this.failed.add(key);
        })
        .finally(() => {
          this.synthesizing = false;
          // Start again from wherever the listener is now.
          this.fillAhead();
        });
      return;
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
  // The settings page only wants to hear a voice; it must not take the reading away from a tab.
  if (port.name === SAMPLE_PORT) {
    port.onMessage.addListener((message: ToEngine) => {
      if (message.type === 'preview') void playSample(message.voice);
    });
    return;
  }
  if (port.name !== ENGINE_PORT) return;
  // One voice at a time: a new reader takes over from the previous one.
  session?.close(true);
  session = new Session(port);
});
