# Handoff: Spanglish Inc.

**From:** [Name], covering during your absence
**To:** [Colleague]
**Date:** [date]

---

## Current status

Spanglish escalated while you were out, reporting that our streaming product did not work at all
and flagging a retention risk. The issue is resolved. The cause was three client-side
configuration defects plus error handling that discarded our diagnostics. There is no defect in
our service, and that is now verified against the live API rather than inferred from the docs.

I have sent them corrected code, a scaling guide, and answers to their privacy questions. The
account is stable and the conversation has moved to their go-live plan.

Nothing requires immediate action. Five open items are listed below with owners.

---

## What happened

Spanglish submitted a Java WebSocket client with three independent blocking defects:

1. The file does not compile. `main()` instantiates `StreamingTranscription`, which does not
   exist. The class in the file is `Spanglish`.
2. The connection URL declares `encoding=opus` while the client transmits raw PCM. The server
   returns `Error 3006 Failed to decode Opus packet` and closes.
3. Audio chunks are 25 ms. The API requires 50 to 1000 ms. The server closes the connection with
   code `3007` and the exact expected range.

Their error handling discarded every diagnostic the service returned, which is why the report
reached us with no detail. That is the actual story of this ticket.

A fourth item, no `speech_model` pinned, was originally written up as a blocker on the theory
that it fell back to an English-only model. **It did not reproduce.** Unpinned sessions resolved
to `universal-3-5-pro` and transcribed Spanish correctly. It is now a recommendation, not a
cause, and the customer has been told so explicitly.

Full analysis: [`01-root-cause.md`](01-root-cause.md). Live results and corrections:
[`07-live-verification.md`](07-live-verification.md).

---

## Deliverables sent

| Deliverable | File | Sent to customer |
|---|---|---|
| Corrected Java client, changes marked `FIX #n`, compile-verified on JDK 19 | [`code/java/`](code/java/) | Yes |
| Reproduction harness: same audio, four configurations, run against the live API | [`code/python/repro.py`](code/python/repro.py) | Yes |
| Production reference client: rollover, backoff, backpressure | [`code/python/production_client.py`](code/python/production_client.py) | Yes |
| Email explaining the cause and the fix | [`02-customer-email.md`](02-customer-email.md) | Yes |
| Scaling guide to 2,000 concurrent streams | [`03-scaling-to-2000.md`](03-scaling-to-2000.md) | Yes |
| Data privacy and retention answers | [`04-data-privacy.md`](04-data-privacy.md) | Yes |
| Internal engineering summary | [`05-internal-eng-summary.md`](05-internal-eng-summary.md) | Internal only |

---

## Actions required from you

**1. Resume ownership of the account.** They are aware you were out and that I covered. A brief
message confirming you have read the file and are back on the account will land better from you
than a silent transition.

**2. Run the follow-up call.** I offered 30 minutes within two days of sending the email. Agenda:

- Run the corrected code against their own bilingual audio and confirm quality
- Confirm target concurrency and go-live date so we can pre-provision their rate budget
- Walk their security team through the retention answers and begin the contractual work

**3. Drive the model selection benchmark.** This is the highest-value open item.

There is a threefold cost difference between `universal-3-5-pro` at approximately $0.45 per hour
and `universal-streaming-multilingual` at approximately $0.15 per hour. Both support English and
Spanish. At 2,000 concurrent streams that is approximately $900 per hour against approximately
$300 per hour.

I recommended the Pro model for stronger mid-sentence language switching on interpreter speech,
and told them explicitly to validate that on their own audio rather than accept the
recommendation. Obtain 10 to 20 representative recordings and run the comparison with them. If
the multilingual model performs adequately, the saving is approximately $4,800 per day. If it
does not, the premium is justified with evidence.

**4. Follow up on internal items A1 through A3.** A3 in particular: public documentation still
contradicts itself on the default `speech_model`. The API reference and the migration guide
disagree, and async defaults are grandfathered by account creation date. On the account I tested
the default was `universal-3-5-pro`, but that is one account on one day, and it is not what the
migration guide says. Their account should be confirmed from the dashboard rather than assumed
to match mine. The docs inconsistency is what produced the wrong prediction in the first draft
of this analysis; it will do the same to a customer.

**5. `speaker_labels` needs a real-audio check before we push it.** On the synthetic test clip,
enabling `speaker_labels` reduced finalised turns from 4 to 3 and dropped the per-turn Spanish
language tags. The content still arrives in `SpeakerRevision` messages, so a client that buffers
by `turn_order` recovers it, but ours prints on `end_of_turn` and lost it. Court transcription
needs speaker separation, so we cannot simply recommend turning it off. Get 10 to 20 real
bilingual recordings and measure before telling them either way. Details in
[`07-live-verification.md`](07-live-verification.md).

---

## Open items

| # | Item | Owner | Priority | Notes |
|---|---|---|---|---|
| P1 | Written confirmation of their model training opt-out status | You | High | Zero retention is conditional on it. Opt-out applies going forward only. |
| P2 | Definitive answer on HIPAA and BAA availability | You, Legal | Medium | Documentation references an executed BAA but does not confirm HIPAA certification. I did not assert it. |
| P3 | Zero retention and reduced async TTL added to the enterprise agreement | Sales, Legal | High | They require a contractual commitment rather than a documentation reference. |
| P4 | Provide SOC 2 Type 2 report, GDPR assessment, DPA and subprocessor list | You | Medium | Under NDA. |
| P5 | Confirm they have deployed the regional endpoint change | Spanglish | High | They were using the edge-routed endpoint, which provides no data residency guarantee for court recordings. |
| A3 | Confirm the default `speech_model` for their account | Engineering | Medium | Resolved to `universal-3-5-pro` on my test account; theirs is unconfirmed. See above. |
| A8 | Measure `speaker_labels` turn behaviour on real bilingual audio | Engineering | Medium | Cost 1 of 4 turns and all `es` tags on the synthetic clip. Not enough evidence to file. |
| A7 | Pre-provision their new-session rate budget before go-live | Support, Sales engineering | High | Blocks their cold start. No cost to us. |

---

## Information not included in the customer-facing documents

**They may not have run the code they sent us.** The file does not compile, which is verified. I
asked what they actually executed and have not received a response. If their production client
differs from the submitted file, there may be an additional issue we have not seen. I did not
press the point because they were already frustrated and the three blockers account for the
reported symptoms. Use your judgement on how firmly to pursue it.

**I corrected two of my own published claims after testing them.** The first analysis said
`encoding=opus` fails silently and that an unpinned model would give them English-only output.
Neither is true. Both went to the customer before I had a key, and both are now corrected in
writing rather than dropped. If they quote the original wording back at you, the corrections and
the raw transcripts are in [`07-live-verification.md`](07-live-verification.md). I would rather
they see us revise a claim than defend one.

**Their async workload carries greater privacy exposure than the streaming workload they asked
about.** Streaming offers zero data retention. Async retains uploaded audio for 24 to 48 hours
and transcripts for 72 hours by default. They have not raised this. I addressed it proactively
in the privacy document because their security team will identify it during review. Expect
questions.

**They will encounter the three-hour session limit.** Sessions close at three hours with code
`3008`, and court proceedings frequently run longer. I flagged this and provided rollover code,
but they have not confirmed they will implement it. This should be verified before go-live. It
is the most likely cause of a first-day production incident.

**Billing may be a surprise.** Streaming is billed on WebSocket connection duration, not audio
transmitted. At 2,000 concurrent streams, connections left open during recesses represent
meaningful cost. I put this in writing to their engineering lead. Confirm it has reached whoever
owns their infrastructure budget.

**Assessment of the relationship.** They were frustrated but reasonable!

---

## Repository layout

```
part-2-spanglish/
├── 01-root-cause.md              Full defect register, 23 items
├── 02-customer-email.md          Email sent, with notes on the approach taken
├── 03-scaling-to-2000.md         Customer-facing scaling guide
├── 04-data-privacy.md            Customer-facing privacy and retention answers
├── 05-internal-eng-summary.md    Internal analysis and recommended actions
├── 06-handoff.md                 This document
└── code/
    ├── java/                     Corrected client, build script, Maven configuration
    └── python/                   Reproduction harness and production reference client
```

---

## If they report a new issue

Request the following three items before beginning any investigation. They take the customer
under a minute to collect and significantly reduce triage time:

1. The session ID from the `Begin` message, which is the correlation identifier support requires
2. The WebSocket close code and the complete reason string
3. The `configuration` object from the `Begin` message, which reports the settings the service
   applied

If they cannot provide these, their logging has not been corrected, and that should be addressed
first. It is the primary reason this escalation took as long as it did.

Contact me if anything is unclear. I am available to join the follow-up call if a joint handover
would be useful.
