/**
 * The language matrix for the custom pipeline.
 *
 * Three different services constrain this, and they don't agree:
 *
 *   AssemblyAI Universal-Streaming  18 languages  (what we can hear)
 *   LLM Gateway translation         effectively unbounded
 *   ElevenLabs Flash v2.5           32 languages  (what we can say)
 *
 * The binding constraint is STT: we can only hear these 18. Of those, all but
 * Hebrew are also speakable by Flash v2.5, so 17 languages can be freely paired
 * in either direction. Hebrew transcribes and translates but has no voice, so a
 * turn translated *into* Hebrew is shown as text and not spoken.
 *
 * This is the whole reason Method 1 exists: any of these can pair with any other.
 * The Voice Agent API can only do the five English-paired combinations.
 */

export type Language = {
  code: string;
  name: string;
  flag: string;
  /** ElevenLabs Flash v2.5 can voice this. Everything except Hebrew. */
  canSpeak: boolean;
};

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", flag: "🇺🇸", canSpeak: true },
  { code: "es", name: "Spanish", flag: "🇪🇸", canSpeak: true },
  { code: "fr", name: "French", flag: "🇫🇷", canSpeak: true },
  { code: "de", name: "German", flag: "🇩🇪", canSpeak: true },
  { code: "it", name: "Italian", flag: "🇮🇹", canSpeak: true },
  { code: "pt", name: "Portuguese", flag: "🇵🇹", canSpeak: true },
  { code: "nl", name: "Dutch", flag: "🇳🇱", canSpeak: true },
  { code: "tr", name: "Turkish", flag: "🇹🇷", canSpeak: true },
  { code: "sv", name: "Swedish", flag: "🇸🇪", canSpeak: true },
  { code: "no", name: "Norwegian", flag: "🇳🇴", canSpeak: true },
  { code: "da", name: "Danish", flag: "🇩🇰", canSpeak: true },
  { code: "fi", name: "Finnish", flag: "🇫🇮", canSpeak: true },
  { code: "hi", name: "Hindi", flag: "🇮🇳", canSpeak: true },
  { code: "vi", name: "Vietnamese", flag: "🇻🇳", canSpeak: true },
  { code: "ar", name: "Arabic", flag: "🇸🇦", canSpeak: true },
  { code: "ja", name: "Japanese", flag: "🇯🇵", canSpeak: true },
  { code: "zh", name: "Chinese", flag: "🇨🇳", canSpeak: true },
  { code: "he", name: "Hebrew", flag: "🇮🇱", canSpeak: false },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function lang(code: string): Language {
  return (
    BY_CODE.get(code) ?? { code, name: code.toUpperCase(), flag: "🏳️", canSpeak: false }
  );
}
