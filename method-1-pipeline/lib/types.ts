/** One completed exchange: what was heard, what it became, and how long each stage took. */
export type Turn = {
  id: string;
  sourceLang: string;
  targetLang: string;
  original: string;
  translation: string | null;
  /** Set when translation or speech failed; the turn still renders. */
  error?: string;
  /** Wall-clock from end-of-turn to audio starting. */
  totalMs: number | null;
  stages: {
    /** Time from first audio of the turn to AssemblyAI's formatted final. */
    stt?: number;
    /** LLM Gateway round-trip. */
    translate?: number;
    /** Request to first audio byte. */
    tts?: number;
  };
  /** Which voice path actually ran, so the details panel can't lie about it. */
  voice?: "elevenlabs" | "browser" | "none";
};

export type Status = "idle" | "connecting" | "listening" | "error";
