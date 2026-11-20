'use client';
import { useState } from 'react';
import { Card, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useData } from '@/lib/use-data';

interface Report {
  cohort: {
    by: string;
    from: string;
    to: string;
    cases: number;
    truncated: boolean;
    drafts: number;
  };
  primary: {
    label: string;
    numerator: number;
    denominator: number;
    rate: number | null;
    exclusions: { cancelled: number; followUpWindowStillOpen: number; notYetApproved: number };
  };
  separateCounts: Record<string, number>;
  dispositions: Record<string, number>;
  staffEffort: {
    handoffs: number;
    handoffsOpen: number;
    medianAcknowledgeMinutes: number | null;
    contactAttempts: number;
    billedVoiceMinutes: number;
  };
  asOf: string;
}

const COUNT_LABEL: Record<string, string> = {
  enrolled: 'Approved for follow-up',
  contacted: 'Contact attempted',
  booked: 'Booked (milestone only)',
  selfReportedOnly: 'Patient says done (not verified)',
  verifiedCompleted: 'Completed · verified',
  verifiedWithoutCareLoopBooking: '…of which completed elsewhere',
};
const DISP_LABEL: Record<string, string> = {
  optedOut: 'Opted out',
  declined: 'Declined',
  unreachable: 'Unreachable',
  cancelled: 'Cancelled (order withdrawn)',
  stillOpen: 'Still open',
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function ReportsPage() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date(Date.now() + 14 * 86_400_000)));
  const [cohort, setCohort] = useState<'due' | 'created'>('due');
  const { data, error, loading, refresh } = useData<Report>(
    () => api<Report>(`/v1/reports?from=${from}&to=${to}&cohort=${cohort}`),
    [from, to, cohort],
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Reports</h1>
        <p className="text-sm text-[var(--muted)]">
          Operational follow-through only. No clinical outcome is inferred from these numbers.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label="Cohort by">
          <select
            className={inputClass}
            value={cohort}
            onChange={(e) => setCohort(e.target.value as 'due' | 'created')}
          >
            <option value="due">Due date</option>
            <option value="created">Created date</option>
          </select>
        </Field>
        <Field label="From">
          <input
            type="date"
            className={inputClass}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            className={inputClass}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>

      {loading && !data ? (
        <Skeleton rows={4} />
      ) : error && !data ? (
        <LoadError message={error} onRetry={refresh} />
      ) : (
        data && (
          <>
            {data.cohort.truncated && (
              <Notice tone="warn">
                Only the first 2,000 cases in this range are included. Narrow the dates.
              </Notice>
            )}
            <Card title={data.primary.label}>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-3xl font-semibold tabular-nums">
                  {data.primary.rate === null ? '—' : `${Math.round(data.primary.rate * 100)}%`}
                </span>
                <span className="text-sm text-[var(--muted)]">
                  {data.primary.numerator} verified on time ÷ {data.primary.denominator} approved
                  obligations whose due date has passed
                </span>
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Excluded: {data.primary.exclusions.followUpWindowStillOpen} still within their due
                date · {data.primary.exclusions.cancelled} cancelled ·{' '}
                {data.primary.exclusions.notYetApproved} not yet approved. Self-reports and bookings
                never count as completion.
              </p>
            </Card>
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Separate counts">
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(data.separateCounts).map(([k, v]) => (
                      <tr key={k} className="border-b border-[var(--line)] last:border-0">
                        <td className="py-1.5">{COUNT_LABEL[k] ?? k}</td>
                        <td className="py-1.5 text-right tabular-nums">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  These are independent counts, not a funnel: a case can be completed elsewhere
                  without a CareLoop booking.
                </p>
              </Card>
              <Card title="Dispositions">
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(data.dispositions).map(([k, v]) => (
                      <tr key={k} className="border-b border-[var(--line)] last:border-0">
                        <td className="py-1.5">{DISP_LABEL[k] ?? k}</td>
                        <td className="py-1.5 text-right tabular-nums">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  None of these count as successful completion.
                </p>
              </Card>
              <Card title="Staff effort and usage">
                <ul className="space-y-1 text-sm">
                  <li>
                    Handoffs: {data.staffEffort.handoffs} ({data.staffEffort.handoffsOpen} open)
                  </li>
                  <li>
                    Median time to acknowledge:{' '}
                    {data.staffEffort.medianAcknowledgeMinutes === null
                      ? '—'
                      : `${data.staffEffort.medianAcknowledgeMinutes} min`}
                  </li>
                  <li>Contact attempts: {data.staffEffort.contactAttempts}</li>
                  <li>Billed voice minutes: {data.staffEffort.billedVoiceMinutes}</li>
                </ul>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  Staff minutes per 100 cases need a timed baseline from the pilot.
                </p>
              </Card>
              <Economics enrolled={data.separateCounts.enrolled ?? 0} />
            </div>
            <p className="text-right text-xs text-[var(--muted)]">
              {data.cohort.cases} cases in cohort · as of{' '}
              {new Date(data.asOf).toLocaleTimeString('en-IN')}
            </p>
          </>
        )
      )}
    </div>
  );
}

/** Blueprint p.10 scenario calculator. Inputs are assumptions, never measured results. */
function Economics({ enrolled }: { enrolled: number }) {
  const [cases, setCases] = useState(450);
  const [uplift, setUplift] = useState(15);
  const [contribution, setContribution] = useState(300);
  const [hours, setHours] = useState(15);
  const fee = 2999 + cases * 25;
  const extra = cases * (uplift / 100);
  const net = extra * contribution + hours * 150 - fee;
  const breakEven = Math.max(0, (fee - hours * 150) / contribution);
  const num = (v: number, set: (n: number) => void, label: string, step = 1) => (
    <Field label={label}>
      <input
        type="number"
        step={step}
        className={inputClass}
        value={v}
        onChange={(e) => set(Number(e.target.value) || 0)}
      />
    </Field>
  );
  return (
    <Card title="Scenario economics (illustrative)">
      <Notice tone="warn">
        A scenario calculation from assumptions — not pilot results. Replace the inputs with
        measured numbers.
      </Notice>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        {num(cases, setCases, 'Eligible cases / month')}
        {num(uplift, setUplift, 'Assumed uplift (pp)')}
        {num(contribution, setContribution, 'Contribution per extra test (₹)')}
        {num(hours, setHours, 'Staff hours saved / month')}
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        <li>
          CareLoop fee: ₹{fee.toLocaleString('en-IN')} (₹2,999 + ₹25 × {cases})
        </li>
        <li>Illustrative net benefit: ₹{Math.round(net).toLocaleString('en-IN')} / month</li>
        <li>
          Break-even: {Math.ceil(breakEven)} extra completed tests (
          {cases ? ((breakEven / cases) * 100).toFixed(1) : '—'} pp)
        </li>
      </ul>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Applies only to ordered tests performed at the paying lab; consultation-only cases
        contribute admin savings, not test revenue. This cohort has {enrolled} approved cases.
      </p>
    </Card>
  );
}
