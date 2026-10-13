// Content script: wires the reader to the page, the on-page controls and the
// commands that arrive from the toolbar button, shortcuts and context menu.

import type { ToBackground, ToContent } from '../shared/protocol';
import { clampRate, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';
import { HOST_TAG, rangeOf, type Block } from './blocks';
import { blockAt, blockRect, readPage, readSelection, type Reading } from './page';
import { Reader } from './reader';
import { estimateSeconds } from './segment';
import { Launcher, ParagraphButton, SelectionButton, Toast } from './ui/page-buttons';
import { Player } from './ui/player';
import { styles } from './ui/styles';

const MIN_ARTICLE_CHARACTERS = 900;

async function main(): Promise<void> {
  // Pages that are a bare file (an image, a PDF, XML) have nothing to attach to.
  if (!document.body || !(document.documentElement instanceof HTMLElement)) return;

  let settings = await loadSettings();
  const reader = new Reader(settings);

  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('style');
  sheet.textContent = styles;
  root.append(sheet);
  const mount = () => {
    if (!host.isConnected) document.documentElement.append(host);
  };

  // Changes apply at once and are written a moment later, so dragging a slider
  // does not flood storage (and every other tab) with updates.
  let unsaved: Partial<Settings> = {};
  let saveTimer = 0;
  const change = (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    apply();
    unsaved = { ...unsaved, ...patch };
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveSettings(unsaved);
      unsaved = {};
    }, 250);
  };
  const siteHidden = () => settings.disabledSites.includes(location.hostname);

  // ------------------------------------------------------------ the page text

  let page: Reading | null = null;
  /** The article on this page, extracted once and reused until the page changes. */
  const getPage = (): Reading => {
    const current = reader.currentReading;
    if (current && current === page) return current;
    page ??= readPage(settings);
    return page;
  };

  const toast = new Toast(root);

  function startPage(blockIndex = 0): void {
    const reading = getPage();
    if (reading.units.length === 0) {
      mount();
      return toast.show('Lector found no text to read on this page. Select some text and try again.');
    }
    reader.startAtBlock(reading, blockIndex);
  }

  function startSelection(): boolean {
    const mapped = readSelection(settings);
    const reading = mapped ?? plainSelection();
    if (!reading) return false;
    // The highlight takes over from the selection, which would otherwise sit on top of it.
    if (mapped) window.getSelection()?.removeAllRanges();
    selectionButton.hide();
    reader.start(reading);
    return true;
  }

  /** A selection inside a form field has no text nodes to highlight, but can still be read. */
  function plainSelection(): Reading | null {
    const field = document.activeElement;
    let text = window.getSelection()?.toString() ?? '';
    if (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && field.type === 'text')) {
      text = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const block: Block = { el: document.body, text, nodes: [], nodeIndex: new Int32Array(0), nodeOffset: new Int32Array(0), heading: false };
    const spoken = Array.from(new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text));
    return {
      blocks: [block],
      units: spoken
        .filter((s) => /[\p{L}\p{N}]/u.test(s.segment))
        .map((s, i, all) => ({ block, blockIndex: 0, start: s.index, end: s.index + s.segment.length, spoken: s.segment.trim(), map: new Int32Array(0), endsBlock: i === all.length - 1 })),
    };
  }

  // ----------------------------------------------------------------- controls

  const player = new Player(
    root,
    {
      toggle: () => reader.toggle(),
      previous: () => reader.previous(),
      next: () => reader.next(),
      close: () => reader.stop(),
      setRate: (rate) => change({ rate: clampRate(rate) }),
      setVoice: (voice) => change({ voice }),
      previewVoice: (voice) => reader.previewVoice(voice),
      change,
      backToText: () => reader.resumeScroll(),
      openSettings: () => void chrome.runtime.sendMessage({ type: 'open-options' } satisfies ToBackground),
      hideOnThisSite: () => {
        change({ disabledSites: [...new Set([...settings.disabledSites, location.hostname])] });
        toast.show(`Buttons are hidden on ${location.hostname}. The toolbar button and Alt+R still work.`);
      },
    },
    settings,
  );

  const launcher = new Launcher(root, () => startPage());
  const paragraphButton = new ParagraphButton(root, (blockIndex) => startPage(blockIndex));
  const selectionButton = new SelectionButton(root, () => startSelection());

  function refreshLauncher(): void {
    if (reader.isActive || !settings.launcher || siteHidden()) return launcher.hide();
    const reading = getPage();
    const characters = reading.units.reduce((sum, unit) => sum + unit.spoken.length, 0);
    if (characters < MIN_ARTICLE_CHARACTERS) return launcher.hide();
    mount();
    launcher.show(estimateSeconds(reading.units) / settings.rate);
  }

  reader.subscribe((snapshot) => {
    if (snapshot.active) {
      mount();
      launcher.hide();
      player.show();
      player.update(snapshot);
    } else {
      player.hide();
      refreshLauncher();
    }
  });

  function apply(): void {
    reader.applySettings(settings);
    player.setSettings(settings);
    if (!settings.paragraphButton || siteHidden()) paragraphButton.hide();
    if (!settings.selectionButton || siteHidden()) selectionButton.hide();
    if (!reader.isActive) refreshLauncher();
  }
  onSettingsChanged((next) => {
    // Extraction options changed: the cached article is stale.
    if (next.skipCitations !== settings.skipCitations || next.skipCaptions !== settings.skipCaptions || next.skipCode !== settings.skipCode || next.skipUrls !== settings.skipUrls || next.skipBrackets !== settings.skipBrackets || next.skipParentheses !== settings.skipParentheses) {
      if (!reader.isActive) page = null;
    }
    settings = next;
    apply();
  });

  // ------------------------------------------------- play button by paragraph

  let pointer: { target: EventTarget | null; y: number; own: boolean } | null = null;
  let pointerFrame = 0;
  document.addEventListener(
    'mousemove',
    (event) => {
      if (!settings.paragraphButton || siteHidden()) return;
      // Events from inside our shadow root arrive retargeted to the host element.
      pointer = { target: event.composedPath()[0] ?? event.target, y: event.clientY, own: event.target === host };
      pointerFrame ||= requestAnimationFrame(() => {
        pointerFrame = 0;
        if (!pointer || pointer.own) return;
        // Wait until the page has been looked at once; extraction is too slow to run from a mouse move.
        if (!page) return;
        const reading = getPage();
        const index = blockAt(reading, pointer.target as Node, pointer.y);
        if (index < 0) return paragraphButton.hideSoon();
        mount();
        paragraphButton.showAt(index, ...linePosition(reading.blocks[index]));
      });
    },
    { passive: true },
  );
  document.addEventListener('scroll', () => paragraphButton.hide(), { capture: true, passive: true });
  document.documentElement.addEventListener('mouseleave', () => paragraphButton.hideSoon());

  function linePosition(block: Block): [DOMRect, number] {
    const whole = blockRect(block) ?? block.el.getBoundingClientRect();
    const firstLine = rangeOf(block, 0, Math.min(block.text.length, 2))?.getBoundingClientRect() ?? whole;
    return [firstLine, whole.left];
  }

  // -------------------------------------------------- "Listen" by a selection

  let selectionTimer = 0;
  let lastPointerUp = { x: 0, y: 0, at: 0 };
  document.addEventListener('pointerup', (event) => (lastPointerUp = { x: event.clientX, y: event.clientY, at: performance.now() }), true);
  document.addEventListener('scroll', () => selectionButton.hide(), { capture: true, passive: true });
  document.addEventListener('selectionchange', () => {
    clearTimeout(selectionTimer);
    selectionButton.hide();
    if (!settings.selectionButton || siteHidden()) return;
    selectionTimer = window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      if (selection.toString().trim().split(/\s+/).length < 3) return;
      const anchor = selection.anchorNode?.parentElement;
      if (anchor?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      mount();
      // Next to the pointer when the selection was just made with it, otherwise at the end of the selection.
      if (performance.now() - lastPointerUp.at < 800) return selectionButton.showAt(lastPointerUp.x, lastPointerUp.y);
      const rects = selection.getRangeAt(0).getClientRects();
      const last = rects[rects.length - 1];
      if (last && last.bottom > 0 && last.top < window.innerHeight) selectionButton.showAt(last.right, last.bottom);
    }, 350);
  });

  // ------------------------------------------------------------------ commands

  let contextTarget: { node: Node | null; y: number } = { node: null, y: 0 };
  document.addEventListener('contextmenu', (event) => (contextTarget = { node: event.target as Node, y: event.clientY }), true);

  chrome.runtime.onMessage.addListener((message: ToContent) => {
    switch (message.type) {
      case 'toggle':
        if (reader.isActive) reader.toggle();
        else if (!startSelection()) startPage();
        break;
      case 'read-selection':
        if (!startSelection()) {
          mount();
          toast.show('Select some text first, then try again.');
        }
        break;
      case 'read-from-here': {
        const index = blockAt(getPage(), contextTarget.node, contextTarget.y);
        startPage(Math.max(index, 0));
        break;
      }
      case 'stop':
        reader.stop();
        break;
    }
  });

  // Shortcuts that only make sense while something is being read.
  window.addEventListener(
    'keydown',
    (event) => {
      if (!reader.isActive || !event.altKey || event.ctrlKey || event.metaKey) return;
      const handled = (() => {
        switch (event.code) {
          case 'Period':
            return event.shiftKey ? reader.nextBlock(1) : reader.next(), true;
          case 'Comma':
            return event.shiftKey ? reader.nextBlock(-1) : reader.previous(), true;
          case 'Equal':
            return change({ rate: clampRate(settings.rate + 0.1) }), true;
          case 'Minus':
            return change({ rate: clampRate(settings.rate - 0.1) }), true;
          default:
            return false;
        }
      })();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  // ------------------------------------------------------ keeping up to date

  let refreshTimer = 0;
  let refreshDelay = 1500;
  let lastUrl = location.href;
  const refresh = () => {
    if (location.href !== lastUrl) {
      // A single-page app moved to another article.
      lastUrl = location.href;
      if (reader.isActive) reader.stop();
    }
    if (reader.isActive) return;
    const started = performance.now();
    page = readPage(settings);
    // Busy pages change constantly; look again less often when looking is expensive.
    refreshDelay = Math.min(20000, Math.max(1500, (performance.now() - started) * 50));
    refreshLauncher();
  };
  const scheduleRefresh = (delay: number) => {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => (window.requestIdleCallback ?? window.setTimeout)(refresh), delay);
  };
  new MutationObserver((records) => {
    if (records.every((record) => record.target === host || host.contains(record.target))) return;
    scheduleRefresh(refreshDelay);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('popstate', () => scheduleRefresh(300));
  scheduleRefresh(400);
}

void main();
