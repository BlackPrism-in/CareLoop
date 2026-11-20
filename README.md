# CareLoop

Multilingual AI follow-up coordinator for independent Indian diagnostic labs. It turns a clinician-approved, non-urgent next step into a booked and **independently verified** completion. It does not do diagnosis, result interpretation or triage.

- Plan: [docs/ROADMAP.md](docs/ROADMAP.md)
- Current phase: [docs/PHASE0.md](docs/PHASE0.md)

```
apps/      web-api (Next.js) · worker (Cloud Tasks handlers) · voice (WebSocket gateway)
packages/  contracts · domain · adapters · ai · observability
scripts/   seed (emulator only) · check-models
evals/     synthetic fixtures and scenario packs
infra/     Terraform for Google Cloud + Firestore rules/indexes
```

Requires Node 22 and pnpm 10. Firebase CLI + Java for emulators.
