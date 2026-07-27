/**
 * Event bus between the handheld and the dashboard.
 *
 * The device streams audio straight to AssemblyAI, so this service never sees the audio.
 * What it does see is a small stream of events the device publishes as it works: the session
 * it opened, the configuration AssemblyAI confirmed, each finished turn, and the running
 * meter. The dashboard subscribes to that stream.
 *
 * Both roles use the same WebSocket path. Anything a client sends is treated as a published
 * event and fanned out to every other client. That keeps the device side trivial: open a
 * socket, send JSON.
 *
 * State is retained so a dashboard opened halfway through a conversation is not blank. Late
 * subscribers receive the session, the current status and the turns so far. Partial
 * transcripts are not retained; they are superseded within a few hundred milliseconds.
 */

import type { WebSocket } from "ws";

// -----------------------------------------------------------------------------------------
// Event contract, shared by the TypeScript backend and the Python device
// -----------------------------------------------------------------------------------------

/** Sent once when the device opens a streaming session. */
export interface SessionEvent {
  type: "session";
  sessionId: string;
  host: string;
  /** The two language codes in play, for example ["en", "es"]. */
  pair: string[];
  /** Connection parameters the device used. */
  params: Record<string, string>;
  /** The configuration AssemblyAI echoed back in its Begin message, if it sent one. */
  appliedConfig?: Record<string, unknown> | null;
  startedAt: number;
  /** True when the events come from the built-in replay rather than a live session. */
  simulated?: boolean;
}

/** In-progress transcript. Superseded constantly, never retained. */
export interface PartialEvent {
  type: "partial";
  text: string;
}

/** One finished turn: what was said, what language it was, and what came back. */
export interface TurnEvent {
  type: "turn";
  turnOrder: number;
  /** Language AssemblyAI detected. Nobody selected this. */
  language: string;
  languageConfidence: number | null;
  transcript: string;
  targetLanguage: string;
  translation: string;
  timing: { sttMs: number; translateMs: number; ttsMs: number };
  at: number;
  /** Optional callout the dashboard renders under the turn. Used by the scripted replay. */
  note?: string;
}

export interface StatusEvent {
  type: "status";
  state: "idle" | "connecting" | "live" | "closed" | "error";
  detail?: string;
  /** WebSocket close code, when the session ended abnormally. */
  closeCode?: number;
}

/**
 * Running meter.
 *
 * Streaming is billed on how long the socket stays open, not on how much audio is sent, so
 * these two numbers come apart whenever the device is held open through silence. The
 * dashboard shows both on purpose.
 */
export interface MeterEvent {
  type: "meter";
  sessionSeconds: number;
  audioSeconds: number;
}

export type BusEvent = SessionEvent | PartialEvent | TurnEvent | StatusEvent | MeterEvent;

// -----------------------------------------------------------------------------------------

const OPEN = 1; // WebSocket.OPEN, without importing the runtime value

export class EventBus {
  private clients = new Set<WebSocket>();
  private session: SessionEvent | null = null;
  private status: StatusEvent = { type: "status", state: "idle" };
  private turns: TurnEvent[] = [];
  private meter: MeterEvent | null = null;

  /** Cap retained history. A dashboard does not need an unbounded backlog. */
  private static readonly MAX_RETAINED_TURNS = 200;

  add(client: WebSocket): void {
    this.clients.add(client);
    // Bring a late subscriber up to date before it receives anything live.
    const backlog: BusEvent[] = [this.status];
    if (this.session) backlog.unshift(this.session);
    if (this.meter) backlog.push(this.meter);
    backlog.push(...this.turns);
    for (const event of backlog) this.sendTo(client, event);
  }

  remove(client: WebSocket): void {
    this.clients.delete(client);
  }

  /**
   * Record an event and fan it out.
   * `origin` is excluded from the fan-out so a publisher does not receive its own event.
   */
  publish(event: BusEvent, origin?: WebSocket): void {
    switch (event.type) {
      case "session":
        // A new session resets the view. Old turns belong to the previous conversation.
        this.session = event;
        this.turns = [];
        this.meter = null;
        break;
      case "turn":
        this.turns.push(event);
        if (this.turns.length > EventBus.MAX_RETAINED_TURNS) this.turns.shift();
        break;
      case "status":
        this.status = event;
        break;
      case "meter":
        this.meter = event;
        break;
      case "partial":
        break; // transient by design
    }

    for (const client of this.clients) {
      if (client !== origin) this.sendTo(client, event);
    }
  }

  /** Clear retained state, so the next demo run starts from a blank dashboard. */
  reset(): void {
    this.session = null;
    this.turns = [];
    this.meter = null;
    this.publish({ type: "status", state: "idle" });
  }

  get subscriberCount(): number {
    return this.clients.size;
  }

  private sendTo(client: WebSocket, event: BusEvent): void {
    if (client.readyState !== OPEN) return;
    try {
      client.send(JSON.stringify(event));
    } catch {
      this.clients.delete(client);
    }
  }
}
