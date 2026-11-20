# Supervised pilot protocol (Phase 8)

Based on Blueprint p.3 (site qualification) and p.11 (pilot design and measures). **Don't start until every item in [PILOT_READINESS.md](PILOT_READINESS.md) is closed.** CareLoop's software supports this protocol (Pilot page). It doesn't replace the people it names.

## 1. Qualify the site (before signing)
| Requirement | How to check | Pass? |
|---|---|---|
| The owner can authorise the pilot (not a franchise collection centre) | Ask who signs software and patient-contact decisions | |
| About 200+ eligible cases a month | Count **approved actions** for the last month, not abnormal results | |
| A named staff owner and a clinical reviewer | Names and contact hours in writing | |
| Reliable booking and completion evidence | Calendar access, structured export, or staff attestation process | |
| Patient contact permission and adult scope | Their current consent wording; how they record language | |
| Willing to share an operational baseline | De-identified aggregate counts are fine | |

### Discovery interview (ask for evidence before showing a price)
- What happened to the last ten approved follow-ups?
- Who chased them, and how do you know they were completed?
- Which cases can't be delegated?
- What does your current software already do?
- What does it cost in staff time?
- What budget would you commit after seeing a defined improvement?

## 2. Timeline
| Week | Phase (Pilot → Setup) | What happens |
|---|---|---|
| 0 | Not started | Contract, approvals, named staff, training. Enter the **real** cost rates from invoices, set the call-review count (suggested 50), keep concurrent comparison **on** and the share at 50%. Run `pnpm eval` and the restore drill |
| 1–2 | **Baseline** | Staff create and approve cases as usual. CareLoop **contacts no one**; the lab follows its normal process. Staff log time on every case they work. Evidence is recorded for every completion |
| 3–6 | **Intervention** | Each new approval is randomly allocated to **CareLoop** or **usual care**. The allocation is hidden and fixed per case. Only CareLoop cases are contacted. The first N calls are supervised and reviewed (Pilot → Call reviews). Staff keep logging time in both groups |
| 7+ | **Ended** | No new allocations. Keep recording evidence until every case's due date has passed, then read the report |

**Never withhold standard or urgent care.** Usual-care cases get exactly what the lab does today. Critical results stay in the lab's existing human workflow throughout.

**Stop rules:** pause automated contact (Overview → *Pause automated contact*) and follow [RUNBOOK.md](RUNBOOK.md) if any of these happen:
- any unauthorized contact, wrong-patient disclosure, duplicate booking or false completion;
- any call where the assistant gave medical advice;
- a reviewed call with an identity problem;
- the lab asks you to stop.

## 3. Measures and decision gates (Pilot → Report)
| Measure | Definition | Gate |
|---|---|---|
| Primary outcome | Verified completion by the approved due date ÷ eligible obligations whose window has closed, per group, with 95% CI. Self-reports are shown separately | Reported, not gated |
| Feasibility | Identity-verified contact before the due date in the CareLoop group, by language, with reasons for failure | ≥ 60% |
| Incremental value | CareLoop vs concurrent usual care, difference in pp with 95% CI. Before/after vs baseline is shown but labelled not causal | +10 pp (exploratory at pilot scale) |
| Workload | Staff minutes per 100 cases, CareLoop vs baseline, including review, handoffs and exceptions. Needs ≥ 80% of cases with logged time | ≥ 30% reduction |
| Reliability | Contact outside the CareLoop group, duplicate live bookings, completion without independent evidence | 0 |
| Supervised review | First N calls reviewed; issues by category | All N reviewed |
| Commercial | Sites accepting paid continuation at an explicit price, after seeing their own numbers | ≥ 2 sites (recorded outside CareLoop) |

With fewer than 30 cases in a group, the report shows the numbers but marks the gate **not enough data**. At around 200 cases a month, a 4-week intervention split 50/50 gives about 100 per group. That's enough to see a large effect, but **not** to prove a +10 pp difference. Report it as exploratory, as the blueprint says.

## 4. Reporting the result
- Download the report (Pilot → Report → *Download*). Present every gate with its value, sample sizes, exclusions and limitations, as shown.
- Replace the blueprint's illustrative economics with the report's metered cost per case and margin at the proposed price. If the margin doesn't cover the target, narrow the workflow or reprice (Blueprint p.10).
- Don't claim clinical outcome improvements. CareLoop measures operational follow-through.
