// Rebuilds paragraphs from the loose pieces of text a PDF page is made of.
// A PDF stores positioned fragments, not paragraphs, so lines and paragraphs
// are inferred from geometry: baselines, gaps, indents and font sizes.

import type { Block } from '../content/blocks';

/** One fragment of text on a page, with its place in PDF units (origin bottom-left). */
export interface Piece {
  node: Text;
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  /** Font height. */
  size: number;
}

interface Line {
  pieces: Piece[];
  x: number;
  right: number;
  y: number;
  size: number;
  text: string;
}

export interface PageLines {
  lines: Line[];
  height: number;
  el: Element;
}

const median = (values: number[]) => (values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[values.length >> 1]);

export function toLines(pieces: Piece[], el: Element, height: number): PageLines {
  const lines: Line[] = [];
  let current: Line | null = null;
  for (const piece of pieces) {
    if (!piece.text.trim()) continue;
    const sameLine: boolean = current !== null && Math.abs(piece.y - current.y) < Math.max(piece.size, current.size) * 0.45 && piece.x >= current.x - piece.size;
    if (current && sameLine) {
      current.pieces.push(piece);
      current.right = Math.max(current.right, piece.x + piece.width);
      current.size = Math.max(current.size, piece.size);
    } else {
      current = { pieces: [piece], x: piece.x, right: piece.x + piece.width, y: piece.y, size: piece.size, text: '' };
      lines.push(current);
    }
  }
  for (const line of lines) line.text = line.pieces.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
  return { lines, height, el };
}

/** Page numbers and running titles: text at the top or bottom edge that repeats from page to page. */
export function findRunningLines(pages: PageLines[]): Set<Line> {
  const edge = (page: PageLines, line: Line) => line.y > page.height * 0.92 || line.y < page.height * 0.07;
  const shape = (line: Line) => line.text.replace(/\d+/g, '#').toLowerCase();
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const key of new Set(page.lines.filter((line) => edge(page, line)).map(shape))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.3));
  const running = new Set<Line>();
  for (const page of pages) {
    for (const line of page.lines) {
      if (!edge(page, line)) continue;
      const pageNumber = /^(page\s*)?[\divxlc]{1,5}(\s*(of|\/)\s*\d+)?$/i.test(line.text) || /^[-–—]\s*\d+\s*[-–—]$/.test(line.text);
      if (pageNumber || (pages.length >= 2 && (counts.get(shape(line)) ?? 0) >= threshold)) running.add(line);
    }
  }
  return running;
}

/** Groups a page's lines into paragraphs and turns each into a readable block. */
export function toBlocks(page: PageLines, skip: Set<Line>, bodySize: number): Block[] {
  const lines = page.lines.filter((line) => !skip.has(line));
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0 && gap < lines[i].size * 3) gaps.push(gap);
  }
  const leading = median(gaps) || bodySize * 1.2;

  const paragraphs: Line[][] = [];
  let paragraph: Line[] = [];
  let columnRight = 0;
  lines.forEach((line, i) => {
    const previous = lines[i - 1];
    let breaks = !previous;
    if (previous) {
      const gap = previous.y - line.y;
      const sizeChanged = Math.abs(line.size - previous.size) > Math.max(line.size, previous.size) * 0.12;
      const movedUp = gap < -line.size * 0.5; // a new column, or a box placed elsewhere
      const wideGap = gap > leading * 1.35;
      // A first-line indent starts a paragraph. Centred text also starts further right, but shares a midpoint.
      const centred = Math.abs((line.x + line.right) / 2 - (previous.x + previous.right) / 2) < line.size * 1.5;
      const indented = !centred && line.x - previous.x > line.size * 0.9 && line.x - paragraph[0].x > -line.size;
      const previousShort = previous.right < columnRight - line.size * 3 && /[.!?:]["”’)]?$/.test(previous.text);
      breaks = sizeChanged || movedUp || wideGap || indented || previousShort;
    }
    if (breaks && paragraph.length > 0) {
      paragraphs.push(paragraph);
      paragraph = [];
      columnRight = 0;
    }
    paragraph.push(line);
    columnRight = Math.max(columnRight, line.right);
  });
  if (paragraph.length > 0) paragraphs.push(paragraph);

  return paragraphs.map((group) => buildBlock(group, page.el, bodySize)).filter((block): block is Block => block !== null);
}

function buildBlock(lines: Line[], el: Element, bodySize: number): Block | null {
  const nodes: Text[] = [];
  const nodeIndex: number[] = [];
  const nodeOffset: number[] = [];
  let text = '';
  let pendingSpace = false;

  lines.forEach((line, lineNumber) => {
    line.pieces.forEach((piece, pieceNumber) => {
      const data = piece.node.data;
      const at = nodes.push(piece.node) - 1;
      const previous = line.pieces[pieceNumber - 1];
      // Fragments on a line are separate words only when there is a visible gap between them.
      if (previous && piece.x - (previous.x + previous.width) > piece.size * 0.12) pendingSpace = text.length > 0;
      if (pieceNumber === 0 && lineNumber > 0) {
        // A word broken across lines with a hyphen is put back together.
        const broken = /[\p{Ll}]-$/u.test(text) && /^\p{Ll}/u.test(data.trimStart());
        if (broken) {
          text = text.slice(0, -1);
          nodeIndex.pop();
          nodeOffset.pop();
          pendingSpace = false;
        } else pendingSpace = text.length > 0;
      }
      for (let i = 0; i < data.length; i++) {
        if (/\s/.test(data[i])) {
          pendingSpace = text.length > 0;
          continue;
        }
        if (pendingSpace) {
          text += ' ';
          nodeIndex.push(at);
          nodeOffset.push(i);
          pendingSpace = false;
        }
        text += data[i];
        nodeIndex.push(at);
        nodeOffset.push(i);
      }
    });
  });

  if (!/[\p{L}\p{N}]{2}/u.test(text)) return null;
  const size = median(lines.map((line) => line.size));
  return {
    el,
    text,
    nodes,
    nodeIndex: Int32Array.from(nodeIndex),
    nodeOffset: Int32Array.from(nodeOffset),
    heading: size > bodySize * 1.15 && text.length < 200,
  };
}

/** Joins a paragraph that runs over a page break back into one block. */
export function joinAcrossPages(blocks: Block[], lastOfPage: Set<Block>): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    const previous = out.at(-1);
    const continues = previous && lastOfPage.has(previous) && !previous.heading && !block.heading && !/[.!?:]["”’)]?$/.test(previous.text) && /^[\p{Ll}(]/u.test(block.text);
    if (!previous || !continues) {
      out.push(block);
      continue;
    }
    const hyphenated = /\p{Ll}-$/u.test(previous.text);
    const head = hyphenated ? previous.text.slice(0, -1) : `${previous.text} `;
    const keep = hyphenated ? previous.text.length - 1 : previous.text.length;
    const shift = previous.nodes.length;
    const nodeIndex = new Int32Array(head.length + block.text.length);
    const nodeOffset = new Int32Array(head.length + block.text.length);
    nodeIndex.set(previous.nodeIndex.subarray(0, keep));
    nodeOffset.set(previous.nodeOffset.subarray(0, keep));
    if (!hyphenated) {
      // The joining space points at the first character of the continuation.
      nodeIndex[keep] = block.nodeIndex[0] + shift;
      nodeOffset[keep] = block.nodeOffset[0];
    }
    for (let i = 0; i < block.text.length; i++) {
      nodeIndex[head.length + i] = block.nodeIndex[i] + shift;
      nodeOffset[head.length + i] = block.nodeOffset[i];
    }
    const merged: Block = { el: block.el, text: head + block.text, nodes: [...previous.nodes, ...block.nodes], nodeIndex, nodeOffset, heading: false };
    if (lastOfPage.has(block)) lastOfPage.add(merged);
    out[out.length - 1] = merged;
  }
  return out;
}
