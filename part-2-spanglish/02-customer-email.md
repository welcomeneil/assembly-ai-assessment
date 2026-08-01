## Subject: Fixed bilingual streaming code + scaling & privacy answers
Hi [Name],

Great to meet you!

I'm Neil, covering for [Colleague]. I found the issue in your snippet. It is fixed, and the working code is attached.
You had three distinct client-side configuration errors. Your code was also swallowing the error messages we were sending you, which is why you couldn't debug it. No changes are needed on our side.
## What was wrong

   1. Code won't compile: main() calls StreamingTranscription, but the class is named Spanglish. The code you sent is not the code you ran. Please send the exact executed file so I can check for other issues.
   2. Audio format mismatch: Your URL stated encoding=opus, but your code sends raw 16-bit PCM. We returned "Error 3006: Failed to decode Opus packet" within a second of the session opening, then closed the connection.
   3. Buffer size too small: FRAMES_PER_BUFFER = 400 sends 25ms of audio. Our API requires 50–1000ms. We closed the socket with "3007: Input Duration Violation: 25.0 ms. Expected between 50 and 1000 ms".

I want to be direct about the fourth thing, because it's the important one. We told you what was wrong on both counts, immediately and by name. Your onMessage handler switches on the message type and handles four of them; ours arrived as type "Error", which fell through to `default: break;` and was discarded. Your onClose printed our close code as a bare integer with no explanation. That's why weeks of debugging produced no detail to report — the answers were arriving and being deleted. The attached file logs everything we send.

One thing I checked and want to correct before you hear it elsewhere: I initially expected that not pinning a speech_model would have put you on an English-only model and mangled the Spanish. I tested it, and that isn't what happens — an unpinned session resolved to universal-3-5-pro and transcribed both languages correctly. I've still pinned the model in the attached file, because inheriting a default means your transcription quality can change without you deploying anything, but it was not a cause of your outage.

## The fix
Three edits clear all three blockers:

    - private static final int FRAMES_PER_BUFFER = 400;
    + private static final int FRAMES_PER_BUFFER = 800;

    - "...?sample_rate=16000&encoding=opus&format_turns=true"
    + "...?encoding=pcm_s16le&sample_rate=16000&speech_model=universal-3-5-pro"
    +     + "&language_codes=en&language_codes=es&language_detection=true"

    - StreamingTranscription transcription = new StreamingTranscription();
    + Spanglish transcription = new Spanglish();

Note that language_codes is a repeated parameter, one code per occurrence. Sending language_codes=en,es is rejected on connect with error 3006. I hit that myself while testing the fix.

## Attached files:

* Spanglish.java: Your corrected file. Fixes the bugs above, plus hidden memory leaks, connection hangs, and error visibility. Run it against a fixed WAV with `--file yourfile.wav` if you want a repeatable test before wiring the microphone back up.
* repro.py: A 2-minute script showing the step-by-step failures and fixes using your audio. Every close code quoted above came from this run — you can reproduce all of it on your own key.

------------------------------
## Scaling to 2,000 concurrent streams
We do not cap total concurrent streams. We only limit new sessions opened per minute, which auto-scales by 10% every minute you hit ≥70% capacity.

* Steady state: 2,000 concurrent streams (30-min average) is ~67 new sessions/min. Your standard paid budget covers this.
* Cold start: Ramping 0 to 2,000 immediately takes 12 minutes to scale automatically. We can pre-provision this to cut the wait to 4 minutes at no extra cost.
* Required client logic: You must implement exponential backoff with jitter for close code 3009. You also need session rollover for hearings passing our 3-hour limit (close code 3008). The attached Python client shows how.
* Billing warning: Streaming is billed on WebSocket connection time, not audio sent. Idle sockets cost money. Close connections during recess and adjournment.

------------------------------
## Data privacy and retention
The full security document is attached. Key points:

* Zero retention: We do not store audio or transcripts if you opt out of model training. Only metadata (IDs, duration) is kept for billing.
* Data residency: Your snippet used the global endpoint. I changed it to ://assemblyai.com to guarantee data never leaves the US.
* Contract: We will work with your AE to write these zero-retention terms directly into your enterprise agreement.

------------------------------
## Next steps
Let's do a 30-minute call this week to run the code together, set your concurrency target, and sync with your security team.
What days and times over the next 48 hours work best for a quick 30-minute call?

Applied AI Engineer, AssemblyAI
[phone] · [email]

