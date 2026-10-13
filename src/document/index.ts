// Lector's document view: a clean page of text built from a document whose
// own page cannot be read in place (Google Docs draws its text on a canvas).

import { boot } from '../content/boot';

interface StoredDocument {
  title: string;
  html: string;
  source: string;
}

const KEPT = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
  'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SUB', 'SUP', 'BR', 'HR', 'PRE', 'CODE',
]);
const DROPPED = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'IMG', 'SVG', 'FORM', 'INPUT', 'BUTTON', 'TEMPLATE']);

/**
 * Copies the readable structure of `source` into `target` and nothing else:
 * no scripts, no styles, no attributes except safe link addresses.
 */
function copyClean(source: Node, target: Node): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toUpperCase();
    if (DROPPED.has(tag)) continue;
    if (!KEPT.has(tag)) {
      copyClean(element, target); // keep the text, lose the wrapper
      continue;
    }
    // Google Docs marks the title with a class rather than a heading tag.
    const isTitle = tag === 'P' && element.classList.contains('title');
    const copy = document.createElement(isTitle ? 'h1' : tag.toLowerCase());
    if (tag === 'A') {
      const href = element.getAttribute('href') ?? '';
      if (/^(https?:|mailto:)/i.test(href)) {
        copy.setAttribute('href', href);
        copy.setAttribute('target', '_blank');
        copy.setAttribute('rel', 'noreferrer noopener');
      }
    }
    // Numbers that carry meaning: table spans, and where a numbered list picks up.
    for (const name of ['colspan', 'rowspan', 'start']) {
      const value = element.getAttribute(name);
      if (value && /^\d{1,4}$/.test(value)) copy.setAttribute(name, value);
    }
    copyClean(element, copy);
    target.appendChild(copy);
  }
}

async function main(): Promise<void> {
  const key = new URLSearchParams(location.search).get('key') ?? '';
  const stored = key ? ((await chrome.storage.session.get(key))[key] as StoredDocument | undefined) : undefined;
  const article = document.querySelector('article')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  if (!stored) {
    status.hidden = false;
    status.textContent = 'This reading view has expired. Go back to the document and press Listen again.';
    return;
  }

  document.title = `${stored.title} · Lector`;
  document.querySelector('#title')!.textContent = stored.title;
  const original = document.querySelector<HTMLAnchorElement>('#original')!;
  if (/^https:/i.test(stored.source)) {
    original.href = stored.source;
    original.hidden = false;
  }

  // Parsed in an inert document, so nothing in it can run or load.
  const parsed = new DOMParser().parseFromString(stored.html, 'text/html');
  copyClean(parsed.body, article);
  if (!article.querySelector('h1')) {
    const heading = document.createElement('h1');
    heading.textContent = stored.title;
    article.prepend(heading);
  }
  for (const empty of Array.from(article.querySelectorAll('p'))) {
    if (!empty.textContent?.trim()) empty.remove();
  }

  await boot({ autoplay: true, watch: false });
}

void main();
