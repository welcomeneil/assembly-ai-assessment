# Demo brief: iTranslate

For the account executive. Read this before the call. Ten minutes.

Everything else in this folder is the engineering behind the demo. This page is the meeting.

---

## 1. What they told us

They make a handheld translator. Two people who do not share a language talk into it, and it
speaks each side back to the other. They want the speech recognition to be more accurate.

That is a real problem and we solve it. But it is not the thing that will make them sign.

---

## 2. What they actually need

Their device has to be told which language is coming before someone speaks. That is how
speech recognition has always worked: you pick a language, then you talk.

For a translator, that means a button. Every time the conversation changes hands, somebody has
to press something. If the wrong language is selected, the device does not throw an error. It
confidently transcribes the wrong thing, translates the wrong thing, and says the wrong thing
out loud. Neither person can tell, because neither of them can read the other's language.

**Our model does not need to be told.** It works out which language is being spoken, turn by
turn, and it can follow a switch in the middle of a single sentence. It does that across 18
languages inside one connection.

So the pitch is not "your transcripts get a bit better."

The pitch is: **you can take the button off the device.** Two people pick it up and talk.

That is a product change, and it is the reason to keep talking to us.

---

## 3. What the customer should believe when the call ends

Four things. If they leave believing these, the demo worked.

1. **Their device does not need to get more powerful.** No chip change, no battery hit, no
   new hardware. It streams audio and plays audio. Everything hard happens on our side.
2. **The language button can go away**, and that makes their product noticeably nicer to use.
3. **There is real accuracy headroom they are not using**, and most of it costs them nothing
   to turn on.
4. **We understood their product**, not just their API question.

---

## 4. The demo, beat by beat

Runs about six minutes. One browser window.

**Setup, before they join:**

```bash
cd part-1-itranslate/demo/backend
npm install && npm run build && npm start
```

Open http://localhost:8787. Nothing else needed. No API key, no microphone, no network.

---

**Beat 1. Set the scene.** (30 seconds)

"This is a tourist and a market vendor in Madrid, talking through a handheld. Watch the
coloured tag on each line."

Press **Play sample conversation**.

---

**Beat 2. Let the language flip.** (90 seconds, the important part)

The tag on each line changes between English and Spanish as the conversation goes back and
forth. The counter at the top labelled **Language switches** climbs.

Say: *"Nobody pressed anything. That tag is our model telling you what it heard. Your device
never had to know what was coming."*

Then stop talking and let it run. This beat sells itself. Do not narrate over it.

---

**Beat 3. The names.** (45 seconds)

Two lines are flagged on screen: one mentions **Hotel Catalonia**, one mentions **Elena**.

Say: *"Those came out right because the device told us to expect them. It knows where it is
from GPS and it knows the traveller's hotel from their itinerary. It sends us a short
description of the situation at the start of every conversation. The user types nothing."*

If they want the number: on AssemblyAI's own benchmark across 20,000 calls, a detailed
description of the situation cut errors on people's names by **49%** and overall word errors by
**21%**. That is the single biggest accuracy lever available to them, and it is free.

---

**Beat 4. The mid-sentence switch.** (45 seconds)

The last line of the conversation starts in Spanish and finishes in English:

> *"Sí, un Rioja crianza. Le pongo una botella, is perfect for the jamón."*

Say: *"That is one sentence, two languages. A device that was told 'this is Spanish now' would
turn that English fragment into Spanish-sounding nonsense. Real bilingual speakers do this
constantly."*

---

**Beat 5. The speed.** (45 seconds)

Point at the coloured bar under any line. It splits the wait into three parts: recognising the
speech, translating it, speaking it.

Say: *"Under a second, end to end, and you can see exactly where it goes. When you want to make
it faster, you know which part to work on."*

---

**Beat 6. Show your work.** (45 seconds)

The right-hand panel shows the exact settings the device used and the exact description it sent
us.

Say: *"Nothing here is hidden. That is what we sent and that is what we got back."*

This beat is for their engineers, who are the ones who will actually decide.

---

**Beat 7. The one they will thank you for.** (60 seconds)

The bottom right panel compares how long the connection stayed open against how much talking
actually happened.

Say: *"We charge for how long the connection is open, not how much audio goes through it. On a
device someone puts in their pocket, those two numbers come apart fast. Across a hundred
thousand devices this decision is worth more than which model you pick. We would rather tell
you now than have you find it on a bill."*

Nobody expects a vendor to volunteer this. It buys more trust than the whole rest of the demo.

---

## 5. Architecture, if they ask

One picture, and only if they ask. Do not lead with it.

```
   their device                      their servers                   us
   ------------                      -------------                   --
   microphone  ------------------------------------------------->  transcribe
                                                                        |
                                     ask us for a key  <----------------+
                                     ask us to translate  <-------------+
                                            |
   speaker     <---------------------------- (their existing voice)
```

Three things worth saying out loud:

- **The audio goes straight to us.** It does not pass through their servers. Their backend
  stays small no matter how many devices they sell.
- **No password lives on the device.** Anyone can open a handheld and read what is inside it.
  Their server hands out a key that works once and expires in a minute.
- **Settings come from their server, not the device.** Firmware updates take months to reach a
  consumer fleet. This way they can change how the device behaves for everyone at once, or for
  1% of them first.

---

## 6. What we ask for at the end

Do not ask for a contract. Ask for a test.

**"Send us thirty minutes of your real recordings and what was actually said in them. We will
run it through and show you the accuracy difference in a week."**

Why this works:

- It is a small ask. Nobody has to get approval to send us audio they already have.
- It moves the conversation from our claims to their data.
- We already built the tool that produces the number, so the week is real.

Their free account has $50 of credit and needs no card, so their engineers can start today
without procurement.

If they say yes, the follow-up is: agree what "good enough" means before we run it. A number
nobody agreed to in advance is a number somebody argues with afterwards.

---

## 7. What I need from the call

Five questions. Getting three of them is a good call.

1. **Does the device have a language selector today?** The whole pitch rests on this and I am
   inferring it. If they already solved it, we pivot to pure accuracy.
2. **What do they hear most from unhappy users?** Wrong words, too slow, or missed speech.
   Those are three different fixes.
3. **Which language pairs actually get used?** Fleet-wide, not the marketing list.
4. **Where do people use it?** Airports and restaurants are a different noise problem than
   hotel lobbies.
5. **Are they selling in the EU?** If so we need the conversation about where data is
   processed, and it is easier to have now than during their launch review.

---

## 8. If they ask

**"How is this different from Google or Amazon?"**
Mid-sentence language switching inside a single connection, and the situational description
that drives the accuracy gain. Offer the head-to-head on their own audio rather than arguing
about it.

**"These are private conversations. What happens to them?"**
For live streaming we keep nothing. No audio, no transcripts, once training opt-out is on.
Paid accounts only. There is a fuller answer in
[Part 2's privacy write-up](../part-2-spanglish/04-data-privacy.md), and anything contractual
goes to legal rather than being promised on a call.

**"What does this cost at 100,000 devices?"**
Depends almost entirely on when the device hangs up, not on which model they choose. The
numbers are in [01-approach.md](01-approach.md). Give them the range and the reason, not a
single figure.

**"How much firmware work is this?"**
Less than they expect. The device streams audio and plays audio, which it already does. The
settings come from their server. Removing the button is the biggest change and it is a
deletion.

**"What if the network drops?"**
The device holds a few seconds of audio and reconnects. We have a reference client that does
this, in [Part 2](../part-2-spanglish/code/python/production_client.py).

**"Can it handle three people?"**
Yes, and it can label who said what. Worth mentioning, not worth demoing. Their product is
two-way.

---

## 9. Honest notes, not for the customer

- The conversation in the demo is **written, not recorded.** The timings are realistic values
  from our published figures, not measurements. The dashboard says so on screen in amber. Do
  not let anyone screenshot it as a benchmark.
- **The language-button claim is an inference.** I have not seen their firmware. Question 1 in
  section 7 exists to confirm it. If I am wrong, the accuracy story stands on its own and the
  demo still works.
- **None of this has run against the live service yet.** No API key was available when it was
  built. Everything follows published documentation, and the accuracy harness exists so their
  numbers replace my claims. Worth twenty minutes with a real key before the call.

---

## Where the rest of it lives

| If they want | Give them |
|---|---|
| The full technical approach | [01-approach.md](01-approach.md) |
| Every accuracy lever, ranked | [02-accuracy-playbook.md](02-accuracy-playbook.md) |
| To run the demo themselves | [README.md](README.md) |
| To measure it on their own audio | [accuracy_bench.py](demo/bench/accuracy_bench.py) |
