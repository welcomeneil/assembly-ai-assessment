/**
 * AssemblyAI Universal-Streaming v3 client.
 *
 * Docs: https://www.assemblyai.com/docs/speech-to-text/universal-streaming
 *
 * The browser can't set WebSocket headers, so it can't send an API key. Instead
 * the server mints a single-use token (see app/api/aai-token/route.ts) and we
 * pass it as a query param. That's also exactly the shape iTranslate's handheld
 * needs: no key in firmware, nothing to revoke across a fleet.
 */

const WS_URL = "wss://streaming.assemblyai.com/v3/ws";

export type FinalTurn = {
  transcript: string;
  languageCode: string | null;
  languageConfidence: number;
  /** When the API first told us the speaker had stopped. All timing is from here. */
  endOfTurnAt: number;
};

export type StreamHandlers = {
  /** Fired once per utterance, on the formatted final only. */
  onFinal: (turn: FinalTurn) => void;
  /** Connection dropped or failed after we were up and running. */
  onError: (message: string) => void;
};

export class AAIStream {
  private ws: WebSocket | null = null;
  /** turn_order → timestamp of the first end_of_turn signal for that turn. */
  private endOfTurnAt = new Map<number, number>();
  private closingByUs = false;

  constructor(
    private readonly languageCodes: string[],
    private readonly handlers: StreamHandlers,
  ) {}

  async connect(): Promise<void> {
    const res = await fetch("/api/aai-token");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Token request failed (${res.status})`);
    }
    const { token } = (await res.json()) as { token: string };

    const params = new URLSearchParams({
      token,
      sample_rate: "16000",
      encoding: "pcm_s16le",
      speech_model: "universal-3-5-pro",
      // Formatted finals are punctuated and cased, which translates far better
      // than raw lowercase output.
      format_turns: "true",
      // Both people share one socket. This is what removes the turn-taking
      // button from the device: the model reports which language it heard.
      language_detection: "true",
      language_codes: JSON.stringify(this.languageCodes),
      // Keeps the connection alive through the pauses in a real conversation.
      session_heartbeat: "true",
    });

    const ws = new WebSocket(`${WS_URL}?${params}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(e);

    // Resolve only once the socket is actually open, so the caller doesn't
    // start the microphone and drop the first words on the floor.
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Could not reach AssemblyAI."));
      ws.onclose = (e) => reject(new Error(e.reason || `Connection refused (${e.code}).`));
    });

    // Swap in the steady-state handlers now that we're up.
    ws.onerror = () => this.handlers.onError("The connection to AssemblyAI dropped.");
    ws.onclose = (e) => {
      if (!this.closingByUs && e.code !== 1000) {
        this.handlers.onError(e.reason || `Disconnected (${e.code}).`);
      }
    };
  }

  private onMessage(e: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch {
      return;
    }

    if (msg.type !== "Turn") return;

    const order = Number(msg.turn_order ?? 0);
    const endOfTurn = Boolean(msg.end_of_turn);
    const formatted = Boolean(msg.turn_is_formatted);

    // The unformatted end_of_turn lands first. That's the moment the API
    // decided the speaker stopped, and it's the honest zero point for every
    // latency number we show.
    if (endOfTurn && !this.endOfTurnAt.has(order)) {
      this.endOfTurnAt.set(order, performance.now());
    }

    if (!endOfTurn || !formatted) return;

    const transcript = String(msg.transcript ?? "").trim();
    if (!transcript) return;

    this.handlers.onFinal({
      transcript,
      languageCode: (msg.language_code as string | null) ?? null,
      languageConfidence: Number(msg.language_confidence ?? 0),
      endOfTurnAt: this.endOfTurnAt.get(order) ?? performance.now(),
    });
    this.endOfTurnAt.delete(order);
  }

  send(pcm: Int16Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm.buffer as ArrayBuffer);
    }
  }

  close(): void {
    this.closingByUs = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Terminate" }));
      this.ws.close(1000);
    }
    this.ws = null;
  }
}
