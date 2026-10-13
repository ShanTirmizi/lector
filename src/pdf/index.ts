// Lector's PDF view. Draws each page with pdf.js, lays an invisible copy of
// the text over it, and reads that text with the same reader used on web pages.

import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Block } from '../content/blocks';
import { boot, type Booted } from '../content/boot';
import type { Reading } from '../content/page';
import { segment } from '../content/segment';
import { findRunningLines, joinAcrossPages, toBlocks, toLines, type PageLines, type Piece } from './layout';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdfjs/pdf.worker.min.mjs');

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const pagesEl = $('#pages');
const statusEl = $('#status');
const titleEl = $('#title');
const MAX_WIDTH = 920;

let blocks: Block[] = [];
let lector: Booted | null = null;

function setStatus(message: string, problem = false): void {
  statusEl.textContent = message;
  statusEl.hidden = !message;
  statusEl.classList.toggle('problem', problem);
}

async function load(data: ArrayBuffer, name: string): Promise<void> {
  pagesEl.replaceChildren();
  blocks = [];
  document.title = `${name} · Lector`;
  titleEl.textContent = name;
  $('#drop').hidden = true;
  setStatus('Opening…');

  const pdf = await pdfjs.getDocument({
    data,
    cMapUrl: chrome.runtime.getURL('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('pdfjs/standard_fonts/'),
    wasmUrl: chrome.runtime.getURL('pdfjs/wasm/'),
  }).promise;

  const pageLines: PageLines[] = [];
  const sizes: number[] = [];
  // Pages are drawn when they come near the screen; the text of every page is laid out now, because it is what gets read.
  const painter = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        painter.unobserve(entry.target);
        void paint(entry.target as HTMLElement);
      }
    },
    { rootMargin: '1200px 0px' },
  );
  const paintJobs = new Map<HTMLElement, () => Promise<void>>();
  const paint = async (el: HTMLElement) => paintJobs.get(el)?.();

  for (let number = 1; number <= pdf.numPages; number++) {
    setStatus(`Reading page ${number} of ${pdf.numPages}`);
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1.7, (Math.min(window.innerWidth - 32, MAX_WIDTH)) / base.width);
    const viewport = page.getViewport({ scale });

    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.style.setProperty('--scale-factor', String(scale));
    pageEl.style.width = `${Math.floor(viewport.width)}px`;
    pageEl.style.height = `${Math.floor(viewport.height)}px`;
    const canvas = document.createElement('canvas');
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    pageEl.append(canvas, layer);
    pagesEl.append(pageEl);

    const content = await page.getTextContent();
    const textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
    await textLayer.render();

    // Pair each drawn fragment with its geometry. Items without `str` are structure markers.
    const items = content.items.filter((item): item is TextItem => 'str' in item);
    const spans = textLayer.textDivs;
    const pieces: Piece[] = [];
    items.forEach((item, i) => {
      const node = spans[i]?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE || !spans[i].isConnected) return;
      const size = Math.hypot(item.transform[2], item.transform[3]) || item.height;
      // Text printed sideways is a margin stamp or a figure label, not part of the reading.
      if (Math.abs(item.transform[1]) > Math.abs(item.transform[0])) return;
      pieces.push({ node: node as Text, text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, size });
      if (item.str.trim()) for (let k = 0; k < item.str.length; k += 40) sizes.push(size);
    });
    pageLines.push(toLines(pieces, layer, base.height));

    paintJobs.set(pageEl, async () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
    });
    painter.observe(pageEl);
    // Let the first pages appear before the rest are processed.
    if (number % 4 === 0) await new Promise((resolve) => setTimeout(resolve));
  }

  const bodySize = [...sizes].sort((a, b) => a - b)[sizes.length >> 1] ?? 10;
  const running = findRunningLines(pageLines);
  const lastOfPage = new Set<Block>();
  const all: Block[] = [];
  for (const page of pageLines) {
    const pageBlocks = toBlocks(page, running, bodySize);
    if (pageBlocks.length > 0) lastOfPage.add(pageBlocks.at(-1)!);
    all.push(...pageBlocks);
  }
  blocks = joinAcrossPages(all, lastOfPage);

  if (blocks.length === 0) setStatus('This PDF has no text layer. It is probably a scan, which Lector cannot read yet.', true);
  else setStatus('');
  lector?.refresh();
}

async function openFromUrl(url: string): Promise<void> {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Document').replace(/\.pdf$/i, '');
  setStatus('Downloading…');
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(String(response.status));
    await load(await response.arrayBuffer(), name);
  } catch {
    $('#drop').hidden = false;
    setStatus(
      url.startsWith('file:')
        ? 'Chrome does not let extensions open files on your computer unless you allow it. Drop the PDF here instead.'
        : 'Lector could not download this PDF. Drop the file here to read it.',
      true,
    );
  }
}

async function openFile(file: File | undefined): Promise<void> {
  if (!file) return;
  try {
    await load(await file.arrayBuffer(), file.name.replace(/\.pdf$/i, ''));
  } catch {
    $('#drop').hidden = false;
    setStatus('That file could not be opened as a PDF.', true);
  }
}

async function main(): Promise<void> {
  lector = await boot({
    readPage: (settings): Reading => ({ blocks, units: segment(blocks, settings, 'en') }),
    overlayHighlight: true,
    watch: false,
  });

  $<HTMLInputElement>('#file').addEventListener('change', (event) => void openFile((event.target as HTMLInputElement).files?.[0]));
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    void openFile(event.dataTransfer?.files[0]);
  });

  const file = new URLSearchParams(location.search).get('file');
  if (file) {
    $<HTMLAnchorElement>('#original').href = file;
    $('#original').hidden = false;
    await openFromUrl(file);
  } else {
    $('#drop').hidden = false;
  }
}

void main();
