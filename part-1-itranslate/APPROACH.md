# Approach

iTranslate wants better live speech-to-text on a handheld with no GPU. 
The customer wants improved STT accuracy, so the answer is configuration,
and demonstrating our STT streaming capabilities in action.

---

## 1. The reframe

A language-pinned recogniser has to be told what is coming before anyone speaks. On a
two-way translator that means a button, pressed on every handoff.

`universal-3-5-pro` returns the language per turn and follows a switch inside one
sentence. **The button can come off the device.** The accuracy work below is real, but
this is the part worth a second meeting.

*Caveat: I'm inferring the button from how comparable devices work
It's the first question to ask. If I'm wrong, everything below stands.*

---

## 2. Architecture

```
  handheld                        iTranslate's server              AssemblyAI
  --------                        -------------------              ----------
  1. ask for a token  ---------->  mints, 60s, single use
  2. audio  -------------------------------------------------->  transcribe
  3. final transcript, tagged with the language  <----------------+
     |
     +--> their translation engine --> their TTS --> speaker
```


**Audio goes device → AssemblyAI directly.** Not through their backend.

**No API key on the device.** A consumer handheld can be opened and its firmware
dumped; a key on one device is a key on every device, and revoking it bricks the fleet.
Their server mints a single-use token valid for 60 seconds
(`GET /v3/token`, `expires_in_seconds` 1–600).

**Connection parameters come from their server, not firmware.** Consumer firmware takes
months to roll across a fleet, so anything compiled in is frozen for months. Served,
the model, noise setting and turn thresholds change for everyone at once — or for 1%
first. This is the difference between tuning accuracy in a week and in a release cycle.

**Scope stops at the transcript.** They asked about recognition accuracy and already own
translation and TTS. AssemblyAI *can* carry translation on the same socket via
`llm_gateway`, and there's a real latency argument for it, but that's a different
conversation and leading with it reads as a land-grab on the one they didn't ask about.

---

## 3. Accuracy levers — what I predicted, and what measured

I wrote the left column from AssemblyAI's published figures, then ran it against the
live API on 56 seconds of real bilingual conversation, three runs per config.

| Lever | I predicted | Measured | |
|---|---|---|---|
| `keyterms_prompt` | helps names | **29.2% → 25.9% WER** | ✅ ship it |
| `language_detection` + `language_codes` | removes the wrong-language failure | works — per-turn `es`/`en` labels with confidence | ✅ ship it |
| `prompt`, detailed | **−21% WER** (their benchmark, 20,000 calls) | **29.2% → 33.3% WER**, reproducible | ❌ off by default |
| `voice_focus=far-field` | a handheld at arm's length is far-field | part of a −4.8pt regression | ❌ off by default |
| `min_turn_silence=480` | two people passing a device pause longer | collapsed 10 turns into 6 | ❌ off by default |
| `mode=max_accuracy` | a translator can afford the latency | no gain on this clip | ❌ off by default |

**Three of my six predictions were wrong, including the one I ranked first.** Full
numbers in [MEASUREMENTS.md](demo/fixtures/MEASUREMENTS.md).

The generalisable point is not "prompting is bad" — it's one 56-second clip and the
prompt was in English over mostly-Spanish audio, which may be the whole story. It's that
**a vendor benchmark is a reason to test a lever, not a reason to ship it.** The value
we bring iTranslate is the harness that tells them which levers pay on *their* audio,
and that harness is `demo/src/score.ts`.

My reasoning about `voice_focus` is a cleaner version of the same mistake: I inferred it
from how the device is *held*, and tested it on a 2008 home recording. Both may well be
right on real device audio. That is exactly what their 30 minutes of recordings is for.

**Not accuracy, but raise it anyway:** Opus encoding cuts bandwidth roughly tenfold,
which on a metered cellular handheld is the difference between a device people use
freely and one they ration. Ship it separately with its own integration test —
declaring a compressed encoding while sending raw PCM produces a session that connects,
reports healthy and silently returns nothing.

---

## 4. Cost, which they didn't ask about

Streaming bills on **how long the connection is open, not how much audio goes through
it.** A translation device is bursty: a 40-second exchange, then ten minutes of walking.

The demo makes this visible — **70.7s billed against 56.0s of audio**, so 21% of the
session was paid for silence. At 100,000 devices and 6 sessions a day, a tail like that
is roughly **$1,000 a day**. The hang-up policy deserves more engineering attention than
the model choice.

`universal-3-5-pro` is $0.45/hr; `universal-streaming-english` and `-multilingual` are
$0.15/hr. If a fleet-wide cost ceiling bites, the honest move is to route the long tail
of low-value sessions to the cheaper model rather than to weaken the tuning on the ones
that matter.

---

## 5. What I'd do first

1. **Get 30 minutes of their real recordings with what was actually said.** Section 3 is
   the argument for this: my predictions were wrong on their-adjacent audio, so they will
   be wrong on their actual audio too, in ways nobody can guess. `demo/src/score.ts`
   already produces the measurement; a week turns claims into their numbers.
2. **Agree what "good enough" means before running it.** A target nobody agreed to in
   advance is one somebody argues with afterwards.
3. **Ship `keyterms_prompt` and `language_detection` behind the served config**, to 1% of
   the fleet, and re-test `prompt` and `voice_focus` on their audio rather than assuming
   my result transfers.

---

## 6. Open questions and limits

- **How many languages, really?** The live API accepts **21** codes plus `multi`;
  AssemblyAI's multilingual-streaming post says six. I verified what the parameter
  validator accepts, not per-language quality, so I would not promise any of the 21
  before testing. For the long tail beyond that, `whisper-rt` covers 99 — the shape of
  the answer is Universal for the high-volume pairs and Whisper as a fallback tier,
  chosen per session from the served config.
- **Detection can return a language you did not declare.** Two turns came back tagged
  French with `language_codes=["en","es"]` set, at 0.27 and 0.49 confidence. A device
  should treat sub-0.7 as "don't switch the output voice" rather than trusting the label.
- **Endpointing depends on the audio having pauses.** The first clip I tried was
  continuous overlapping speech and produced a single turn for 45 seconds — no turn
  boundaries, so no per-turn language labels. Worth knowing before promising per-turn
  behaviour on audio nobody has heard yet.
- **`prompt` is capped at 1750 characters**, so the device needs a policy for which names
  make the cut once an itinerary gets long — if prompting turns out to help on their
  audio at all.
- **Which pairs actually get used fleet-wide**, and where people use the device. A
  station is a different noise problem from a hotel lobby, and `voice_focus_threshold`
  is tunable per environment.
- **EU sales?** There are region-pinned endpoints (`streaming.eu.`), and that
  conversation is easier now than during their launch review.

---

## Sources

All figures above are from AssemblyAI's current documentation:

| Claim | Where |
|---|---|
| prompt: −21% WER / −29% entity error, 20,000 calls; −10% scenario; −5% domain | [Streaming prompting guide](https://www.assemblyai.com/docs/streaming/prompting) |
| keyterms: 100 terms, 50 chars; all connection parameters; message shapes | [Streaming API reference](https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api) |
| token endpoint, 1–600s, max session 10,800s | [Token reference](https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token) |
| $0.45/hr Universal-3.5 Pro, $0.15/hr streaming; billed on connection time; 100 new streams/min paid | [Pricing](https://www.assemblyai.com/pricing) |
| "6 languages" (blog) vs **21 accepted by the live API** — see §6 | [Multilingual streaming](https://www.assemblyai.com/blog/introducing-multilingual-universal-streaming) |
| `llm_gateway` config and `LlmGatewayResponse` shape | [LLM Gateway with streaming](https://www.assemblyai.com/docs/streaming/guides/real_time_llm_gateway) |
