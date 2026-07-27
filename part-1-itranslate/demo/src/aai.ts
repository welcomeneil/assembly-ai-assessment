/**
 * AssemblyAI streaming client.
 *
 * Two things worth calling out for iTranslate's engineers:
 *
 *  1. The device never holds an API key. A consumer handheld can be opened and its
 *     firmware dumped, and a key on one device is a key on every device -- revoking it
 *     would brick the fleet. Their server mints a single-use token instead, valid for
 *     seconds, requested immediately before connecting.
 *
 *  2. Audio goes from the device straight to AssemblyAI. It does not route through
 *     iTranslate's backend. That keeps their backend small no matter how many devices
 *     they sell, and removes a hop from the latency budget.
 */

import { WebSocket } from "ws";

const TOKEN_ENDPOINT = "https://streaming.assemblyai.com/v3/token";
const STREAMING_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";

/** Region-pinned endpoints, for when the EU data residency question comes up. */
export const ENDPOINTS = {
  global: STREAMING_ENDPOINT,
  us: "wss://streaming.us.assemblyai.com/v3/ws",
  eu: "wss://streaming.eu.assemblyai.com/v3/ws",
} as const;

export interface TurnWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  word_is_final: boolean;
}

export interface TurnMessage {
  type: "Turn";
  turn_order: number;
  end_of_turn: boolean;
  transcript: string;
  utterance?: string;
  language_code?: string;
  language_confidence?: number;
  end_of_turn_confidence?: number;
  words: TurnWord[];
}

export interface BeginMessage {
  type: "Begin";
  id: string;
  expires_at: number;
  configuration?: Record<string, unknown>;
}

export interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  session_duration_seconds: number;
}

export interface LlmGatewayMessage {
  type: "LlmGatewayResponse";
  turn_order: number;
  transcript?: string;
  data: { choices?: Array<{ message?: { content?: string } }> };
}

export type ServerMessage =
  | BeginMessage
  | TurnMessage
  | TerminationMessage
  | LlmGatewayMessage
  | { type: string; [key: string]: unknown };

/**
 * Mint a temporary streaming token.
 *
 * `expires_in_seconds` is how long the token can be redeemed for (1-600). It is not
 * how long the session lasts: once the socket is open the session runs up to
 * `max_session_duration_seconds` regardless. Keep the redemption window short -- the
 * device asks for a token and connects immediately.
 */
export async function mintToken(
  apiKey: string,
  options: { expiresInSeconds?: number; maxSessionDurationSeconds?: number } = {},
): Promise<{ token: string; expiresInSeconds: number }> {
  const query = new URLSearchParams({
    expires_in_seconds: String(options.expiresInSeconds ?? 60),
  });
  if (options.maxSessionDurationSeconds !== undefined) {
    query.set("max_session_duration_seconds", String(options.maxSessionDurationSeconds));
  }

  const response = await fetch(`${TOKEN_ENDPOINT}?${query}`, {
    headers: { Authorization: apiKey },
  });
  if (!response.ok) {
    throw new Error(
      `token request failed: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { token: string; expires_in_seconds: number };
  return { token: body.token, expiresInSeconds: body.expires_in_seconds };
}

export interface StreamHandlers {
  onBegin?: (message: BeginMessage) => void;
  onPartial?: (message: TurnMessage) => void;
  onTurn?: (message: TurnMessage) => void;
  onTranslation?: (message: LlmGatewayMessage) => void;
  onTermination?: (message: TerminationMessage) => void;
  onError?: (error: Error) => void;
}

export class StreamingSession {
  private readonly socket: WebSocket;
  private closed = false;

  private constructor(socket: WebSocket, handlers: StreamHandlers) {
    this.socket = socket;

    socket.on("message", (raw) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        handlers.onError?.(new Error(`unparseable message: ${raw.toString().slice(0, 200)}`));
        return;
      }

      switch (message.type) {
        case "Begin":
          handlers.onBegin?.(message as BeginMessage);
          break;
        case "Turn": {
          const turn = message as TurnMessage;
          if (turn.end_of_turn) handlers.onTurn?.(turn);
          else handlers.onPartial?.(turn);
          break;
        }
        // The API reference and the LLM Gateway guide disagree on the casing of this
        // message type, so accept both rather than silently dropping translations.
        case "LlmGatewayResponse":
        case "LLMGatewayResponse":
          handlers.onTranslation?.(message as LlmGatewayMessage);
          break;
        case "Termination":
          handlers.onTermination?.(message as TerminationMessage);
          break;
        case "Error":
          handlers.onError?.(new Error(String(message["error"] ?? "unknown server error")));
          break;
        default:
          break; // SpeechStarted, Heartbeat, SpeakerRevision -- not used by this demo.
      }
    });

    socket.on("error", (error) => handlers.onError?.(error as Error));
    socket.on("close", (code, reason) => {
      this.closed = true;
      // 1000 is a clean close. Anything else is worth surfacing: 3007 in particular
      // means the audio chunks were outside the 50-1000 ms window.
      if (code !== 1000 && code !== 1005) {
        handlers.onError?.(new Error(`socket closed ${code}: ${reason.toString()}`));
      }
    });
  }

  static async connect(
    apiKey: string,
    params: Record<string, string>,
    handlers: StreamHandlers,
    endpoint: string = STREAMING_ENDPOINT,
  ): Promise<StreamingSession> {
    const { token } = await mintToken(apiKey, { expiresInSeconds: 60 });
    const query = new URLSearchParams({ ...params, token });
    const socket = new WebSocket(`${endpoint}?${query}`);

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    return new StreamingSession(socket, handlers);
  }

  /** Send one audio chunk. Must be 50-1000 ms of audio, paced at roughly real time. */
  send(chunk: Buffer): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(chunk);
  }

  /** Ask the server to finalise the current turn now rather than waiting on silence. */
  forceEndpoint(): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "ForceEndpoint" }));
    }
  }

  /**
   * Close the session.
   *
   * Worth doing promptly: streaming is billed on how long the connection is open, not
   * on how much audio went through it. On a device that spends most of its life in
   * someone's pocket, that distinction is the whole cost model.
   */
  terminate(): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "Terminate" }));
    }
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }
}

/** Extract the translated text from an LLM Gateway reply. */
export function translationText(message: LlmGatewayMessage): string {
  return message.data?.choices?.[0]?.message?.content?.trim() ?? "";
}
