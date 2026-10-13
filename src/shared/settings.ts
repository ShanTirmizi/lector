import { DEFAULT_VOICE } from './voices';

export type HighlightColor = 'marigold' | 'mint' | 'sky' | 'rose';

export interface Settings {
  voice: string;
  rate: number;
  highlightSentence: boolean;
  highlightWord: boolean;
  highlightColor: HighlightColor;
  autoScroll: boolean;
  paragraphButton: boolean;
  selectionButton: boolean;
  launcher: boolean;
  skipCitations: boolean;
  skipUrls: boolean;
  skipBrackets: boolean;
  skipParentheses: boolean;
  skipCaptions: boolean;
  skipCode: boolean;
  /** Hostnames where the in-page buttons stay hidden. */
  disabledSites: string[];
  /** Where the player was last dropped, as fractions of the viewport. */
  playerPosition: { x: number; y: number } | null;
}

export const DEFAULTS: Settings = {
  voice: DEFAULT_VOICE,
  rate: 1,
  highlightSentence: true,
  highlightWord: true,
  highlightColor: 'marigold',
  autoScroll: true,
  paragraphButton: true,
  selectionButton: true,
  launcher: true,
  skipCitations: true,
  skipUrls: true,
  skipBrackets: false,
  skipParentheses: false,
  skipCaptions: true,
  skipCode: true,
  disabledSites: [],
  playerPosition: null,
};

export const MIN_RATE = 0.5;
export const MAX_RATE = 4;

export function clampRate(rate: number): number {
  return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) * 20) / 20;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function onSettingsChanged(listener: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) listener({ ...DEFAULTS, ...(changes.settings.newValue as Partial<Settings>) });
  });
}
