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
  } catch {
    // The page has no content script (browser pages, the web store, a tab opened before install).
  }
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

chrome.runtime.onMessage.addListener((message: ToBackground, _sender, respond) => {
  if (message.type === 'ensure-engine') {
    ensureEngine().then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, error: String(error?.message ?? error) }),
    );
    return true;
  }
  if (message.type === 'open-options') void chrome.runtime.openOptionsPage();
  return false;
});

chrome.action.onClicked.addListener((tab) => void sendToTab(tab.id, { type: 'toggle' }));

chrome.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (command === 'toggle-reading') await sendToTab(tabId, { type: 'toggle' });
  if (command === 'read-selection') await sendToTab(tabId, { type: 'read-selection' });
  if (command === 'stop-reading') await sendToTab(tabId, { type: 'stop' });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-selection', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'read-from-here', title: 'Read aloud from here', contexts: ['page', 'link', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'read-selection') void sendToTab(tab?.id, { type: 'read-selection' });
  if (info.menuItemId === 'read-from-here') void sendToTab(tab?.id, { type: 'read-from-here' });
});
