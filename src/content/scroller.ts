// Keeps the sentence being read in view, and steps aside as soon as the
// listener scrolls on their own.

const TARGET = 0.32; // where the sentence is placed, as a fraction of the viewport height
const TOP_LIMIT = 0.1;
const BOTTOM_LIMIT = 0.68;
const SETTLE_MS = 1100;

function scrollParent(el: Element | null): Element | null {
  for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') && node.scrollHeight > node.clientHeight + 4) return node;
  }
  return null;
}

export class Scroller {
  enabled = true;
  /** True after the listener scrolled away; following resumes when they come back or ask. */
  suspended = false;
  private selfScrollUntil = 0;
  private active = false;
  private lastRange: Range | null = null;

  constructor(private onSuspendedChange: (suspended: boolean) => void) {
    // Capture phase, so scrolls inside nested containers are seen too.
    document.addEventListener('scroll', () => this.onScroll(), { capture: true, passive: true });
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.setSuspended(false);
  }

  private setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    this.onSuspendedChange(suspended);
  }

  private onScroll(): void {
    if (!this.active || !this.enabled || performance.now() < this.selfScrollUntil) return;
    if (!this.suspended) return this.setSuspended(true);
    // Scrolled back to the text being read: pick up again.
    if (this.lastRange && this.comfortable(this.lastRange)) this.setSuspended(false);
  }

  private bounds(range: Range): { top: number; bottom: number; viewTop: number; viewHeight: number; parent: Element | null } | null {
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    const ancestor = range.commonAncestorContainer;
    const parent = scrollParent(ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement);
    const view = parent?.getBoundingClientRect();
    const viewTop = Math.max(view?.top ?? 0, 0);
    const viewBottom = Math.min(view?.bottom ?? window.innerHeight, window.innerHeight);
    return { top: rect.top, bottom: rect.bottom, viewTop, viewHeight: viewBottom - viewTop, parent };
  }

  private comfortable(range: Range): boolean {
    const b = this.bounds(range);
    if (!b) return true;
    return b.top >= b.viewTop + b.viewHeight * TOP_LIMIT && b.bottom <= b.viewTop + b.viewHeight * BOTTOM_LIMIT;
  }

  /**
   * Called whenever a new sentence starts. `byListener` marks a jump the
   * listener asked for (next, previous, a paragraph button), which always
   * brings the text back into view.
   */
  follow(range: Range | null, byListener = false, recenter = false): void {
    this.lastRange = range;
    if (!range || !this.enabled) return;
    if (byListener) this.setSuspended(false);
    if (this.suspended) return;
    const b = this.bounds(range);
    if (!b) return;
    const tall = b.bottom - b.top > b.viewHeight * (BOTTOM_LIMIT - TOP_LIMIT);
    if (!recenter && !tall && this.comfortable(range)) return;
    const delta = b.top - (b.viewTop + b.viewHeight * TARGET);
    if (Math.abs(delta) < 4) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches && Math.abs(delta) < window.innerHeight * 3;
    this.selfScrollUntil = performance.now() + (smooth ? SETTLE_MS : 200);
    (b.parent ?? window).scrollBy({ top: delta, behavior: smooth ? 'smooth' : 'instant' });
  }

  /** Jumps back to the text being read and resumes following. */
  resume(): void {
    this.follow(this.lastRange, true, true);
  }
}
