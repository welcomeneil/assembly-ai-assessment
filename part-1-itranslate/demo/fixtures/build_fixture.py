#!/usr/bin/env python3
"""Build the demo fixture from the Bangor Miami CHAT transcript.

The demo needs organic bilingual speech, not TTS. This reads herring1.cha from the
Bangor Miami corpus and produces two artifacts:

  herring1-excerpt.json   the replayed session the dashboard shows with no API key
  reference.txt           the gold transcript live mode scores against

Everything mechanical -- timings, word-level language tags, CHAT normalisation -- comes
straight out of the corpus. Two things are editorial and marked as such below: the turn
grouping (which CHAT utterances a real endpointer would merge) and the simulated ASR
output, which is what makes the no-key fixture a simulation rather than a measurement.

Usage:  python3 build_fixture.py path/to/herring1.cha
        ./fetch_sample.sh calls this for you.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# The window: utterances 262-292 of herring1, ~45 seconds. Chosen because it is dense
# with exactly what breaks a translation device -- place and person names, spoken money
# amounts, and two genuine mid-sentence switches between English and Spanish.
FIRST_UTTERANCE = 262
LAST_UTTERANCE = 292

# EDITORIAL 1: turn grouping. A CHAT utterance is not an ASR turn. These groups are
# quoted speech split across CHAT lines (`+"/.` sets up a quote, `+"` carries it), which
# a real endpointer hears as one continuous turn.
MERGE_GROUPS = [(265, 266, 267), (272, 273), (277, 278)]

# Non-speech events. voice_focus suppresses these rather than emitting a turn for them.
DROP = {268, 287, 290}

# Spanish for the English turns. The reverse direction (English for the Spanish turns)
# is not invented -- it comes from the corpus's own %eng tier, transcribed by hand at
# Bangor University.
SPANISH = {
    262: "les dieron una lista",
    263: "van a ir a Boston",
    264: "van a ir a Washington",
    265: "van a ir — y el marido dice: «y ¡ay!» «¿estás bien?», o sea",
    269: "ya sabes, después de un rato",
    270: "¡hola!",
    271: "él estaba como",
    272: "sí, él dice: «¿vas a viajar por todo el país con Paige?»",
    275: "¡ah!",
    276: "así que de verdad va a",
    277: "yo estaba como: «creo que me voy a apuntar»",
    279: "lo único es que no vuelan a Canadá, así que yo estaba como",
    280: "sí",
    281: "pero vuelan a Chicago",
    282: "tienen Chicago desde Fort Lauderdale",
    283: "por cuarenta y cuatro — ochenta y ocho dólares ida y vuelta",
    284: "Fernando desde Nicaragua pagó, creo que fue como ciento dos o algo así, algo ridículo",
    285: "billete de ida y vuelta a Jamaica, a Kingston, donde vive Michael: ciento nueve",
    286: "está bien",
    288: "¿y qué pasó en el trabajo?",
    289: "necesito un",
    292: "es ridículo",
}

# EDITORIAL 2: the simulated ASR output. Keyed by the turn's first utterance number,
# this is what the tuned configuration is shown returning. Anything not listed comes
# back matching the reference.
#
# These are the errors a well-configured session still makes on this audio, and they are
# deliberately not zero -- a perfect transcript of two people talking over each other in
# a 2008 restaurant recording would be a tell that the fixture was invented. They cluster
# where real recognisers actually slip: false starts collapsed, a repeated word dropped,
# a trailing word lost under overlapping speech. Roughly 7% word error rate overall.
#
# What stays clean is what the demo actually claims: every keyterm lands, and all three
# mid-sentence language switches transcribe correctly. Those are the levers being sold.
SIMULATED_ASR = {
    # False start collapsed, and the Spanish interjection loses its first word.
    265: "they're going to and the husband's like ay are you ok like",
    # Punctuation the model adds that the corpus transcript does not have. Not an error.
    269: "you know, like, after a while",
    # Overlaps almost entirely with the previous speaker; the first word is lost.
    271: "was like",
    # Retracing cleaned up: "your whole" -> "the whole" is heard once, not twice.
    272: "yeah he says are you gonna travel the whole country with Paige",
    # The corpus marks this stretch unintelligible, so it is shown but not scored.
    276: "so it's really gonna",
    # Trailing "like" lost as the speaker tails off into the next turn.
    279: "the only thing is they don't fly to Canada so I'm",
    # Stuttered word heard once.
    281: "but they fly to Chicago",
    284: "Fernando from Nicaragua, he paid, I think it was like one hundred two "
         "or something like that, it's ridiculous",
    # "one one oh nine" -- the repeated digit is dropped.
    285: "Jamaica round trip ticket to Kingston where Michael stays one oh nine",
    # Cut off by the other speaker.
    289: "I need",
}

# The device builds these itself from GPS, the selected domain and the traveller's
# itinerary. No user types any of it. See config.ts for the same values in TypeScript.
PROMPT = (
    "Informal conversation between two bilingual English and Spanish speakers in a "
    "restaurant in Miami, planning a trip. They switch between English and Spanish "
    "mid-sentence. Cities, airlines and ticket prices are discussed."
)

KEYTERMS = [
    "Fort Lauderdale", "Kingston", "Nicaragua", "Jamaica",
    "Chicago", "Boston", "Washington", "Paige", "Fernando", "Michael", "Lauren",
]

# ---------------------------------------------------------------------------
# CHAT normalisation
# ---------------------------------------------------------------------------

# CHAT markers, stripped in this order. The guiding rule for an ASR reference is: keep
# every word that was actually spoken out loud, drop everything that is annotation.
_TIMING = re.compile(r"\x15(\d+)_(\d+)\x15")
_LANG_TAG = re.compile(r"@s:[a-z&+]+")           # word-level language tag
_EVENT = re.compile(r"&=\S+")                     # &=laugh, &=mumble -- not speech
_FRAGMENT = re.compile(r"&\S+")                   # &hə, &ʤo -- phonological fragments
_SCOPE = re.compile(r"[<>]")                      # scoping brackets around retracings
_BRACKETED = re.compile(r"\[[^\]]*\]")            # [/] [//] [///] [?] [- spa] [: x]
_PAUSE = re.compile(r"\(\.+\)")                   # (.) (..) (...)
_UNSPOKEN = re.compile(r"\(([^)]*)\)")            # (be)cause -- material NOT pronounced
# Longest first: `+"/.` must not be consumed as `+"` followed by a stray `/.`
_QUOTE = re.compile(r'\+"/\.|\+/\.|\+\.\.\.|\+["<,^]')
_PUNCT_ONLY = re.compile(r"^[\s.!?,]*$")


def normalise(raw: str) -> str:
    """CHAT utterance -> the words a recogniser would have to produce."""
    text = _TIMING.sub("", raw)
    text = _LANG_TAG.sub("", text)
    text = _QUOTE.sub(" ", text)
    text = _BRACKETED.sub(" ", text)
    text = _EVENT.sub(" ", text)
    text = _FRAGMENT.sub(" ", text)
    text = _PAUSE.sub(" ", text)
    text = _UNSPOKEN.sub("", text)          # (be)cause -> cause
    text = _SCOPE.sub(" ", text)
    text = text.replace("_", " ")           # Fort_Lauderdale -> Fort Lauderdale
    text = re.sub(r"\s+([.!?,])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_cha(path: Path) -> list[dict]:
    """Read a CHAT file into utterances, joining tab-continued lines."""
    lines: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").split("\n"):
        if line.startswith("\t") and lines:
            lines[-1] += " " + line.strip()
        else:
            lines.append(line)

    utterances: list[dict] = []
    current: dict | None = None
    for line in lines:
        speaker = re.match(r"^\*([A-Z]{3}):\t(.*)$", line)
        if speaker:
            raw = speaker.group(2)
            bullet = _TIMING.search(raw)
            current = {
                "n": len(utterances) + 1,
                "speaker": speaker.group(1),
                "raw": raw,
                "start": int(bullet.group(1)) if bullet else 0,
                "end": int(bullet.group(2)) if bullet else 0,
                "eng": None,
            }
            utterances.append(current)
            continue
        translation = re.match(r"^%eng:\t(.*)$", line)
        if translation and current is not None:
            current["eng"] = translation.group(1).strip().rstrip(".")
    return utterances


def _languages_in(raw: str) -> list[str]:
    """Per-word language evidence for a single CHAT utterance.

    `[- spa]` heads a Spanish utterance and scopes to that utterance only -- which is
    why this runs per utterance and not over a merged turn. `@s:spa` tags an individual
    Spanish word. `@s:eng&spa` means the corpus could not attribute the word to either
    language (proper nouns, mostly), so it is evidence for neither.
    """
    spanish_utterance = "[- spa]" in raw
    languages: list[str] = []
    for token in raw.split():
        tag = re.search(r"@s:([a-z&+]+)", token)
        if tag is None:
            if re.match(r"^[&<>+\[(\x15]", token) or _PUNCT_ONLY.match(token):
                continue
            # Untagged words are English, unless this utterance is headed [- spa].
            languages.append("es" if spanish_utterance else "en")
        elif tag.group(1) == "spa":
            languages.append("es")
        elif tag.group(1) == "eng":
            languages.append("en")
    return languages


def language_of(parts: list[dict]) -> tuple[str, bool]:
    """Turn-level language label, plus whether the language changed inside the turn."""
    languages = [lang for p in parts for lang in _languages_in(p["raw"])]
    if not languages:
        return "en", False
    switched = len(set(languages)) > 1
    # One label per turn, as the API returns. Whichever language carries the turn wins;
    # the first attributable word breaks a tie.
    dominant = max(sorted(set(languages), key=languages.index), key=languages.count)
    return dominant, switched


def build(cha_path: Path) -> dict:
    utterances = parse_cha(cha_path)
    by_number = {u["n"]: u for u in utterances}

    merged_into = {n: group[0] for group in MERGE_GROUPS for n in group[1:]}
    origin = utterances[FIRST_UTTERANCE - 1]["start"]

    turns: list[dict] = []
    for n in range(FIRST_UTTERANCE, LAST_UTTERANCE + 1):
        if n in DROP or n in merged_into or n not in by_number:
            continue

        group = [n] + [m for m, head in merged_into.items() if head == n]
        parts = [by_number[m] for m in sorted(group)]

        raw = " ".join(p["raw"] for p in parts)
        reference = normalise(raw)
        if not reference or _PUNCT_ONLY.match(reference):
            continue

        language, switched = language_of(parts)
        unintelligible = "xxx" in reference
        reference = re.sub(r"\s*\bxxx\b\s*", " ", reference)
        reference = re.sub(r"\s+([.!?,])", r"\1", reference).strip()

        # Direction of translation follows the detected language, which is the whole
        # point: nothing on the device had to be told which way round to go.
        target = "es" if language == "en" else "en"
        if target == "en":
            translation = next((p["eng"] for p in parts if p["eng"]), None)
            translation_source = "corpus %eng tier (human)"
        else:
            translation = SPANISH.get(n)
            translation_source = "written for the fixture"

        transcript = SIMULATED_ASR.get(n, reference.rstrip(".!?"))

        turns.append({
            "order": len(turns) + 1,
            "speaker": parts[0]["speaker"],
            "utterances": group,
            "audioStartMs": parts[0]["start"] - origin,
            "audioEndMs": max(p["end"] for p in parts) - origin,
            "reference": reference,
            "transcript": transcript,
            "languageCode": language,
            "midTurnSwitch": switched,
            "unintelligible": unintelligible,
            "translation": translation,
            "translationSource": translation_source,
            "target": target,
        })

    return {
        "meta": {
            "simulated": True,
            "corpus": "Bangor Miami corpus (Deuchar et al.), file herring1",
            "situation": "Informal conversation between two cousins in a restaurant, "
                         "Miami, 8 March 2008",
            "window": f"utterances {FIRST_UTTERANCE}-{LAST_UTTERANCE}",
            "audioStartMs": origin,
            "audioEndMs": by_number[LAST_UTTERANCE]["end"],
            "audioFile": "herring1.wav",
            "real": [
                "the audio and its timings",
                "the reference transcript",
                "the per-turn language labels",
                "the English translations of the Spanish turns (corpus %eng tier)",
            ],
            "simulatedParts": [
                "the recogniser output (constructed, not measured)",
                "the per-stage latency figures",
                "the Spanish translations of the English turns",
            ],
        },
        "session": {"prompt": PROMPT, "keyterms": KEYTERMS},
        "turns": turns,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    cha_path = Path(sys.argv[1])
    if not cha_path.exists():
        print(f"not found: {cha_path}", file=sys.stderr)
        print("run ./fetch_sample.sh to download the corpus first", file=sys.stderr)
        return 1

    fixture = build(cha_path)
    out_dir = Path(__file__).parent

    (out_dir / "herring1-excerpt.json").write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    reference = "\n".join(t["reference"] for t in fixture["turns"]) + "\n"
    (out_dir / "reference.txt").write_text(reference, encoding="utf-8")

    turns = fixture["turns"]
    switches = sum(1 for i in range(1, len(turns))
                   if turns[i]["languageCode"] != turns[i - 1]["languageCode"])
    span = (fixture["meta"]["audioEndMs"] - fixture["meta"]["audioStartMs"]) / 1000
    print(f"{len(turns)} turns, {span:.1f}s of audio, "
          f"{switches} language switches, "
          f"{sum(1 for t in turns if t['midTurnSwitch'])} of them mid-turn")
    print(f"wrote {out_dir / 'herring1-excerpt.json'}")
    print(f"wrote {out_dir / 'reference.txt'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
