// Turns the model's per-phoneme durations into a start time for every word.
//
// The model speaks a phoneme string, not the original text, and the phonemiser
// does not keep a one-to-one link between the two: it merges short words
// ("of the"), expands numbers ("2024" becomes three words) and rewrites
// abbreviations. So words are matched to phonemes in two steps:
//   1. If the text and the phoneme string have the same number of words, pair
//      them up in order.
//   2. Otherwise phonemise each word on its own, and line that sequence up
//      against the real one with an edit-distance alignment.

import type { WordMark } from '../shared/protocol';

const STRESS = new Set(['ˈ', 'ˌ']);
const PUNCTUATION = new Set(Array.from(' ;:,.!?¡¿—…"«»“”()[]{}-–\'‘’'));
// Symbols that are spoken even though they contain no letters or digits.
const SPOKEN_SYMBOLS = /[&+%=@#$€£¥°<>]/;

function isSound(ch: string): boolean {
  return !PUNCTUATION.has(ch) && !STRESS.has(ch);
}

export interface TextToken {
  cs: number;
  ce: number;
  text: string;
}

/** Whitespace-separated pieces of the text that produce sound when read. */
export function spokenTokens(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const token = match[0];
    if (/[\p{L}\p{N}]/u.test(token) || SPOKEN_SYMBOLS.test(token)) {
      tokens.push({ cs: match.index, ce: match.index + token.length, text: token });
    }
  }
  return tokens;
}

/** Start index, in the phoneme characters, of every phoneme word. */
function phonemeWordStarts(chars: string[]): number[] {
  const starts: number[] = [];
  let groupStart = -1;
  let hasSound = false;
  const close = () => {
    if (groupStart >= 0 && hasSound) starts.push(groupStart);
    groupStart = -1;
    hasSound = false;
  };
  chars.forEach((ch, i) => {
    if (ch === ' ') return close();
    if (groupStart < 0) groupStart = i;
    if (isSound(ch)) hasSound = true;
  });
  close();
  return starts;
}

/**
 * For each character of `expected`, the index of the character of `actual` it
 * lines up with, or -1 when it has no partner.
 */
function alignSequences(expected: string[], actual: string[]): Int32Array {
  const n = expected.length;
  const m = actual.length;
  const width = m + 1;
  const cost = new Uint16Array((n + 1) * width);
  for (let j = 0; j <= m; j++) cost[j] = j;
  for (let i = 1; i <= n; i++) {
    cost[i * width] = i;
    for (let j = 1; j <= m; j++) {
      const substitute = cost[(i - 1) * width + j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1);
      const skipExpected = cost[(i - 1) * width + j] + 1;
      const skipActual = cost[i * width + j - 1] + 1;
      cost[i * width + j] = Math.min(substitute, skipExpected, skipActual);
    }
  }
  const partner = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const here = cost[i * width + j];
    if (here === cost[(i - 1) * width + j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1)) {
      partner[i - 1] = j - 1;
      i--;
      j--;
    } else if (here === cost[(i - 1) * width + j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return partner;
}

/**
 * @param text       the text that was spoken
 * @param chars      the phoneme characters the model received, in order
 * @param charStart  start time in seconds of each phoneme character
 * @param phonemizeWord  phonemises a single word, used only when counts differ
 */
export async function alignWords(
  text: string,
  chars: string[],
  charStart: Float64Array,
  phonemizeWord: (word: string) => Promise<string>,
): Promise<WordMark[]> {
  const tokens = spokenTokens(text);
  if (tokens.length === 0 || chars.length === 0) return [];

  const wordStarts = phonemeWordStarts(chars);
  if (wordStarts.length === tokens.length) {
    return tokens.map((token, k) => ({ cs: token.cs, ce: token.ce, t: charStart[wordStarts[k]] }));
  }

  // Counts differ: align sound by sound.
  const expected: string[] = [];
  const owner: number[] = [];
  for (let k = 0; k < tokens.length; k++) {
    for (const ch of await phonemizeWord(tokens[k].text)) {
      if (isSound(ch)) {
        expected.push(ch);
        owner.push(k);
      }
    }
  }
  const actual: string[] = [];
  const actualIndex: number[] = [];
  chars.forEach((ch, i) => {
    if (isSound(ch)) {
      actual.push(ch);
      actualIndex.push(i);
    }
  });

  const partner = alignSequences(expected, actual);
  const times = new Array<number>(tokens.length).fill(NaN);
  for (let e = 0; e < expected.length; e++) {
    if (partner[e] >= 0 && Number.isNaN(times[owner[e]])) times[owner[e]] = charStart[actualIndex[partner[e]]];
  }
  // Words with no partner take the start of the next word that has one.
  for (let k = tokens.length - 2; k >= 0; k--) if (Number.isNaN(times[k])) times[k] = times[k + 1];
  let last = 0;
  return tokens.map((token, k) => {
    const t = Number.isNaN(times[k]) ? last : Math.max(last, times[k]);
    last = t;
    return { cs: token.cs, ce: token.ce, t };
  });
}
