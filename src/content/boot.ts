// Wires the reader to a document: the on-page controls and the commands that
// arrive from the toolbar button, shortcuts and context menu. Used by the
// content script on web pages and by Lector's own PDF and document views.

import type { ToBackground, ToContent } from '../shared/protocol';
import { clampRate, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';
import { HOST_TAG, rangeOf, type Block } from './blocks';
import { blockAt, blockRect, readPage, readSelection, type Reading } from './page';
import { Reader } from './reader';
import { estimateSeconds } from './segment';
import { Launcher, ParagraphButton, SelectionButton, Toast } from './ui/page-buttons';
import { Player } from './ui/player';
import { styles } from './ui/styles';
import { Tips } from './ui/tips';

const MIN_ARTICLE_CHARACTERS = 900;

export interface BootOptions {
  /** Supplies the text to read, instead of looking for an article in the page. */
  readPage?: (settings: Settings) => Reading;
  /** The text sits invisibly on top of a picture of the page (PDFs), so highlights must stay see-through. */
  overlayHighlight?: boolean;
  /** Start reading as soon as everything is ready. */
  autoplay?: boolean;
  /** Re-examine the page when its content changes. Off for documents that never change. */
  watch?: boolean;
}

export interface Booted {
  /** Call when the text supplied by `readPage` has changed. */
  refresh(): void;
  start(): void;
}

export async function boot(options: BootOptions = {}): Promise<Booted | null> {
  // Pages that are a bare file (an image, XML) have nothing to attach to.
  if (!document.body || !(document.documentElement instanceof HTMLElement)) return null;
  const extract = options.readPage ?? readPage;

  let settings = await loadSettings();
  const reader = new Reader(settings, options.overlayHighlight ?? false);

  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('style');
  sheet.textContent = styles;
  root.append(sheet);
  /** Set when a newer copy of this script takes over the page (see content/index.ts). */
  let retired = false;
  const mount = () => {
    if (!retired && !host.isConnected) document.documentElement.append(host);
  };
  document.addEventListener(
    'lector:retire',
    () => {
      retired = true;
      reader.stop();
      host.remove();
    },
    { once: true },
  );

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
      // Fails only if the extension was reloaded under this page; the change still applies here.
      saveSettings(unsaved).catch(() => undefined);
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
    page ??= extract(settings);
    return page;
  };

  const toast = new Toast(root);

  // Where the listener stopped on each page, so a long read can be picked up later.
  const placeKey = () => location.origin + location.pathname + (location.protocol === 'chrome-extension:' ? location.search : '');
  type Places = Record<string, { index: number; total: number; at: number }>;
  let placeTimer = 0;
  let pendingPlace: (() => Promise<void>) | null = null;
  const flushPlace = () => {
    clearTimeout(placeTimer);
    const write = pendingPlace;
    pendingPlace = null;
    // Fails only if the extension was reloaded under this page.
    write?.().catch(() => undefined);
  };
  const rememberPlace = (index: number, total: number, finished: boolean) => {
    pendingPlace = async () => {
      const places = ((await chrome.storage.local.get('places')).places ?? {}) as Places;
      if (finished || index < 3) delete places[placeKey()];
      else places[placeKey()] = { index, total, at: Date.now() };
      const newest = Object.entries(places).sort((a, b) => b[1].at - a[1].at).slice(0, 150);
      await chrome.storage.local.set({ places: Object.fromEntries(newest) });
    };
    clearTimeout(placeTimer);
    placeTimer = window.setTimeout(flushPlace, 1200);
  };
  // Leaving the page or closing the player should not lose the last few seconds of progress.
  window.addEventListener('pagehide', flushPlace);

  /** Reads the page. With no paragraph given, carries on from where the listener last stopped. */
  function startPage(blockIndex?: number): void {
    // A fresh look at the page each time reading starts from the top: sections may have been
    // expanded, or more of the article loaded, since the page was last examined.
    if (blockIndex === undefined && !reader.isActive) page = null;
    const reading = getPage();
    if (reading.units.length === 0) {
      mount();
      return toast.show('Lector found no text to read on this page. Select some text and try again.');
    }
    if (!speaksLanguage(reading)) return;
    if (blockIndex !== undefined) return reader.startAtBlock(reading, blockIndex);
    chrome.storage.local
      .get('places')
      .then((stored) => ((stored.places ?? {}) as Places)[placeKey()])
      .catch(() => undefined)
      .then((place) => {
        // Only when the page still has the same shape as last time.
        const resume = place && place.total === reading.units.length && place.index < reading.units.length - 2;
        reader.start(reading, resume ? place.index : 0);
        if (resume) toast.show('Carrying on from where you stopped.', { label: 'Start from the top', run: () => reader.seek(0) });
      });
  }

  /**
   * The voices only speak English. Text in another script is refused, since it
   * would come out as noise; text in another Latin-script language is read with a warning.
   */
  function speaksLanguage(reading: Reading): boolean {
    const sample = reading.units.slice(0, 40).map((unit) => unit.spoken).join(' ');
    const letters = sample.match(/\p{L}/gu) ?? [];
    const latin = sample.match(/\p{Script=Latin}/gu) ?? [];
    if (letters.length > 20 && latin.length < letters.length * 0.5) {
      mount();
      toast.show('Lector only has English voices for now, and this text is in another language.');
      return false;
    }
    const lang = (reading.blocks[0]?.el.closest('[lang]')?.getAttribute('lang') ?? '').toLowerCase();
    if (lang && !lang.startsWith('en') && reading === page) {
      mount();
      toast.show('This page is not marked as English. Lector only has English voices, so it may sound wrong.');
    }
    return true;
  }

  function startSelection(): boolean {
    const mapped = readSelection(settings);
    const reading = mapped ?? plainSelection();
    if (!reading) return false;
    if (!speaksLanguage(reading)) return true;
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
      peek: (fraction) => reader.peek(fraction),
      seekTo: (fraction) => reader.seekFraction(fraction),
      openSettings: () => void chrome.runtime.sendMessage({ type: 'open-options' } satisfies ToBackground),
      hideOnThisSite: () => {
        change({ disabledSites: [...new Set([...settings.disabledSites, location.hostname])] });
        toast.show(`Buttons are hidden on ${location.hostname}. The toolbar button and Alt+R still work.`);
      },
    },
    settings,
  );

  new Tips(root);
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

  let lastPlace = -1;
  let explainedDownload = false;
  let downloadNote = false;
  reader.subscribe((snapshot) => {
    if (snapshot.download !== null && !explainedDownload) {
      explainedDownload = true;
      downloadNote = true;
      toast.show('Getting the voice. This is a one-time download of up to 330 MB. After it, Lector starts in a moment and works offline.', undefined, 60000);
    } else if (downloadNote && snapshot.download === null) {
      downloadNote = false;
      toast.hide();
    }
    if (snapshot.active) {
      mount();
      launcher.hide();
      player.show();
      player.update(snapshot);
      if (reader.currentReading === page && (snapshot.index !== lastPlace || snapshot.state === 'ended')) {
        lastPlace = snapshot.index;
        rememberPlace(snapshot.index, snapshot.total, snapshot.state === 'ended');
      }
    } else {
      flushPlace();
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
      if (retired || !settings.paragraphButton || siteHidden()) return;
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
    if (retired || !settings.selectionButton || siteHidden()) return;
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

  // Lector's own pages are not content scripts, so the service worker cannot
  // address them by tab; it broadcasts instead and names the tab it means.
  const ownTab = location.protocol === 'chrome-extension:' ? (await chrome.tabs.getCurrent())?.id : undefined;
  chrome.runtime.onMessage.addListener((message: ToContent & { forTab?: number }) => {
    if (retired || (message.forTab !== undefined && message.forTab !== ownTab)) return;
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
        startPage(index >= 0 ? index : undefined);
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
      if (retired || !reader.isActive || !event.altKey || event.ctrlKey || event.metaKey) return;
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
    if (retired) return;
    if (location.href !== lastUrl) {
      // A single-page app moved to another article.
      lastUrl = location.href;
      if (reader.isActive) reader.stop();
    }
    if (reader.isActive) return;
    const started = performance.now();
    page = extract(settings);
    // Busy pages change constantly; look again less often when looking is expensive.
    refreshDelay = Math.min(20000, Math.max(1500, (performance.now() - started) * 50));
    refreshLauncher();
  };
  const scheduleRefresh = (delay: number) => {
    clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => (window.requestIdleCallback ?? window.setTimeout)(refresh), delay);
  };
  if (options.watch ?? true) {
    new MutationObserver((records) => {
      if (records.every((record) => record.target === host || host.contains(record.target))) return;
      scheduleRefresh(refreshDelay);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      // Sections that are opened and closed without adding anything to the page.
      attributes: true,
      attributeFilter: ['hidden', 'open', 'aria-hidden', 'aria-expanded'],
    });
    window.addEventListener('popstate', () => scheduleRefresh(300));
  }
  if (options.autoplay) {
    refresh();
    startPage();
  } else scheduleRefresh(400);

  return { refresh, start: () => startPage() };
}
