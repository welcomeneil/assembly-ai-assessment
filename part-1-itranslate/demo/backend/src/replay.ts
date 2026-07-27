/**
 * Scripted conversation for the dashboard.
 *
 * This exists so the demo can be shown with no API key, no microphone and no network. An
 * account executive should be able to run one command, open a browser and have something to
 * point at. Every event it emits is labelled `simulated: true`, and the dashboard displays a
 * banner saying the data is scripted. Nothing here should ever be presented as measured.
 *
 * The conversation is a tourist and a market vendor in Madrid. It is chosen to show three
 * things in order:
 *
 *   1. Neither person touches a language button. The badge on each turn is what AssemblyAI
 *      detected, not what somebody selected.
 *   2. Proper nouns that a general model gets wrong come back correct, because the device
 *      put them in the context prompt from its own GPS and itinerary data.
 *   3. The last turn switches language mid-sentence. A language-pinned session cannot do
 *      this; it transcribes the English fragment as broken Spanish.
 *
 * Latency figures are plausible values in the range AssemblyAI documents, not measurements.
 */

import type { EventBus, TurnEvent, SessionEvent } from "./events.js";

interface ScriptedTurn {
  language: string;
  languageConfidence: number;
  transcript: string;
  targetLanguage: string;
  translation: string;
  sttMs: number;
  translateMs: number;
  ttsMs: number;
  /** Optional note the dashboard highlights, used to call out what just happened. */
  note?: string;
}

const SCRIPT: ScriptedTurn[] = [
  {
    language: "en", languageConfidence: 0.99,
    transcript: "Hi, do you sell the jamón ibérico by the gram or by the plate?",
    targetLanguage: "es",
    translation: "Hola, ¿vende el jamón ibérico por gramo o por plato?",
    sttMs: 384, translateMs: 291, ttsMs: 88,
  },
  {
    language: "es", languageConfidence: 0.98,
    transcript: "Por gramo, señor. Cien gramos son doce euros con cincuenta.",
    targetLanguage: "en",
    translation: "By the gram, sir. A hundred grams is twelve euros fifty.",
    sttMs: 402, translateMs: 268, ttsMs: 74,
    note: "Language switched with no input from either speaker.",
  },
  {
    language: "en", languageConfidence: 0.99,
    transcript: "Perfect, I'll take two hundred grams. Can you vacuum seal it?",
    targetLanguage: "es",
    translation: "Perfecto, me llevo doscientos gramos. ¿Puede sellarlo al vacío?",
    sttMs: 356, translateMs: 302, ttsMs: 91,
  },
  {
    language: "es", languageConfidence: 0.97,
    transcript: "Claro que sí. ¿Lo va a llevar en avión? Necesita el sellado para eso.",
    targetLanguage: "en",
    translation: "Of course. Are you taking it on a plane? You need it sealed for that.",
    sttMs: 441, translateMs: 274, ttsMs: 82,
  },
  {
    language: "en", languageConfidence: 0.99,
    transcript: "Yes, I fly back Thursday. I'm at the Hotel Catalonia until then.",
    targetLanguage: "es",
    translation: "Sí, vuelo de regreso el jueves. Estoy en el Hotel Catalonia hasta entonces.",
    sttMs: 372, translateMs: 288, ttsMs: 79,
    note: "\"Hotel Catalonia\" came from the device's itinerary, via the context prompt.",
  },
  {
    language: "es", languageConfidence: 0.98,
    transcript: "Muy bien. Elena, ¿me pasas el sellador, por favor?",
    targetLanguage: "en",
    translation: "Very good. Elena, can you pass me the sealer, please?",
    sttMs: 318, translateMs: 251, ttsMs: 71,
    note: "\"Elena\" is in the context prompt too. Person-name errors drop sharply with it.",
  },
  {
    language: "en", languageConfidence: 0.98,
    transcript: "Could you recommend a wine that goes with this?",
    targetLanguage: "es",
    translation: "¿Podría recomendarme un vino que vaya bien con esto?",
    sttMs: 341, translateMs: 264, ttsMs: 77,
  },
  {
    language: "es", languageConfidence: 0.91,
    transcript: "Sí, un Rioja crianza. Le pongo una botella, is perfect for the jamón.",
    targetLanguage: "en",
    translation: "Yes, a Rioja crianza. I'll get you a bottle, it's perfect for the jamón.",
    sttMs: 468, translateMs: 316, ttsMs: 86,
    note: "Mid-sentence switch into English. A language-pinned session mangles this.",
  },
];

/** Split a sentence into growing prefixes, the way a streaming partial actually arrives. */
function partials(text: string, steps: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  for (let i = 1; i <= steps; i++) {
    const upTo = Math.max(1, Math.round((words.length * i) / steps));
    out.push(words.slice(0, upTo).join(" "));
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ReplayHandle {
  stop(): void;
}

/**
 * Push the scripted conversation onto the bus at conversational pace.
 * Returns a handle so a second Play press cancels the run in flight.
 */
export function startReplay(bus: EventBus, host: string): ReplayHandle {
  let cancelled = false;
  const startedAt = Date.now();

  const session: SessionEvent = {
    type: "session",
    sessionId: `replay-${startedAt.toString(36)}`,
    host,
    pair: ["en", "es"],
    params: {
      speech_model: "universal-3-5-pro",
      encoding: "pcm_s16le",
      sample_rate: "16000",
      language_codes: "en,es",
      language_detection: "true",
      voice_focus: "near-field",
      voice_focus_threshold: "0.7",
      mode: "min_latency",
      prompt:
        "Face-to-face conversation between two people speaking English and Spanish, " +
        "translated through a handheld device. Topic: travel. Location: Mercado de San " +
        "Miguel, Madrid. Names likely to be mentioned: Elena, Hotel Catalonia, jamón ibérico.",
    },
    appliedConfig: null,
    startedAt,
    simulated: true,
  };

  (async () => {
    bus.reset();
    bus.publish({ type: "status", state: "connecting", detail: "Requesting session token" });
    await sleep(500);
    if (cancelled) return;

    bus.publish(session);
    bus.publish({ type: "status", state: "live", detail: "Scripted conversation" });

    // Meter ticks once a second for the whole run, independent of the turn loop. This is the
    // point about billing: the connection clock keeps running whether anyone is talking or not.
    let audioSeconds = 0;
    const meter = setInterval(() => {
      if (cancelled) return;
      bus.publish({
        type: "meter",
        sessionSeconds: (Date.now() - startedAt) / 1000,
        audioSeconds,
      });
    }, 1000);

    try {
      for (const [index, turn] of SCRIPT.entries()) {
        if (cancelled) return;
        await sleep(650); // the beat before somebody starts talking

        const steps = 4;
        const speakingMs = 1400 + turn.transcript.length * 22;
        for (const text of partials(turn.transcript, steps)) {
          if (cancelled) return;
          bus.publish({ type: "partial", text });
          await sleep(speakingMs / steps);
        }
        audioSeconds += speakingMs / 1000;

        if (cancelled) return;
        bus.publish({ type: "partial", text: "" });

        const event: TurnEvent = {
          type: "turn",
          turnOrder: index,
          language: turn.language,
          languageConfidence: turn.languageConfidence,
          transcript: turn.transcript,
          targetLanguage: turn.targetLanguage,
          translation: turn.translation,
          timing: { sttMs: turn.sttMs, translateMs: turn.translateMs, ttsMs: turn.ttsMs },
          at: Date.now(),
          note: turn.note,
        };
        // Wait out the pipeline before showing the result, so the latency number on screen
        // matches how long the viewer actually waited.
        await sleep(turn.sttMs + turn.translateMs + turn.ttsMs);
        if (cancelled) return;
        bus.publish(event);
      }

      await sleep(900);
      if (cancelled) return;
      bus.publish({
        type: "status",
        state: "closed",
        detail: "Session closed after the conversation ended, which stops the billing clock",
        closeCode: 1000,
      });
    } finally {
      clearInterval(meter);
    }
  })();

  return {
    stop() {
      cancelled = true;
    },
  };
}
