# Partner guide (LIMS vendors and resellers)

A working draft for distribution partners: LIMS vendors and others who bring
CareLoop to diagnostic labs. Commercial terms are placeholders until a
partner agreement is signed.

## What CareLoop does for a lab
CareLoop follows up on actions a clinician has already ordered, such as a
consultation or a repeat test, until there is verified proof they happened. It:
- takes orders from the lab's LIMS, a CSV or a PDF, as drafts a reviewer approves;
- calls the patient (supervised AI voice) or sends a link to book or ask for a call;
- books through the lab's calendar or staff;
- closes the follow-up only with verified evidence.

It **does not** interpret results, give medical advice, or contact anyone without consent and approval.

## How a partner fits in
| Partner role | What you do | What CareLoop does |
|---|---|---|
| Referral | Introduce the lab | Onboarding, support, billing |
| Integration | Send new orders from your LIMS to CareLoop (HL7 v2 ORM or JSON webhook, see [PHASE9.md](PHASE9.md)) | Turns them into draft cases, one per order |
| Reseller | Sell, onboard and give first-line support | Platform, second-line support, statements |

## Onboarding a lab (checklist)
1. **Agreement and data protection:** the lab is the data fiduciary under the DPDP Act and CareLoop is its processor. Sign the processing terms before any real patient data is loaded.
2. **Lab setup:** create the tenant, its sites (time zone, calling hours) and staff with roles. Owners turn on MFA.
3. **Consent:** the lab records consent for follow-up coordination for each patient, using its own notice.
4. **Integration (optional):** connect the LIMS feed. Test with synthetic patients first.
5. **Supervised start:** follow [PILOT_PROTOCOL.md](PILOT_PROTOCOL.md). Staff review the first calls, and outreach stays off until the readiness checklist passes ([PILOT_READINESS.md](PILOT_READINESS.md)).
6. **Go live:** the owner switches on outreach for the lab.

## Pricing (placeholder)
- ₹2,999 per site per month plus ₹25 per enrolled follow-up, each charged once. CareLoop produces monthly usage statements; see "Billing" in [PHASE9.md](PHASE9.md).
- Reseller margin, payment terms and who invoices the lab: **to be agreed per partner**.

## Support split
| Level | Who | Examples |
|---|---|---|
| First line | Partner | Staff logins, how-to questions, CSV formats, feed connectivity |
| Second line | CareLoop | Platform faults, failed jobs, webhook signatures, data requests |
| Safety | CareLoop + lab | Any call flagged for review; reported in line with [RUNBOOK.md](RUNBOOK.md) |

## What partners must not do
- Market CareLoop as diagnostic, as giving clinical advice, or as a guarantee of outcomes.
- Load real patient data into a demo or staging lab.
- Share webhook secrets over email or chat. Use a secure channel, and rotate any secret that has been exposed.
- Change a lab's consent records or approve cases on the lab's behalf.

## Before a partner launch
- Confirm the LIMS message profile against a real sample (with identifiers removed).
- Confirm FHIR identifier systems if the partner exports to a hospital system.
- Agree the commercial terms above and record them in the partner agreement.
