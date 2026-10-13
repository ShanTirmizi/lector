// The small controls Lector places on the page itself: the launcher on the
// edge of the window, the play button beside a paragraph, and the "Listen"
// button next to a text selection.

import { formatDuration, h } from './dom';
import { icons } from './icons';

export class Launcher {
  private el: HTMLButtonElement;
  private label = h('span');
  private time = h('small');

  constructor(root: ShadowRoot, onClick: () => void) {
    this.el = h('button', { class: 'launcher', type: 'button', hidden: true, title: 'Read this page aloud (Alt+R)', onClick }, h('span', { class: 'dot', html: icons.play }), this.label, this.time);
    this.el.style.top = '42%';
    root.append(this.el);
  }

  /** @param seconds  listening time to show, or 0 when it is not known yet */
  show(seconds: number): void {
    this.label.textContent = 'Listen';
    this.time.textContent = seconds > 0 ? formatDuration(seconds) : '';
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }
}

/** The play button that appears beside the paragraph under the pointer. */
export class ParagraphButton {
  private el: HTMLButtonElement;
  private target = -1;
  private hideTimer = 0;

  constructor(root: ShadowRoot, onClick: (blockIndex: number) => void) {
    this.el = h('button', { class: 'spot', type: 'button', 'aria-label': 'Read from this paragraph', title: 'Read from here', html: icons.play, onClick: () => this.target >= 0 && onClick(this.target) });
    this.el.addEventListener('pointerenter', () => clearTimeout(this.hideTimer));
    this.el.addEventListener('pointerleave', () => this.hideSoon());
    root.append(this.el);
  }

  /** Shows the button beside a block. `firstLine` is the box of the block's first line of text. */
  showAt(blockIndex: number, firstLine: DOMRect, blockLeft: number): void {
    clearTimeout(this.hideTimer);
    this.target = blockIndex;
    const size = 28;
    // In the margin when there is one, otherwise tucked just above the first line.
    const inMargin = blockLeft - size - 8 >= 4;
    const left = inMargin ? blockLeft - size - 8 : Math.max(4, blockLeft);
    const top = inMargin ? firstLine.top + firstLine.height / 2 - size / 2 : firstLine.top - size - 2;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(Math.max(4, top))}px`;
    this.el.classList.add('on');
  }

  hideSoon(delay = 320): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), delay);
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.el.classList.remove('on');
    this.target = -1;
  }

  get shownFor(): number {
    return this.el.classList.contains('on') ? this.target : -1;
  }
}

/** The "Listen" button shown next to a text selection. */
export class SelectionButton {
  private el: HTMLButtonElement;

  constructor(root: ShadowRoot, onClick: () => void) {
    this.el = h('button', { class: 'listen', type: 'button', hidden: true, html: `${icons.play}<span>Listen</span>` });
    // Keep the selection alive: a normal click would clear it before we read it.
    this.el.addEventListener('pointerdown', (event) => event.preventDefault());
    this.el.addEventListener('click', () => {
      this.hide();
      onClick();
    });
    root.append(this.el);
  }

  /** Shows the button just below and to the right of a point, kept inside the window. */
  showAt(x: number, y: number): void {
    this.el.hidden = false;
    const width = this.el.offsetWidth || 92;
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, x + 6));
    const top = y + 44 < window.innerHeight ? y + 10 : y - 44;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  hide(): void {
    this.el.hidden = true;
  }
}

export class Toast {
  private el: HTMLElement | null = null;
  private timer = 0;

  constructor(private root: ShadowRoot) {}

  show(message: string): void {
    this.el?.remove();
    clearTimeout(this.timer);
    this.el = h('div', { class: 'toast', role: 'status' }, message);
    this.root.append(this.el);
    this.timer = window.setTimeout(() => this.el?.remove(), 4200);
  }
}
