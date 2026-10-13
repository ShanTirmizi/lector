// Step 1: read the current selection aloud.

import { EngineClient } from './engine-client';
import { loadSettings } from '../shared/settings';
import type { ToContent } from '../shared/protocol';

const engine = new EngineClient(
  (message) => console.debug('[lector] ' + JSON.stringify(message).slice(0, 300)),
  () => console.debug('[lector] engine connection closed'),
);

async function readSelection(): Promise<void> {
  const text = window.getSelection()?.toString().replace(/\s+/g, ' ').trim();
  if (!text) return;
  const settings = await loadSettings();
  const sentences = Array.from(new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text), (s) => s.segment.trim()).filter(Boolean);
  await engine.send({
    type: 'load',
    chunks: sentences.map((sentence) => ({ text: sentence })),
    index: 0,
    voice: settings.voice,
    rate: settings.rate,
    autoplay: true,
  });
}

chrome.runtime.onMessage.addListener((message: ToContent) => {
  if (message.type === 'read-selection') void readSelection();
  if (message.type === 'stop') engine.sendIfConnected({ type: 'stop' });
});
