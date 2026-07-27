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
 * This is the largest accuracy lever available and it costs nothing to turn on.
 * AssemblyAI's prompting guide reports, over 20,000 real calls: a domain-level prompt
 * cuts word error rate 5%, a scenario-level prompt 10%, and a detailed prompt 21% with
 * a 29% cut in entity error rate. Detailed means 20-50 words of plain prose describing
 * the audio -- not a keyword list, which is what `keyterms_prompt` is for.
 *
 * A handheld already knows everything needed to write one: GPS gives the location, the
 * user picked the situation, and the itinerary supplies the names. The user types
 * nothing.
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
    language_codes: context.pair.join(","),

    // This is what removes the language button: every turn comes back tagged with the
    // language it was actually spoken in, plus a confidence.
    language_detection: "true",

    // The device is held out between two people in a market, a station, a restaurant.
    // That is far-field audio with other voices in it, not a headset.
    voice_focus: "far-field",

    // A translation device can afford latency a voice agent cannot -- the user is
    // waiting for a sentence to be spoken back, not for a turn-taking cue. Spend it
    // on accuracy.
    mode: "max_accuracy",

    // Two people handing a device back and forth pause longer than one person
    // thinking. Ending the turn too early cuts the second half of a sentence.
    min_turn_silence: "480",

    // 16 kHz mono PCM is what the device's microphone path produces.
    encoding: "pcm_s16le",
    sample_rate: "16000",

    // Cheap insurance on cellular: notice a dead connection instead of waiting on it.
    session_heartbeat: "true",

    // Translate inside the streaming session. The alternative is shipping every final
    // turn back out to a second service and waiting on another round trip, which on a
    // cellular handheld is the difference between one network hop and three.
    llm_gateway: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content:
            `Translate the transcript between ${languageName(context.pair[0])} and ` +
            `${languageName(context.pair[1])}, into whichever of the two it is not ` +
            `already in. Reply with the translation only.\n\nTranscript: {{turn}}`,
        },
      ],
      max_tokens: 300,
    }),
  };
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
 * The context for the bundled sample: two bilingual cousins in a Miami restaurant
 * planning a trip. In production the device fills this in from GPS and the itinerary.
 */
export const SAMPLE_CONTEXT: DeviceContext = {
  location: "a restaurant in Miami",
  situation: "Informal conversation between two people planning a trip, discussing " +
    "cities, flights and ticket prices.",
  knownNames: [
    "Fort Lauderdale",
    "Kingston",
    "Nicaragua",
    "Jamaica",
    "Chicago",
    "Boston",
    "Washington",
    "Paige",
    "Fernando",
    "Michael",
    "Lauren",
  ],
  pair: ["en", "es"],
};
