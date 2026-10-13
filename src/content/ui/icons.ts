// Icons drawn for Lector. Each is a 24×24 SVG that takes the current text colour.

const svg = (body: string) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">${body}</svg>`;

export const icons = {
  play: svg('<path d="M8.2 5.3c0-1 1.1-1.6 2-1.1l10 6.7c.8.5.8 1.7 0 2.2l-10 6.7c-.9.5-2-.1-2-1.1V5.3Z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="4.5" width="4.4" height="15" rx="1.6" fill="currentColor"/><rect x="13.6" y="4.5" width="4.4" height="15" rx="1.6" fill="currentColor"/>'),
  replay: svg('<path d="M5 12a7 7 0 1 0 2.3-5.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4.6 4.2v3.9h3.9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  previous: svg('<path d="M18.5 6.6v10.8c0 .8-.9 1.3-1.6.8l-7.6-5.4a1 1 0 0 1 0-1.6l7.6-5.4c.7-.5 1.6 0 1.6.8Z" fill="currentColor"/><rect x="5" y="5.5" width="2.4" height="13" rx="1.2" fill="currentColor"/>'),
  next: svg('<path d="M5.5 6.6v10.8c0 .8.9 1.3 1.6.8l7.6-5.4a1 1 0 0 0 0-1.6L7.1 5.8c-.7-.5-1.6 0-1.6.8Z" fill="currentColor"/><rect x="16.6" y="5.5" width="2.4" height="13" rx="1.2" fill="currentColor"/>'),
  close: svg('<path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  more: svg('<path d="M5 8h14M5 12h14M5 16h9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  check: svg('<path d="m5.5 12.5 4.2 4.2L18.5 8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  sample: svg('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  locate: svg('<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
};
