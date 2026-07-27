/**
 * The streaming configuration, and why each parameter is set the way it is.
 *
 * This lives on the server rather than in device firmware on purpose. A consumer
 * handheld takes months to roll a firmware update across a fleet, so anything baked in
 * is frozen for months. Served from here, the model, the noise setting and the turn
 * thresholds can change for every device at once -- or for 1% of them first.
 */

export interface DeviceContext {
  /** Where the device is, from GPS. */
  location: string;
  /** What the user picked on the device, or what the itinerary implies. */
  situation: string;
  /** Names the device already knows: contacts, hotel bookings, saved places. */
  knownNames: string[];
  /** The language pair the conversation is running in. */
  pair: [string, string];
}

/**
 * Build the `prompt` value.
 *
 * Not sent by default, and this is the most interesting result in the demo.
 *
 * AssemblyAI's prompting guide reports, over 20,000 real calls, that a detailed prompt
 * cuts word error rate 21% and entity error rate 29%. On the sample here it did the
 * opposite: 29.2% -> 33.3% word error rate, identical across three runs. Reproducible,
 * so not noise.
 *
 * A plausible reason is that the prompt is written in English while most of the audio
 * is Spanish, so it biases the recogniser the wrong way -- but that is a hypothesis,
 * not a finding, and it is one clip. The honest conclusion is narrower: a published
 * benchmark is a reason to test a lever, not a reason to ship it. iTranslate should
 * measure this on their own audio before turning it on.
 *
 * Kept here, and reachable through the API, because it is the first thing to re-test
 * on their recordings -- a handheld already knows everything needed to write one: GPS
 * gives the location, the user picked the situation, the itinerary supplies the names.
 */
export function buildPrompt(context: DeviceContext): string {
  const [from, to] = context.pair;
  const languages = `${languageName(from)} and ${languageName(to)}`;
  const names =
    context.knownNames.length > 0
      ? ` Names likely to come up: ${context.knownNames.slice(0, 6).join(", ")}.`
      : "";
  return (
    `${context.situation} The speakers are in ${context.location} and switch between ` +
    `${languages}, sometimes within a single sentence.${names}`
  );
}

/**
 * Build `keyterms_prompt`.
 *
 * This is the lever that actually paid on the sample: 29.2% -> 25.9% word error rate
 * over three runs, and it is what puts the landmark names on screen correctly.
 *
 * Limits are 100 terms per session, 50 characters each. Common words are left out --
 * they are already well represented in training data, and spending the budget on them
 * displaces the proper nouns that users actually notice getting mangled.
 */
export function buildKeyterms(context: DeviceContext): string[] {
  return context.knownNames
    .filter((term) => term.length <= 50)
    .slice(0, 100);
}

/**
 * The connection parameters, as they go on the WebSocket query string.
 *
 * Every one of these is a deliberate choice for a battery-powered handheld held at
 * arm's length between two people, which is a different problem from a headset on a
 * call-centre agent.
 */
export function buildParams(context: DeviceContext): Record<string, string> {
  return {
    // Universal-3.5 Pro is the only streaming model that takes a prompt, does
    // voice focus, and follows a language switch inside a single turn.
    speech_model: "universal-3-5-pro",

    // Both languages declared up front. The device is not told which one is coming.
    //
    // This is an array parameter and has to be JSON-encoded on the query string. A
    // comma-joined string is rejected with `Invalid 'language_codes.0'`, which is easy
    // to misread as "the language is unsupported" rather than "the encoding is wrong" --
    // the server parsed "en,es" as a single code. Repeated `language_codes=` params
    // work too; both are verified against the live API.
    language_codes: JSON.stringify(context.pair),

    // This is what removes the language button: every turn comes back tagged with the
    // language it was actually spoken in, plus a confidence.
    language_detection: "true",

    // Deliberately left at their defaults: `voice_focus`, `mode` and `min_turn_silence`.
    //
    // All three were in an earlier version of this config on the reasoning that a
    // handheld held at arm's length is far-field audio and that a translator can afford
    // latency. Measured on the sample, that combination cost 4.8 points of word error
    // rate and collapsed 10 turns into 6 -- `min_turn_silence: 480` merged turns that
    // the default splits correctly. See fixtures/MEASUREMENTS.md.
    //
    // They may still be right for iTranslate's real device audio, which is not what
    // this corpus recording is. That is a question for their 30 minutes of recordings,
    // not for my reasoning about their hardware.

    // 16 kHz mono PCM is what the device's microphone path produces.
    encoding: "pcm_s16le",
    sample_rate: "16000",

    // Cheap insurance on cellular: notice a dead connection instead of waiting on it.
    session_heartbeat: "true",

    // The lever that measured well. Array parameter, JSON-encoded like language_codes.
    keyterms_prompt: JSON.stringify(buildKeyterms(context)),
  };

  // Deliberately not set: `llm_gateway`. AssemblyAI can carry the translation on this
  // same socket, and there is a decent latency argument for it -- but iTranslate asked
  // about recognition accuracy and already has a translation stack. This demo stays on
  // the thing they asked about. Translation and text-to-speech remain theirs.
}

function languageName(code: string): string {
  const names: Record<string, string> = {
    en: "English",
    es: "Spanish",
    de: "German",
    fr: "French",
    pt: "Portuguese",
    it: "Italian",
  };
  return names[code] ?? code;
}

/**
 * The context for the bundled sample: a family talking about a cruise to France and a
 * day trip to Paris, switching between Spanish and English throughout. In production
 * the device fills this in from GPS, the selected situation and the itinerary.
 */
export const SAMPLE_CONTEXT: DeviceContext = {
  location: "France",
  situation: "A family talking about a cruise from England to France and a day trip " +
    "to Paris, discussing ships, ports, tour times and landmarks.",
  knownNames: [
    "Torre Eiffel",
    "Notre Dame",
    "Arco del Triunfo",
    "Louvre",
    "Guggenheim",
    "Francia",
    "Paris",
    "English channel",
  ],
  pair: ["en", "es"],
};
