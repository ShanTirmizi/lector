// Content script entry. Most pages get the full reader. Two kinds of page keep
// their text out of reach (Chrome's PDF viewer, and Google Docs, which draws
// on a canvas), so those get a button that opens the text in Lector's own view.

import type { ToBackground, ToContent } from '../shared/protocol';
import { loadSettings } from '../shared/settings';
import { HOST_TAG } from './blocks';
import { boot } from './boot';
import { h } from './ui/dom';
import { Launcher, Toast } from './ui/page-buttons';
import { styles } from './ui/styles';

const send = (message: ToBackground) => chrome.runtime.sendMessage(message);

/** A launcher and the play shortcut, both wired to `open`. */
async function handOff(open: () => Promise<void>): Promise<void> {
  const settings = await loadSettings();
  const host = document.createElement(HOST_TAG);
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', {}, styles));
  document.documentElement.append(host);
  const toast = new Toast(root);
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await open();
    } catch (error) {
      toast.show((error as Error).message);
    } finally {
      busy = false;
    }
  };
  const launcher = new Launcher(root, () => void run());
  if (settings.launcher && !settings.disabledSites.includes(location.hostname)) launcher.show(0);
  whenRetired.push(() => host.remove());
  if (retired) return host.remove();
  chrome.runtime.onMessage.addListener((message: ToContent) => {
    if (!retired && message.type === 'toggle') void run();
  });
}

// When Lector is updated, Chrome leaves the old content script running in open
// tabs, cut off from the extension. A new copy announces itself; older copies
// hear that and remove themselves.
const RETIRE = 'lector:retire';
document.dispatchEvent(new CustomEvent(RETIRE));
// Start listening in the same breath, before anything asynchronous, so that two
// copies starting together cannot both survive.
let retired = false;
const whenRetired: Array<() => void> = [];
document.addEventListener(
  RETIRE,
  () => {
    retired = true;
    for (const cleanUp of whenRetired) cleanUp();
  },
  { once: true },
);
// Copies too old to know about retiring put their controls back if they are removed,
// so what they left behind is hidden in place instead.
for (const old of Array.from(document.querySelectorAll<HTMLElement>(HOST_TAG))) old.style.setProperty('display', 'none', 'important');

// A document open in the Google Docs editor or viewer. Published documents
// (/document/d/e/…/pub) are ordinary web pages and are read in place.
const googleDoc = location.hostname === 'docs.google.com' ? location.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/(?!e\/)[^/]{20,}/) : null;

// Chrome shows a PDF as a bare page holding a single embedded viewer.
const pdfViewer = document.contentType === 'application/pdf' || (document.body?.childElementCount === 1 && document.body.firstElementChild?.matches('embed[type="application/pdf"]'));

if (pdfViewer) {
  void handOff(async () => void (await send({ type: 'open-pdf', url: location.href })));
} else if (googleDoc) {
  void handOff(async () => {
    // The document's own export, fetched as the signed-in reader. Nothing leaves the browser.
    // The matched path keeps the /u/1/ part, so the right signed-in account is used.
    const response = await fetch(`${googleDoc[0]}/export?format=html`, { credentials: 'include' });
    if (!response.ok) throw new Error('Lector could not open this document. You may not have permission to download it.');
    const title = document.title.replace(/ - Google Docs$/, '');
    // Only the text is needed. Dropping pictures and styling here keeps the hand-over small.
    const exported = new DOMParser().parseFromString(await response.text(), 'text/html');
    exported.querySelectorAll('img, style, script, link, meta').forEach((node) => node.remove());
    const reply = await send({ type: 'open-document', title, html: exported.body.innerHTML, source: location.href });
    if (!reply?.ok) throw new Error('Lector could not open this document. It may be too large.');
  });
} else {
  void boot();
}
