# Method 1 — Custom Pipeline

Two people who don't share a language talk to each other through a laptop. Nobody presses a
button to say whose turn it is.

Every stage is a separate call you own:

```
mic ─► AssemblyAI Universal-Streaming v3   (speech → text, with the language it heard)
    ─► AssemblyAI LLM Gateway              (text → translated text)
    ─► ElevenLabs Flash v2.5               (translated text → speech)
```

## Run it

```bash
cp .env.example .env.local     # add your keys
npm install
npm run dev                    # http://localhost:3001
```

Use Chrome. Safari ignores the `AudioContext` sample-rate option and runs the mic at the
hardware rate; the worklet resamples to compensate, but Chrome is the tested path.

| Variable | Needed | What happens without it |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | yes | nothing works |
| `GEMINI_API_KEY` | yes* | translation falls through to another configured gateway |
| `ELEVENLABS_API_KEY` | no | falls back to the browser's `speechSynthesis` voice |
| `ELEVENLABS_VOICE_ID` | no | lists the account's voices, else a premade default |
| `TRANSLATION_PROVIDER` | no | auto-selects the first configured gateway |
| `TRANSLATION_MODEL` | no | the chosen provider's default |

\* or any other translation gateway — see below.

## Languages

**18 in, 32 out, any pair.** ES↔FR, ES↔DE, FR↔IT all work — that's the reason to choose this
over the Voice Agent, which only manages five English-paired combinations.

The 18 come from Universal-Streaming: `en es fr de it pt tr nl sv no da fi hi vi ar he ja zh`.
All but Hebrew are also speakable by Flash v2.5, so Hebrew is marked *text only* in the picker —
it transcribes and translates, but there is no voice for it.

## How it hangs together

| File | Job |
|---|---|
| `public/pcm-worklet.js` | Float32 → Int16 PCM at 16 kHz, resampling and muting |
| `lib/mic.ts` | `getUserMedia` → worklet → 100 ms frames |
| `lib/aai-stream.ts` | the streaming socket; fires on formatted finals only |
| `lib/tts.ts` | ElevenLabs, falling back to the browser voice |
| `app/api/aai-token/` | mints the 60-second single-use token |
| `app/api/translate/` | LLM Gateway |
| `app/api/tts/` | ElevenLabs, streamed straight through |
| `app/api/transcript-translate/` | the batch Translation API — see below |

**No API key reaches the browser.** The server mints a single-use token valid for 60 seconds.
That's the pattern iTranslate's handheld needs: a consumer device can be opened and its firmware
dumped, so a key baked into one device is a key on every device, and revoking it bricks the
fleet.

### The translation gateway is swappable

`lib/translation-provider.ts` holds a table of gateways that all speak the
OpenAI chat-completions shape, so switching one for another costs an env var
rather than a code change. The first key present wins:

| Order | Provider | Default model | Key |
|---|---|---|---|
| 1 | Google AI Studio | `gemini-3.1-flash-lite` | `GEMINI_API_KEY` |
| 2 | Groq | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| 3 | OpenAI | `gpt-4o-mini` | `OPENAI_API_KEY` |
| 4 | AssemblyAI LLM Gateway | `gemini-2.5-flash-lite` | `ASSEMBLYAI_API_KEY` |

Pin one explicitly with `TRANSLATION_PROVIDER`. With `details` on, the header
names the gateway and model actually in use, so the demo can't misreport itself.

**AssemblyAI is last on purpose.** Its key is always set — streaming needs it —
so putting it first would mask a working Gemini or Groq key behind an
entitlement error. That entitlement is the catch: **AssemblyAI's LLM Gateway is
a separate paid add-on from transcription**, and a key that streams audio
perfectly still returns 401 there until it's enabled. The route says so in
those words rather than reporting a generic failure.

Architecturally, AssemblyAI's gateway is the one to prefer — it's what their own
guide uses and it keeps the pipeline on a single vendor. The table exists so the
demo isn't blocked on a billing question.

### The two translation products are not the same thing

The live loop uses **LLM Gateway** (`POST /v1/chat/completions`), which is what AssemblyAI's own
[real-time translation guide](https://www.assemblyai.com/docs/streaming/guides/real_time_translation)
does.

The **Translated transcript** button uses
[Speech Understanding Translation](https://www.assemblyai.com/docs/speech-understanding/translation)
(`POST /v1/understanding`), a different product. It's keyed on a `transcript_id` from the async
`/v2/transcript` pipeline, so it *cannot* sit in a realtime loop — but it gives you 100+
languages, several at once, speaker-labelled, with formality control, from one request. Realtime
gets you the conversation; this gets you the record of it.

Measured: 56 seconds of bilingual audio → transcript, speaker labels, and Spanish→French
translation in **8 seconds**.

There is also a lower-latency realtime option this demo deliberately skips: the `llm_gateway`
WebSocket query parameter runs the same translation server-side and returns it on the STT
socket, saving a round trip. Its prompt is fixed at connect time and its timing can't be broken
out per stage, which is exactly what the details panel exists to show. In production, prefer it.

### The echo loop

Speaker output re-entering the microphone is the most likely way this breaks live: it
transcribes its own voice, translates that, plays it, forever. Three defences:

1. The worklet emits **silence** the instant playback starts, clearing 250 ms after it ends. The
   socket stays open, so the server sees a normal pause rather than a stall.
2. `echoCancellation` on the input stream.
3. A final turn matching what was just spoken is discarded.

### Wrong-language protection

`Turn.language_code` is trusted only when it names one of the two languages in play. This API
has been observed returning a third language at low confidence — French at 0.27 and 0.49 on an
en/es conversation. Anything outside the pair goes to the gateway with a prompt that works out
the direction itself, so a bad label can't send the translation to the wrong language on stage.

### ElevenLabs on a free or scoped key

Two limits worth knowing before the call, both hit while wiring this up:

- Listing voices needs the `voices_read` permission, which scoped keys often lack. The route
  catches that and uses a premade voice instead of failing.
- Free plans **cannot use library voices at all** — only premade ones. A library voice ID returns
  `402 paid_plan_required`.

Verified on a free key: `es`, `fr`, `de`, `ja` and `hi` all synthesise at roughly 190 ms to first
byte with `eleven_flash_v2_5`.

## Known limits

- **`/api/transcript-translate` polls inside the route handler.** Fine on a laptop; deployed to
  serverless you'd move it to a durable workflow or a webhook rather than holding a function
  open for a few minutes.
- The details panel labels its first stage `transcript`, not "STT". It measures from the API
  signalling end-of-turn to the formatted final — finalisation latency, not the whole of
  recognition, which runs while the person is still talking.
- Only Chrome is tested.
