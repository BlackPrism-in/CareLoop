# Coordination agent

The Coordination agent accepts an approved case snapshot plus a structured,
patient-confirmed preference summary. It does not receive a transcript and
cannot directly change case state. The model proposes one step; the gateway
re-reads authoritative state and gates every adapter or domain command.

## Local sandbox wiring

`InMemoryCoordinationWorld` implements both the booking adapter and the domain
command ports. Seed it with a case and sandbox slots, then pass `world.deps()`
to `CoordinationGateway`. Use `actorForMemoryCase()` only in local/demo code;
production actors must be constructed from authenticated server membership.

`runCoordination()` accepts a `CoordinationModel` interface. For local model
calls, construct one with `createGeminiCoordinationModel(loadConfig())`; for
deterministic development, provide an implementation of `propose()` that
returns a strict `CoordinationStepProposal`.

## Safety boundaries

- A booking result means `REQUESTED`, never completed or confirmed.
- Booking calls require an exact match with both the latest adapter offer and
  `patientConfirmedSlotId`, and must match the structured preferences.
- A booking command timeout is treated as an unknown outcome and is handed off;
  the runner never blindly repeats it.
- Consent revocation stops the loop without creating a handoff.
- The gateway reserves its final operation for a handoff and re-reads the case
  before every call.
- Tenant, actor, expected version, approval revision, idempotency key, handoff
  owner, and due time are server supplied, never model supplied.

The sandbox is for development only. Replace the in-memory ports with the Phase
3 booking adapter and deterministic domain commands before deployment. Scenario
evaluations and rules-only baseline comparison remain a separate next step.
