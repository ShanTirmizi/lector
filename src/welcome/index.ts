// The page shown once after installing: says how to start, and is itself something to read.

import { boot } from '../content/boot';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
for (const key of Array.from(document.querySelectorAll('kbd.alt'))) key.textContent = isMac ? 'Option' : 'Alt';

void boot({ watch: false }).then((lector) => {
  document.querySelector('#start')?.addEventListener('click', () => lector?.start());
});
