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
hardware rate. 

Chrome is the tested path.

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

Architecturally, AssemblyAI's gateway is the one to prefer — it's what their own
guide uses and it keeps the pipeline on a single vendor.

### The two translation products are not the same thing

The live loop uses **LLM Gateway** (`POST /v1/chat/completions`), which is what AssemblyAI's own
[real-time translation guide](https://www.assemblyai.com/docs/streaming/guides/real_time_translation)
does.

The **Translated transcript** button uses
[Speech Understanding Translation](https://www.assemblyai.com/docs/speech-understanding/translation)
(`POST /v1/understanding`). It's keyed on a `transcript_id` from the async
`/v2/transcript` pipeline, so it *cannot* sit in a realtime loop. Realtime
gets you the conversation; this gets you the record of it.

Measured: 56 seconds of bilingual audio → transcript, speaker labels, and Spanish→French
translation in **8 seconds**.

### Wrong-language protection

`Turn.language_code` is trusted only when it names one of the two languages in play. This API
has been observed returning a third language at low confidence — French at 0.27 and 0.49 on an
en/es conversation. Anything outside the pair goes to the gateway with a prompt that works out
the direction itself, so a bad label can't send the translation to the wrong language on stage.
