/**
 * Which gateway translates a turn.
 *
 * AssemblyAI's LLM Gateway is the architecturally native choice and the one
 * their own real-time translation guide uses — but it's a separate paid
 * entitlement from transcription, and a key without it returns 401 while
 * streaming and the batch Translation API keep working. So the stage is
 * provider-agnostic: every option here speaks the OpenAI chat-completions
 * shape, which means one request body, one response parser, and a swap costs
 * an env var rather than a code change.
 *
 * Order matters — the first provider with a key present wins, unless
 * TRANSLATION_PROVIDER names one explicitly.
 */

export type ProviderId = "gemini" | "assemblyai" | "openai" | "groq";

type Provider = {
  /** Shown in the UI's details panel so the demo never misreports itself. */
  label: string;
  url: string;
  defaultModel: string;
  envKey: string;
  /** AssemblyAI takes a bare key; everyone else takes Bearer. */
  authHeader: (key: string) => string;
};

export const PROVIDERS: Record<ProviderId, Provider> = {
  gemini: {
    label: "Google AI Studio",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // Flash-lite is the latency tier, which is what matters in a live loop.
    // Note the generation: 3.1, not the 2.5 that AssemblyAI's gateway exposes.
    defaultModel: "gemini-3.1-flash-lite",
    envKey: "GEMINI_API_KEY",
    authHeader: (key) => `Bearer ${key}`,
  },
  assemblyai: {
    label: "AssemblyAI LLM Gateway",
    url: "https://llm-gateway.assemblyai.com/v1/chat/completions",
    defaultModel: "gemini-2.5-flash-lite",
    envKey: "ASSEMBLYAI_API_KEY",
    authHeader: (key) => key,
  },
  openai: {
    label: "OpenAI",
    url: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    envKey: "OPENAI_API_KEY",
    authHeader: (key) => `Bearer ${key}`,
  },
  groq: {
    label: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    envKey: "GROQ_API_KEY",
    authHeader: (key) => `Bearer ${key}`,
  },
};

/** Preference order when TRANSLATION_PROVIDER isn't set. */
const FALLBACK_ORDER: ProviderId[] = ["gemini", "groq", "openai", "assemblyai"];

export type Resolved = {
  id: ProviderId;
  provider: Provider;
  apiKey: string;
  model: string;
};

/**
 * The active provider, or null when no configured key is present.
 *
 * AssemblyAI sits last in the fallback order deliberately: its key is always
 * set (streaming needs it), so putting it first would mask a working Gemini or
 * Groq key behind an entitlement error.
 */
export function resolveProvider(): Resolved | null {
  const forced = process.env.TRANSLATION_PROVIDER as ProviderId | undefined;
  const order = forced && PROVIDERS[forced] ? [forced] : FALLBACK_ORDER;

  for (const id of order) {
    const provider = PROVIDERS[id];
    const apiKey = process.env[provider.envKey];
    if (!apiKey) continue;
    return {
      id,
      provider,
      apiKey,
      model: process.env.TRANSLATION_MODEL || provider.defaultModel,
    };
  }
  return null;
}
