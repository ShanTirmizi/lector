// Small labels that appear above a control when the pointer rests on it.
// Any element with a `data-tip` attribute gets one; `data-keys` adds a shortcut.

import { h } from './dom';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** Writes a shortcut the way this platform shows it: "⌥R" on a Mac, "Alt+R" elsewhere. */
export function keys(...parts: string[]): string {
  return parts.map((part) => (part === 'Alt' ? (isMac ? '⌥' : 'Alt') : part === 'Shift' ? (isMac ? '⇧' : 'Shift') : part)).join(isMac ? '' : '+');
}

export class Tips {
  private bubble = h('div', { class: 'tip', role: 'tooltip', hidden: true });
  private timer = 0;
  private target: Element | null = null;

  constructor(root: ShadowRoot) {
    root.append(this.bubble);
    root.addEventListener('pointerover', (event) => {
      const target = (event.target as Element).closest?.('[data-tip]');
      if (target === this.target) return;
      this.hide();
      if (!target) return;
      this.target = target;
      this.timer = window.setTimeout(() => this.show(target), 420);
    });
    root.addEventListener('pointerout', (event) => {
      const next = (event as PointerEvent).relatedTarget as Node | null;
      if (this.target && (!next || !this.target.contains(next))) this.hide();
    });
    root.addEventListener('pointerdown', () => this.hide(), true);
  }

  private show(target: Element): void {
    if (!target.isConnected) return;
    const text = target.getAttribute('data-tip') ?? '';
    const shortcut = target.getAttribute('data-keys');
    this.bubble.replaceChildren(text, shortcut ? h('kbd', {}, shortcut) : '');
    this.bubble.hidden = false;
    place(this.bubble, target.getBoundingClientRect());
  }

  hide(): void {
    clearTimeout(this.timer);
    this.target = null;
    this.bubble.hidden = true;
  }
}

/** Centres a floating element above a box, or below it when there is no room, kept inside the window. */
export function place(el: HTMLElement, anchor: { left: number; top: number; bottom: number; width: number }, gap = 9): void {
  const size = el.getBoundingClientRect();
  const left = Math.min(window.innerWidth - size.width - 8, Math.max(8, anchor.left + anchor.width / 2 - size.width / 2));
  const above = anchor.top - size.height - gap;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(above >= 6 ? above : anchor.bottom + gap)}px`;
}
