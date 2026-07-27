/**
 * The event protocol between the pipeline and the dashboard.
 *
 * Live sessions and the no-key fixture replay emit exactly the same events, so the
 * dashboard has one code path and the fixture cannot drift into showing something the
 * real pipeline could never produce.
 */

export interface Word {
  text: string;
  confidence: number;
}

/** One aligned edit between the reference and what the recogniser returned. */
export interface DiffOp {
  kind: "ok" | "sub" | "del" | "ins";
  ref?: string;
  hyp?: string;
}

export interface SessionConfig {
  /** Exactly the query parameters sent on the WebSocket, for display and for auditing. */
  params: Record<string, string>;
  prompt: string;
  keyterms: string[];
}

export type DashboardEvent =
  | {
      type: "session.open";
      at: number;
      mode: "live" | "fixture";
      audio: string;
      config: SessionConfig;
      /** Provenance of a fixture run: what is real and what is constructed. */
      provenance?: Record<string, unknown>;
    }
  | { type: "turn.partial"; at: number; order: number; transcript: string }
  | {
      type: "turn.final";
      at: number;
      order: number;
      transcript: string;
      words: Word[];
      languageCode: string;
      languageConfidence: number;
      midTurnSwitch: boolean;
      audioStartMs: number;
      audioEndMs: number;
      sttMs: number;
    }
  | {
      type: "turn.translation";
      at: number;
      order: number;
      target: string;
      text: string;
      translateMs: number;
    }
  | { type: "turn.speech"; at: number; order: number; ttsMs: number }
  | {
      type: "turn.accuracy";
      at: number;
      order: number;
      reference: string;
      /** null when the turn is unscorable, e.g. the corpus marks it unintelligible. */
      wer: number | null;
      keytermsHit: string[];
      ops: DiffOp[];
    }
  | { type: "meter"; at: number; connectionMs: number; audioMs: number }
  | {
      type: "session.close";
      at: number;
      audioDurationSeconds: number;
      sessionDurationSeconds: number;
    }
  | { type: "error"; at: number; message: string };
