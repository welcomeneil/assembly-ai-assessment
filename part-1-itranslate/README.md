# Part 1 — iTranslate

iTranslate wants better live speech-to-text on their handheld translator. This is a
dashboard of one tuned recognition session running end to end, scored against a human
transcript as it goes.

Scope is recognition only — they already own translation and text-to-speech.

The approach write-up is [APPROACH.md](APPROACH.md). The measured results are
[MEASUREMENTS.md](demo/fixtures/MEASUREMENTS.md). This page is how to run it.

---

## Run it

```bash
cd demo
npm install
npm run build && npm start
```

Open **http://localhost:8787** and press **Play session**. No API key needed — it
replays a **recording of a real AssemblyAI session**, at the timings it was captured at.

<details>
<summary>Run a fresh live session</summary>

```bash
cd demo
./audio/fetch_sample.sh                          # audio + reference transcript, ~24 MB
echo 'ASSEMBLYAI_API_KEY=your_key' > .env        # gitignored
npm start                                        # Play now runs live
npm run capture                                  # or re-record the offline session
```

Or run the handheld path itself — its own token, its own socket, no key on the device:

```bash
cd device && pip install -r requirements.txt
python3 device_sim.py --file ../demo/audio/paris.wav --dashboard
python3 device_sim.py --mic --dashboard
```
</details>

---

## What's on screen

The audio is **real spontaneous bilingual conversation** — a family talking about a
cruise to France and a day in Paris, switching between Spanish and English throughout.
From the Bangor Miami corpus, with a transcript made by hand at Bangor University.

| On screen | Why it's the thing to look at |
|---|---|
| **A language tag on every turn** | `es 0.96`, `en 0.36`, `fr 0.27`. Nobody selected a language — `language_detection` returns it per turn. This is what lets the language button come off the device |
| **Word error rate, 25.7%** | 37 errors in 144 words, measured against the human transcript. The diff panel marks every one |
| **Names recognised, 5/8** | Torre Eiffel, Notre Dame, Arco del Triunfo, Louvre, Francia — that's `keyterms_prompt`, worth **3.3 points of WER** on this clip |
| **Time to final transcript** | median 351 ms. Accuracy didn't cost latency. The last bar is the end-of-stream flush, not conversational latency |
| **Session cost** | 70.7s billed against 56.0s of audio — 21% of the session paid for silence |

**Two turns are tagged `fr`** at 0.27 and 0.49 confidence — they are Spanish and English.
Declared `language_codes` do not constrain what detection may return. Low confidence is
the usable signal, and it's on screen; a device should treat sub-0.7 as "don't switch
the output voice".

---

## What running it live actually changed

Everything below came out of pointing this at the real API, and all of it contradicted
something I'd written first.

- **`prompt` made accuracy worse** — 29.2% → 33.3% WER, identical across three runs.
  AssemblyAI publishes −21% for a detailed prompt. It's off by default now.
- **`keyterms_prompt` is the lever that paid** — 29.2% → 25.9%.
- **`voice_focus=far-field` and `min_turn_silence=480` both hurt.** I'd reasoned my way
  into them from how the device is held. Measured, they cost 4.8 points.
- **The first clip I picked failed completely** — one turn for 45 seconds, no Spanish
  detected. Continuous overlapping speech gives the endpointer no silence to cut on.
- **`language_codes` must be JSON-encoded**; `en,es` is rejected in a way that reads
  like an unsupported-language error.

Details, numbers and repeat runs: [MEASUREMENTS.md](demo/fixtures/MEASUREMENTS.md).

---

## What's real

**Everything on screen is measured.** The offline mode replays `fixtures/session.json`,
which is a recorded real session — not a construction. The reference transcript and
audio are the corpus's. The only thing the replay adds is the idle tail on the cost
meter, and it says so.

**Verified by running it:** `tsc --noEmit` clean under strict mode · 15 unit tests pass
· live sessions against the real API, with three-run repeats on the config comparison ·
`fetch_sample.sh` end to end · the dashboard opened in a browser in light and dark.

**Not verified:** `device_sim.py` past compiling and its CLI — the server-side path is
what I ran live. Single 56-second clip, so the lever comparison is directional.

---

## Layout

```
demo/
  src/score.ts          word error rate + keyterm recall — the only thing computing a
                        number on screen, so the only file with tests
  src/config.ts         the connection parameters, each with the measurement behind it
  src/aai.ts            token minting + streaming client
  src/pipeline.ts       live session: audio in, scored turns out
  src/capture.ts        records a real session to fixtures/session.json
  src/fixture.ts        replays that recording when there's no key
  public/index.html     the dashboard — one file, no bundler, no CDN
  fixtures/             the recorded session, gold transcript, MEASUREMENTS.md
  audio/fetch_sample.sh downloads the corpus audio and builds the reference
device/device_sim.py    the handheld: token → its own socket → final transcript → seam
```

---

Audio and transcript: Bangor Miami corpus, Deuchar, M. et al., ESRC Centre for Research
on Bilingualism, Bangor University — [bangortalk.org.uk](https://bangortalk.org.uk/).
GPL-3, TalkBank code of ethics. Downloaded at runtime, not committed here.
