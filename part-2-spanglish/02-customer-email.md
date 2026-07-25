# Customer-facing email — Spanglish Inc.

> Deliverable 2 of 5. Tone target: fast, specific, accountable, zero blame. They are angry and
> they are right to be — their client gave them no information to work with. Lead with the fix,
> not with the diagnosis. Attach working code, not instructions.

---

**To:** [Eng lead], Spanglish Inc.
**Cc:** [AE], [Solutions lead]
**Subject:** Fixed — working bilingual streaming code attached, plus your scaling + privacy answers

---

Hi [Name],

I'm [Name], stepping in while [Colleague] is out. I've been through your snippet — **we found
it, it's fixed, and there's working code attached.** Short version: four separate issues in the
client configuration, each one enough to break the stream on its own. No changes needed on
your account or our side.

I want to acknowledge something first: your client code was swallowing the errors our API was
sending back. You had almost no information to debug with, and "it doesn't work at all" was a
completely fair description of what you could see. Fixing that visibility is part of what's
attached.

## What was wrong

**1. The audio format didn't match what was declared.** Your connection URL said
`encoding=opus`, but the code captures raw 16-bit PCM from the microphone and sends it
unmodified. `opus` is a real, supported option — so we accepted the session, sent you a
`Begin`, and then tried to Opus-decode PCM. That fails silently: the connection looks perfectly
healthy and no transcript ever arrives. This is almost certainly the behaviour you saw.

**2. The audio chunks were half the minimum size.** `FRAMES_PER_BUFFER = 400` is 25 ms of audio
per message. Our API requires 50–1000 ms and closes the socket with code **3007, "Input
duration violation: 25 ms. Expected between 50 and 1000 ms."** We were telling you exactly
this — your `onClose` handler printed the code as a bare number with no explanation, so it read
as noise.

**3. No speech model was pinned, so you were on the English-only model.** This is the one that
matters most for your use case. With no `speech_model` in the URL you inherit an account
default, and Spanish audio came back transliterated into English-looking words — confidently
wrong rather than obviously broken. For bilingual court proceedings that's the worst possible
failure mode. Pin the model explicitly and this goes away.

**4. The file as sent doesn't compile.** `main()` instantiates a class called
`StreamingTranscription`, but the class in that file is `Spanglish`. `javac` rejects it with
"cannot find symbol." Flagging it because it means the code you sent isn't the code you ran —
if you can share what you actually executed, I'll diff it against this and make sure nothing
else is lurking.

## The fix

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

Attached:

- **`Spanglish.java`** — your file, corrected, with a `// FIX #n` comment on every change. It
  compiles clean under JDK 19 with `-Xlint:all`. Beyond the four blockers it fixes a handful of
  things that would have bitten you at scale: unbounded memory growth on long hearings, a hang
  after any server-side close, and error handling that was hiding our diagnostics from you.
- **`repro.py`** — runs the same audio file through four configurations (as-sent → each fix
  applied in turn → fully fixed) and prints what happens in each. Roughly two minutes to run,
  and you can see each failure appear and clear rather than taking my word for it.

`language_codes=en,es` biases toward English and Spanish while keeping native mid-sentence
code-switching, which is exactly the interpreter case. With `language_detection=true` each turn
comes back tagged with the detected language — useful for your record, and it gives you a
signal to alert on if quality ever drifts.

Two things worth turning on for court work, both a single parameter:

- **`speaker_labels=true`** — real-time diarization, so judge / witness / interpreter are
  separated in the transcript. Note that we send `SpeakerRevision` messages that retroactively
  correct earlier labels as the model hears more voice; persist turns by `turn_order` and apply
  the revisions so the record converges on the right attribution.
- **`keyterms_prompt`** — boost legal terminology in both languages (`voir dire`, `habeas
  corpus`, `fiscal`, `testigo`). Up to 100 terms, and it meaningfully helps on domain vocabulary.

## Scaling to 2,000 concurrent streams

Full detail in the attached scaling guide, but the headline is that **your mental model of the
limit is probably wrong in a way that works in your favour**:

We don't cap total concurrent streams. There is no ceiling at 2,000, or at any number. What we
govern is **how many new sessions you can open per minute**, and that budget auto-scales — any
minute you use ≥70% of it, we raise it ~10% for the next minute.

What that means concretely:

- **Steady state is a non-event.** 2,000 concurrent streams averaging 30 minutes each is only
  ~67 new sessions/min — comfortably inside a standard paid budget.
- **The cold start is the only real constraint.** Ramping 0 → 2,000 on the default budget takes
  roughly 12 minutes of compounding. We can pre-provision a higher starting budget and cut that
  to ~4 minutes. **No additional cost** — just tell us your target and we'll set it before your
  go-live.
- **Two things to build before you ramp:** retry on close code `3009` with exponential backoff
  **and jitter** (without jitter, throttled clients retry in lockstep and re-trip the limit),
  and session rollover for hearings longer than **3 hours**, which is our hard per-session cap
  (close code `3008`). Court proceedings will hit that. The attached Python reference client
  implements both.

One billing note I'd rather you hear from me now than discover on an invoice: **streaming is
billed on WebSocket open-to-close time, not on audio sent.** An idle socket costs the same as
an active one. Close sockets at recess and at adjournment. At 2,000 concurrent that's the
difference between roughly $300/hr and $900/hr depending on model — details and the
`universal-streaming-multilingual` cost option are in the guide.

## Data privacy and retention

Attached as a separate document since your security team will want to review it directly. The
headline: **for Streaming, we offer zero data retention of audio and transcripts when your
account is opted out of model training.** We keep session metadata — session ID, duration — for
billing and logging, but not the audio and not the transcript text.

Three things I'd like to get moving on your behalf this week:

1. **Confirm your model-training opt-out status.** Zero retention is conditional on it, and
   opt-out is forward-looking only — it can't be applied retroactively. I'll check where your
   account stands and send written confirmation.
2. **Switch to a Data Zone endpoint.** Your snippet used `streaming.assemblyai.com`, which
   edge-routes for lowest latency and carries **no data-residency guarantee**. For court audio
   you want `streaming.us.assemblyai.com` (or `.eu.`), which guarantees data never leaves the
   region. I've already made that change in the attached code.
3. **Get zero retention written into your agreement.** Public documentation is not a
   contractual commitment, and your security reviewers will correctly say so. I'll work with
   your AE to get it into the enterprise agreement alongside the DPA.

I'd also flag `redact_pii=true` for streaming — it redacts PII from final turns in-flight.
Whether that's appropriate for a legal record is your call, but it should be a deliberate one.

## Next steps

I'd like to get on a call — **30 minutes, any time in the next two days.** Agenda:

1. Live-run the fixed code against one of your real bilingual recordings and confirm quality
   together
2. Lock your target concurrency and go-live date so we can pre-provision the rate budget
3. Walk your security team through the retention answers and start the contractual paperwork

If it's easier, send me a representative bilingual sample and I'll run it and send back the
transcript with the diarization and language tags before we even meet.

Sorry this cost you time. The information you needed was being generated and then thrown away
by the client before it reached you — that's a bad experience regardless of where the code
lives, and I've filed it internally so we improve the error surface and the Java guidance.

[Name]
Applied AI Engineer, AssemblyAI
[phone] · [email] · available on Slack Connect if that's faster

---

## Notes for internal reviewers (not sent)

- **Deliberately does not say "your bug."** It says what was wrong and what fixes it. The
  compile error is raised as a question about environment drift, not as a gotcha.
- **Leads with the fix and attached working code.** They are at churn risk; the first
  paragraph has to reduce their blood pressure.
- **Names the billing model unprompted.** A surprise invoice at 2,000 streams would undo all
  the goodwill this email buys. Better to be the person who warned them.
- **Explicitly separates documented behaviour from contractual commitment** on privacy. Their
  security team will make that distinction anyway; making it first builds credibility.
- **The 3-hour session cap is proactively surfaced.** They have not asked about it and they
  will absolutely hit it. Court proceedings run long.
- **Ends with the accountability line.** No grovelling, no excuse — one sentence naming the
  real DX failure and the internal action taken.
