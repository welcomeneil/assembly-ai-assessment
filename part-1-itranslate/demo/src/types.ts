/**
 * The event protocol between the pipeline and the dashboard.
 *
 * Live sessions and the no-key fixture replay emit exactly the same events, so the
 * dashboard has one code path and the fixture cannot drift into showing something the
 * real pipeline could never produce.
 *
 * Scope: recognition only. iTranslate asked about speech-to-text accuracy, and they
 * already own the translation and text-to-speech legs of their pipeline, so neither
 * appears here.
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
      type: "turn.accuracy";
      at: number;
      order: number;
      /** Keyterms this turn got right. Per-turn and unambiguous. */
      keytermsHit: string[];
      /**
       * The running session total.
       *
       * There is deliberately no per-turn word error rate. Turn boundaries do not line
       * up with the reference's sentence boundaries, so accuracy can only be scored
       * against a global alignment -- and slicing that alignment back into per-turn
       * pieces double-counts, because an earlier turn's alignment shifts as more of the
       * hypothesis arrives. One honest number beats ten misleading ones.
       */
      session: { wer: number; errors: number; words: number };
    }
  | {
      /** The one word-level diff, over the whole session, emitted when it ends. */
      type: "session.accuracy";
      at: number;
      reference: string;
      wer: number;
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
