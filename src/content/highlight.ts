// Paints the sentence and word being spoken with the CSS Custom Highlight API,
// which colours ranges of text without touching the page's DOM.

import type { HighlightColor } from '../shared/settings';

const SENTENCE = 'lector-sentence';
const WORD = 'lector-word';

// Red, green, blue for each highlighter colour.
const INK: Record<HighlightColor, [number, number, number]> = {
  marigold: [255, 214, 82],
  mint: [94, 224, 170],
  sky: [120, 192, 255],
  rose: [255, 158, 184],
};

/** True when the text at `el` sits on a dark background. */
export function onDarkBackground(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const match = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
    if (!match) continue;
    const [r, g, b, alpha = 1] = match.map(Number);
    if (alpha < 0.5) continue;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches && !document.body?.style.backgroundColor;
}

export class Highlighter {
  private style = document.createElement('style');
  private color: HighlightColor = 'marigold';
  private dark = false;
  private supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

  constructor() {
    this.style.dataset.lector = 'highlight';
    this.render();
  }

  private render(): void {
    const [r, g, b] = INK[this.color];
    const sentence = this.dark ? `rgba(${r}, ${g}, ${b}, 0.26)` : `rgba(${r}, ${g}, ${b}, 0.30)`;
    this.style.textContent = `
      ::highlight(${SENTENCE}) { background-color: ${sentence}; }
      ::highlight(${WORD}) { background-color: rgb(${r}, ${g}, ${b}); color: #17130a; }
    `;
  }

  private attach(): void {
    if (!this.style.isConnected) (document.head ?? document.documentElement).append(this.style);
  }

  setColor(color: HighlightColor): void {
    if (color === this.color) return;
    this.color = color;
    this.render();
  }

  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    this.render();
  }

  setSentence(ranges: Range[]): void {
    this.set(SENTENCE, ranges, 0);
  }

  setWord(ranges: Range[]): void {
    this.set(WORD, ranges, 1);
  }

  private set(name: string, ranges: Range[], priority: number): void {
    if (!this.supported) return;
    if (ranges.length === 0) {
      CSS.highlights.delete(name);
      return;
    }
    this.attach();
    const highlight = new Highlight(...ranges);
    highlight.priority = priority;
    CSS.highlights.set(name, highlight);
  }

  clear(): void {
    if (!this.supported) return;
    CSS.highlights.delete(SENTENCE);
    CSS.highlights.delete(WORD);
  }
}
