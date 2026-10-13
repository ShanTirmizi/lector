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
  chrome.runtime.onMessage.addListener((message: ToContent) => {
    if (message.type === 'toggle') void run();
  });
}

const googleDoc = location.hostname === 'docs.google.com' ? location.pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([^/]+)/) : null;

if (document.contentType === 'application/pdf') {
  void handOff(async () => void (await send({ type: 'open-pdf', url: location.href })));
} else if (googleDoc) {
  void handOff(async () => {
    // The document's own export, fetched as the signed-in reader. Nothing leaves the browser.
    const response = await fetch(`/document/d/${googleDoc[1]}/export?format=html`, { credentials: 'include' });
    if (!response.ok) throw new Error('Lector could not open this document. You may not have permission to download it.');
    const title = document.title.replace(/ - Google Docs$/, '');
    // Only the text is needed. Dropping pictures and styling here keeps the hand-over small.
    const exported = new DOMParser().parseFromString(await response.text(), 'text/html');
    exported.querySelectorAll('img, style, script, link, meta').forEach((node) => node.remove());
    await send({ type: 'open-document', title, html: exported.body.innerHTML, source: location.href });
  });
} else {
  void boot();
}
