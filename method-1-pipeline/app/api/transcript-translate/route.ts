/**
 * The other translation product — AssemblyAI's Speech Understanding Translation.
 * https://www.assemblyai.com/docs/speech-understanding/translation
 *
 * This is NOT what the realtime loop uses, and the difference is the point.
 * Translation here is keyed on a transcript_id from the async /v2/transcript
 * pipeline, so it can't run per-turn in a live conversation. What it gives you
 * instead is the whole record: speaker-labelled, 100+ target languages, several
 * at once, with formality control — from a single request.
 *
 * For iTranslate that maps to an obvious feature: email me the conversation.
 *
 * Takes a WAV body (built client-side from the PCM we already buffered for
 * streaming) and returns speaker-labelled utterances with their translations.
 */

export const dynamic = "force-dynamic";
/** Transcription plus translation on a few minutes of audio can outrun the default. */
export const maxDuration = 300;

const API_BASE = "https://api.assemblyai.com/v2";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 240_000;

type Utterance = {
  speaker: string;
  text: string;
  translated_texts?: Record<string, string>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "ASSEMBLYAI_API_KEY is not set." }, { status: 503 });
  }

  const url = new URL(request.url);
  const targets = (url.searchParams.get("targets") ?? "es")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const formal = url.searchParams.get("formal") === "true";
  const matchOriginal = url.searchParams.get("matchOriginal") !== "false";

  const audio = await request.arrayBuffer();
  if (audio.byteLength < 1024) {
    return Response.json({ error: "No audio was recorded." }, { status: 400 });
  }

  const auth = { Authorization: apiKey };

  try {
    // 1. Upload the raw WAV.
    const uploadRes = await fetch(`${API_BASE}/upload`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: audio,
    });
    if (!uploadRes.ok) {
      throw new Error(`Upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
    }
    const { upload_url } = (await uploadRes.json()) as { upload_url: string };

    // 2. Transcribe and translate in one request. speech_understanding rides
    //    along with the transcription rather than being a second job.
    const createRes = await fetch(`${API_BASE}/transcript`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_url: upload_url,
        // Async takes a plural array here. The streaming socket uses the
        // singular `speech_model` — the two APIs differ, and the async one
        // rejects the singular form outright.
        speech_models: ["universal-3-5-pro"],
        language_detection: true,
        speaker_labels: true,
        speech_understanding: {
          request: {
            translation: {
              target_languages: targets,
              formal,
              // Keeps translations aligned to the original utterances so the
              // two columns line up in the UI.
              match_original_utterance: matchOriginal,
            },
          },
        },
      }),
    });
    if (!createRes.ok) {
      throw new Error(`Transcript request failed (${createRes.status}): ${await createRes.text()}`);
    }
    const { id } = (await createRes.json()) as { id: string };

    // 3. Poll to completion.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const pollRes = await fetch(`${API_BASE}/transcript/${id}`, { headers: auth });
      if (!pollRes.ok) {
        throw new Error(`Poll failed (${pollRes.status}): ${await pollRes.text()}`);
      }

      const data = (await pollRes.json()) as {
        status: string;
        error?: string;
        text?: string;
        utterances?: Utterance[];
        translated_texts?: Record<string, string>;
      };

      if (data.status === "error") throw new Error(data.error ?? "Transcription failed.");
      if (data.status !== "completed") continue;

      return Response.json({
        id,
        text: data.text ?? "",
        translatedTexts: data.translated_texts ?? {},
        utterances: (data.utterances ?? []).map((u) => ({
          speaker: u.speaker,
          text: u.text,
          translations: u.translated_texts ?? {},
        })),
        targets,
      });
    }

    throw new Error("Timed out waiting for the transcript.");
  } catch (err) {
    console.error("[transcript-translate]", err);
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
