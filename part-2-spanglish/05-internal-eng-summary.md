# Internal summary: Spanglish Inc. streaming escalation

**To:** Streaming engineering, engineering leadership
**From:** Applied AI Engineering
**Subject:** "Product doesn't work at all" report from Spanglish Inc.
**Status:** Resolved. No service defect. No change required to our code.

---

## Conclusion

The failure was caused by four independent defects in the customer's client. Each is sufficient
to break the stream on its own, and all four were present at the same time. The streaming
service behaved according to specification throughout. In three of the four cases it returned
the correct diagnostic information, which the customer's client discarded before it reached an
operator.

No action is required on the streaming service to resolve this ticket. Separate developer
experience issues are identified in the "Issues on our side" section below, and I recommend
those be addressed.

---

## Defects found

| # | Defect | Service behaviour | Correct per spec |
|---|---|---|---|
| 1 | `main()` instantiates a class that does not exist | Request never reached the service | Not applicable |
| 2 | `encoding=opus` declared while raw PCM is transmitted | Sent `Begin`, then `Error 3006 Failed to decode Opus packet`, then closed | Yes |
| 3 | 25 ms audio chunks against a 50 to 1000 ms requirement | Closed with `3007 Input Duration Violation: 25.0 ms. Expected between 50 and 1000 ms` | Yes |
| 4 | No `speech_model` specified | Served `universal-3-5-pro` and transcribed both languages correctly. Not a contributing cause | Yes |

All four rows verified against the live API on 2026-08-01, superseding the earlier
docs-only analysis. Defect 4 did not reproduce the predicted failure and has been downgraded
from a blocker. Details and two further corrections in
[`07-live-verification.md`](07-live-verification.md).

Full analysis: [`01-root-cause.md`](01-root-cause.md).
Reproduction harness: [`code/python/repro.py`](code/python/repro.py). It streams identical audio
through the as-submitted configuration, each fix in isolation, and the corrected configuration,
and reports the close code for each.

### Confirmation of defect 1

The submitted file does not compile. Verified locally against JDK 19:

```
com/assemblyai/Spanglish.java:45: error: cannot find symbol
        StreamingTranscription transcription = new StreamingTranscription();
  symbol: class StreamingTranscription
2 errors
```

The class declared in the file is `Spanglish`. No class named `StreamingTranscription` exists in
the project. The file as submitted has never been executed, which means the code the customer
ran differs from the code we received. I have asked them for the version they actually ran. No
response yet.

---

## Why the report contained no diagnostic detail

Four minor defects in the customer's error handling combined to suppress all diagnostic output:

1. The `switch` statement in `onMessage` uses `default: break;`, which silently discards every
   message type the client does not explicitly handle, including server diagnostics.
2. `onClose` prints the close code as a bare integer with no accompanying description. The
   service returned code `3007` with an accurate reason string, which the client rendered as
   `Status=3007` with no context.
3. `data.get("type").getAsString()` is called without checking that the field exists. A message
   without a `type` field raises `NullPointerException`, and the catch block prints
   `e.getMessage()`, which returns `null` for an NPE. The operator's console displays
   `Error handling message: null`.
4. Neither `onClose` nor `onError` releases the latch that `main()` blocks on, so after any
   server-initiated close the process hangs rather than exiting. This presents as an
   unresponsive application rather than a failed request.

The service communicated the cause of the failure on multiple occasions and the client discarded
it each time. The customer's report was brief because their tooling provided no additional
information, not because the report was carelessly written.

---

## Issues on our side

The customer's errors were genuine. Three of the four are also predictable consequences of
decisions we have made, and I do not recommend closing this as customer error without addressing
them.

### 1. The Java SDK was discontinued in April 2025

Spanglish is a Java organisation. Our Java SDK was discontinued in April 2025 and the current
guidance directs Java users to integrate against the API reference directly. They therefore
built a raw WebSocket client by hand and encountered the specific problems an SDK is designed to
prevent: encoding and format mismatch, chunk sizing, close code interpretation, the terminate
handshake, and backpressure handling.

Every blocker in this ticket would have been prevented or made immediately obvious by a
maintained SDK.

**Request:** determine how many enterprise accounts are running hand-built JVM clients. If
Spanglish is not an isolated case, the absence of a Java SDK is a retention risk rather than a
maintenance saving. Options in increasing order of cost: publish a fully annotated raw WebSocket
reference implementation in the documentation, support a community-maintained JVM client, or
reinstate the SDK. The account count should inform that decision.

### 2. ~~`encoding=opus` fails silently when the audio does not match~~ WITHDRAWN

I proposed that we emit an explicit `Error` after repeated Opus decode failures, and called it
the highest value item on this list. **We already do this.** I had written the section before I
had an API key. Verified 2026-08-01:

```
[Error] {"type":"Error","error_code":3006,
         "error":"Failed to decode Opus packet: Invalid data found when processing input"}
[close] code=3006
```

The message names the failure and arrives within the first second. No work required, and no
product defect in this ticket. Recording it here rather than deleting it because the original
claim reached the customer-facing analysis and had to be corrected there too.

The residual point is worth keeping in a different form: our diagnostics are only as good as the
client's willingness to display them, and a raw-WebSocket customer with `default: break;` in
`onMessage` sees none of them. That is an argument for item 1, not for a service change.

### 3. Documentation is inconsistent about the default `speech_model`

- The streaming API reference lists the default as `universal-3-5-pro`.
- The Universal-Streaming to U3 Pro migration guide states that an omitted `speech_model`
  resolves to the English model.
- Async defaults are grandfathered by account creation date, with accounts created before
  2026-02-04 retaining the earlier default. The streaming default may follow the same pattern.

I was unable to determine from public documentation which model Spanglish's account resolves to.

**Request:** reconcile the two pages, and state the grandfathering rule explicitly on the
streaming reference page as is already done for async. Separately, someone with dashboard access
should confirm the value for Spanglish's account. My guidance to the customer, to specify the
model explicitly, is correct in either case, but the actual value should be confirmed.

### 4. Close codes are accurate but poorly surfaced

The codes and reason strings we return are correct. Customers routinely render them as bare
integers, as happened here.

The reason string for `3009`, "Unauthorized Connection: Too many concurrent sessions", is also
misleading. The limit enforced is new sessions per minute, not total concurrent sessions. This
wording will continue to generate requests to raise a concurrency cap that does not exist.

**Request:** revise the `3009` reason string to describe the rate limit accurately, and publish
a close code reference table mapping each code to its meaning and the recommended client action.

---

## Commercial context

This is not a routine support ticket. Spanglish is an enterprise account at retention risk with
an expansion to 2,000 concurrent streams pending. At peak that represents approximately $300 to
$900 per hour of streaming spend depending on model selection, in addition to their existing
async workload.

They requested two deliverables beyond the fix, both of which have been provided:

- Scaling guidance to 2,000 concurrent streams: [`03-scaling-to-2000.md`](03-scaling-to-2000.md)
- Data privacy and retention answers: [`04-data-privacy.md`](04-data-privacy.md)

Two items require action from other teams:

1. **Pre-provision their new-session rate budget before go-live.** At the default 100 sessions
   per minute, a cold start to 2,000 concurrent streams takes approximately 12 minutes of
   auto-scaling. At 500 per minute it takes approximately 4 minutes. There is no cost to us and
   it removes their highest-risk failure scenario.
2. **Legal and Sales:** the customer requires zero data retention and a reduced async TTL as
   contractual commitments rather than documentation references. A definitive answer on HIPAA
   and BAA availability is also outstanding. Items P1 through P5 are tracked in the privacy
   document.

---

## Recommended actions

| # | Action | Owner | Priority |
|---|---|---|---|
| A1 | Emit an explicit `Error` message on repeated audio decode failure before closing | Streaming engineering | High |
| A2 | Reconcile the documented default `speech_model` and state the grandfathering rule | Documentation | High |
| A3 | Confirm the default `speech_model` for Spanglish's account | Engineering | High |
| A4 | Revise the `3009` reason string to describe the new-session rate limit | Streaming engineering, Documentation | Medium |
| A5 | Publish a close code reference table with recommended client actions | Documentation | Medium |
| A6 | Determine the number of enterprise accounts on hand-built JVM clients | Engineering leadership | Medium |
| A7 | Pre-provision Spanglish's rate budget before go-live | Support, Sales engineering | High |
| A8 | Add guidance to verify `Begin.configuration` against requested parameters | Documentation | Low |

---

## Summary

We returned correct behaviour and accurate error messages to a client that was unable to display
them, in a language for which we no longer publish an SDK. The defect is not in our code, and
after live verification there is no product change required either. The contributing conditions
that are within our control are the missing JVM client and the contradictory documentation on
default models, and both should be corrected.
