# Measurements

Everything here was measured against the live AssemblyAI API on the bundled sample:
55.7 seconds of the Bangor Miami corpus, `sastre8` utterances 849–874. A family talking
about a cruise to France and a day in Paris, switching between Spanish and English
throughout. Scored against the corpus's human transcript (144 reference words).

One clip is one clip. These are directional, not conclusive — which is the point of
shipping the harness rather than the numbers.

## Accuracy levers

`universal-3-5-pro`, `language_codes=["en","es"]`, `language_detection=true`, three runs each.

| Config | WER (mean of 3) | Runs | Spread |
|---|---|---|---|
| bare | 29.2% | 29.2, 29.2, 29.2 | 0.0pt |
| **`keyterms_prompt`** | **25.9%** | 26.4, 25.7, 25.7 | 0.7pt |
| `prompt` | 33.3% | 33.3, 33.3, 33.3 | 0.0pt |
| `prompt` + `keyterms_prompt` | 29.9% | single run | — |
| all + `voice_focus=far-field` + `mode=max_accuracy` + `min_turn_silence=480` | 34.7% | single run | — |
| `universal-streaming-multilingual` + keyterms | 37.5% | single run | — |

**`keyterms_prompt` is the lever that paid: −3.3 points.** It is also what puts the
landmark names on screen correctly, which is the part a user notices.

**`prompt` cost 4.1 points**, reproducibly. AssemblyAI's prompting guide reports −21% WER
for a detailed prompt over 20,000 calls, so this is the opposite of the published result.
A plausible explanation is that the prompt is written in English while most of this audio
is Spanish, biasing the recogniser the wrong way — but that is a hypothesis. The
defensible conclusion is narrower: **a vendor benchmark is a reason to test a lever, not a
reason to ship it.**

**`voice_focus=far-field` and `min_turn_silence=480` both hurt.** I had reasoned my way
into them — a handheld held at arm's length *is* far-field, and two people passing a
device back and forth *do* pause longer. Measured, they cost 4.8 points and collapsed 10
turns into 6. The reasoning was about iTranslate's device; the audio is a 2008 home
recording. Both may still be right on real device audio. That is what their 30 minutes of
recordings are for.

## Language detection

The claim the demo rests on. The shipped recording: 10 turns, 25.7% WER over 144
reference words, `es`×7 / `en`×1 / `fr`×2, 4 switches between turns. Nothing selected a
language.

Three honest observations:

- **Two turns come back `fr`** — at 0.27 and 0.49 confidence, on Spanish and English
  speech — despite `language_codes` being `["en","es"]`. Declared languages do not
  constrain what detection may return. **Confidence is the usable signal**: a device
  should treat sub-0.7 as "don't switch the output voice".
- **Short turns carry little evidence.** The two-word opener scores 0.36.
- **The last turn's 2.3s latency is an artefact** of the audio file ending, not
  conversational lag. The median across turns is 351 ms.

## An earlier clip that did not work

The first version of this demo used `herring1` — two cousins talking over each other in a
restaurant. Live, it produced **one turn for the entire 45 seconds**, `en 1.00`, 41–46% WER,
and never detected Spanish at all.

Two causes, both worth knowing:

1. **Continuous overlapping speech never gives the endpointer silence to cut on.** No
   silence, no turn boundaries, so no per-turn language labels.
2. **That clip is 63% English** with only two Spanish utterances in the window. There was
   not enough Spanish for detection to have anything to report.

This is why the demo moved to `sastre8`. Worth saying out loud on a call: the clip that
demos well is the one whose audio actually resembles the customer's use case — two people
taking turns speaking *into* a device, not friends talking over each other.

## API details found by running it

- **`language_codes` is an array parameter** and must be JSON-encoded (`["en","es"]`) or
  sent as repeated `language_codes=` params. A comma-joined `en,es` is rejected with
  `Invalid 'language_codes.0'`, which reads like "unsupported language" but actually
  means "the server parsed your whole string as one code".
- **The API accepts 21 language codes** plus `multi`: en, es, de, fr, it, pt, tr, nl, sv,
  no, da, fi, hi, vi, ar, he, ja, ur, zh, ru, ko. AssemblyAI's multilingual-streaming blog
  post says six. I verified what the parameter validator accepts, not per-language
  quality — worth confirming which of the 21 are production-grade before promising any.
- **`prompt` is rejected on `universal-streaming-multilingual`** ("prompt is only
  supported with..."), despite the prompting guide listing that model as supported.
- **`language_codes=multi` silently switches the model** to
  `universal-streaming-multilingual`, which the `Begin` message's `configuration` echo
  reveals. Read that echo; it is the ground truth for what was actually applied.

## Reproducing

```bash
cd demo
./audio/fetch_sample.sh          # audio + reference transcript
export ASSEMBLYAI_API_KEY=...
npm run capture                  # records a fresh session into session.json
```

`src/score.ts` is the scoring engine and is unit tested (`npm test`, 15 tests). Point it
at the customer's audio and their transcript and it produces their numbers instead of
mine.

## A scoring bug worth recording

An earlier version of the dashboard showed 47.5% on a session that measured 25%. The
cause: it scored each turn separately and summed the results. Turn boundaries do not line
up with the reference's sentence boundaries, so per-turn alignments overlap and
double-count — the per-turn ops covered 390 words against a 144-word reference.

**Word error rate is only meaningful over one complete alignment.** The dashboard now
shows a single session number and a single diff, and `score.test.ts` asserts the
invariant that ops partition the reference exactly once.
