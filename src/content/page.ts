// What there is to read on this page: the whole article, or just a selection.

import type { Settings } from '../shared/settings';
import { extractBlocks, findMainContent, type Block } from './blocks';
import { segment, type Unit } from './segment';

export interface Reading {
  blocks: Block[];
  units: Unit[];
}

function language(): string {
  return (document.documentElement.lang || navigator.language || 'en').split(/[-_]/)[0];
}

/** The main text of the page. */
export function readPage(settings: Settings): Reading {
  const blocks = extractBlocks(findMainContent(), settings);
  return { blocks, units: segment(blocks, settings, language()) };
}

/** First character of the block at or after the start of `range`, and the first one past its end. */
function clipToRange(block: Block, range: Range): [number, number] {
  const position = (i: number, extra: number) => {
    const node = block.nodes[block.nodeIndex[i]];
    try {
      return range.comparePoint(node, Math.min(block.nodeOffset[i] + extra, node.data.length));
    } catch {
      return 1;
    }
  };
  const length = block.text.length;
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (position(mid, 0) < 0) low = mid + 1;
    else high = mid;
  }
  const from = low;
  high = length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (position(mid, 1) <= 0) low = mid + 1;
    else high = mid;
  }
  return [from, low];
}

/** The selected text, mapped onto the page so it can be highlighted as it is read. */
export function readSelection(settings: Settings): Reading | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  let root: Node | null = range.commonAncestorContainer;
  if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
  if (!root) return null;
  // Start from a block-level ancestor so a selection inside a link or emphasis still yields its paragraph.
  let container = root as Element;
  while (container.parentElement && getComputedStyle(container).display.startsWith('inline')) container = container.parentElement;

  // A selection is an explicit request: read it even if it is a caption or a code sample.
  const all = extractBlocks(container, { ...settings, skipCaptions: false, skipCode: false });
  const blocks: Block[] = [];
  const clips: Array<[number, number]> = [];
  for (const block of all) {
    const clip = clipToRange(block, range);
    if (clip[1] > clip[0]) {
      blocks.push(block);
      clips.push(clip);
    }
  }
  if (blocks.length === 0) return null;
  const units = segment(blocks, settings, language(), clips);
  return units.length > 0 ? { blocks, units } : null;
}

/** The block of a reading that contains `target`, or the nearest one below a point. */
export function blockAt(reading: Reading, target: Node | null, clientY?: number): number {
  for (let node = target; node; node = node.parentNode) {
    const candidates: number[] = [];
    reading.blocks.forEach((block, i) => {
      if (block.el === node) candidates.push(i);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      if (clientY === undefined) return candidates[0];
      // Several runs of text share this element: take the one under the pointer.
      for (const i of candidates) {
        const rect = blockRect(reading.blocks[i]);
        if (rect && clientY <= rect.bottom) return i;
      }
      return candidates.at(-1)!;
    }
  }
  return -1;
}

export function blockRect(block: Block): DOMRect | null {
  const first = block.nodes[0];
  const last = block.nodes.at(-1);
  if (!first?.isConnected || !last?.isConnected) return null;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.data.length);
  const rect = range.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}
