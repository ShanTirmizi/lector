// Finds the readable text of a page and keeps an exact map from every
// character back to the DOM, so that sentences and words can be highlighted
// without changing the page.

import type { Settings } from '../shared/settings';

export const HOST_TAG = 'lector-ui';

/** A paragraph-like run of text: a paragraph, heading, list item or table cell. */
export interface Block {
  /** The element that holds the text. Several blocks can share one element. */
  el: Element;
  /** The text with whitespace collapsed. */
  text: string;
  nodes: Text[];
  /** For each character of `text`, the index of its text node in `nodes`… */
  nodeIndex: Int32Array;
  /** …and its offset inside that node. */
  nodeOffset: Int32Array;
  heading: boolean;
}

export type ExtractOptions = Pick<Settings, 'skipCitations' | 'skipCaptions' | 'skipCode'>;

const SKIPPED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA',
  'INPUT', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED', 'MENU', 'DIALOG', 'MATH', 'HEAD',
  HOST_TAG.toUpperCase(),
]);
const SKIPPED_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'toolbar', 'tablist',
  'dialog', 'alert', 'status', 'button', 'img',
]);
const INLINE_TAGS = new Set([
  'A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'CODE', 'SMALL', 'SUB', 'SUP', 'MARK', 'ABBR', 'CITE', 'Q',
  'TIME', 'KBD', 'VAR', 'DEL', 'INS', 'FONT', 'BDI', 'BDO', 'WBR', 'DFN', 'SAMP', 'DATA', 'RUBY', 'LABEL', 'TT', 'BIG',
]);
const BLOCK_SELECTOR = 'p,div,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,table,tr,td,th,section,article,pre,figure,figcaption,header,main,hr,details,summary';
// Class and id fragments that mark page furniture rather than content.
const FURNITURE = /(^|[-_ ])(comments?|share|sharing|social|related|recirc\w*|promo\w*|advert\w*|ads?|sponsor\w*|newsletter|subscribe|paywall|cookie|consent|breadcrumbs?|sidebar|toolbar|menu|pagination|pager|popup|modal|outbrain|taboola|toc|navbox|mw-editsection|mw-jump-link|noprint|hatnote|ambox|baseline-indicator|mbox|metadata|reflist|references|footnotes|infobox|catlinks|visually-hidden|sr-only|screen-reader-text)([-_ ]|$)/i;
const CAPTION = /(^|[-_ ])(caption|thumbcaption|gallerytext|wp-caption-text|credit)([-_ ]|$)/i;
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function isCitationMarker(el: Element): boolean {
  if (el.tagName !== 'SUP' && !(el.tagName === 'A' && el.parentElement?.tagName === 'SUP')) return false;
  if (el.classList.contains('reference') || el.querySelector('a[href^="#"]') || el.matches('a[href^="#"]')) return true;
  return /^\s*\[?\d{1,3}\]?\s*$/.test(el.textContent ?? '');
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  if (typeof el.checkVisibility === 'function') return !el.checkVisibility({ visibilityProperty: true });
  const style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden';
}

class Extractor {
  private rootTextLength: number;

  constructor(
    private root: Element,
    private options: ExtractOptions,
  ) {
    this.rootTextLength = (root.textContent ?? '').length;
  }

  private skipped(el: Element): boolean {
    if (SKIPPED_TAGS.has(el.tagName.toUpperCase())) return true;
    const role = el.getAttribute('role');
    if (role && SKIPPED_ROLES.has(role)) return true;
    if (this.options.skipCaptions && (el.tagName === 'FIGCAPTION' || el.tagName === 'CAPTION')) return true;
    if (this.options.skipCode && el.tagName === 'PRE') return true;
    if (this.options.skipCitations && isCitationMarker(el)) return true;
    if (el !== this.root) {
      const label = `${el.className && typeof el.className === 'string' ? el.className : ''} ${el.id}`;
      // A large element is never furniture, whatever it is called.
      if (label.length > 1 && FURNITURE.test(label) && (el.textContent ?? '').length < this.rootTextLength * 0.4) return true;
      if (this.options.skipCaptions && label.length > 1 && CAPTION.test(label) && (el.textContent ?? '').length < 600) return true;
    }
    return isHidden(el);
  }

  private isBlockLevel(el: Element): boolean {
    if (INLINE_TAGS.has(el.tagName)) return el.querySelector(BLOCK_SELECTOR) !== null;
    const display = getComputedStyle(el).display;
    if (display === 'contents') return true;
    return !display.startsWith('inline') || el.querySelector(BLOCK_SELECTOR) !== null;
  }

  collect(el: Element, out: Block[]): void {
    let run: Node[] = [];
    let breaks = 0;
    const flush = () => {
      if (run.length > 0) {
        const block = this.makeBlock(el, run);
        if (block) out.push(block);
      }
      run = [];
      breaks = 0;
    };
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (/\S/.test((child as Text).data)) breaks = 0;
        run.push(child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element;
        if (element.tagName === 'BR') {
          // Two line breaks in a row separate paragraphs.
          if (++breaks >= 2) flush();
          else run.push(element);
          continue;
        }
        if (this.skipped(element)) continue;
        if (this.isBlockLevel(element)) {
          flush();
          this.collect(element, out);
        } else {
          breaks = 0;
          run.push(element);
        }
      }
    }
    flush();
  }

  private makeBlock(parent: Element, run: Node[]): Block | null {
    const nodes: Text[] = [];
    const index: number[] = [];
    const offset: number[] = [];
    let text = '';
    let pendingSpace = false;

    const addText = (node: Text) => {
      const data = node.data;
      let nodeAt = -1;
      for (let i = 0; i < data.length; i++) {
        const code = data.charCodeAt(i);
        // Zero-width characters and soft hyphens are not text.
        if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0xad) continue;
        const space = code === 32 || code === 10 || code === 9 || code === 13 || code === 0xa0 || code === 12;
        if (space) {
          pendingSpace = text.length > 0;
          continue;
        }
        if (nodeAt < 0) nodeAt = nodes.push(node) - 1;
        if (pendingSpace) {
          text += ' ';
          index.push(nodeAt);
          offset.push(i);
          pendingSpace = false;
        }
        text += data[i];
        index.push(nodeAt);
        offset.push(i);
      }
    };

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) return addText(node as Text);
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (element.tagName === 'BR') {
        pendingSpace = text.length > 0;
        return;
      }
      if (this.skipped(element)) return;
      for (const child of Array.from(element.childNodes)) visit(child);
    };
    for (const node of run) visit(node);

    if (!/[\p{L}\p{N}]/u.test(text)) return null;
    const holder = run.length === 1 && run[0].nodeType === Node.ELEMENT_NODE ? (run[0] as Element) : parent;
    return {
      el: holder,
      text,
      nodes,
      nodeIndex: Int32Array.from(index),
      nodeOffset: Int32Array.from(offset),
      heading: HEADINGS.has(parent.tagName) || parent.closest('h1,h2,h3,h4,h5,h6') !== null,
    };
  }
}

/** The DOM range spanning characters [start, end) of a block, for measuring and scrolling. */
export function rangeOf(block: Block, start: number, end: number): Range | null {
  // A collapsed space has no position of its own, so it never marks an edge.
  while (start < end && block.text[start] === ' ') start++;
  while (end > start && block.text[end - 1] === ' ') end--;
  if (end <= start || start < 0 || end > block.text.length) return null;
  const first = block.nodes[block.nodeIndex[start]];
  const last = block.nodes[block.nodeIndex[end - 1]];
  if (!first?.isConnected || !last?.isConnected) return null;
  const range = document.createRange();
  try {
    range.setStart(first, Math.min(block.nodeOffset[start], first.data.length));
    range.setEnd(last, Math.min(block.nodeOffset[end - 1] + 1, last.data.length));
  } catch {
    return null;
  }
  return range;
}

/**
 * One range per text node for characters [start, end). Unlike a single
 * spanning range this leaves out anything in between that is not read, such
 * as a citation marker in the middle of a sentence.
 */
export function rangesOf(block: Block, start: number, end: number): Range[] {
  while (start < end && block.text[start] === ' ') start++;
  while (end > start && block.text[end - 1] === ' ') end--;
  const ranges: Range[] = [];
  let i = start;
  while (i < end) {
    const nodeAt = block.nodeIndex[i];
    let j = i;
    while (j + 1 < end && block.nodeIndex[j + 1] === nodeAt) j++;
    const node = block.nodes[nodeAt];
    // Spaces at the edge of a node belong to the neighbouring node's position.
    let a = i;
    let b = j;
    while (a < b && block.text[a] === ' ') a++;
    while (b > a && block.text[b] === ' ') b--;
    if (node?.isConnected && block.text[a] !== ' ') {
      const range = document.createRange();
      try {
        range.setStart(node, Math.min(block.nodeOffset[a], node.data.length));
        range.setEnd(node, Math.min(block.nodeOffset[b] + 1, node.data.length));
        ranges.push(range);
      } catch {
        /* the page changed under us; skip this piece */
      }
    }
    i = j + 1;
  }
  return ranges;
}

// ------------------------------------------------------------ main content

/** Site-specific containers, for apps whose reading area cannot be guessed from structure. */
const SITE_ROOTS: Array<{ host: RegExp; selector: string }> = [
  { host: /^mail\.google\.com$/, selector: 'div.a3s.aiL, div.a3s' },
  { host: /(^|\.)wikipedia\.org$/, selector: '#mw-content-text .mw-parser-output' },
];

function visibleTextLength(el: Element): number {
  return (el.textContent ?? '').replace(/\s+/g, ' ').length;
}

/**
 * Picks the element that holds the main text. Paragraphs vote for their parent
 * (and, at half weight, their grandparent); the container with the most
 * paragraph text wins. An enclosing <article> or <main> is preferred when it
 * holds nearly all of that text, because it also holds the headline.
 */
export function findMainContent(doc: Document = document): Element {
  for (const site of SITE_ROOTS) {
    if (!site.host.test(location.hostname)) continue;
    const matches = Array.from(doc.querySelectorAll(site.selector)).filter((el) => !isHidden(el));
    // In a mail thread the last expanded message is the one being read.
    if (matches.length > 0) return matches.at(-1)!;
  }

  const scores = new Map<Element, number>();
  for (const paragraph of Array.from(doc.querySelectorAll('p, blockquote, li'))) {
    if (paragraph.closest('nav, aside, footer, form, [role="navigation"], [role="complementary"]')) continue;
    const length = visibleTextLength(paragraph);
    if (length < 60) continue;
    const linkLength = Array.from(paragraph.querySelectorAll('a')).reduce((sum, a) => sum + visibleTextLength(a), 0);
    if (linkLength > length * 0.6) continue;
    const weight = paragraph.tagName === 'LI' ? length * 0.5 : length;
    const parent = paragraph.parentElement;
    if (!parent) continue;
    scores.set(parent, (scores.get(parent) ?? 0) + weight);
    const grandparent = parent.parentElement;
    if (grandparent) scores.set(grandparent, (scores.get(grandparent) ?? 0) + weight / 2);
  }

  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, score] of scores) {
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  if (!best || bestScore < 200) {
    return doc.querySelector('article, main, [role="main"]') ?? doc.body;
  }

  // Widen to the enclosing article when it is mostly this text.
  const bestLength = visibleTextLength(best);
  let chosen = best;
  for (let el = best.parentElement; el && el !== doc.body; el = el.parentElement) {
    const semantic = el.matches('article, main, [role="main"], [itemprop="articleBody"]');
    if (semantic && bestLength > visibleTextLength(el) * 0.5) chosen = el;
  }
  return chosen;
}

export function extractBlocks(root: Element, options: ExtractOptions): Block[] {
  const blocks: Block[] = [];
  const extractor = new Extractor(root, options);
  extractor.collect(root, blocks);

  // Read the headline first when it sits just outside the content container.
  if (root !== document.body && !blocks.some((b) => b.heading && b.el.closest('h1'))) {
    const headline = Array.from(document.querySelectorAll('h1')).find((h) => !isHidden(h) && !root.contains(h) && !h.closest('nav, aside, footer'));
    if (headline && headline.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const head: Block[] = [];
      extractor.collect(headline, head);
      blocks.unshift(...head);
    }
  }
  return dropLinkLists(blocks);
}

/** Removes runs of blocks that are nothing but links: menus, tag clouds, "read next" lists. */
function dropLinkLists(blocks: Block[]): Block[] {
  return blocks.filter((block) => {
    if (block.heading || block.text.length > 200) return true;
    const el = block.el;
    const links = el.tagName === 'A' ? [el] : Array.from(el.querySelectorAll('a'));
    if (links.length === 0) return true;
    const linkLength = links.reduce((sum, a) => sum + visibleTextLength(a), 0);
    return linkLength < block.text.length * 0.8 || /[.!?]["”’)]?$/.test(block.text);
  });
}
