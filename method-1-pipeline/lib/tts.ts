/**
 * Speaking the translation, with a fallback that keeps the demo alive.
 *
 * Primary path is ElevenLabs Flash v2.5 through /api/tts. If the key is missing
 * (503) or the call fails for any reason, we fall through to the browser's own
 * speechSynthesis. It sounds worse, but a demo that degrades is infinitely
 * better than a demo that stops talking in front of a customer.
 *
 * Resolves when playback has actually finished, because the caller un-mutes the
 * microphone off the back of that.
 */

export type SpeakResult = {
  voice: "elevenlabs" | "browser" | "none";
  /** Request to first audio byte. Null when the browser voice handled it. */
  ttfbMs: number | null;
};

/**
 * Fires the instant before sound reaches the speakers. The caller mutes the
 * microphone on this, which is the difference between a working demo and an
 * infinite translation loop.
 */
export type OnPlaybackStart = () => void;

/** Resolves once, when the voice list is actually populated. */
function browserVoices(): Promise<SpeechSynthesisVoice[]> {
  const existing = speechSynthesis.getVoices();
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1000);
  });
}

async function speakWithBrowser(
  text: string,
  languageCode: string,
  onStart: OnPlaybackStart,
): Promise<void> {
  if (typeof speechSynthesis === "undefined") return;

  const voices = await browserVoices();
  const match =
    voices.find((v) => v.lang.toLowerCase().startsWith(languageCode.toLowerCase())) ?? null;

  await new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    if (match) utterance.voice = match;
    utterance.lang = match?.lang ?? languageCode;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    onStart();
    speechSynthesis.speak(utterance);
  });
}

async function speakWithElevenLabs(
  text: string,
  languageCode: string,
  onStart: OnPlaybackStart,
): Promise<{ ttfbMs: number }> {
  const startedAt = performance.now();

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, languageCode }),
  });
  if (!res.ok || !res.body) throw new Error(`tts ${res.status}`);

  // Read the first chunk to get an honest time-to-first-byte, then collect the
  // rest. These clips are a few tens of KB, so buffering fully before playing
  // costs very little and avoids the fragility of MediaSource streaming.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let ttfbMs = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!chunks.length) ttfbMs = performance.now() - startedAt;
    chunks.push(value);
  }
  if (!chunks.length) throw new Error("tts returned no audio");

  const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "audio/mpeg" }));
  try {
    const audio = new Audio(url);
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("playback failed"));
      onStart();
      audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  return { ttfbMs };
}

export async function speak(
  text: string,
  languageCode: string,
  onStart: OnPlaybackStart = () => {},
): Promise<SpeakResult> {
  if (!text.trim()) return { voice: "none", ttfbMs: null };

  try {
    const { ttfbMs } = await speakWithElevenLabs(text, languageCode, onStart);
    return { voice: "elevenlabs", ttfbMs };
  } catch {
    try {
      await speakWithBrowser(text, languageCode, onStart);
      return { voice: "browser", ttfbMs: null };
    } catch {
      return { voice: "none", ttfbMs: null };
    }
  }
}
