// Service worker: keeps the offscreen voice engine alive when a page asks for
// it, and turns the toolbar button, keyboard shortcuts and context menu into
// commands for the active tab.

import type { ToBackground, ToContent } from '../shared/protocol';

const OFFSCREEN_URL = 'offscreen.html';
let creating: Promise<void> | null = null;

async function ensureEngine(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      // BLOBS keeps the document (and the loaded voice model) alive between sentences
      // and while the model downloads; AUDIO_PLAYBACK alone is closed after 30 quiet seconds.
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS],
      justification: 'Runs the on-device voice model and plays the speech it generates.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

async function sendToTab(tabId: number | undefined, message: ToContent): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {
    // No content script answered: a browser page, one of our own pages, or a tab
    // that was already open when Lector was installed or updated.
  }
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const url = tab?.url ?? '';
  if (url.startsWith(chrome.runtime.getURL(''))) {
    // Lector's own PDF and document views listen for broadcasts addressed to their tab.
    await chrome.runtime.sendMessage({ ...message, forTab: tabId }).catch(() => undefined);
  } else if (await inject(tabId)) {
    // Give the freshly added script a moment to start listening, then try once more.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
  } else if (message.type === 'toggle' && /\.pdf($|[?#])/i.test(url)) {
    // Chrome would not let a script into this tab, but the address says it is a PDF.
    await openPdf(url, tab);
  }
}

/** Adds the content script to a tab that does not have a working one. False where Chrome forbids it. */
async function inject(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

/** Tabs that were open before an install or update have no content script, or a dead one. */
async function injectEverywhere(): Promise<void> {
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] })) {
    if (tab.id !== undefined && !tab.discarded) void inject(tab.id);
  }
}

async function openPdf(url: string, from?: chrome.tabs.Tab): Promise<void> {
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('pdf.html')}?file=${encodeURIComponent(url)}`, index: from ? from.index + 1 : undefined, openerTabId: from?.id });
}

async function openDocument(message: Extract<ToBackground, { type: 'open-document' }>, from?: chrome.tabs.Tab): Promise<void> {
  const key = `document:${Date.now()}:${crypto.randomUUID()}`;
  // Kept only for this browser session, and only so the new tab can pick it up.
  // Older hand-overs are cleared first; the last few stay so their tabs survive a reload.
  const old = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('document:')).sort();
  await chrome.storage.session.remove(old.slice(0, Math.max(0, old.length - 3)));
  await chrome.storage.session.set({ [key]: { title: message.title, html: message.html, source: message.source } });
  await chrome.tabs.create({ url: `${chrome.runtime.getURL('document.html')}?key=${encodeURIComponent(key)}`, index: from ? from.index + 1 : undefined, openerTabId: from?.id });
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

chrome.runtime.onMessage.addListener((message: ToBackground, sender, respond) => {
  if (message.type === 'ensure-engine') {
    ensureEngine().then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error?.message ?? error) }),
    );
    return true;
  }
  if (message.type === 'open-options') void chrome.runtime.openOptionsPage();
  if (message.type === 'open-pdf') void openPdf(message.url, sender.tab);
  if (message.type === 'open-document') {
    openDocument(message, sender.tab).then(
      () => respond({ ok: true }),
      () => respond({ ok: false }),
    );
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener((tab) => void sendToTab(tab.id, { type: 'toggle' }));

chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (command === 'toggle-reading') await sendToTab(tabId, { type: 'toggle' });
  if (command === 'read-selection') await sendToTab(tabId, { type: 'read-selection' });
  if (command === 'stop-reading') await sendToTab(tabId, { type: 'stop' });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) void chrome.tabs.create({ url: 'welcome.html' });
  void injectEverywhere();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-selection', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'read-from-here', title: 'Read aloud from here', contexts: ['page', 'link', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'read-selection') void sendToTab(tab?.id, { type: 'read-selection' });
  if (info.menuItemId === 'read-from-here') void sendToTab(tab?.id, { type: 'read-from-here' });
});
