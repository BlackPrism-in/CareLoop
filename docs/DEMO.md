# The 3-minute demo (Blueprint p.12)

All data is synthetic, and every simulated step is labelled **◌ Simulated** on screen.

## Before you go on stage
1. **Model check:** this must print `OK` for all four roles. The live call needs Gemini.

   ```bash
   pnpm check:models
   ```

2. **Release gate:** must end with `release gate: PASS`. Keep `evals/reports/latest.md` open in a tab.

   ```bash
   pnpm eval
   ```

3. **Start the stack**, each command in its own terminal with the env loaded (`set -a && . ./.env.local && set +a`):

   ```bash
   pnpm emulators
   ```

   ```bash
   pnpm demo:reset
   ```

   ```bash
   pnpm --filter @careloop/worker dev
   ```

   ```bash
   pnpm --filter @careloop/voice dev
   ```

   ```bash
   pnpm --filter @careloop/web-api build && pnpm --filter @careloop/web-api start
   ```

   Use the production build for the web app: on this Mac `next dev` reloads in a loop (see PHASE3.md).

4. **Three browser windows** (separate profiles), already signed in. Roles are kept separate on purpose: that's part of the story.
   - **Reviewer:** `reviewer@demo.careloop.test`
   - **Front desk:** `frontdesk@demo.careloop.test`
   - **Verifier:** `verifier@demo.careloop.test`
5. **Audio:** headset on, and microphone permission granted for `localhost:3000` in the front-desk window.
6. **Backup recording:** do one full run and record it. The first frame and the file name must say **"Recorded backup — synthetic data"**. If anything fails live, say so and play it.

`pnpm demo:reset` restores the starting state at any time. The cases are created with due dates relative to today. If you rehearse outside 09:00–19:00 IST, it widens the demo lab's contact hours to the whole day and tells you so.

## The script

| Time | Window | Do | Say |
|---|---|---|---|
| 0:00–0:25 | Reviewer | **Intake review → CL-2004**. Point at each value beside its source. Tick the checklist, enter `order_demo_03`, **Approve for outreach**. | "A clinician already approved this next step. CareLoop doesn't read results or choose tests; a person confirms the administrative details before anyone is contacted." |
| 0:25–1:15 | Front desk | **CL-2001 → Open call**. The assistant introduces itself in Hindi and offers a human. Click **Confirm identity (supervised, simulated)**. Say: *"शाम को ही आ पाऊँगा, दिन में काम होता है"* (or *"I can only come after 4 pm"*). | "The patient's barrier is work hours. The assistant can only offer times the calendar returns." |
| 1:15–1:45 | Front desk | Accept the evening time it reads back. Watch the event lines: *Looked up times → Booking requested → Calendar confirmed*. Case shows **Booked · awaiting proof**. | "It said 'booked' only after the calendar acknowledged. A booking isn't the outcome; the case stays open." |
| 1:45–2:15 | Verifier | **CL-2002** → **Mismatched record**: rejected, *"Different patient reference"*. Then **Matching attendance**: **Completed · verified**. | "Both are signed calendar events. Wrong evidence is rejected with a reason; only matching evidence completes the case." |
| 2:15–2:40 | Front desk | **CL-2003 → Open call → Confirm identity** → ask *"Is my report serious?"*. The assistant gives the approved response. Open **Human queue**: a *Medical question* task for Front Desk. | "Medical questions never reach the model. A named person gets the task, and that doesn't close the follow-up." |
| 2:40–3:00 | Reviewer | **Reports**: separate counts, the rate with its denominator, and the economics marked illustrative. Flash `latest.md`: 64/64, gate PASS. | "We report bookings, self-reports and verified completion separately, and we measure ourselves against a release gate rather than claiming pilot results." |

## If something goes wrong
- **The live model doesn't connect:** the call panel says so. On the same case, choose *Wants to book* and pick the evening slot with the read-back tick. It's the same booking path, recorded by staff. Say this plainly.
- **Anything else:** play the recorded backup and say it's a recording.
- **Opt-out alternative for 2:15:** on CL-2003 say *"please don't call me again"*. The assistant records the opt-out and the case shows *Opted out*.
