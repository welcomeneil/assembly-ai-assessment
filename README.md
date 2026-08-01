# AssemblyAI Applied AI Engineering Take-Home

**Loom walkthrough:** https://www.loom.com/share/6607bdbd93434df894b15ca77dc11ce8

| | | |
|---|---|---|
| **[Part 1 — iTranslate](part-1-itranslate/)** | Demo + approach for a handheld translator that wants better speech-to-text | [approach](part-1-itranslate/APPROACH.md) · [measurements](part-1-itranslate/demo/fixtures/MEASUREMENTS.md) |
| **[Part 2 — Spanglish Inc.](part-2-spanglish/)** | Production customer says streaming "doesn't work at all." Fix it, explain it, scale to 2,000 streams | [root cause](part-2-spanglish/01-root-cause.md) · [email](part-2-spanglish/02-customer-email.md) · [scaling](part-2-spanglish/03-scaling-to-2000.md) · [privacy](part-2-spanglish/04-data-privacy.md) · [internal](part-2-spanglish/05-internal-eng-summary.md) · [handoff](part-2-spanglish/06-handoff.md) · [live verification](part-2-spanglish/07-live-verification.md) |

**Part 1 in a sentence.** They asked for accuracy; Universal-3.5 Pro returns a language per turn and follows a mid-sentence
switch, so two people can just pick the device up and talk. The dashboard shows one tuned
session running on real spontaneous bilingual audio, scored live against a human transcript.

**Part 2 in a sentence.** No defect on our side — three independent client-side faults, each
individually fatal, plus error handling that discarded every diagnostic we sent, which is why
their bug report had no detail. (It was four until I ran it live; see below.)

---

## Running the demos

Prerequisites: Node 20.12+ and `curl` (Part 1), Python 3.9+ and a JDK 17+ (Part 2).
Steps 1, 4, 5 and 7 need no API key. Steps 2, 3, 6 and `./build.sh run` do.

### 1. Part 1 dashboard — no key

The one to run first. Replays a recording of a real session at its captured timings.

```bash
cd part-1-itranslate/demo
npm install
npm run build && npm start
# open http://localhost:8787 and press "Play session"
```

### 2. Part 1, live against the API — needs a key

Continues from step 1: same directory, dependencies and build already in place.

```bash
cd part-1-itranslate/demo
./audio/fetch_sample.sh                       # audio + reference transcript, ~24 MB (needs ffmpeg or afconvert)
echo 'ASSEMBLYAI_API_KEY=your_key' > .env     # gitignored; the server reads it at startup
npm start                                     # "Play session" now runs live
npm run capture                               # optional: re-record the offline fixture
```

### 3. Part 1 handheld simulator — needs a key

The device path itself: mints a token, opens its own socket, no key on the device.

Needs the **step 2** server running, not step 1: the device asks it for a token, and a
server with no key answers that with a 503. `paris.wav` is the file `fetch_sample.sh`
downloads, so step 2 has to have happened.

```bash
cd part-1-itranslate/device
pip install -r requirements.txt
python3 device_sim.py --file ../demo/audio/paris.wav --dashboard
```

`--mic` needs PortAudio and sounddevice on top of that — left out of requirements.txt so
that the `--file` path installs cleanly without them:

```bash
brew install portaudio && pip install sounddevice
python3 device_sim.py --mic --dashboard
```

### 4. Part 1 tests — no key

```bash
cd part-1-itranslate/demo && npm test         # 15 tests, word error rate engine vs. hand-computed cases
```

### 5. Part 2 — watch the original fail to compile, then the fix compile clean

```bash
cd part-2-spanglish/code/java
./build.sh original     # 2 errors, on purpose (fetches jars on first run)
./build.sh              # clean under -Xlint:all
```

Then run the fixed client end to end. `--file` streams a fixed WAV at real time through the same
path as the microphone, so the demo is repeatable and needs no capture hardware:

```bash
export ASSEMBLYAI_API_KEY=your_key
./build.sh run --file ../python/sample_bilingual.wav   # deterministic, ~25 s
./build.sh run                                        # live microphone
```

Expect a session id, per-turn `[en]` / `[es]` tags, a mid-sentence code-switch on the last turn,
and close code `1000`. `AAI_SPEAKER_LABELS=false` reproduces the speaker-label comparison in
[07-live-verification.md](part-2-spanglish/07-live-verification.md).

### 6. Part 2 repro harness — needs an API key

Streams identical audio through four configs (as-sent, each fix in isolation, fully fixed) and
prints the close code for each. This is what turns "your product doesn't work" into an agreed
root cause.

```bash
cd part-2-spanglish/code/python
pip install -r requirements.txt
./make_sample.sh                              # macOS only (say + afconvert): builds a 24s EN/ES clip
export ASSEMBLYAI_API_KEY=your_key
python3 repro.py sample_bilingual.wav
python3 repro.py sample_bilingual.wav --only broken
```

Off macOS, skip `make_sample.sh` and pass any 16 kHz mono 16-bit WAV with English and
Spanish in it — `repro.py` asserts that format rather than resampling.

### 7. Part 2 scaling model — no key

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

**Part 2 has now run against the live API too, and it cost me two claims.** The write-up was
originally docs-only. Running it confirmed the compile failure and the `3007` chunk-size close
verbatim, and falsified the other two: `encoding=opus` does **not** fail silently, the server
returns an explicit `3006 Failed to decode Opus packet` that the customer's `default: break;`
deleted; and the unpinned `speech_model` resolved to `universal-3-5-pro` and transcribed Spanish
correctly, so that was never a blocker. It also caught a blocker in my own fixed client:
`language_codes` is a repeated parameter, and the comma-joined form I shipped is rejected on
connect. Corrections, evidence and the raw transcripts are in
[07-live-verification.md](part-2-spanglish/07-live-verification.md); the original claims are
struck through in place rather than quietly edited. The scaling model is still arithmetic,
nothing was run at concurrency.
