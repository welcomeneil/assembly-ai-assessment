# AssemblyAI Applied AI Engineering Take-Home

**Loom walkthrough:** [add link here]

Two parts, both complete.

- **[Part 1: iTranslate demo](part-1-itranslate/)**, build a demo and document the approach for
  a handheld translation device that needs better speech-to-text accuracy.
- **[Part 2: Spanglish Inc.](part-2-spanglish/)**, a production customer says streaming
  "doesn't work at all." Fix it, explain it, and scale them to 2,000 streams.

---

## Part 1: iTranslate demo

**The ask.** A handheld translator with no GPU but with wifi and cellular. It transcribes
speech, translates it, and speaks the result. They want better transcription accuracy.

**What I found.** They asked for accuracy. The bigger opportunity is that their device needs a
language button, because a language-pinned recognizer has to be told what's coming before
someone speaks. Get it wrong and the device doesn't error — it confidently speaks the wrong
thing, and neither person can tell. Universal-3.5 Pro returns the language per turn and follows
a switch mid-sentence, so the button can come off. Two people just pick it up and talk.

**The largest accuracy lever is one almost nobody turns on.** A 20–50 word description of the
situation cuts word error rate **21%** and entity errors **29%**, measured over 20,000 calls. A
handheld knows its GPS location, the selected situation and the traveller's itinerary, so it can
write that description itself on every session. The user types nothing.

| Deliverable | File |
|---|---|
| **The demo** — one tuned pipeline, live, every stage on screen | [demo/](part-1-itranslate/demo/) |
| **How to run it, and what's real vs. simulated** | [README.md](part-1-itranslate/README.md) |
| **The approach**: architecture, levers ranked, cost, limits, sources | [APPROACH.md](part-1-itranslate/APPROACH.md) |
| Scoring engine — word error rate + keyterm recall, unit tested | [score.ts](part-1-itranslate/demo/src/score.ts) |
| The connection parameters, and why each one is set that way | [config.ts](part-1-itranslate/demo/src/config.ts) |
| Dashboard — one file, no bundler, no CDN | [index.html](part-1-itranslate/demo/public/index.html) |
| Device simulator (Python) — token, own socket, in-session translation, TTS | [device_sim.py](part-1-itranslate/device/device_sim.py) |

**Runs with no API key.** `npm install && npm run build && npm start`, open
http://localhost:8787, press Play.

The demo audio is **real spontaneous bilingual conversation**, not TTS and not scripted — two
cousins in a Miami restaurant from the Bangor Miami corpus, with a human reference transcript.
Overlapping speech, false starts, and three turns that change language mid-sentence. Word error
rate is scored live against that transcript and errors are marked word by word.

Two things they didn't ask about: streaming bills on **connection time, not audio sent** — the
demo shows 23% of a session billed for silence, roughly $1,000 a day at fleet scale. And Opus
encoding cuts bandwidth about **tenfold**, which matters on a battery-powered cellular device.

---

## Part 2: Spanglish Inc. critical issue

**The situation.** A production customer building bilingual court transcription reported that
our streaming product "doesn't work at all." They sent a Java code snippet and nothing else.
Engineering suspected a bug on our side.

**The finding.** No bug on our side. Their client had four separate problems, and any one of
them alone would break the stream.

| Problem | What happens |
|---|---|
| The file doesn't compile | `main()` creates a class that doesn't exist |
| Wrong audio format declared | Says "compressed audio," sends raw audio. Connects fine, returns nothing, no error |
| Audio chunks too small | 25ms sent, 50ms minimum required. Server closes with code 3007 |
| No language model specified | Bilingual customer left on a default they never chose |

**The bigger issue.** Their code was throwing away every error message we sent. That's why the
report had no detail. They weren't being unhelpful, they genuinely couldn't see anything.

### The five deliverables

| # | What was asked for | File |
|---|---|---|
| 1 | Fixed code with comments explaining changes | [Spanglish.java](part-2-spanglish/code/java/src/main/java/com/assemblyai/Spanglish.java) |
| 2 | Customer email + how to scale to 2,000 streams | [Email](part-2-spanglish/02-customer-email.md) · [Scaling guide](part-2-spanglish/03-scaling-to-2000.md) |
| 3 | Data privacy and retention answers | [Privacy doc](part-2-spanglish/04-data-privacy.md) |
| 4 | Internal engineering summary | [Internal summary](part-2-spanglish/05-internal-eng-summary.md) |
| 5 | Handoff for the returning colleague | [Handoff](part-2-spanglish/06-handoff.md) |

### Supporting work

| File | What it is |
|---|---|
| [01-root-cause.md](part-2-spanglish/01-root-cause.md) | Full analysis. All 23 defects found, not just the 4 blockers |
| [repro.py](part-2-spanglish/code/python/repro.py) | Runs the same audio 4 ways: broken, each fix, working |
| [production_client.py](part-2-spanglish/code/python/production_client.py) | Reference client for running 2,000 streams |
| [reference/original/](part-2-spanglish/reference/original/) | The customer's file as received, for comparison |

---

## Running the code

### Part 1

**The dashboard, no API key needed.** This is the one to run first.

```bash
cd part-1-itranslate/demo
npm install
npm run build && npm start
# open http://localhost:8787 and press "Play session"
```

**Live, with a key.** Fetch the sample audio, then start the server with a key set. The
dashboard runs a real session on the same conversation.

```bash
cd part-1-itranslate/demo
./audio/fetch_sample.sh          # ~23 MB, needs ffmpeg or macOS afconvert
export ASSEMBLYAI_API_KEY=your_key
npm start
```

**The handheld itself.** Its own socket to AssemblyAI, no key on the device, translation
inside the session, speech out.

```bash
cd part-1-itranslate/device && pip install -r requirements.txt
python3 device_sim.py --file ../demo/audio/herring1.wav --dashboard
python3 device_sim.py --mic --dashboard
```

**Tests.** `cd part-1-itranslate/demo && npm test` — the word error rate engine against
hand-computed cases.

### Part 2

**See the original fail, then see the fix compile:**

```bash
cd part-2-spanglish
./code/java/build.sh original    # 2 compile errors, on purpose
./code/java/build.sh             # compiles clean
```

**Run the four-way comparison** (needs an API key):

```bash
cd part-2-spanglish/code/python
pip install -r requirements.txt
./make_sample.sh                              # builds a 24s English/Spanish test clip (macOS)
export ASSEMBLYAI_API_KEY=your_key
python3 repro.py sample_bilingual.wav
```

**See the scaling math:**

```bash
python3 part-2-spanglish/code/python/production_client.py
```

---

## What I verified vs. what I inferred

Being upfront about this because it affects how much weight to put on each claim.

**Actually ran, Part 1:**
- `tsc --noEmit` clean under strict mode; 13 unit tests pass, every expected value hand-computed
- The replay drives the full event stream: 24 turns, 3 mid-turn language switches, 11/11
  keyterms, 1 unintelligible turn correctly excluded from scoring, 7.3% aggregate word error rate
- `fetch_sample.sh` end to end — downloads the corpus, cuts the window, produces a 44.8s
  16 kHz mono WAV, rebuilds the fixture from the same transcript
- The WAV decoder against that real file: 448 chunks of 100 ms, inside the API's 50–1000 ms window
- The dashboard opened in a browser and checked in both light and dark

**Actually ran, Part 2:**
- The original file does not compile. JDK 19, two errors. Output saved in
  [reference/](part-2-spanglish/reference/javac-original-output.txt)
- The fixed file compiles clean with all warnings enabled
- The scaling math, which produced the 12-minute and 4-minute ramp numbers
- The test audio generator
