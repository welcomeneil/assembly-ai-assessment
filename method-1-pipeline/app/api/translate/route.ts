/**
 * Stage two of the pipeline: transcript in, translation out.
 *
 * The architecture follows AssemblyAI's own guide —
 * https://www.assemblyai.com/docs/streaming/guides/real_time_translation
 * — a separate REST call fired on `end_of_turn: true`, with the result read
 * from choices[0].message.content.
 *
 * The *gateway* is swappable (see lib/translation-provider.ts). AssemblyAI's
 * LLM Gateway is a separate paid entitlement from transcription, so a key that
 * streams audio fine can still 401 here. Every supported provider speaks the
 * OpenAI chat-completions shape, so switching costs an env var, not a rewrite,
 * and the stage keeps working while entitlement is sorted out.
 *
 * Worth knowing for the conversation with iTranslate: AssemblyAI *also* has a
 * first-class Translation API under Speech Understanding, and it is not this
 * one. That is keyed on a transcript_id from the async /v2/transcript pipeline,
 * so it cannot sit in a realtime loop — but it does 100+ languages with speaker
 * labels and formality control. We use it in /api/transcript-translate for the
 * post-conversation record.
 */

import { resolveProvider } from "@/lib/translation-provider";

export const dynamic = "force-dynamic";

type Side = { code: string; name: string };
type Body = {
  text?: string;
  a?: Side;
  b?: Side;
  /** Which side the speaker used, when language detection was trustworthy. */
  sourceCode?: string | null;
};

/** Models like to wrap JSON in fences however firmly you ask them not to. */
function parseLoose(content: string): { source?: string; translation?: string } | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const resolved = resolveProvider();
  if (!resolved) {
    return Response.json(
      { error: "No translation provider is configured. Set GEMINI_API_KEY in .env.local." },
      { status: 503 },
    );
  }
  const { id, provider, apiKey, model } = resolved;

  const { text, a, b, sourceCode } = (await request.json()) as Body;
  if (!text?.trim() || !a || !b) {
    return Response.json({ error: "text, a and b are required." }, { status: 400 });
  }

  // Two modes. When the streaming API told us which language it heard, and that
  // language is one of the two in play, we just name both ends — one sentence,
  // fastest, no ambiguity.
  //
  // When it didn't (a null code, or a language outside the pair — this API has
  // been seen returning low-confidence French on an en/es conversation), we ask
  // the model to identify the direction as well. It costs a few tokens and it
  // means a bad label can never send the translation to the wrong language.
  const known = sourceCode === a.code || sourceCode === b.code;
  const source = sourceCode === a.code ? a : b;
  const target = sourceCode === a.code ? b : a;

  const prompt = known
    ? `Translate the text from ${source.name} into ${target.name}. Output only the ` +
      `translation — no preamble, no quotes, no explanation. Preserve names, numbers, ` +
      `and place names exactly.\n\nText: ${text}`
    : `The text below is one turn of a conversation held in ${a.name} and ${b.name}. ` +
      `Work out which of those two it is in, then translate it into the other one. ` +
      `Preserve names, numbers, and place names exactly.\n\n` +
      `Reply with JSON only, no code fence: ` +
      `{"source":"${a.code}" or "${b.code}","translation":"..."}\n\nText: ${text}`;

  const res = await fetch(provider.url, {
    method: "POST",
    headers: {
      Authorization: provider.authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[translate] ${id} ${res.status}: ${detail}`);

    // A 401 here usually means entitlement, not a bad key — AssemblyAI gates the
    // LLM Gateway separately from transcription. Naming that saves a hunt
    // through a pipeline that isn't broken.
    if (res.status === 401 && id === "assemblyai") {
      return Response.json(
        {
          error:
            "LLM Gateway isn't enabled on this AssemblyAI key. Transcription and the batch " +
            "Translation API still work — this is an account entitlement, not a code problem. " +
            "Set GEMINI_API_KEY in .env.local to route translation elsewhere.",
        },
        { status: 502 },
      );
    }

    return Response.json(
      { error: `Translation failed via ${provider.label} (${res.status}).` },
      { status: 502 },
    );
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    return Response.json({ error: "The gateway returned no translation." }, { status: 502 });
  }

  if (known) {
    return Response.json({
      translation: content,
      sourceCode: source.code,
      targetCode: target.code,
    });
  }

  const parsed = parseLoose(content);
  // If the model ignored the JSON instruction, fall back to treating the whole
  // reply as the translation and assume the a→b direction. Still useful output.
  const detected = parsed?.source === b.code ? b : a;
  return Response.json({
    translation: parsed?.translation?.trim() || content,
    sourceCode: detected.code,
    targetCode: detected.code === a.code ? b.code : a.code,
  });
}
