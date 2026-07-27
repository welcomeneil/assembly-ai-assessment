# Part 1 — iTranslate

A live dashboard of the speech-to-text pipeline for iTranslate's handheld translator,
tuned for accuracy. Audio in, transcript out, translation, speech — every stage on
screen, with the exact parameters that produced it.

The approach write-up is [APPROACH.md](APPROACH.md). This page is how to run it.

---

## Run it

```bash
cd demo
npm install
npm run build && npm start
```

Open **http://localhost:8787** and press **Play session**. No API key, no microphone,
no network.

<details>
<summary>With a real API key</summary>

```bash
cd demo
./audio/fetch_sample.sh          # downloads the sample audio, ~23 MB
export ASSEMBLYAI_API_KEY=...
npm start
```

Same dashboard, real session. Or run the handheld itself:

```bash
cd device && pip install -r requirements.txt
python3 device_sim.py --file ../demo/audio/herring1.wav --dashboard
python3 device_sim.py --mic --dashboard
```
</details>

---

## What's on screen

The demo audio is **real spontaneous bilingual conversation** — two cousins in a Miami
restaurant, from the Bangor Miami corpus, with a transcript made by hand at Bangor
University. Not TTS, not scripted. Overlapping speech, false starts, and code-switching
mid-sentence, which is harder than anything the device meets in the field.

| On screen | Why it's the thing to look at |
|---|---|
| **A language tag on every turn** | Nobody selected a language. `language_detection` returns it per turn — this is what lets the language button come off the device |
| **"switched mid-sentence"** | Three turns change language part-way through, e.g. *"porque se llama Paige the girl"*. A language-pinned session cannot follow that; it transcribes the English as Spanish-sounding nonsense and nobody in the conversation can tell |
| **Word error rate, 7.3%** | Scored live against the human transcript. Errors are marked word by word, so you see *which* word went wrong, not just a rate |
| **Names recognised, 11/11** | Every place and person name landed. That's `keyterms_prompt`, and it's what users actually notice |
| **The prompt panel** | The device wrote that itself from GPS, the selected situation and the itinerary. The user typed nothing. It is the single largest accuracy lever available and it is free |
| **Session cost** | The connection stays open 13s after the talking stops. Streaming bills on connection time, so 23% of that session was billed for silence |

---

## What's real and what isn't

Running with **no API key**, the audio, its timings, the reference transcript, the
per-turn language labels and the English translations of the Spanish turns all come
from the corpus. **The recogniser output and the latency figures are constructed** —
the dashboard says so on screen in amber. With a key, everything is measured.

I had no API key, so **nothing here has run against the live AssemblyAI service.** The
parameters come from current documentation, cited in [APPROACH.md](APPROACH.md).

**Verified by running it:** `tsc --noEmit` clean under strict mode · 13 unit tests pass
(`npm test`) · the replay drives the full event stream (24 turns, 3 mid-turn switches,
11/11 keyterms, 1 unintelligible turn correctly excluded from scoring) ·
`fetch_sample.sh` runs end to end and produces a 44.8s 16 kHz mono WAV · the WAV decoder
handles that real file (448 chunks of 100 ms) · the dashboard was opened in a browser
and checked in both light and dark.

**Not verified:** anything requiring the live API, and `device_sim.py` beyond compiling
and its CLI.

---

## Layout

```
demo/
  src/score.ts          word error rate + keyterm recall — the only file that computes
                        a number on screen, so the only one with tests
  src/config.ts         the connection parameters, and why each one is set that way
  src/aai.ts            token minting + streaming client
  src/pipeline.ts       live session: audio in, scored turns out
  src/fixture.ts        the no-key replay
  public/index.html     the dashboard — one file, no bundler, no CDN
  fixtures/             the sample session + build_fixture.py that generates it
  audio/fetch_sample.sh downloads the corpus audio and rebuilds the fixture from it
device/device_sim.py    the handheld: token → its own socket → translation → speech
```

`npm test` runs the scoring tests. Every expected value in them is worked out by hand.

The dashboard has no build step on purpose: a demo shown to a customer should not be
able to fail at compile time, or because venue wifi can't reach a CDN.

---

Audio and transcript: Bangor Miami corpus, Deuchar, M. et al., ESRC Centre for Research
on Bilingualism, Bangor University — [bangortalk.org.uk](https://bangortalk.org.uk/).
GPL-3, TalkBank code of ethics. Downloaded at runtime, not committed here.
