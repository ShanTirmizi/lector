// Styles for everything Lector draws on a page. They live in a shadow root,
// so the page's CSS cannot reach in and these rules cannot leak out.

export const styles = `
:host {
  all: initial;
  --green: #173f35;
  --green-deep: #0f2d26;
  --green-lift: #20503f;
  --chalk: #f2f5ee;
  --sage: #a9bdb2;
  --ink: #17130a;
  --marker: #ffd84d;
  --coral: #ff9a8a;
  --font: ui-rounded, "SF Pro Rounded", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  position: fixed;
  inset: 0 auto auto 0;
  width: 0;
  height: 0;
  z-index: 2147483647;
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.3;
  color: var(--chalk);
  -webkit-font-smoothing: antialiased;
  color-scheme: dark;
}
@media print { :host { display: none; } }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
button:focus-visible, input:focus-visible {
  outline: 2px solid var(--marker);
  outline-offset: 2px;
}
svg { display: block; }

/* ------------------------------------------------------------------ player */

.player {
  position: fixed;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 58px;
  padding: 0 8px 5px 6px;
  background: var(--green);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 29px;
  box-shadow: 0 14px 34px rgba(9, 28, 23, 0.34), 0 2px 6px rgba(9, 28, 23, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  user-select: none;
  touch-action: none;
  white-space: nowrap;
  animation: rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.player.dragging { cursor: grabbing; box-shadow: 0 22px 44px rgba(9, 28, 23, 0.42), 0 3px 8px rgba(9, 28, 23, 0.24); }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } }

.grip {
  position: relative;
  width: 18px;
  height: 36px;
  cursor: grab;
}
/* Six dots, the usual sign for "drag me". */
.grip::before {
  content: "";
  position: absolute;
  left: 6px;
  top: 11px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.32);
  box-shadow: 6px 0 0 rgba(255, 255, 255, 0.32), 0 6px 0 rgba(255, 255, 255, 0.32), 6px 6px 0 rgba(255, 255, 255, 0.32), 0 12px 0 rgba(255, 255, 255, 0.32), 6px 12px 0 rgba(255, 255, 255, 0.32);
}

.icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--chalk);
  transition: background-color 120ms;
}
.icon:hover { background: rgba(255, 255, 255, 0.1); }
.icon:active { background: rgba(255, 255, 255, 0.16); }
.icon:disabled { opacity: 0.35; cursor: default; background: none; }
.icon svg { width: 20px; height: 20px; }
.icon.quiet { color: var(--sage); }
.icon.quiet:hover { color: var(--chalk); }

.play {
  position: relative;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  margin: 0 3px;
  border-radius: 50%;
  background: var(--marker);
  color: var(--ink);
  transition: transform 120ms;
}
.play:hover { transform: scale(1.05); }
.play:active { transform: scale(0.96); }
.play svg { width: 22px; height: 22px; }
/* A ring that turns while the voice is getting ready, or fills as it downloads. */
.play .ring {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
}
.player[data-busy="spin"] .ring {
  opacity: 1;
  background: conic-gradient(var(--marker) 0 28%, transparent 28%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  animation: turn 900ms linear infinite;
}
.player[data-busy="fill"] .ring {
  opacity: 1;
  background: conic-gradient(var(--marker) calc(var(--download, 0) * 1turn), rgba(255, 255, 255, 0.18) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
}
.player[data-busy] .play { background: rgba(255, 216, 77, 0.22); color: var(--marker); }
@keyframes turn { to { transform: rotate(1turn); } }

.chip {
  height: 34px;
  padding: 0 11px;
  border-radius: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  transition: background-color 120ms;
}
.chip:hover, .chip[aria-expanded="true"] { background: rgba(255, 255, 255, 0.1); }
.chip.speed { min-width: 52px; text-align: center; }
.chip.voice { display: flex; align-items: center; gap: 8px; }
/* Three bars that move while the voice is speaking. */
.eq { display: flex; align-items: center; gap: 2px; width: 12px; height: 14px; }
.eq b { width: 2.6px; height: 4px; border-radius: 2px; background: var(--marker); transition: height 200ms; }
.player[data-speaking] .eq b { animation: speak 900ms ease-in-out infinite; }
.player[data-speaking] .eq b:nth-child(2) { animation-delay: -300ms; animation-duration: 760ms; }
.player[data-speaking] .eq b:nth-child(3) { animation-delay: -560ms; animation-duration: 1040ms; }
@keyframes speak { 0%, 100% { height: 4px; } 50% { height: 13px; } }

.status {
  /* A fixed width, so the buttons do not shift under the pointer when the text changes. */
  width: 142px;
  padding: 0 8px;
  color: var(--sage);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}
.status.problem { width: 230px; color: var(--coral); white-space: normal; font-size: 12.5px; line-height: 1.25; text-align: left; }
.status.wide { width: 210px; }
.back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 11px 0 7px;
  border-radius: 15px;
  background: rgba(255, 216, 77, 0.16);
  color: var(--marker);
  font-weight: 600;
}
.back:hover { background: rgba(255, 216, 77, 0.26); }
.back svg { width: 16px; height: 16px; }

.rule { width: 1px; height: 22px; margin: 0 5px; background: rgba(255, 255, 255, 0.14); }

/* Progress drawn like a stroke of highlighter along the bottom edge. It is also a scrubber. */
.scrub {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 0;
  height: 15px;
  cursor: pointer;
  touch-action: none;
  border-radius: 8px;
}
.scrub .track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 6px;
  height: 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.13);
  overflow: hidden;
  transition: height 120ms, bottom 120ms;
}
.scrub .track i {
  display: block;
  height: 100%;
  width: calc(var(--progress, 0) * 100%);
  border-radius: 3px;
  background: var(--marker);
  transition: width 400ms ease-out;
}
.scrub .thumb {
  position: absolute;
  bottom: 2px;
  left: calc(var(--at, 0) * 100%);
  width: 3px;
  height: 11px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: var(--chalk);
  opacity: 0;
  transition: opacity 120ms;
  pointer-events: none;
}
.scrub:hover .track, .scrub:active .track { height: 5px; bottom: 5px; }
.scrub:hover .thumb, .scrub:active .thumb { opacity: 1; }
.scrub:active .track i { transition: none; }

.tip, .peek {
  position: fixed;
  z-index: 3;
  padding: 6px 10px;
  border-radius: 9px;
  background: var(--green-deep);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 6px 18px rgba(9, 28, 23, 0.34);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  animation: fade 110ms ease-out;
}
@keyframes fade { from { opacity: 0; } }
.tip kbd {
  margin-left: 8px;
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.12);
  font: inherit;
  font-weight: 600;
  color: var(--marker);
}
.peek { display: grid; gap: 2px; max-width: 320px; padding: 9px 12px; white-space: normal; font-size: 13px; line-height: 1.35; }
.peek small { color: var(--sage); font-size: 12px; font-variant-numeric: tabular-nums; }

.player.narrow .status:not(.problem), .player.narrow .rule { display: none; }
.player.narrow { padding-left: 2px; }
.player.tiny .grip, .player.tiny .chip.voice span { display: none; }
.player.tiny { padding-left: 6px; }

/* ------------------------------------------------------------------ panels */

.panel {
  position: fixed;
  z-index: 2;
  width: 272px;
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  padding: 14px;
  background: var(--green-deep);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 18px;
  box-shadow: 0 18px 40px rgba(9, 28, 23, 0.4);
  animation: rise 140ms ease-out;
}
.panel h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--sage);
}

.readout { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.readout small { display: block; margin-top: 2px; font-size: 13px; font-weight: 500; color: var(--sage); letter-spacing: 0; }
input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 22px;
  margin: 10px 0 12px;
  background: none;
  cursor: pointer;
}
input[type="range"]::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(to right, var(--marker) var(--fill, 0%), rgba(255, 255, 255, 0.16) var(--fill, 0%));
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  margin-top: -6.5px;
  border-radius: 50%;
  background: var(--chalk);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
.presets { display: grid; grid-template-columns: repeat(6, 1fr); gap: 5px; }
.presets button {
  height: 30px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.07);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
  letter-spacing: -0.01em;
}
.presets button:hover { background: rgba(255, 255, 255, 0.14); }
.presets button[aria-pressed="true"] { background: var(--marker); color: var(--ink); }

.voices { -webkit-mask-image: linear-gradient(#000 calc(100% - 22px), transparent); mask-image: linear-gradient(#000 calc(100% - 22px), transparent); padding-bottom: 14px !important; max-height: min(326px, calc(100vh - 150px)); margin: 0 -8px -6px; padding: 0 2px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent; }
.voices h3 { margin: 10px 8px 4px; font-size: 12px; font-weight: 600; color: var(--sage); }
.voices h3:first-child { margin-top: 0; }
.voice-row { display: flex; align-items: center; border-radius: 11px; }
.voice-row:hover { background: rgba(255, 255, 255, 0.07); }
.voice-row .pick { flex: 1; display: flex; align-items: center; gap: 9px; padding: 6px 8px; text-align: left; border-radius: 11px; }
.voice-row .face {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: hsl(var(--hue) 46% 78%);
  color: hsl(var(--hue) 50% 20%);
  font-style: normal;
  font-weight: 700;
  font-size: 13px;
}
.voice-row .pick b { font-weight: 600; }
.voice-row .pick span { color: var(--sage); font-size: 12.5px; }
.voice-row .pick svg { width: 16px; height: 16px; margin-left: auto; color: var(--marker); visibility: hidden; }
.voice-row[aria-current="true"] .pick svg { visibility: visible; }
.voice-row .try { display: grid; place-items: center; width: 32px; height: 32px; margin-right: 3px; border-radius: 50%; color: var(--sage); }
.voice-row .try:hover { background: rgba(255, 255, 255, 0.12); color: var(--chalk); }
.voice-row .try svg { width: 17px; height: 17px; }

.switch { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 7px 0; text-align: left; }
.switch i {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.2);
  transition: background-color 140ms;
}
.switch i::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--chalk);
  transition: transform 140ms;
}
.switch[aria-checked="true"] i { background: var(--marker); }
.switch[aria-checked="true"] i::after { transform: translateX(14px); background: var(--ink); }
.swatches { display: flex; align-items: center; justify-content: space-between; padding: 8px 0 10px; }
.swatches div { display: flex; gap: 8px; }
.swatches button { width: 22px; height: 22px; border-radius: 50%; background: var(--swatch); }
.swatches button[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--green-deep), 0 0 0 4px var(--chalk); }
.links { display: grid; gap: 2px; margin: 4px -8px -6px; padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, 0.1); }
.links button { padding: 8px; border-radius: 9px; text-align: left; color: var(--sage); }
.links button:hover { background: rgba(255, 255, 255, 0.07); color: var(--chalk); }
.keys { margin: 8px 0 0; color: var(--sage); font-size: 12.5px; line-height: 1.7; }
.keys kbd { font: inherit; font-weight: 600; color: var(--chalk); }

/* --------------------------------------------------- buttons on the page */

.launcher {
  position: fixed;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 14px 0 7px;
  background: var(--green);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-right: 0;
  border-radius: 22px 0 0 22px;
  box-shadow: 0 8px 22px rgba(9, 28, 23, 0.28);
  font-weight: 600;
  transform: translateX(calc(100% - 46px));
  transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.launcher:hover, .launcher:focus-visible { transform: none; }
.launcher .dot { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--marker); color: var(--ink); }
.launcher .dot svg { width: 16px; height: 16px; }
.launcher small { font-size: 12.5px; font-weight: 500; color: var(--sage); }

.spot {
  position: fixed;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--green);
  color: var(--marker);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 4px 12px rgba(9, 28, 23, 0.3);
  opacity: 0;
  transform: scale(0.8);
  transition: opacity 120ms, transform 120ms;
  pointer-events: none;
}
.spot.on { opacity: 1; transform: none; pointer-events: auto; }
.spot:hover { background: var(--green-lift); }
.spot svg { width: 14px; height: 14px; }

.listen {
  position: fixed;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 13px 0 9px;
  border-radius: 16px;
  background: var(--green);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 6px 16px rgba(9, 28, 23, 0.32);
  font-weight: 600;
  animation: rise 140ms ease-out;
}
.listen:hover { background: var(--green-lift); }
.listen svg { width: 15px; height: 15px; color: var(--marker); }

.toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  translate: -50% 0;
  max-width: min(460px, calc(100vw - 32px));
  padding: 11px 16px;
  border-radius: 14px;
  background: var(--green-deep);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 26px rgba(9, 28, 23, 0.36);
  animation: rise 160ms ease-out;
  display: flex;
  align-items: center;
  gap: 14px;
}
.toast button { flex: none; height: 30px; padding: 0 12px; border-radius: 15px; background: rgba(255, 216, 77, 0.16); color: var(--marker); font-weight: 600; white-space: nowrap; }
.toast button:hover { background: rgba(255, 216, 77, 0.26); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  .player[data-busy="spin"] .ring { animation-duration: 2400ms !important; }
  .player[data-speaking] .eq b { animation: none !important; height: 9px; }
}
`;
