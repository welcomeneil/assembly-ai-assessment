# Part 2 — Spanglish Inc. critical issue

**Verdict: no defect in the AssemblyAI streaming service.** Four independent client-side faults
in the customer's snippet, each individually fatal. Fixed code, customer comms, privacy
answers, internal summary, and handoff are all below.

---

## Deliverables

| # | Asked for | File |
|---|---|---|
| 1 | Fixed code with comments explaining changes | [`code/java/src/main/java/com/assemblyai/Spanglish.java`](code/java/src/main/java/com/assemblyai/Spanglish.java) — every change tagged `// FIX #n` |
| 2 | Customer-facing email + how to scale to 2,000 streams | [`02-customer-email.md`](02-customer-email.md) + [`03-scaling-to-2000.md`](03-scaling-to-2000.md) |
| 3 | Answers to data privacy / retention concerns | [`04-data-privacy.md`](04-data-privacy.md) |
| 4 | Internal summary for engineering | [`05-internal-eng-summary.md`](05-internal-eng-summary.md) |
| 5 | Handoff document for the returning colleague | [`06-handoff.md`](06-handoff.md) |

Supporting: [`01-root-cause.md`](01-root-cause.md) — the full 23-item defect register that the
`FIX #n` comments map to.

---

## The four blockers

Any one of these breaks the stream on its own. All four were present simultaneously.

| # | Fault | Symptom |
|---|---|---|
| 1 | `main()` instantiates `StreamingTranscription`, a class that doesn't exist | **Does not compile** |
| 2 | `encoding=opus` declared while sending raw PCM | Session connects, `Begin` arrives, **no transcript ever** — fails silently |
| 3 | 25 ms chunks against a 50–1000 ms contract | Close `3007 Input duration violation: 25 ms` |
| 4 | No `speech_model` pinned → English-only default | Spanish transliterated into English-looking nonsense |

Three edits clear all four:

```diff
-private static final int FRAMES_PER_BUFFER = 400;   // 25 ms — below the 50 ms minimum
+private static final int FRAMES_PER_BUFFER = 800;   // 50 ms

-"wss://streaming.assemblyai.com/v3/ws?sample_rate=%d&encoding=opus&format_turns=true"
+"wss://streaming.us.assemblyai.com/v3/ws?sample_rate=%d&encoding=pcm_s16le"
+    + "&speech_model=universal-3-5-pro&language_codes=en,es&language_detection=true"

-StreamingTranscription transcription = new StreamingTranscription();
+Spanglish transcription = new Spanglish();
```

**Why it took so long to diagnose:** four *minor* defects in the customer's error handling
compose into a total diagnostic blackout. `default: break;` swallowed our diagnostics, the close
code printed as a bare integer, an unguarded NPE surfaced as literally
`Error handling message: null`, and neither `onClose` nor `onError` released the latch `main()`
was parked on — so the process hung rather than exited. We told them what was wrong four times
and the client discarded it every time. Their bug report was terse because that is genuinely all
the information they had.

---

## What's verified vs. reasoned

Being explicit, because it matters for how much weight to put on each claim.

**Verified by running it locally:**
- The original file does **not** compile — JDK 19, 2 errors. Output captured in
  [`reference/javac-original-output.txt`](reference/javac-original-output.txt); reproduce with
  `./code/java/build.sh original`.
- The fixed Java compiles clean under `-Xlint:all` with zero warnings.
- Both Python files compile; the cold-start ramp model runs and produces the ~12-minute /
  ~4-minute figures quoted in the scaling guide.
- `make_sample.sh` generates a valid 24.1 s bilingual courtroom WAV at 16 kHz mono 16-bit.

**Not verified — no API key in this environment:**
- I have not executed any of this against the live AssemblyAI API. The predicted behaviours
  (close `3007`, silent Opus decode failure, English-only output on Spanish audio) are derived
  from AssemblyAI's published API reference and error-code documentation, not observed.
  `repro.py` exists specifically so that anyone with a key can confirm or refute all of it in
  about two minutes.

**Known unknown, flagged rather than papered over:**
- AssemblyAI's own docs contradict each other on the default `speech_model` for a bare v3 URL —
  the API reference says `universal-3-5-pro`, the migration guide says the English model, and
  async defaults are grandfathered by account creation date. **I could not determine which
  default Spanglish's specific account resolves to.** It's observable in one request via the
  `configuration` object in the `Begin` message. Tracked as open item A3 in the internal summary.
  The recommendation — pin the model explicitly, never inherit a default in production — is
  correct either way.

---

## Running it

### Repro harness (the demo)

Streams identical audio through four configurations — as-sent, each fix in isolation, fully
fixed — and prints the close code for each. This is the artifact that turns "your product
doesn't work" into an agreed root cause.

```bash
cd code/python
pip install -r requirements.txt
./make_sample.sh                              # macOS: builds a 24 s EN/ES courtroom sample
export ASSEMBLYAI_API_KEY=...
python3 repro.py sample_bilingual.wav         # all four configs
python3 repro.py sample_bilingual.wav --only broken
```

### Fixed Java client

```bash
cd code/java
./build.sh              # compile (fetches jars on first run)
./build.sh original     # compile the ORIGINAL — fails, on purpose
export ASSEMBLYAI_API_KEY=...
./build.sh run          # live microphone
```

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
├── 01-root-cause.md              23-item defect register + the diagnostic-blackout analysis
├── 02-customer-email.md          the email, with reviewer notes on why it's written that way
├── 03-scaling-to-2000.md         customer-facing: rate limits, rollover, cost, checklist
├── 04-data-privacy.md            customer-facing: retention, residency, compliance, contract asks
├── 05-internal-eng-summary.md    not-our-bug + the four DX problems that are ours
├── 06-handoff.md                 handoff to the returning colleague
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
