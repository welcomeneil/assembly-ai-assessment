/**
 * Stage three: translated text in, spoken audio out.
 *
 * Streams straight through — `upstream.body` is piped to the client without
 * buffering, so playback can start on the first chunk instead of waiting for
 * the whole file. Flash v2.5 is the lowest-latency multilingual model
 * ElevenLabs ships (~75ms) and covers 32 languages.
 *
 * If this route fails or the key is missing, the client falls back to the
 * browser's own speechSynthesis. Worse voice, but the demo keeps talking.
 */

export const dynamic = "force-dynamic";

const API_BASE = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_flash_v2_5";
/** Small file, fast first byte. Quality is fine through laptop speakers. */
const OUTPUT_FORMAT = "mp3_22050_32";

/**
 * Sarah — a premade voice available on every tier.
 *
 * Free and scoped keys can't list voices (that needs `voices_read`) and can't
 * use library voices at all (that needs a paid plan), so discovery isn't
 * something to rely on. Premade voices work everywhere, and with Flash v2.5 the
 * voice supplies the timbre while `language_code` supplies the language —
 * verified here across es, fr, de, ja and hi at ~190ms to first byte.
 */
const FALLBACK_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

/** Resolved once per process so a fresh key works with no configuration. */
let cachedVoiceId: string | null = null;

async function resolveVoiceId(apiKey: string): Promise<string> {
  const configured = process.env.ELEVENLABS_VOICE_ID;
  if (configured) return configured;
  if (cachedVoiceId) return cachedVoiceId;

  try {
    const res = await fetch(`${API_BASE}/voices`, { headers: { "xi-api-key": apiKey } });
    if (res.ok) {
      const data = (await res.json()) as { voices?: { voice_id: string }[] };
      const first = data.voices?.[0]?.voice_id;
      if (first) {
        cachedVoiceId = first;
        return first;
      }
    }
  } catch {
    // Network trouble listing voices is no reason to lose the voice entirely.
  }

  // Couldn't ask, so don't 503 — use the voice that works on every plan.
  cachedVoiceId = FALLBACK_VOICE_ID;
  return cachedVoiceId;
}

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // 503 is the signal the client watches for to switch to the browser voice.
  if (!apiKey) {
    return Response.json({ error: "ELEVENLABS_API_KEY is not set." }, { status: 503 });
  }

  const { text, languageCode } = (await request.json()) as {
    text?: string;
    languageCode?: string;
  };
  if (!text?.trim()) {
    return Response.json({ error: "text is required." }, { status: 400 });
  }

  let voiceId: string;
  try {
    voiceId = await resolveVoiceId(apiKey);
  } catch (err) {
    console.error("[tts] voice resolution failed:", err);
    return Response.json({ error: (err as Error).message }, { status: 503 });
  }

  const url = new URL(`${API_BASE}/text-to-speech/${voiceId}/stream`);
  url.searchParams.set("output_format", OUTPUT_FORMAT);

  const upstream = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      // Pinning the language stops Flash from guessing wrong on short phrases.
      ...(languageCode ? { language_code: languageCode } : {}),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error(`[tts] ElevenLabs ${upstream.status}: ${detail}`);
    return Response.json(
      { error: `ElevenLabs error (${upstream.status}). ${detail}`.trim() },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
