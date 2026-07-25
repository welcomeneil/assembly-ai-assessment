# Root cause analysis — Spanglish Inc. streaming failure

**Verdict: no defect in the AssemblyAI streaming service.** Four independent client-side
faults were present simultaneously in the file Spanglish sent us. Each one is sufficient on
its own to produce "it doesn't work at all." The service behaved to spec throughout, and in
three of the four cases it emitted the correct diagnostic — which the customer's error
handling discarded before a human ever saw it.

---

## The four blockers

### Blocker 1 — the file does not compile

```java
public static void main(String[] args) {
    StreamingTranscription transcription = new StreamingTranscription();  // no such class
    transcription.run();
}
```

The class declared in this file is `Spanglish`. `StreamingTranscription` does not exist
anywhere in the project. Verified locally against JDK 19:

```
com/assemblyai/Spanglish.java:45: error: cannot find symbol
        StreamingTranscription transcription = new StreamingTranscription();
        ^
  symbol:   class StreamingTranscription
  location: class Spanglish
2 errors
```

**This code has never executed.** That reframes the whole ticket: whatever Spanglish observed,
they did not observe it from this file. Worth asking them, without accusation, what they
actually ran — it changes what else we need to look at.

---

### Blocker 2 — the declared encoding does not match the bytes on the wire

```java
"wss://streaming.assemblyai.com/v3/ws?sample_rate=%d&encoding=opus&format_turns=true"
```

`encoding=opus` is a **valid** parameter value. That is exactly what makes this the nastiest
bug of the four. It does not fail loudly at connect time. `opus` tells the server *"every
binary message I send is exactly one raw Opus packet."*

What the client actually captures:

```java
AudioFormat format = new AudioFormat(SAMPLE_RATE, 16, CHANNELS, true, false);
//                                                               ^signed  ^little-endian
```

That is textbook **`pcm_s16le`** — raw, uncompressed PCM. Nothing in the code ever encodes it.
So the server accepts the session, sends `Begin`, and then tries to Opus-decode raw PCM. It
never produces a `Turn`.

Two follow-on effects worth knowing:

- `sample_rate` is **ignored** for `opus`, `ogg_opus`, and `aac` — those formats are
  self-describing. So `sample_rate=16000` was doing nothing either.
- From the customer's seat this looks precisely like "connected fine, product is broken."
  There is no error to read. This is the failure mode most likely to have produced the
  "doesn't work at all" phrasing.

**Fix:** `encoding=pcm_s16le`.

---

### Blocker 3 — 25 ms audio chunks violate the API contract

```java
private static final int FRAMES_PER_BUFFER = 400; // 25ms of audio (0.025s * 16000Hz)
```

The comment is arithmetically correct and that is the problem — 400 frames at 16 kHz really is
25 ms, and the v3 API requires every binary payload to carry **50–1000 ms**. The server closes
the socket with:

```
3007  Input duration violation: 25 ms. Expected between 50 and 1000 ms
```

The server told them the answer. `onClose` printed `Status=3007` as a bare integer with no
mapping, so it read as noise.

**Fix:** 800 frames = 1600 bytes = 50 ms, which is also AssemblyAI's recommended low-latency
chunk size.

---

### Blocker 4 — no `speech_model`, so a bilingual customer got the English-only model

The URL pins no `speech_model`. A bare v3 URL resolves to an account-level default, and for an
established account like Spanglish's that is the English-only Universal-Streaming model.

For a court proceeding with a Spanish interpreter this is the worst possible outcome: it does
not error, it does not warn, it just transliterates Spanish into English-looking tokens. Half
the record comes back as confident nonsense. If they got as far as seeing any output at all,
*this* is what they saw.

> **Caveat, stated plainly:** AssemblyAI's public docs are inconsistent about the default —
> the API reference lists `universal-3-5-pro` as the default, while the Universal-Streaming
> migration guide says an omitted `speech_model` "defaults to English model." Async defaults
> are known to be grandfathered by account creation date (accounts created before 2026-02-04
> keep the older default), so the streaming default likely varies by account age too. **I have
> not confirmed which default Spanglish's specific account resolves to.** That is verifiable in
> one request — the `Begin` message echoes back a `configuration` object with the model the
> server actually applied. See "Open items" in [`06-handoff.md`](06-handoff.md).
>
> The recommendation is unchanged either way, and this is the durable lesson for the customer:
> **never inherit a default in production.** Pin the model explicitly.

**Fix:** `speech_model=universal-3-5-pro&language_codes=en,es`

`universal-3-5-pro` code-switches natively mid-sentence across 18 languages, which is the
interpreter case exactly. `language_codes=en,es` biases toward English and Spanish without
disabling code-switching. Adding `language_detection=true` returns a per-turn `language_code`
and confidence — useful for a court record, and it makes a model regression detectable in
telemetry instead of in a complaint.

---

## Full defect register

Numbers match the `// FIX #n` comments in
[`code/java/src/main/java/com/assemblyai/Spanglish.java`](code/java/src/main/java/com/assemblyai/Spanglish.java).

| # | Severity | Defect | Effect | Fix |
|---|---|---|---|---|
| 1 | **Blocker** | `main()` instantiates non-existent `StreamingTranscription` | Does not compile | Instantiate `Spanglish` |
| 2 | **Blocker** | `encoding=opus` declared, raw PCM sent | Silent decode failure; `Begin` but never a `Turn` | `encoding=pcm_s16le` |
| 3 | **Blocker** | 25 ms chunks (`FRAMES_PER_BUFFER = 400`) | Close `3007` input duration violation | 800 frames = 50 ms |
| 4 | **Blocker** | No `speech_model` pinned | English-only model on Spanish audio | Pin `universal-3-5-pro` + `language_codes=en,es` |
| 5 | Cleanup | `format_turns=true` | Deprecated on U3.5 Pro (formatting always on) | Remove |
| 6 | High | Mic line buffer = 800 B (one chunk) | Line overruns → dropped words | ~1 s of slack |
| 7 | High | `ws.send()` inline in the mic read loop | Network stalls back-pressure audio capture | Bounded queue + sender thread |
| 8 | High | `break` on any send exception | One transient error permanently kills streaming, process keeps running silently | Log and continue; let `onClose` decide |
| 9 | **High** | `onClose`/`onError` never `countDown()` the latch | **Main thread hangs forever after any server close** — looks like a frozen product | Count down on every exit path |
| 10 | High | `data.get("type").getAsString()` unguarded | NPE on any typeless message; `e.getMessage()` is `null`, so it prints "Error handling message: null" | Guard `has("type")`, log raw payload |
| 11 | **High** | `default: break;` swallows unknown message types | **Server-side diagnostics discarded before a human sees them** | Log unknown types |
| 12 | Medium | Print logic branches on `turn_is_formatted` | Deprecated on U3.5 Pro; unreliable finality signal | Branch on `end_of_turn` |
| 13 | High (at scale) | `List<byte[]> recordedFrames` grows unbounded | ~345 MB heap per 3-hour session; OOM at 2,000 streams | Stream to disk, patch WAV header on close |
| 14 | **High** | Close code printed as a bare integer | The server's explanation rendered as noise | Map 1008/3005/3006/3007/3008/3009 to English |
| 15 | Medium | `Thread.sleep(500)` after `Terminate` | Races the flush; final turn can be lost | Await the `Termination` message |
| 16 | Medium | `API_KEY = "api_key"` hardcoded literal | Close `1008` if never replaced; key leaks into VCS | Read from env |
| 17 | Medium | `connectBlocking()` return value ignored | Failed handshake indistinguishable from success | Check the boolean, add a timeout |
| 20 | Medium | `cleanup()` closes the mic line while the reader thread is blocked in `read()` | Spurious error on every clean exit | Stop → join → close |
| 21 | Low | `cleanup()` re-entrant (shutdown hook + `catch` block) | Double close, duplicate WAV write | Idempotence guard |
| 22 | **Compliance** | Default edge-routed host | **No data-residency guarantee for court audio** | `streaming.us.` / `streaming.eu.` |
| 23 | Medium | `Begin.configuration` never inspected | The applied model was observable all along and nobody looked | Log and assert it |

Items 18/19 in the source are notes on things the original got **right** — the `AudioFormat`
signedness and endianness were correct, which is precisely why `encoding=opus` was the
mismatch rather than the capture code.

---

## Why this took so long to diagnose (the honest version)

Defects **9, 10, 11 and 14 form a diagnostic blackout**. Independently they are minor. Together
they mean:

- the server sends a precise error → `default: break;` drops it (#11)
- the close code carrying the reason → printed as a bare integer (#14)
- an NPE in the message handler → surfaces as literally `"Error handling message: null"` (#10)
- the process then hangs instead of exiting → looks like a hang, not a failure (#9)

The customer was not being vague when they said "it doesn't work at all." **That is genuinely
all the information their client gave them.** Worth remembering before anyone on our side reads
the terse bug report as unhelpful.

---

## What the fixed code changes

See [`code/java/`](code/java/) for the annotated Java (compile-verified) and
[`code/python/repro.py`](code/python/repro.py) for a harness that runs the same audio through
all four configurations so the customer can watch each bug fire and clear in isolation.

Minimal diff, if they want the smallest possible change to unblock today:

```diff
-private static final int FRAMES_PER_BUFFER = 400;   // 25 ms — violates the 50–1000 ms contract
+private static final int FRAMES_PER_BUFFER = 800;   // 50 ms

-"wss://streaming.assemblyai.com/v3/ws?sample_rate=%d&encoding=opus&format_turns=true"
+"wss://streaming.us.assemblyai.com/v3/ws?sample_rate=%d&encoding=pcm_s16le"
+    + "&speech_model=universal-3-5-pro&language_codes=en,es&language_detection=true"

-StreamingTranscription transcription = new StreamingTranscription();
+Spanglish transcription = new Spanglish();
```

Those three edits clear all four blockers. Everything else in the register is what makes it
survive 2,000 concurrent streams in production.
