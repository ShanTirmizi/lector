// A page's connection to the voice engine in the offscreen document.

import { ENGINE_PORT, type FromEngine, type ToBackground, type ToEngine } from '../shared/protocol';

export class EngineClient {
  private port: chrome.runtime.Port | null = null;
  private connecting: Promise<chrome.runtime.Port> | null = null;
  /** Bumped by disconnect(), so a connection that finishes opening afterwards is thrown away. */
  private epoch = 0;

  constructor(
    private onMessage: (message: FromEngine) => void,
    private onLost: () => void,
    private name: string = ENGINE_PORT,
  ) {}

  private connect(): Promise<chrome.runtime.Port> {
    if (this.port) return Promise.resolve(this.port);
    const epoch = this.epoch;
    this.connecting ??= (async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'ensure-engine' } satisfies ToBackground);
      if (!reply?.ok) throw new Error(reply?.error ?? 'The voice engine could not start.');
      if (epoch !== this.epoch) throw new Error('cancelled');
      const port = chrome.runtime.connect({ name: this.name });
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

  /** Sends a message, opening the connection first if there is none. */
  async send(message: ToEngine): Promise<void> {
    const epoch = this.epoch;
    const port = await this.connect();
    // The reading was closed while the engine was starting.
    if (epoch !== this.epoch) return;
    port.postMessage(message);
  }

  /**
   * Sends a message that only means something to an existing session. While the
   * connection is still opening it is held and sent after whatever opened it.
   */
  sendIfConnected(message: ToEngine): void {
    if (this.port) return this.port.postMessage(message);
    const epoch = this.epoch;
    this.connecting?.then(
      (port) => {
        if (epoch === this.epoch) port.postMessage(message);
      },
      () => undefined,
    );
  }

  disconnect(): void {
    this.epoch++;
    const port = this.port;
    this.port = null;
    port?.disconnect();
  }
}
