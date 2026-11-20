# Phase 4: AI agents and voice (status)

## Not yet verified against real Gemini
No Gemini credentials exist in this environment yet. Every agent sits behind an interface. The tests use a scripted model that plays the model's side, while all safety checks run in code that doesn't depend on the model. Once `.env.local` is set up ([GCP_SETUP.md](GCP_SETUP.md)), run this before the event; all four rows must say `OK`:

```bash
pnpm check:models
```

Then do one real call (see "Try it" below).

In the browser, everything up to the model is checked: issuing the ticket, consuming it over the WebSocket, and the gateway attempting Gemini Live. Without credentials, Live refused with "permission denied", and the UI showed an honest error.

## The four agents
| Agent | Model (config) | What it may do | Enforced in code |
|---|---|---|---|
| Intake | `INTAKE_MODEL_ID` (Flash-Lite) | Propose administrative fields from pasted approved text | Each value's source span must appear verbatim; values validated; clinical fields discarded; document text wrapped as data. A reviewer still approves |
| Conversation | `LIVE_MODEL_ID` (Live) | Talk; request the six tools below | Gateway validates every tool call; tools run as `AGENT` domain commands |
| Coordination | `COORDINATION_MODEL_ID` (Flash) | Pick the best offered slot for the patient's preference | Must pick from adapter slots; an invented slot, malformed output or timeout falls back to a rule-based matcher (Hindi/English) |
| Verification | `VERIFICATION_MODEL_ID` (Flash) | Summarise matches and conflicts in evidence | Recommendation only; used in Phase 5 next to deterministic matching |

Prompts are versioned (`intake-v1`, `conversation-v1`, `coordination-v1`, `verification-v1`). The interaction record stores the model and prompt version.

## Voice call
1. A coordinator opens a call on a case that is in contact. `POST /v1/voice/sessions` returns a **60-second, single-use, case-bound ticket**: random, stored only as a hash, with no key and no health data.
2. The browser connects to `careloop-voice` (origin allow-list) and sends the ticket as its **first message**, never in the URL.
3. The gateway gives the Live model only minimal logistics: lab name, action type, due date and language. No patient name, no report.
4. **Identity gate:** before supervising staff press *Confirm identity*, the slot and booking tools return `IDENTITY_NOT_VERIFIED`.
5. **Tools:** `find_slots`, `request_booking`, `request_callback`, `route_to_staff`, `record_opt_out`, `end_call`. Limits:
   - Booking needs a slot from the last `find_slots` result and the patient's yes to the read-back.
   - The agent may only say "booked" once the calendar confirms; otherwise the tool returns `REQUEST_SENT`.
   - At most 8 tool calls per call, then the case goes to staff.
6. **Checks that don't rely on the prompt:**
   - **Medical questions** (English, Hindi and romanised Hindi): the question is not forwarded to the model. Staff get a task, and the model is told to give the approved response and end the call.
   - **Honesty:** if the agent says "booked or confirmed" before the calendar does, the call is flagged for review (`unsupportedClaims`).
7. **Session cap:** `VOICE_SESSION_MAX_SECONDS` (170 s) and the case's remaining audio budget (180 s in total), well below the Cloud Run timeout. There's a 15-second wrap-up warning.
8. **End of call:**
   - Billed audio is recorded on the case. If the call never got past CONTACTING, a contact outcome is recorded too.
   - The interaction stores a compact disposition, tool log and safety events. **No transcript, no audio.**
   - A model that never connected is **not** counted as a call.

**Text alternative:** "Type as the patient" sends a text turn, for accessibility and for noisy rooms.

## Intake helper
New follow-up → *Start from the approved instruction*: paste the text, and the verified fields pre-fill the form, each with its source text. Missing or discarded values are listed. Nothing is stored until the form is submitted.

## Try it (once Gemini is configured)
Run the emulators and seed, then the worker, voice and web services, each with your env loaded:

```bash
pnpm --filter @careloop/voice dev
```

Then:
1. Approve CL-1042 as the reviewer.
2. As front desk, choose *Start contact*, then *Open call*.
3. Say who you are, then press *Confirm identity*.
4. Say "I can only come after 5 pm."
5. Accept the time it offers.

The case should reach **Booked**. Also try "is my report serious?", which should hand the case to staff, and "please don't call again", which should opt the patient out.

## Tests
- `packages/ai` (12): intake spans, invalid and clinical fields, injection, malformed output; coordination with an invented slot, a timeout and Hindi preferences; verification recommendation; prompt scope.
- `apps/voice` unit (15): medical-question and booked-claim detectors in English and Hindi.
- `apps/voice` emulator (9):
  - full "after work" call to a confirmed sandbox booking
  - medical question backstop; opt-out
  - premature-booking claim flagged; no-answer retry and billing
  - tool budget; failed connect isn't a call
  - tickets single-use and expiring
  - WebSocket origin and ticket checks
- `apps/web-api` emulator (14): voice ticket route (coordinator only, case-bound, no key, single use).

## Infra
The voice service can enqueue jobs. Its allowed origin and public `wss://` URL come from the deterministic Cloud Run URLs. Gemini locations: text `global`, Live `us-central1`.
