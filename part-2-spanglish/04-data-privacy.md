# Data privacy and retention — answers for Spanglish Inc.

> Customer-facing; written to be forwarded to a security reviewer unedited.
>
> **Scope note, stated up front:** everything below reflects AssemblyAI's publicly documented
> behaviour and published compliance posture as of July 2026. Documented behaviour is not a
> contractual commitment. Items requiring contractual confirmation are marked
> **[CONFIRM IN CONTRACT]**, and I will drive those with your AE and our legal team rather than
> leaving you to chase them. Your reviewers will draw that distinction anyway — better that we
> draw it first.

---

## The question you actually asked

> *"How can we be confident that no customer data is being retained by your systems?"*

Direct answer, in three parts:

1. **For Streaming: we offer zero data retention of audio and transcripts, conditional on your
   account being opted out of model training.** Session metadata (session ID, duration) is
   retained for billing and logging. Audio and transcript text are not.
2. **For your existing async workload the answer is different** — async retains by default, and
   this is where your real exposure is today. See §3.
3. **Confidence should not rest on our word.** §7 lists the verification and contractual steps
   that convert this from an assurance into an obligation.

---

## 1. Streaming — zero data retention

Per AssemblyAI's published FAQ: *"If you are opted out of model training, we offer zero data
retention of audio and transcripts for our Streaming product."* And: *"Certain metadata about
the transcript is stored and maintained for logging and billing purposes."*

| Data | Retained? |
|---|---|
| Audio streamed over the WebSocket | **No** |
| Transcript text returned over the WebSocket | **No** |
| Session metadata (session ID, duration, timestamps) | Yes — billing and logging |

Two conditions attach, and both matter:

**Condition 1 — model training opt-out.** Zero retention for Streaming is *conditional* on it.
Two constraints your reviewers will ask about:
- Opt-out is **not available on free accounts**. It requires a paid plan.
- Opt-out is **forward-looking only** and cannot be applied retroactively.

**Action:** I am confirming your account's current opt-out status this week and will send
written confirmation. **[CONFIRM IN CONTRACT]**

**Condition 2 — you must not enable features that create artifacts.** Streaming webhooks
(§6) transmit the finalised transcript to an endpoint you control. That is your data in your
infrastructure, but it means "nothing is retained" becomes "nothing is retained *by
AssemblyAI*." Make sure your reviewers understand where that boundary sits.

---

## 2. Data residency — change this now

Your snippet connects to `wss://streaming.assemblyai.com/v3/ws`. That host is **edge-routed for
lowest latency across Oregon, Virginia, and Ireland, and carries no data-residency guarantee.**

For court audio that is the wrong default. Use a Data Zone endpoint:

| Endpoint | Guarantee |
|---|---|
| `wss://streaming.us.assemblyai.com/v3/ws` | Audio and transcription data **never leave the United States** |
| `wss://streaming.eu.assemblyai.com/v3/ws` | Audio and transcription data **never leave the European Union** (Dublin, `eu-west-1`) |
| `wss://streaming.assemblyai.com/v3/ws` | Lowest latency; **no residency guarantee** |

The equivalent for your async workload is `api.eu.assemblyai.com` for EU residency.

This is a one-line change and it is already applied in the corrected code we sent. Given that
US court records may carry jurisdictional handling requirements, I'd treat this as the highest
priority item in this document after the opt-out confirmation.

---

## 3. Your async workload — where the actual exposure is

You are already in production on async, and **async does not default to zero retention.** This
is the gap your security review should focus on, and nobody has raised it with you yet.

| Artifact | Default behaviour |
|---|---|
| Uploaded audio files | Deletion begins at **24 hours**, completes by **48 hours** |
| Final transcription artifacts | Default **72-hour** TTL, configurable **down to 1 hour** |

Deletion uses AWS DynamoDB's TTL mechanism, so the process begins at TTL expiry and completes
subject to AWS's own processing window — "begins at" rather than "instant at."

**Three things you can do about it:**

1. **Request a reduced TTL.** 1 hour is the documented minimum. **[CONFIRM IN CONTRACT]**
2. **Delete transcripts explicitly** via the API once you've retrieved them, rather than waiting
   for TTL. Fastest path to purge, and it produces an auditable action on your side.
3. **Consider whether court proceedings belong on async at all.** If streaming gives you zero
   retention and async gives you 24–72 hours, that's an architectural argument for streaming
   beyond the latency benefit.

---

## 4. Compliance posture

| Standard | Status |
|---|---|
| SOC 2 Type 1 | Certified |
| SOC 2 Type 2 | Certified — independent audit of controls over time |
| GDPR | Third-party assessment completed; DPA available |
| PCI-DSS 4.0 Level 1 | Compliant as of 2025-03-31 |
| EU data residency | Available (Dublin, `eu-west-1`) |
| BAA / HIPAA | Available under enterprise agreement — **[CONFIRM IN CONTRACT]** |

**On HIPAA specifically:** AssemblyAI's zero-retention documentation references customers with
"an executed BAA," so BAAs are offered. The public security page does not itemise HIPAA
certification, so I am not going to assert it — I'll get you a definitive written answer rather
than a confident guess. Court proceedings are generally not PHI, but medical testimony can be,
so it's worth settling.

**Security controls:**
- **Encryption:** AES-256 at rest, TLS 1.3 in transit
- **Penetration testing:** at least annually, on internal and customer-facing assets
- **Vulnerability scanning:** periodic, with criticality-based remediation
- **Uptime:** 99.9% for contracted customers

**Documents to request:** SOC 2 Type 2 report (under NDA), GDPR assessment report, DPA,
subprocessor list, Trust Center access. I can have all of these to your security team within a
few business days.

---

## 5. Model training

- Paid accounts can opt out of use of Customer Data for AI/ML model training **and** for
  benchmarking.
- The model training environment is separate from the production environment.
- Opt-out is **forward-looking only** — it cannot be applied retroactively.
- Free accounts cannot opt out.
- AssemblyAI has itself opted out of model training with all LLM Gateway providers.

**If your account has ever run production traffic while opted in, say so during the security
review.** Retroactive opt-out is not possible and it is better surfaced by you than discovered
by an auditor.

---

## 6. Controls you can turn on yourself

| Control | Parameter | Notes for a court context |
|---|---|---|
| PII redaction | `redact_pii=true` | Redacts PII from final turns in-flight. Also set `redact_pii_sub` (`entity_name` or `hash`). **Note:** enabling it defaults `include_partial_turns` to false. Whether redaction is appropriate for a legal record is your call — but make it a deliberate one, ideally with counsel. |
| Profanity filter | `filter_profanity=true` | Almost certainly **not** what you want for a verbatim court record. Listed for completeness. |
| Data residency | Data Zone endpoint | See §2. |
| Ephemeral credentials | Temporary tokens | If any client-side code ever connects directly, use short-lived tokens (`expires_in_seconds` 1–600, single-use) rather than shipping an API key. |
| Key rotation | Separate keys per environment | Also limits blast radius and stops a load test from throttling production. |

---

## 7. How to get to actual confidence

Assurances are a starting point. This is the path to something your auditors will accept:

1. **Written confirmation of your model-training opt-out status.** I'm driving this; expect it
   this week.
2. **Zero retention for Streaming written into your enterprise agreement.** Public docs are not
   a contract; your reviewers are right to say so.
3. **Executed DPA**, with the subprocessor list reviewed and a change-notification obligation.
4. **SOC 2 Type 2 report reviewed under NDA** — read the exceptions section, not just the
   opinion.
5. **Reduced async TTL** agreed in writing if you keep any async workload. **[CONFIRM IN CONTRACT]**
6. **Data Zone endpoint pinned** in code and verified in your own egress logs — you can confirm
   the destination region independently rather than taking our word for it.
7. **BAA executed** if any proceeding could involve PHI. **[CONFIRM IN CONTRACT]**

---

## Summary for your security reviewer

> Streaming audio and transcripts are not retained by AssemblyAI when the account is opted out
> of model training; only session metadata (ID, duration) is kept, for billing and logging.
> Data residency is guaranteed when a regional Data Zone endpoint is used; the default endpoint
> is edge-routed and does not carry that guarantee. The existing async workload retains
> uploaded audio for 24–48 hours and transcripts for a default 72 hours (reducible to 1 hour),
> which is the larger current exposure and should be addressed independently. AssemblyAI holds
> SOC 2 Type 1 and Type 2, has completed a third-party GDPR assessment, and is PCI-DSS 4.0
> Level 1 compliant. Encryption is AES-256 at rest and TLS 1.3 in transit. Zero retention,
> reduced async TTL, and any BAA should be confirmed contractually rather than relied on from
> public documentation.

---

**Open items I own** — tracked in [`06-handoff.md`](06-handoff.md):

| # | Item | Owner | Status |
|---|---|---|---|
| P1 | Confirm Spanglish's model-training opt-out status in writing | Me | Open |
| P2 | Definitive HIPAA/BAA answer from legal | Me + Legal | Open |
| P3 | Zero retention + reduced async TTL into the enterprise agreement | AE + Legal | Open |
| P4 | SOC 2 Type 2, GDPR report, DPA, subprocessor list to their security team | Me | Open |
| P5 | Confirm Data Zone endpoint change deployed on their side | Spanglish | Open |
