# Part 2. Spanglish Inc. critical issue

**Verdict: no defect in the AssemblyAI streaming service.** Three independent client-side faults
in the customer's snippet, each individually fatal, plus error handling that deleted every
diagnostic we sent. Fixed code, customer comms, privacy answers, internal summary, and handoff
are all below.

> Everything here was first written from the docs, then run against the live API on 2026-08-01.
> Two of my published claims did not survive that, and one new blocker turned up in my own fixed
> client. Corrections are marked in place and collected in
> [`07-live-verification.md`](07-live-verification.md).

---

## Deliverables

| # | Asked for | File |
|---|---|---|
| 1 | Fixed code with comments explaining changes | [`code/java/src/main/java/com/assemblyai/Spanglish.java`](code/java/src/main/java/com/assemblyai/Spanglish.java), every change tagged `// FIX #n` |
| 2 | Customer-facing email + how to scale to 2,000 streams | [`02-customer-email.md`](02-customer-email.md) + [`03-scaling-to-2000.md`](03-scaling-to-2000.md) |
| 3 | Answers to data privacy / retention concerns | [`04-data-privacy.md`](04-data-privacy.md) |
| 4 | Internal summary for engineering | [`05-internal-eng-summary.md`](05-internal-eng-summary.md) |
| 5 | Handoff document for the returning colleague | [`06-handoff.md`](06-handoff.md) |

Supporting: [`01-root-cause.md`](01-root-cause.md), the full 25-item defect register that the
`FIX #n` comments map to, and [`07-live-verification.md`](07-live-verification.md), the live-API
results and the corrections they forced.

---

## The three blockers

Any one of these breaks the stream on its own. All three were present simultaneously. Every
symptom below is what the live API actually returned, not what the docs predict.

| # | Fault | Symptom |
|---|---|---|
| 1 | `main()` instantiates `StreamingTranscription`, a class that doesn't exist | **Does not compile** |
| 2 | `encoding=opus` declared while sending raw PCM | `Begin`, then `Error 3006 Failed to decode Opus packet`, then close |
| 3 | 25 ms chunks against a 50–1000 ms contract | Close `3007 Input Duration Violation: 25.0 ms` |

A fourth, no `speech_model` pinned, was written up as a blocker on the theory that it falls back
to an English-only model. **It did not reproduce** — the unpinned default resolved to
`universal-3-5-pro` and handled Spanish correctly. Downgraded to a recommendation.

Three edits clear all three:

```diff
-private static final int FRAMES_PER_BUFFER = 400;   // 25 ms, below the 50 ms minimum
+private static final int FRAMES_PER_BUFFER = 800;   // 50 ms

-"wss://streaming.assemblyai.com/v3/ws?sample_rate=%d&encoding=opus&format_turns=true"
+"wss://streaming.us.assemblyai.com/v3/ws?sample_rate=%d&encoding=pcm_s16le"
+    + "&speech_model=universal-3-5-pro"
+    + "&language_codes=en&language_codes=es&language_detection=true"

-StreamingTranscription transcription = new StreamingTranscription();
+Spanglish transcription = new Spanglish();
```

`language_codes` repeats, one code per occurrence. The comma-joined form is rejected with
`3006`, which I found by shipping it and running it.

**Why it took so long to diagnose:** four *minor* defects in the customer's error handling
compose into a total diagnostic blackout. `default: break;` swallowed our diagnostics — including
the `Error` message naming the Opus decode failure by name — the close code printed as a bare
integer, an unguarded NPE surfaced as literally `Error handling message: null`, and neither
`onClose` nor `onError` released the latch `main()` was parked on, so the process hung rather
than exited. We told them exactly what was wrong, twice, in the first second of every run, and
the client deleted it every time. Their bug report was terse because that is genuinely all the
information they had.

---

## What's verified vs. reasoned

Being explicit, because it matters for how much weight to put on each claim.

**Verified by running it locally:**
- The original file does **not** compile. JDK 19, 2 errors. Output captured in
  [`reference/javac-original-output.txt`](reference/javac-original-output.txt); reproduce with
  `./code/java/build.sh original`.
- The fixed Java compiles clean under `-Xlint:all` with zero warnings.
- Both Python files compile; the cold-start ramp model runs and produces the ~12-minute /
  ~4-minute figures quoted in the scaling guide.
- `make_sample.sh` generates a valid 24.1 s bilingual courtroom WAV at 16 kHz mono 16-bit.

**Verified against the live API on 2026-08-01** — full results in
[`07-live-verification.md`](07-live-verification.md):
- Close `3007` on 25 ms chunks, verbatim, before the session even begins.
- The fixed Java client streams end to end: session id, per-turn `[en]`/`[es]` tags, a
  mid-sentence code-switch on the final turn, close `1000`.
- `encoding=opus` on raw PCM returns `Error 3006 Failed to decode Opus packet`. **This
  contradicts what I originally wrote** — I claimed it fails silently. It does not.
- An unpinned `speech_model` resolved to `universal-3-5-pro`, not the English-only model, and
  transcribed Spanish correctly. **My fourth blocker did not reproduce.**
- `language_codes=en,es` is rejected with `3006`; it is a repeated parameter. My own bug, in the
  code I was calling the fix.

**Still not verified:**
- Nothing was run at concurrency. The 2,000-stream ramp in
  [`03-scaling-to-2000.md`](03-scaling-to-2000.md) is arithmetic. Session rollover past the
  3-hour cap and `3009` backoff behaviour are untested.
- One 24-second clip of synthetic `say` audio on one account. Good evidence for close codes and
  parameter validation, weak evidence for transcription quality.

**Known unknown, flagged rather than papered over:**
- AssemblyAI's docs still contradict each other on the default `speech_model` for a bare v3 URL:
  the API reference says `universal-3-5-pro`, the migration guide says the English model, and
  async defaults are grandfathered by account creation date. My account resolved to
  `universal-3-5-pro`; **Spanglish's account is still unconfirmed** and should not be assumed to
  match. It's observable in one request via the `configuration` object in the `Begin` message.
  Tracked as open item A3. That contradiction is what produced my wrong prediction, which is the
  argument for fixing it.

---

## Running it

### Repro harness (the demo)

Streams identical audio through four configurations, as-sent, each fix in isolation, fully
fixed, and prints the close code for each. This is the artifact that turns "your product
doesn't work" into an agreed root cause.

```bash
cd code/python
pip install -r requirements.txt
./make_sample.sh                              # macOS: builds a 24 s EN/ES courtroom sample
export ASSEMBLYAI_API_KEY=..
python3 repro.py sample_bilingual.wav         # all four configs
python3 repro.py sample_bilingual.wav --only broken
```

### Fixed Java client

```bash
cd code/java
./build.sh              # compile (fetches jars on first run)
./build.sh original     # compile the ORIGINAL, fails, on purpose
export ASSEMBLYAI_API_KEY=..
./build.sh run --file ../python/sample_bilingual.wav   # fixed audio, repeatable, ~25 s
./build.sh run                                         # live microphone
```

`--file` streams a WAV at real time through the same queue, sender and message handling as the
microphone, so it demonstrates the real client rather than a test double. It needs 16 kHz mono
16-bit PCM and drops any trailing remainder under 50 ms, since a short message trips `3007`.
`AAI_SPEAKER_LABELS=false` reproduces the speaker-label comparison in
[`07-live-verification.md`](07-live-verification.md).

Maven works too if you have it: `mvn compile exec:java`.

### Scaling model

```bash
python3 code/python/production_client.py      # cold-start ramp curves to 2,000 streams
```

---

## Layout

```
part-2-spanglish/
├── README.md                     you are here
├── 01-root-cause.md              25-item defect register + the diagnostic-blackout analysis
├── 02-customer-email.md          the email, with reviewer notes on why it's written that way
├── 03-scaling-to-2000.md         customer-facing: rate limits, rollover, cost, checklist
├── 04-data-privacy.md            customer-facing: retention, residency, compliance, contract asks
├── 05-internal-eng-summary.md    not-our-bug + the DX problems that are ours
├── 06-handoff.md                 handoff to the returning colleague
├── 07-live-verification.md       what the live API actually did, incl. two of my claims falsified
├── code/
│   ├── java/                     fixed Spanglish.java, pom.xml, build.sh
│   └── python/                   repro.py, production_client.py, make_sample.sh
└── reference/
    ├── original/                 the customer's file as received, for diffing
    └── javac-original-output.txt captured compiler output proving defect #1
```

---

## Three things worth surfacing that weren't asked for

1. **The 3-hour session cap.** Sessions hard-close at 3 hours (`3008`). Court proceedings run
   longer. This is their most likely day-one production incident and nobody had raised it.
2. **Streaming bills on socket open-to-close, not audio sent.** At 2,000 concurrent that's
   ~$300–900/hr depending on model, and idle sockets cost full price. A surprise invoice would
   undo everything this fix buys.
3. **Their async workload is a bigger privacy exposure than the streaming one they asked
   about.** Streaming gets zero retention; async retains audio 24–48h and transcripts 72h by
   default. Better raised by us than found by their auditor.
