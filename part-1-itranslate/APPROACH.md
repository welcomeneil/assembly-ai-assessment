# Approach

iTranslate wants better live speech-to-text on a handheld with no GPU. Everything hard
happens on our side, so the answer is mostly configuration — but the largest lever
changes their product, not just their accuracy.

---

## 1. The reframe

A language-pinned recogniser has to be told what is coming before anyone speaks. On a
two-way translator that means a button, pressed on every handoff. Get it wrong and the
device doesn't error — it confidently transcribes, translates and speaks the wrong
thing, and neither person can tell, because neither reads the other's language.

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
                                                                  + translate
  3. speaker  <-----------------------------------------------   (same socket)
```

Three decisions, and the reasoning is the deliverable more than the diagram:

**Audio goes device → AssemblyAI directly.** Not through their backend. Their backend
stays the same size at 100,000 devices as at 100, and it's one less hop in the latency
budget.

**No API key on the device.** A consumer handheld can be opened and its firmware
dumped; a key on one device is a key on every device, and revoking it bricks the fleet.
Their server mints a single-use token valid for 60 seconds
(`GET /v3/token`, `expires_in_seconds` 1–600).

**Connection parameters come from their server, not firmware.** Consumer firmware takes
months to roll across a fleet, so anything compiled in is frozen for months. Served,
the model, noise setting and turn thresholds change for everyone at once — or for 1%
first. This is the difference between tuning accuracy in a week and in a release cycle.

**Translation rides inside the streaming session** via `llm_gateway`, so a finished turn
doesn't make a second round trip before the user hears anything. TTS stays theirs —
AssemblyAI doesn't do it and they already have an engine.

---

## 3. Accuracy levers, ranked by return

| # | Lever | Expected | Cost to them |
|---|---|---|---|
| 1 | `prompt`, detailed (20–50 words of prose) | **−21% WER, −29% entity error rate** | free — the device writes it from GPS + situation + itinerary |
| 2 | `keyterms_prompt` (≤100 terms, ≤50 chars each) | proper nouns land; it's what users notice | free — contacts, bookings, saved places |
| 3 | `language_detection` + `language_codes=en,es` | removes the wrong-language failure mode entirely | a firmware deletion |
| 4 | `voice_focus=far-field` | a handheld at arm's length in a station is far-field, not a headset | free |
| 5 | `mode=max_accuracy` | a translator can afford latency a voice agent can't | ~100ms |
| 6 | `min_turn_silence` ≈ 480ms | two people handing a device over pause longer than one person thinking; too-early endpointing eats the end of sentences | free, needs their data to tune |

Levers 1 and 2 are the ones nobody turns on, and together they're most of the gain.
The prompt levels are graded — domain-only is −5%, scenario −10%, detailed −21% — so
it's worth spending the 50 words.

**Not accuracy, but raise it anyway:** Opus encoding cuts bandwidth roughly tenfold,
which on a metered cellular handheld is the difference between a device people use
freely and one they ration. Ship it separately with its own integration test —
declaring a compressed encoding while sending raw PCM produces a session that connects,
reports healthy and silently returns nothing. That exact mistake is what broke the
customer in Part 2.

---

## 4. Cost, which they didn't ask about

Streaming bills on **how long the connection is open, not how much audio goes through
it.** A translation device is bursty: a 40-second exchange, then ten minutes of walking.

The demo makes this visible — the sample session holds the socket 13s past the last
word, and 23% of it is billed for silence. At 100,000 devices and 6 sessions a day that
tail alone is roughly **$1,000 a day**. The hang-up policy deserves more engineering
attention than the model choice.

`universal-3-5-pro` is $0.45/hr; `universal-streaming-english` and
`-multilingual` are $0.15/hr. If a fleet-wide cost ceiling bites, the honest move is to
route the long tail of low-value sessions to the cheaper model rather than to weaken
the tuning on the ones that matter.

---

## 5. What I'd do first

1. **Get 30 minutes of their real recordings with what was actually said.** Every number
   above is from AssemblyAI's benchmarks, not their audio. `demo/src/score.ts` already
   produces the measurement; a week turns my claims into their numbers.
2. **Agree what "good enough" means before running it.** A target nobody agreed to in
   advance is one somebody argues with afterwards.
3. **Ship levers 1–4 behind the served config**, to 1% of the fleet, and compare.

---

## 6. Open questions and limits

- **Six languages.** `universal-3-5-pro` and `universal-streaming-multilingual` cover
  en, es, de, fr, pt, it. For a consumer travel device that is a real ceiling, and I'd
  rather flag it than let it surface during their launch review. `whisper-rt` covers 99
  languages with detection — the shape of the answer is Universal for the high-volume
  pairs and Whisper as the fallback tier, chosen per session from the served config.
- **`prompt` is capped at 1750 characters**, so the device needs a policy for which
  names make the cut once an itinerary gets long.
- **Which pairs actually get used fleet-wide**, and where people use the device —
  a station is a different noise problem from a hotel lobby, and `voice_focus_threshold`
  is tunable per environment.
- **EU sales?** There are region-pinned endpoints (`streaming.eu.`), and that
  conversation is easier now than during their launch review.

---

## Sources

All figures above are from AssemblyAI's current documentation, checked while writing
this:

| Claim | Where |
|---|---|
| prompt: −21% WER / −29% entity error, 20,000 calls; −10% scenario; −5% domain | [Streaming prompting guide](https://www.assemblyai.com/docs/streaming/prompting) |
| keyterms: 100 terms, 50 chars; all connection parameters; message shapes | [Streaming API reference](https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api) |
| token endpoint, 1–600s, max session 10,800s | [Token reference](https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token) |
| $0.45/hr Universal-3.5 Pro, $0.15/hr streaming; billed on connection time; 100 new streams/min paid | [Pricing](https://www.assemblyai.com/pricing) |
| 6 languages with code-switching; `whisper-rt` = 99 | [Multilingual streaming](https://www.assemblyai.com/blog/introducing-multilingual-universal-streaming) |
| `llm_gateway` config and `LlmGatewayResponse` shape | [LLM Gateway with streaming](https://www.assemblyai.com/docs/streaming/guides/real_time_llm_gateway) |

One correction worth recording: a "10.2% WER reduction from context carryover" figure
circulates in search results attributed to AssemblyAI's contextual-awareness post. It
is not in that post, which gives no number. I left it out rather than cite it.
