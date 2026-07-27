#!/usr/bin/env python3
"""Build the gold reference transcript from the Bangor Miami CHAT file.

The demo scores live recognition against a human transcript. That transcript is this
script's only job -- it does not invent anything. The session shown in no-key mode is a
recording of a real AssemblyAI session (see capture_session.mjs), not a construction.

Outputs:
  reference.txt        one normalised line per gold utterance, what live mode scores against
  reference.json       the same plus per-utterance timings and language labels

Usage:  python3 build_reference.py path/to/sastre8.cha
        ../audio/fetch_sample.sh calls this for you.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# The window: utterances 849-874 of sastre8, 55.7 seconds.
#
# Chosen because it is the iTranslate use case almost exactly -- a grandmother explaining
# a cruise to Paris to a relative, switching between Spanish and English constantly, with
# landmark names a recogniser has to get right. 11 Spanish utterances, 15 English, 14
# switches between them, and nothing the transcribers marked unintelligible.
SOURCE_FILE = "sastre8"
FIRST_UTTERANCE = 849
LAST_UTTERANCE = 874
START_MS = 1_538_922
END_MS = 1_594_655

# The device builds these itself from GPS, the selected situation and the itinerary.
# The user types nothing. config.ts holds the same values for the TypeScript side.
PROMPT = (
    "A family talking about a cruise from England to France and a day trip to Paris. "
    "The speakers are bilingual and switch between Spanish and English mid-sentence. "
    "Ships, ports, tour times and Paris landmarks are discussed."
)

KEYTERMS = [
    "Torre Eiffel", "Notre Dame", "Arco del Triunfo", "Louvre", "Guggenheim",
    "Francia", "Paris", "English channel",
]

# ---------------------------------------------------------------------------
# CHAT normalisation
#
# The rule for an ASR reference: keep every word actually spoken out loud, drop
# everything that is transcriber annotation.
# ---------------------------------------------------------------------------

_TIMING = re.compile(r"\x15(\d+)_(\d+)\x15")
_LANG_TAG = re.compile(r"@s:[a-z&+]+")            # word-level language tag
_EVENT = re.compile(r"&=\S+")                      # &=laughs -- not speech
_FRAGMENT = re.compile(r"&\S+")                    # &hə -- phonological fragments
_SCOPE = re.compile(r"[<>]")                       # brackets scoping a retracing
_BRACKETED = re.compile(r"\[[^\]]*\]")             # [/] [//] [///] [?] [- spa]
_PAUSE = re.compile(r"\(\.+\)")                    # (.) (..)
_UNSPOKEN = re.compile(r"\(([^)]*)\)")             # (be)cause -- NOT pronounced
_QUOTE = re.compile(r'\+"/\.|\+//\.|\+/\.|\+\.\.\.|\+["<,^]')
_PUNCT_ONLY = re.compile(r"^[\s.!?,]*$")


def normalise(raw: str) -> str:
    text = _TIMING.sub("", raw)
    text = _LANG_TAG.sub("", text)
    text = _QUOTE.sub(" ", text)
    text = _BRACKETED.sub(" ", text)
    text = _EVENT.sub(" ", text)
    text = _FRAGMENT.sub(" ", text)
    text = _PAUSE.sub(" ", text)
    text = _UNSPOKEN.sub("", text)
    text = _SCOPE.sub(" ", text)
    text = text.replace("_", " ")
    text = re.sub(r"\s+([.!?,])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_cha(path: Path) -> list[dict]:
    lines: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="replace").split("\n"):
        if line.startswith("\t") and lines:
            lines[-1] += " " + line.strip()
        else:
            lines.append(line)

    utterances: list[dict] = []
    for line in lines:
        speaker = re.match(r"^\*([A-Z]{3}):\t(.*)$", line)
        if not speaker:
            continue
        raw = speaker.group(2)
        bullet = _TIMING.search(raw)
        utterances.append({
            "n": len(utterances) + 1,
            "speaker": speaker.group(1),
            "raw": raw,
            "start": int(bullet.group(1)) if bullet else 0,
            "end": int(bullet.group(2)) if bullet else 0,
        })
    return utterances


def language_of(raw: str) -> str:
    """The gold language label, from the corpus's own word-level tags.

    `[- spa]` heads a Spanish utterance. `@s:spa` tags an individual Spanish word.
    `@s:eng&spa` means the transcribers could not attribute the word to either language
    -- proper nouns, mostly -- so it counts for neither.
    """
    spanish_utterance = "[- spa]" in raw
    languages: list[str] = []
    for token in raw.split():
        tag = re.search(r"@s:([a-z&+]+)", token)
        if tag is None:
            if re.match(r"^[&<>+\[(\x15]", token) or _PUNCT_ONLY.match(token):
                continue
            languages.append("es" if spanish_utterance else "en")
        elif tag.group(1) == "spa":
            languages.append("es")
        elif tag.group(1) == "eng":
            languages.append("en")
    if not languages:
        return "es" if spanish_utterance else "en"
    return max(sorted(set(languages), key=languages.index), key=languages.count)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    cha_path = Path(sys.argv[1])
    if not cha_path.exists():
        print(f"not found: {cha_path}\nrun ../audio/fetch_sample.sh first", file=sys.stderr)
        return 1

    utterances = {u["n"]: u for u in parse_cha(cha_path)}
    out_dir = Path(__file__).parent

    gold = []
    for n in range(FIRST_UTTERANCE, LAST_UTTERANCE + 1):
        utterance = utterances.get(n)
        if utterance is None:
            continue
        text = normalise(utterance["raw"])
        if not text or _PUNCT_ONLY.match(text):
            continue
        gold.append({
            "utterance": n,
            "speaker": utterance["speaker"],
            "startMs": utterance["start"] - START_MS,
            "endMs": utterance["end"] - START_MS,
            "text": text,
            "language": language_of(utterance["raw"]),
        })

    (out_dir / "reference.txt").write_text(
        "\n".join(g["text"] for g in gold) + "\n", encoding="utf-8")
    (out_dir / "reference.json").write_text(json.dumps({
        "corpus": "Bangor Miami corpus (Deuchar et al.), file " + SOURCE_FILE,
        "window": f"utterances {FIRST_UTTERANCE}-{LAST_UTTERANCE}",
        "audioFile": "paris.wav",
        "startMs": START_MS,
        "endMs": END_MS,
        "prompt": PROMPT,
        "keyterms": KEYTERMS,
        "utterances": gold,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    spanish = sum(1 for g in gold if g["language"] == "es")
    switches = sum(1 for a, b in zip(gold, gold[1:]) if a["language"] != b["language"])
    print(f"{len(gold)} gold utterances, {(END_MS - START_MS) / 1000:.1f}s of audio")
    print(f"{spanish} Spanish / {len(gold) - spanish} English, {switches} language switches")
    print(f"wrote {out_dir / 'reference.txt'}")
    print(f"wrote {out_dir / 'reference.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
