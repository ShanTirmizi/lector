// The page's connection to the voice engine in the offscreen document.

import { ENGINE_PORT, type FromEngine, type ToBackground, type ToEngine } from '../shared/protocol';

export class EngineClient {
  private port: chrome.runtime.Port | null = null;
  private connecting: Promise<chrome.runtime.Port> | null = null;

  constructor(
    private onMessage: (message: FromEngine) => void,
    private onLost: () => void,
  ) {}

  private connect(): Promise<chrome.runtime.Port> {
    if (this.port) return Promise.resolve(this.port);
    this.connecting ??= (async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'ensure-engine' } satisfies ToBackground);
      if (!reply?.ok) throw new Error(reply?.error ?? 'The voice engine could not start.');
      const port = chrome.runtime.connect({ name: ENGINE_PORT });
      port.onMessage.addListener((message: FromEngine) => this.onMessage(message));
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null;
        this.onLost();
      });
      this.port = port;
      return port;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  async send(message: ToEngine): Promise<void> {
    (await this.connect()).postMessage(message);
  }

  /** Sends only if a connection already exists; used for commands that mean nothing without one. */
  sendIfConnected(message: ToEngine): void {
    this.port?.postMessage(message);
  }

  disconnect(): void {
    const port = this.port;
    this.port = null;
    port?.disconnect();
  }
}
