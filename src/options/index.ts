// The settings page. Every control writes straight to storage; open pages pick the change up from there.

import { EngineClient } from '../content/engine-client';
import { SAMPLE_PORT } from '../shared/protocol';
import { clampRate, loadSettings, onSettingsChanged, saveSettings, type HighlightColor, type Settings } from '../shared/settings';
import { VOICES } from '../shared/voices';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const COLORS: Array<[HighlightColor, string, string]> = [
  ['marigold', '#ffd652', 'Marigold'],
  ['mint', '#5ee0aa', 'Mint'],
  ['sky', '#78c0ff', 'Sky'],
  ['rose', '#ff9eb8', 'Rose'],
];

let settings: Settings;
// A samples-only connection: hearing a voice here must not interrupt a tab that is reading.
const engine = new EngineClient(
  () => undefined,
  () => undefined,
  SAMPLE_PORT,
);

function render(): void {
  $<HTMLSelectElement>('#voice').value = settings.voice;
  $<HTMLInputElement>('#rate').value = String(settings.rate);
  $('#rate-value').textContent = `${Number(settings.rate.toFixed(2))}×`;
  for (const box of document.querySelectorAll<HTMLInputElement>('input[data-key]')) {
    box.checked = Boolean(settings[box.dataset.key as keyof Settings]);
  }
  for (const swatch of document.querySelectorAll<HTMLButtonElement>('#colors button')) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === settings.highlightColor));
  }
  $('#sites').hidden = settings.disabledSites.length === 0;
  $('#site-list').replaceChildren(
    ...settings.disabledSites.map((site) => {
      const item = document.createElement('li');
      const remove = document.createElement('button');
      remove.className = 'quiet';
      remove.textContent = 'Show again';
      remove.addEventListener('click', () => update({ disabledSites: settings.disabledSites.filter((s) => s !== site) }));
      item.append(site, remove);
      return item;
    }),
  );
}

function update(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  render();
  void saveSettings(patch);
}

async function describeModel(): Promise<void> {
  const status = $('#model-status');
  try {
    const cache = await caches.open('transformers-cache');
    const files = (await cache.keys()).filter((request) => request.url.endsWith('.onnx'));
    if (files.length === 0) {
      status.textContent = 'Not downloaded yet. Lector fetches the voice model the first time you press play, then keeps it on this computer.';
      return;
    }
    let bytes = 0;
    for (const file of files) bytes += Number((await cache.match(file))?.headers.get('content-length') ?? 0);
    status.textContent = `Downloaded and stored on this computer${bytes ? ` (${Math.round(bytes / 1e6)} MB)` : ''}. It works without a connection.`;
  } catch {
    status.textContent = 'The voice model is stored in this browser profile.';
  }
}

async function main(): Promise<void> {
  settings = await loadSettings();

  const voice = $<HTMLSelectElement>('#voice');
  for (const accent of ['American', 'British'] as const) {
    const group = document.createElement('optgroup');
    group.label = accent;
    for (const v of VOICES.filter((x) => x.accent === accent)) group.append(new Option(`${v.name}, ${v.gender.toLowerCase()}`, v.id));
    voice.append(group);
  }
  voice.addEventListener('change', () => update({ voice: voice.value }));
  $('#preview').addEventListener('click', () => void engine.send({ type: 'preview', voice: settings.voice }));

  const rate = $<HTMLInputElement>('#rate');
  rate.addEventListener('input', () => update({ rate: clampRate(Number(rate.value)) }));

  for (const box of document.querySelectorAll<HTMLInputElement>('input[data-key]')) {
    box.addEventListener('change', () => update({ [box.dataset.key as string]: box.checked }));
  }

  $('#colors').append(
    ...COLORS.map(([id, color, name]) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.dataset.color = id;
      swatch.title = name;
      swatch.setAttribute('aria-label', name);
      swatch.style.setProperty('--swatch', color);
      swatch.addEventListener('click', () => update({ highlightColor: id }));
      return swatch;
    }),
  );

  $('#shortcuts').addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  $('#clear-model').addEventListener('click', async () => {
    await caches.delete('transformers-cache');
    await describeModel();
  });

  onSettingsChanged((next) => {
    settings = next;
    render();
  });
  render();
  void describeModel();
}

void main();
