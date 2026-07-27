## Subject: Fixed bilingual streaming code + scaling & privacy answers
Hi [Name],

Great to meet you!

I'm Neil, covering for [Colleague]. I found the issue in your snippet. It is fixed, and the working code is attached.
You had four distinct client-side configuration errors. Your code was also swallowing our API errors, which is why you couldn't debug it. No changes are needed on our side.
## What was wrong

   1. Audio format mismatch: Your URL stated encoding=opus, but your code sends raw 16-bit PCM. We accepted the session but couldn't decode the audio, causing it to fail silently.
   2. Buffer size too small: FRAMES_PER_BUFFER = 400 sends 25ms of audio. Our API requires 50–1000ms. The server closed the socket with error 3007, but your code hid the message.
   3. Wrong speech model: No model was specified, defaulting you to English-only. Spanish audio was mistranslated into English. Pinning the correct model fixes this.
   4. Code won't compile: main() calls StreamingTranscription, but the class is named Spanglish. The code you sent is not the code you ran. Please send the exact executed file so I can check for other issues.

## The fix
These three edits fix all four problems:

-private static final int FRAMES_PER_BUFFER = 400;   +private static final int FRAMES_PER_BUFFER = 800;   
-"wss://://assemblyai.com"+"wss://://assemblyai.com"+    + "&speech_model=universal-3-5-pro&language_codes=en,es&language_detection=true"
-StreamingTranscription transcription = new StreamingTranscription();+Spanglish transcription = new Spanglish();

## Attached files:

* Spanglish.java: Your corrected file. Fixes the bugs above, plus hidden memory leaks, connection hangs, and error visibility.
* repro.py: A 2-minute script showing the step-by-step failures and fixes using your audio.

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

