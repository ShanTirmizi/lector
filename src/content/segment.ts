// Cuts blocks into speakable units (roughly sentences) and prepares the text
// that is actually sent to the voice, keeping a map back to the block so that
// skipped pieces (citations, URLs) do not throw the highlighting off.

import type { Settings } from '../shared/settings';
import type { Block } from './blocks';

export interface Unit {
  block: Block;
  /** Index of the block in the reading order. */
  blockIndex: number;
  /** Character range in block.text. */
  start: number;
  end: number;
  /** The text handed to the voice. */
  spoken: string;
  /** For each character of `spoken`, its offset in block.text. */
  map: Int32Array;
  /** True for the last unit of its block. */
  endsBlock: boolean;
}

export type SpeakOptions = Pick<Settings, 'skipCitations' | 'skipUrls' | 'skipBrackets' | 'skipParentheses'>;

// Long enough to keep a sentence's melody, short enough that the voice never takes long to prepare one.
const MAX_UNIT = 240;
const MIN_UNIT = 24;

// A full stop after one of these does not end a sentence.
const ABBREVIATION = /(?:^|[\s(“"'‘])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Gen|Col|Lt|Sgt|Capt|Rev|Hon|Gov|Sen|Rep|vs|etc|e\.g|i\.e|cf|al|No|Nos|Fig|Figs|Vol|Ch|pp?|approx|est|Inc|Ltd|Co|Corp|[A-Z])\.\s*$/;

function sentenceBreaks(text: string, lang: string): number[] {
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  }
  const breaks: number[] = [];
  for (const segment of segmenter.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (end < text.length && ABBREVIATION.test(text.slice(segment.index, end))) continue;
    breaks.push(end);
  }
  if (breaks.at(-1) !== text.length) breaks.push(text.length);
  return breaks;
}

/** Splits [start, end) at clause punctuation until every piece is short enough. */
function splitLong(text: string, start: number, end: number, out: Array<[number, number]>): void {
  if (end - start <= MAX_UNIT) {
    out.push([start, end]);
    return;
  }
  const middle = (start + end) / 2;
  let best = -1;
  let bestScore = Infinity;
  const pattern = /([;:,—–]\s+|\s+[—–-]\s+|\s+)/g;
  pattern.lastIndex = start + MIN_UNIT;
  for (let match = pattern.exec(text); match && match.index < end - MIN_UNIT; match = pattern.exec(text)) {
    const at = match.index + match[0].length;
    const punctuated = /\S/.test(match[0]);
    const score = Math.abs(at - middle) + (punctuated ? 0 : MAX_UNIT / 2);
    if (score < bestScore) {
      bestScore = score;
      best = at;
    }
  }
  if (best < 0) {
    out.push([start, end]);
    return;
  }
  splitLong(text, start, best, out);
  splitLong(text, best, end, out);
}

/** Character ranges to leave unspoken. */
function skippedRanges(text: string, options: SpeakOptions): Array<[number, number]> {
  const patterns: RegExp[] = [];
  if (options.skipCitations) patterns.push(/\[\s*(?:\d{1,3}|[a-z]|citation needed|note \d+)(?:\s*[,–-]\s*\d{1,3})*\s*\]/gi);
  if (options.skipUrls) patterns.push(/\b(?:https?:\/\/|www\.)[^\s<>"”)]+/gi);
  if (options.skipBrackets) patterns.push(/\[[^\]]{0,200}\]/g);
  if (options.skipParentheses) patterns.push(/\([^)]{0,300}\)/g);
  const ranges: Array<[number, number]> = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  return ranges.sort((a, b) => a[0] - b[0]);
}

function buildUnit(block: Block, blockIndex: number, start: number, end: number, skips: Array<[number, number]>): Unit | null {
  let spoken = '';
  const map: number[] = [];
  let skip = 0;
  for (let i = start; i < end; i++) {
    while (skip < skips.length && skips[skip][1] <= i) skip++;
    if (skip < skips.length && i >= skips[skip][0]) continue;
    const ch = block.text[i];
    // Do not leave a double space, or a space before punctuation, where something was removed.
    if (ch === ' ' && (spoken.length === 0 || spoken.endsWith(' '))) continue;
    if (/[,.;:!?)]/.test(ch) && spoken.endsWith(' ') && map.length > 0 && map[map.length - 1] !== i - 1) {
      spoken = spoken.slice(0, -1);
      map.pop();
    }
    spoken += ch;
    map.push(i);
  }
  while (spoken.endsWith(' ')) {
    spoken = spoken.slice(0, -1);
    map.pop();
  }
  if (!/[\p{L}\p{N}]/u.test(spoken)) return null;
  return { block, blockIndex, start, end, spoken, map: Int32Array.from(map), endsBlock: false };
}

/**
 * Units for a list of blocks. `clips` optionally limits each block to part of
 * its text, for reading a selection.
 */
export function segment(blocks: Block[], options: SpeakOptions, lang = '', clips?: Array<[number, number]>): Unit[] {
  const units: Unit[] = [];
  blocks.forEach((block, blockIndex) => {
    const [from, to] = clips?.[blockIndex] ?? [0, block.text.length];
    const skips = skippedRanges(block.text, options);

    const pieces: Array<[number, number]> = [];
    let start = 0;
    for (const end of sentenceBreaks(block.text, lang)) {
      splitLong(block.text, start, end, pieces);
      start = end;
    }
    // Join fragments that are too short to sound right on their own ("Yes.", "1.").
    const merged: Array<[number, number]> = [];
    for (const piece of pieces) {
      const previous = merged.at(-1);
      if (previous && (previous[1] - previous[0] < MIN_UNIT || piece[1] - piece[0] < MIN_UNIT) && piece[1] - previous[0] <= MAX_UNIT) previous[1] = piece[1];
      else merged.push([...piece]);
    }

    const blockUnits: Unit[] = [];
    for (const [a, b] of merged) {
      const s = Math.max(a, from);
      const e = Math.min(b, to);
      if (e <= s) continue;
      const unit = buildUnit(block, blockIndex, s, e, skips);
      if (unit) blockUnits.push(unit);
    }
    if (blockUnits.length > 0) blockUnits[blockUnits.length - 1].endsBlock = true;
    units.push(...blockUnits);
  });
  return units;
}

/** Rough listening time in seconds for some units at normal speed. */
export function estimateSeconds(units: Unit[], from = 0): number {
  let characters = 0;
  for (let i = from; i < units.length; i++) characters += units[i].spoken.length;
  return characters / 15.5;
}
