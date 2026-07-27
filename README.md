# AssemblyAI Applied AI Engineering Take-Home

**Loom walkthrough:** https://www.loom.com/share/6607bdbd93434df894b15ca77dc11ce8

| | | |
|---|---|---|
| **[Part 1 — iTranslate](part-1-itranslate/)** | Demo + approach for a handheld translator that wants better speech-to-text | [approach](part-1-itranslate/APPROACH.md) · [measurements](part-1-itranslate/demo/fixtures/MEASUREMENTS.md) |
| **[Part 2 — Spanglish Inc.](part-2-spanglish/)** | Production customer says streaming "doesn't work at all." Fix it, explain it, scale to 2,000 streams | [root cause](part-2-spanglish/01-root-cause.md) · [email](part-2-spanglish/02-customer-email.md) · [scaling](part-2-spanglish/03-scaling-to-2000.md) · [privacy](part-2-spanglish/04-data-privacy.md) · [internal](part-2-spanglish/05-internal-eng-summary.md) · [handoff](part-2-spanglish/06-handoff.md) |

**Part 1 in a sentence.** They asked for accuracy; the bigger opportunity is deleting the
language button. Universal-3.5 Pro returns a language per turn and follows a mid-sentence
switch, so two people can just pick the device up and talk. The dashboard shows one tuned
session running on real spontaneous bilingual audio, scored live against a human transcript.

**Part 2 in a sentence.** No defect on our side — four independent client-side faults, each
individually fatal, plus error handling that discarded every diagnostic we sent, which is why
their bug report had no detail.

---

## Running the demos

Prerequisites: Node 18+ (Part 1), Python 3.9+ and a JDK (Part 2). An API key is only needed
where noted.

### 1. Part 1 dashboard — no API key

The one to run first. Replays a recording of a real session at its captured timings.

```bash
cd part-1-itranslate/demo
npm install
npm run build && npm start
# open http://localhost:8787 and press "Play session"
```

### 2. Part 1, live against the API

```bash
cd part-1-itranslate/demo
./audio/fetch_sample.sh                       # audio + reference transcript, ~24 MB (needs ffmpeg or afconvert)
echo 'ASSEMBLYAI_API_KEY=your_key' > .env     # gitignored
npm start                                     # "Play session" now runs live
npm run capture                               # optional: re-record the offline fixture
```

### 3. Part 1 handheld simulator

The device path itself: mints a token, opens its own socket, no key on the device.

```bash
cd part-1-itranslate/device
pip install -r requirements.txt
python3 device_sim.py --file ../demo/audio/paris.wav --dashboard   # needs the server from step 1 or 2 running
python3 device_sim.py --mic --dashboard
```

### 4. Part 1 tests

```bash
cd part-1-itranslate/demo && npm test         # 15 tests, word error rate engine vs. hand-computed cases
```

### 5. Part 2 — watch the original fail to compile, then the fix compile clean

```bash
cd part-2-spanglish/code/java
./build.sh original     # 2 errors, on purpose (fetches jars on first run)
./build.sh              # clean under -Xlint:all
export ASSEMBLYAI_API_KEY=your_key
./build.sh run          # live microphone
```

### 6. Part 2 repro harness — needs an API key

Streams identical audio through four configs (as-sent, each fix in isolation, fully fixed) and
prints the close code for each. This is what turns "your product doesn't work" into an agreed
root cause.

```bash
cd part-2-spanglish/code/python
pip install -r requirements.txt
./make_sample.sh                              # macOS: builds a 24s EN/ES courtroom clip
export ASSEMBLYAI_API_KEY=your_key
python3 repro.py sample_bilingual.wav
python3 repro.py sample_bilingual.wav --only broken
```

### 7. Part 2 scaling model

```bash
python3 part-2-spanglish/code/python/production_client.py   # cold-start ramp curves to 2,000 streams
```

---

## What's verified

**Part 1 ran live against the real API**, and that contradicted things I'd written first. The
documented `prompt` lever made accuracy *worse* here (29.2% → 33.3% WER, three identical runs)
and is off by default; `keyterms_prompt` is what paid (−3.3 points). `voice_focus=far-field`
and a longer silence threshold both hurt. Numbers and repeat runs in
[MEASUREMENTS.md](part-1-itranslate/demo/fixtures/MEASUREMENTS.md). One 56-second clip, so these
are directional — which is why the harness ships, not just the numbers.

**Part 2 was not run against the live API** — no key at the time. The compile failure, the clean
rebuild, the scaling math and the sample generator were all run locally; the predicted stream
behaviours (close `3007`, silent Opus decode failure, English-only output) come from the
published docs. `repro.py` exists so anyone with a key can confirm or refute them in two minutes.
