// The reading session: holds what is being read, talks to the voice engine,
// and keeps the highlight and scroll position in step with the audio.

import type { FromEngine, PlayState, WordMark } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { rangeOf, rangesOf } from './blocks';
import { EngineClient } from './engine-client';
import { Highlighter, onDarkBackground } from './highlight';
import type { Reading } from './page';
import { Scroller } from './scroller';
import { estimateSeconds, type Unit } from './segment';

const PARAGRAPH_PAUSE = 0.28;
const HEADING_PAUSE = 0.45;

export interface Snapshot {
  /** Whether a reading is loaded, playing or not. */
  active: boolean;
  state: PlayState;
  index: number;
  total: number;
  /** 0–1 through the reading. */
  progress: number;
  /** Seconds left at the current speed. */
  remaining: number;
  /** Status line for anything the listener has to wait for. */
  notice: string;
  /** 0–1 while the voice model downloads, otherwise null. */
  download: number | null;
  error: string;
  scrollSuspended: boolean;
}

export class Reader {
  private engine: EngineClient;
  private highlighter: Highlighter;
  private scroller: Scroller;
  private reading: Reading | null = null;
  private index = 0;
  private state: PlayState = 'idle';
  private words: WordMark[] = [];
  private wordsIndex = -1;
  private clock = { index: -1, t: 0, rate: 1, at: 0, playing: false };
  private shownWord = -1;
  private frame = 0;
  private modelPhase: 'unknown' | 'download' | 'load' | 'ready' | 'error' = 'unknown';
  private download: number | null = null;
  private error = '';
  /** True when the engine no longer holds our text and must be given it again before playing. */
  private detached = true;
  private listeners = new Set<(snapshot: Snapshot) => void>();

  constructor(
    private settings: Settings,
    overlay = false,
  ) {
    this.highlighter = new Highlighter(overlay);
    this.engine = new EngineClient(
      (message) => this.onEngine(message),
      () => this.onDetached(),
    );
    this.scroller = new Scroller(() => this.emit());
    this.applySettings(settings);
  }

  // ------------------------------------------------------------- observers

  subscribe(listener: (snapshot: Snapshot) => void): void {
    this.listeners.add(listener);
  }

  snapshot(): Snapshot {
    const units = this.reading?.units ?? [];
    const total = units.length;
    let notice = '';
    if (this.state === 'error') notice = this.error || 'Something went wrong.';
    else if (this.state === 'loading' || this.state === 'buffering') {
      if (this.modelPhase === 'download') notice = `Downloading the voice, ${Math.round((this.download ?? 0) * 100)}%`;
      else if (this.modelPhase !== 'ready') notice = 'Waking the voice…';
      else notice = 'Preparing…';
    }
    return {
      active: this.reading !== null,
      state: this.state,
      index: this.index,
      total,
      progress: total > 0 ? Math.min(1, (this.index + (this.state === 'ended' ? 1 : 0)) / total) : 0,
      remaining: this.state === 'ended' ? 0 : estimateSeconds(units, this.index) / this.settings.rate,
      notice,
      download: this.state === 'loading' && this.modelPhase === 'download' ? this.download : null,
      error: this.state === 'error' ? this.error : '',
      scrollSuspended: this.scroller.suspended,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  // -------------------------------------------------------------- commands

  get isActive(): boolean {
    return this.reading !== null;
  }

  get isPlaying(): boolean {
    return this.state === 'playing' || this.state === 'loading' || this.state === 'buffering';
  }

  get currentReading(): Reading | null {
    return this.reading;
  }

  /** Starts reading `reading` from the unit at `index`. */
  start(reading: Reading, index = 0): void {
    this.reading = reading;
    this.index = Math.max(0, Math.min(index, reading.units.length - 1));
    this.scroller.setActive(true);
    this.load(true);
  }

  /** Starts from the first unit of a block. */
  startAtBlock(reading: Reading, blockIndex: number): void {
    const index = reading.units.findIndex((unit) => unit.blockIndex >= blockIndex);
    this.start(reading, Math.max(index, 0));
  }

  private load(autoplay: boolean): void {
    if (!this.reading) return;
    this.detached = false;
    this.error = '';
    this.words = [];
    this.wordsIndex = -1;
    this.state = this.modelPhase === 'ready' ? 'buffering' : 'loading';
    this.showSentence(true, true);
    this.emit();
    this.engine
      .send({
        type: 'load',
        chunks: this.reading.units.map((unit) => ({ text: unit.spoken, pauseAfter: pauseAfter(unit) })),
        index: this.index,
        voice: this.settings.voice,
        rate: this.settings.rate,
        autoplay,
      })
      .catch((error: Error) => this.fail(friendly(error)));
  }

  private fail(message: string): void {
    this.state = 'error';
    this.error = message;
    this.detached = true;
    this.stopFrames();
    this.emit();
  }

  play(): void {
    if (!this.reading) return;
    if (this.detached || this.state === 'error') return this.load(true);
    if (this.state === 'ended') {
      // Reading again: show the first sentence now, since the engine will report the position we already hold.
      this.index = 0;
      this.words = [];
      this.wordsIndex = -1;
      this.showSentence(true, true);
    }
    this.engine.sendIfConnected({ type: 'play' });
  }

  pause(): void {
    this.engine.sendIfConnected({ type: 'pause' });
  }

  toggle(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seek(index: number): void {
    if (!this.reading) return;
    this.index = Math.max(0, Math.min(index, this.reading.units.length - 1));
    if (this.detached) return this.load(this.isPlaying);
    this.words = [];
    this.wordsIndex = -1;
    this.showSentence(true, true);
    this.engine.sendIfConnected({ type: 'seek', index: this.index });
    this.emit();
  }

  next(): void {
    this.seek(this.index + 1);
  }

  previous(): void {
    // Like a music player: a little way into a sentence, "back" restarts it.
    const now = this.currentTime();
    this.seek(now > 1.5 && this.clock.index === this.index ? this.index : this.index - 1);
  }

  nextBlock(direction: 1 | -1): void {
    const units = this.reading?.units;
    if (!units) return;
    const here = units[this.index].blockIndex;
    if (direction === 1) {
      const next = units.findIndex((unit) => unit.blockIndex > here);
      if (next >= 0) this.seek(next);
    } else {
      const startOfThis = units.findIndex((unit) => unit.blockIndex === here);
      const target = startOfThis < this.index ? here : (units[startOfThis - 1]?.blockIndex ?? here);
      this.seek(units.findIndex((unit) => unit.blockIndex === target));
    }
  }

  /** Closes the session and removes every trace from the page. */
  stop(): void {
    this.engine.sendIfConnected({ type: 'stop' });
    this.engine.disconnect();
    this.reading = null;
    this.state = 'idle';
    this.detached = true;
    this.words = [];
    this.stopFrames();
    this.highlighter.clear();
    this.scroller.setActive(false);
    this.emit();
  }

  previewVoice(voice: string): void {
    this.engine.send({ type: 'preview', voice }).catch(() => undefined);
  }

  resumeScroll(): void {
    this.scroller.resume();
  }

  applySettings(settings: Settings): void {
    const rateChanged = settings.rate !== this.settings.rate;
    const voiceChanged = settings.voice !== this.settings.voice;
    this.settings = settings;
    this.highlighter.setColor(settings.highlightColor);
    this.scroller.enabled = settings.autoScroll;
    if (rateChanged) this.engine.sendIfConnected({ type: 'rate', rate: settings.rate });
    if (voiceChanged && this.reading && !this.detached) {
      this.words = [];
      this.wordsIndex = -1;
      this.engine.sendIfConnected({ type: 'voice', voice: settings.voice });
    }
    if (this.reading) {
      this.shownWord = -1;
      this.showSentence(false);
    }
    this.emit();
  }

  // ---------------------------------------------------------------- engine

  private onEngine(message: FromEngine): void {
    switch (message.type) {
      case 'model':
        this.modelPhase = message.phase;
        this.download = message.phase === 'download' ? (message.progress ?? 0) : null;
        if (message.phase === 'error') return this.fail(friendly(new Error(message.message)));
        break;
      case 'state': {
        const moved = message.index !== this.index;
        this.state = message.state;
        this.index = message.index;
        if (message.state === 'error') this.error = friendly(new Error(message.message));
        if (message.state === 'idle') return;
        if (moved) this.showSentence(true);
        if (message.state === 'playing') this.startFrames();
        else this.stopFrames();
        if (message.state === 'ended') this.highlighter.clear();
        break;
      }
      case 'chunk':
        this.words = message.words;
        this.wordsIndex = message.index;
        this.shownWord = -1;
        this.clock = { index: message.index, t: 0, rate: this.settings.rate, at: Date.now(), playing: false };
        return;
      case 'time':
        this.clock = message;
        return;
      case 'displaced':
        return this.onDetached();
    }
    this.emit();
  }

  /** Another tab started reading, or the engine went away: stay where we are, paused. */
  private onDetached(): void {
    this.detached = true;
    this.stopFrames();
    if (this.reading && this.state !== 'error') this.state = 'paused';
    this.highlighter.setWord([]);
    this.emit();
  }

  // ------------------------------------------------------------- highlight

  private currentTime(): number {
    const { t, rate, at, playing } = this.clock;
    return playing ? t + ((Date.now() - at) / 1000) * rate : t;
  }

  private unit(): Unit | null {
    return this.reading?.units[this.index] ?? null;
  }

  private showSentence(scroll: boolean, byListener = false): void {
    const unit = this.unit();
    this.shownWord = -1;
    this.highlighter.setWord([]);
    if (!unit) return this.highlighter.clear();
    const range = rangeOf(unit.block, unit.start, unit.end);
    if (range) this.highlighter.setDark(onDarkBackground(unit.block.el));
    this.highlighter.setSentence(this.settings.highlightSentence ? rangesOf(unit.block, unit.start, unit.end) : []);
    if (scroll) this.scroller.follow(range, byListener);
  }

  private startFrames(): void {
    if (this.frame) return;
    const step = () => {
      this.frame = requestAnimationFrame(step);
      this.showWord();
    };
    this.frame = requestAnimationFrame(step);
  }

  private stopFrames(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private showWord(): void {
    const unit = this.unit();
    if (!unit || !this.settings.highlightWord || this.wordsIndex !== this.index || this.clock.index !== this.index) return;
    const now = this.currentTime();
    // Last word that has started.
    let low = 0;
    let high = this.words.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.words[mid].t <= now) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (found === this.shownWord) return;
    this.shownWord = found;
    if (found < 0) return this.highlighter.setWord([]);
    const word = this.words[found];
    let start = word.cs;
    let end = word.ce;
    // Highlight the word itself, not the punctuation stuck to it.
    while (start < end && /[^\p{L}\p{N}$€£¥%&@#+]/u.test(unit.spoken[start])) start++;
    while (end > start && /[^\p{L}\p{N}%$€£¥]/u.test(unit.spoken[end - 1])) end--;
    if (end <= start || end > unit.map.length) return this.highlighter.setWord([]);
    this.highlighter.setWord(rangesOf(unit.block, unit.map[start], unit.map[end - 1] + 1));
  }
}

function pauseAfter(unit: Unit): number {
  if (!unit.endsBlock) return 0;
  return unit.block.heading ? HEADING_PAUSE : PARAGRAPH_PAUSE;
}

function friendly(error: Error): string {
  const message = error?.message ?? '';
  if (/Extension context invalidated/i.test(message)) return 'Lector was updated. Reload this page to keep listening.';
  if (/fetch|network|Failed to load|ERR_/i.test(message)) return 'The voice could not be downloaded. Check your connection and try again.';
  return message || 'The voice could not start.';
}
