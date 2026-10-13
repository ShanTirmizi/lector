// The floating player: transport controls, speed, voice and quick settings.

import { MAX_RATE, MIN_RATE, clampRate, type HighlightColor, type Settings } from '../../shared/settings';
import { VOICES, voiceById } from '../../shared/voices';
import type { Snapshot } from '../reader';
import { formatRate, formatRemaining, h } from './dom';
import { icons } from './icons';
import { keys, place } from './tips';

export interface PlayerActions {
  toggle(): void;
  previous(): void;
  next(): void;
  close(): void;
  setRate(rate: number): void;
  setVoice(voice: string): void;
  previewVoice(voice: string): void;
  change(patch: Partial<Settings>): void;
  backToText(): void;
  /** What sits at a point 0–1 through the text, for the preview shown while scrubbing. */
  peek(fraction: number): { text: string; remaining: number } | null;
  seekTo(fraction: number): void;
  openSettings(): void;
  hideOnThisSite(): void;
}

type PanelName = 'speed' | 'voice' | 'more';

const PRESETS = [0.75, 1, 1.25, 1.5, 2, 3];
const SWATCHES: Array<[HighlightColor, string, string]> = [
  ['marigold', '#ffd652', 'Marigold'],
  ['mint', '#5ee0aa', 'Mint'],
  ['sky', '#78c0ff', 'Sky'],
  ['rose', '#ff9eb8', 'Rose'],
];
const EDGE = 12;

export class Player {
  private el: HTMLElement;
  private playButton: HTMLButtonElement;
  private previousButton: HTMLButtonElement;
  private nextButton: HTMLButtonElement;
  private speedChip: HTMLButtonElement;
  private voiceChip: HTMLButtonElement;
  private voiceName: HTMLElement;
  private moreButton: HTMLButtonElement;
  private status: HTMLElement;
  private scrub: HTMLElement;
  private peekBubble = h('div', { class: 'peek', hidden: true });
  private panel: HTMLElement | null = null;
  private openPanel: PanelName | null = null;
  private lastIcon = '';
  private visible = false;

  constructor(
    private root: ShadowRoot,
    private actions: PlayerActions,
    private settings: Settings,
  ) {
    const button = (cls: string, label: string, icon: string, onClick: () => void, shortcut?: string) =>
      h('button', { class: cls, type: 'button', 'aria-label': label, 'data-tip': label, 'data-keys': shortcut, html: icon, onClick });

    this.previousButton = button('icon', 'Previous sentence', icons.previous, () => actions.previous(), keys('Alt', ','));
    this.playButton = h('button', { class: 'play', type: 'button', 'data-keys': keys('Alt', 'R'), onClick: () => actions.toggle() });
    this.nextButton = button('icon', 'Next sentence', icons.next, () => actions.next(), keys('Alt', '.'));
    this.speedChip = h('button', { class: 'chip speed', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Speed', 'data-tip': 'Speed', onClick: () => this.togglePanel('speed') });
    this.voiceName = h('span');
    this.voiceChip = h(
      'button',
      { class: 'chip voice', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Voice', 'data-tip': 'Voice', onClick: () => this.togglePanel('voice') },
      h('i', { class: 'eq', html: '<b></b><b></b><b></b>' }),
      this.voiceName,
    );
    this.status = h('div', { class: 'status', role: 'status' });
    this.moreButton = button('icon quiet', 'Reading options', icons.more, () => this.togglePanel('more'));
    const grip = h('div', { class: 'grip', 'data-tip': 'Drag to move' });
    this.scrub = h(
      'div',
      { class: 'scrub', role: 'slider', tabindex: 0, 'aria-label': 'Position in the text', 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div', { class: 'track' }, h('i')),
      h('b', { class: 'thumb' }),
    );

    this.el = h(
      'div',
      { class: 'player', role: 'region', 'aria-label': 'Lector player', hidden: true },
      grip,
      this.previousButton,
      this.playButton,
      this.nextButton,
      h('div', { class: 'rule' }),
      this.speedChip,
      this.voiceChip,
      this.status,
      h('div', { class: 'rule' }),
      this.moreButton,
      button('icon quiet', 'Close the player', icons.close, () => actions.close()),
      this.scrub,
    );
    root.append(this.el, this.peekBubble);

    this.enableScrubbing();
    this.enableDragging();
    window.addEventListener('resize', () => this.visible && this.place());
    // Clicks elsewhere on the page close an open panel. Events from inside the
    // shadow root are retargeted to the host, so check the real path.
    document.addEventListener('pointerdown', (event) => {
      if (this.openPanel && !event.composedPath().some((node) => node === this.panel || node === this.el)) this.closePanel();
    }, true);
    root.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape' && this.openPanel) {
        this.closePanel();
        event.stopPropagation();
      }
    });
    this.renderSettings();
  }

  // -------------------------------------------------------------- lifecycle

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.el.hidden = false;
    this.place();
  }

  hide(): void {
    this.visible = false;
    this.el.hidden = true;
    this.closePanel();
  }

  get rect(): DOMRect {
    return this.el.getBoundingClientRect();
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    this.renderSettings();
    // The speed panel is updated in place so that a drag on its slider survives.
    if (this.openPanel === 'speed') this.refreshSpeed();
    else if (this.openPanel) this.renderPanel();
    if (this.visible) this.place();
  }

  private renderSettings(): void {
    this.speedChip.textContent = formatRate(this.settings.rate);
    this.voiceName.textContent = voiceById(this.settings.voice).name;
  }

  update(snapshot: Snapshot): void {
    const waiting = snapshot.state === 'loading' || snapshot.state === 'buffering';
    const playing = snapshot.state === 'playing' || waiting;

    const icon = snapshot.state === 'ended' ? 'replay' : playing ? 'pause' : 'play';
    if (icon !== this.lastIcon) {
      // Keep the ring element out of innerHTML churn so its animation does not restart.
      this.playButton.innerHTML = `${icons[icon]}<span class="ring"></span>`;
      this.lastIcon = icon;
    }
    const label = snapshot.state === 'ended' ? 'Read again' : playing ? 'Pause' : 'Play';
    this.playButton.setAttribute('aria-label', label);
    this.playButton.setAttribute('data-tip', label);
    this.el.toggleAttribute('data-speaking', snapshot.state === 'playing');

    if (snapshot.download !== null) {
      this.el.dataset.busy = 'fill';
      this.el.style.setProperty('--download', String(snapshot.download));
    } else if (waiting) this.el.dataset.busy = 'spin';
    else delete this.el.dataset.busy;

    if (!this.scrubbing) this.el.style.setProperty('--progress', String(snapshot.progress));
    this.scrub.setAttribute('aria-valuenow', String(Math.round(snapshot.progress * 100)));
    this.previousButton.disabled = snapshot.total === 0;
    this.nextButton.disabled = snapshot.index >= snapshot.total - 1;

    this.status.classList.toggle('problem', snapshot.state === 'error');
    this.status.classList.toggle('wide', snapshot.download !== null);
    if (snapshot.scrollSuspended && snapshot.state !== 'error') {
      if (!this.status.querySelector('.back')) {
        this.status.replaceChildren(
          h('button', { class: 'back', type: 'button', html: `${icons.locate}<span>Back to the text</span>`, onClick: () => this.actions.backToText() }),
        );
      }
    } else {
      this.status.textContent = snapshot.notice || (snapshot.state === 'ended' ? 'Finished' : formatRemaining(snapshot.remaining));
    }
    if (this.visible) this.place();
  }

  // --------------------------------------------------------------- position

  /** Puts the player where it was last dropped, or bottom centre, always fully on screen. */
  private place(): void {
    this.el.classList.toggle('narrow', window.innerWidth < 620);
    this.el.classList.toggle('tiny', window.innerWidth < 380);
    const { width, height } = this.el.getBoundingClientRect();
    const position = this.settings.playerPosition;
    const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
    const maxTop = Math.max(EDGE, window.innerHeight - height - EDGE);
    const left = position ? position.x * window.innerWidth - width / 2 : (window.innerWidth - width) / 2;
    const top = position ? position.y * window.innerHeight - height / 2 : window.innerHeight - height - 28;
    this.el.style.left = `${Math.round(Math.min(maxLeft, Math.max(EDGE, left)))}px`;
    this.el.style.top = `${Math.round(Math.min(maxTop, Math.max(EDGE, top)))}px`;
    if (this.panel) this.placePanel();
  }

  private enableDragging(): void {
    let start: { x: number; y: number; left: number; top: number } | null = null;
    let moved = false;
    this.el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('button, input, .scrub')) return;
      const rect = this.el.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      moved = false;
      this.el.setPointerCapture(event.pointerId);
    });
    this.el.addEventListener('pointermove', (event) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      this.closePanel();
      this.el.classList.add('dragging');
      const { width, height } = this.el.getBoundingClientRect();
      const left = Math.min(window.innerWidth - width - EDGE, Math.max(EDGE, start.left + dx));
      const top = Math.min(window.innerHeight - height - EDGE, Math.max(EDGE, start.top + dy));
      this.el.style.left = `${left}px`;
      this.el.style.top = `${top}px`;
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.el.classList.remove('dragging');
      if (!moved) return;
      const rect = this.el.getBoundingClientRect();
      this.actions.change({
        playerPosition: {
          x: (rect.left + rect.width / 2) / window.innerWidth,
          y: (rect.top + rect.height / 2) / window.innerHeight,
        },
      });
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    // Double-click the handle to send the player home.
    this.el.addEventListener('dblclick', (event) => {
      if ((event.target as Element).closest('button, input')) return;
      this.actions.change({ playerPosition: null });
    });
  }

  // --------------------------------------------------------------- scrubbing

  private scrubbing = false;

  /** Hovering the progress line previews the text at that point; clicking or dragging jumps there. */
  private enableScrubbing(): void {
    const fractionAt = (event: PointerEvent) => {
      const rect = this.scrub.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    };
    const preview = (event: PointerEvent) => {
      const fraction = fractionAt(event);
      const place_ = this.actions.peek(fraction);
      if (!place_) return;
      const text = place_.text.length > 84 ? `${place_.text.slice(0, 82).trimEnd()}…` : place_.text;
      this.peekBubble.replaceChildren(h('span', {}, text), h('small', {}, formatRemaining(place_.remaining)));
      this.peekBubble.hidden = false;
      const rect = this.scrub.getBoundingClientRect();
      const bar = this.el.getBoundingClientRect();
      place(this.peekBubble, { left: rect.left + rect.width * fraction, width: 0, top: bar.top, bottom: bar.bottom });
      this.scrub.style.setProperty('--at', String(fraction));
      if (this.scrubbing) this.el.style.setProperty('--progress', String(fraction));
    };
    this.scrub.addEventListener('pointermove', preview);
    this.scrub.addEventListener('pointerleave', () => {
      if (!this.scrubbing) this.peekBubble.hidden = true;
    });
    this.scrub.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.scrubbing = true;
      this.scrub.setPointerCapture(event.pointerId);
      this.closePanel();
      preview(event);
    });
    const finish = (event: PointerEvent, commit: boolean) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.peekBubble.hidden = true;
      if (commit) this.actions.seekTo(fractionAt(event));
    };
    this.scrub.addEventListener('pointerup', (event) => finish(event, true));
    this.scrub.addEventListener('pointercancel', (event) => finish(event, false));
    this.scrub.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') this.actions.next();
      else if (event.key === 'ArrowLeft') this.actions.previous();
      else return;
      event.preventDefault();
    });
  }

  // ----------------------------------------------------------------- panels

  private togglePanel(name: PanelName): void {
    if (this.openPanel === name) this.closePanel();
    else {
      this.openPanel = name;
      this.renderPanel();
    }
  }

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
    this.openPanel = null;
    for (const trigger of [this.speedChip, this.voiceChip, this.moreButton]) trigger.setAttribute('aria-expanded', 'false');
  }

  private trigger(): HTMLElement {
    return this.openPanel === 'speed' ? this.speedChip : this.openPanel === 'voice' ? this.voiceChip : this.moreButton;
  }

  private renderPanel(): void {
    const scroll = this.panel?.querySelector('.voices')?.scrollTop ?? 0;
    this.panel?.remove();
    const panel = h('div', { class: 'panel', role: 'dialog' });
    if (this.openPanel === 'speed') this.buildSpeed(panel);
    else if (this.openPanel === 'voice') this.buildVoices(panel);
    else this.buildMore(panel);
    this.panel = panel;
    this.root.append(panel);
    for (const trigger of [this.speedChip, this.voiceChip, this.moreButton]) trigger.setAttribute('aria-expanded', String(trigger === this.trigger()));
    const list = panel.querySelector('.voices');
    if (list) list.scrollTop = scroll;
    this.placePanel();
  }

  private placePanel(): void {
    if (!this.panel) return;
    const anchor = this.trigger().getBoundingClientRect();
    const bar = this.el.getBoundingClientRect();
    const size = this.panel.getBoundingClientRect();
    const left = Math.min(window.innerWidth - size.width - EDGE, Math.max(EDGE, anchor.left + anchor.width / 2 - size.width / 2));
    const above = bar.top - size.height - 10;
    const top = above >= EDGE ? above : Math.min(window.innerHeight - size.height - EDGE, bar.bottom + 10);
    this.panel.style.left = `${Math.round(left)}px`;
    this.panel.style.top = `${Math.round(top)}px`;
  }

  private buildSpeed(panel: HTMLElement): void {
    const rate = this.settings.rate;
    const words = Math.round(rate * 170);
    const slider = h('input', { type: 'range', min: MIN_RATE, max: MAX_RATE, step: 0.05, value: rate, 'aria-label': 'Speed' });
    const fill = () => slider.style.setProperty('--fill', `${((Number(slider.value) - MIN_RATE) / (MAX_RATE - MIN_RATE)) * 100}%`);
    fill();
    slider.addEventListener('input', () => {
      fill();
      this.actions.setRate(clampRate(Number(slider.value)));
    });
    panel.append(
      h('h2', {}, 'Speed'),
      h('div', { class: 'readout' }, formatRate(rate), h('small', {}, `about ${words} words a minute`)),
      slider,
      h(
        'div',
        { class: 'presets' },
        ...PRESETS.map((preset) =>
          h('button', { type: 'button', 'aria-pressed': String(Math.abs(preset - rate) < 0.001), onClick: () => this.actions.setRate(preset) }, formatRate(preset)),
        ),
      ),
    );
    // Rebuilding the panel on every change would break a drag on the slider,
    // so the readout is updated in place while it has focus.
    slider.addEventListener('pointerdown', () => (this.sliding = true));
    slider.addEventListener('pointerup', () => (this.sliding = false));
  }

  private sliding = false;

  private buildVoices(panel: HTMLElement): void {
    const list = h('div', { class: 'voices' });
    for (const accent of ['American', 'British'] as const) {
      list.append(h('h3', {}, accent));
      for (const voice of VOICES.filter((v) => v.accent === accent)) {
        list.append(
          h(
            'div',
            { class: 'voice-row', 'aria-current': String(voice.id === this.settings.voice) },
            h('button', { class: 'pick', type: 'button', html: `<i class="face" style="--hue:${hue(voice.id)}">${voice.name[0]}</i><b>${voice.name}</b><span>${voice.gender.toLowerCase()}</span>${icons.check}`, onClick: () => this.actions.setVoice(voice.id) }),
            h('button', { class: 'try', type: 'button', 'aria-label': `Hear ${voice.name}`, 'data-tip': `Hear ${voice.name}`, html: icons.sample, onClick: () => this.actions.previewVoice(voice.id) }),
          ),
        );
      }
    }
    panel.append(h('h2', {}, 'Voice'), list);
  }

  private buildMore(panel: HTMLElement): void {
    const s = this.settings;
    const toggle = (label: string, key: 'highlightSentence' | 'highlightWord' | 'autoScroll' | 'paragraphButton') =>
      h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(s[key]), onClick: () => this.actions.change({ [key]: !s[key] }) }, label, h('i'));
    panel.append(
      h('h2', {}, 'While reading'),
      toggle('Highlight the sentence', 'highlightSentence'),
      toggle('Highlight each word', 'highlightWord'),
      toggle('Scroll along with the voice', 'autoScroll'),
      toggle('Play button beside paragraphs', 'paragraphButton'),
      h(
        'div',
        { class: 'swatches' },
        'Highlighter',
        h(
          'div',
          {},
          ...SWATCHES.map(([id, color, name]) =>
            h('button', { type: 'button', style: `--swatch:${color}`, 'aria-label': name, 'data-tip': name, 'aria-pressed': String(s.highlightColor === id), onClick: () => this.actions.change({ highlightColor: id }) }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'links' },
        h('button', { type: 'button', onClick: () => this.actions.openSettings() }, 'All settings and shortcuts'),
        h('button', { type: 'button', onClick: () => this.actions.hideOnThisSite() }, `Hide buttons on ${location.hostname}`),
      ),
    );
  }

  /** Updates the open speed panel without rebuilding it. */
  private refreshSpeed(): void {
    if (this.openPanel !== 'speed' || !this.panel) return;
    const rate = this.settings.rate;
    const readout = this.panel.querySelector('.readout');
    if (readout) readout.replaceChildren(formatRate(rate), h('small', {}, `about ${Math.round(rate * 170)} words a minute`));
    const slider = this.panel.querySelector('input');
    if (slider && !this.sliding) {
      slider.value = String(rate);
      slider.style.setProperty('--fill', `${((rate - MIN_RATE) / (MAX_RATE - MIN_RATE)) * 100}%`);
    }
    this.panel.querySelectorAll('.presets button').forEach((button, i) => button.setAttribute('aria-pressed', String(Math.abs(PRESETS[i] - rate) < 0.001)));
  }
}

/** A stable colour for a voice, so each has its own face in the list. */
function hue(id: string): number {
  let sum = 0;
  for (const ch of id) sum = (sum * 31 + ch.charCodeAt(0)) % 360;
  return sum;
}
