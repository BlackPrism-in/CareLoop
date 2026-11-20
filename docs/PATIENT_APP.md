# Patient app (Flutter) and WhatsApp

Two front ends share one backend:
- **Lab dashboard** (web, staff): `https://careloop-web-api-94524397144.asia-south1.run.app`. Staff use email and password (plus an authenticator app in the pilot).
- **Patient app** (Flutter, Android and iOS): `apps/patient_app`. Patients sign in with a **code sent on WhatsApp** to the number their lab recorded.

## What a patient can do in the app
- See their follow-ups from every lab that recorded their number: kind of follow-up, due date, status, appointment.
- Pick a time the lab's calendar offers. The app says "Booked" only after the calendar confirms.
- Ask for a different time, or ask the lab to call. Either one creates a staff task, and an existing appointment is kept.
- Stop automated contact. This withdraws WhatsApp/voice permission at once.
- Use the app in English, Hindi or Bengali.

The app never shows names, reports or staff notes, and never gives medical advice.

## WhatsApp messages
| When | Template | Sent by |
|---|---|---|
| Sign-in | `careloop_login_code` (authentication, copy-code button) | web-api |
| Staff click **Send WhatsApp invite** on an approved case | `careloop_followup_invite` (with the app link) | worker |
| The calendar confirms a booking | `careloop_booking_confirmed` | worker |
| 2–26 hours before the visit, in contact hours | `careloop_visit_reminder` | worker (scheduler sweep) |

Each message is sent at most once per case and occasion, and only while the patient's consent covers WhatsApp. Records live in `tenants/{t}/messages`; they never hold the text or a code. Templates are in English and Hindi; Bengali patients get English until Bengali is reviewed.

**Safety rule:** outside the pilot, WhatsApp goes **only** to numbers in `whatsapp_test_recipients` (testers' own phones). Anything else is recorded as simulated. Synthetic labs may send WhatsApp with outreach off only under this rule.

## Try it now (no WhatsApp needed)
WhatsApp isn't connected yet, so for the synthetic demo lab the app shows the code on screen ("Demo lab: WhatsApp is not connected…"). This never happens for a real lab.

1. Install the app: Android APK from `apps/patient_app/build/app/outputs/flutter-apk/` (most phones: `app-arm64-v8a-release.apk`), or run on the iOS Simulator.
2. Sign in with **98000 00101**. It's linked to synthetic patient A, who has CL-2001 (consultation) and CL-2003 (test).
3. Open the consultation, pick a time, and confirm. Within seconds it shows **Booked**. The dashboard shows the same booking.
4. Reset afterwards; linked numbers are kept:

   ```bash
   pnpm demo:reset --project careloop-demo-2611 --confirm careloop-demo-2611
   ```

To link another tester's number to a synthetic patient:

```bash
pnpm --filter @careloop/scripts link-whatsapp --patient pat_demo_02 --phone +91XXXXXXXXXX --project careloop-demo-2611 --confirm careloop-demo-2611
```

## Turn on real WhatsApp
1. **You (Meta Business):** in WhatsApp Manager, note the **WhatsApp Business Account ID** and the sender's **Phone number ID**. Meta's free test number works for up to 5 recipient numbers you verify there.
2. **You:** create a System User access token with `whatsapp_business_messaging` and `whatsapp_business_management`, then store it yourself (paste it, then press Ctrl-D; nothing goes to shell history):

   ```bash
   gcloud secrets versions add whatsapp-access-token --data-file=- --project careloop-demo-2611
   ```

3. **Eng:** submit the templates, then check their review status:

   ```bash
   WHATSAPP_ACCESS_TOKEN="$(gcloud secrets versions access latest --secret=whatsapp-access-token --project careloop-demo-2611)" pnpm --filter @careloop/scripts whatsapp-templates --waba <WABA_ID>
   ```

4. **Eng:** in `infra/envs/demo.tfvars`, set `whatsapp_phone_number_id` and `whatsapp_test_recipients = "+91XXXXXXXXXX"` (your phone), run `terraform apply`, and link your number to a synthetic patient (above).

## Build the app
```bash
cd apps/patient_app && flutter build apk --release --split-per-abi
```

The default server is the demo deployment; point the app elsewhere with `--dart-define=API_BASE_URL=https://…`. On this Mac, iOS builds from the Desktop folder fail code signing because of iCloud file attributes. Build from a copy outside Desktop, or run `xattr -cr apps/patient_app` first.

Store release (later): set a real signing key (Android) and an Apple team (iOS). The current APK is signed with the debug key, for testing only.
