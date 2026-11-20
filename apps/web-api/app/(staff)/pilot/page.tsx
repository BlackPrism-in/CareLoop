'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Button, Card, cx, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useData } from '@/lib/use-data';
import type { PilotReport } from '@careloop/domain';

type Phase = 'NOT_STARTED' | 'BASELINE' | 'INTERVENTION' | 'ENDED';
interface Config {
  phase: Phase;
  baselineStartedAt: string | null;
  interventionStartedAt: string | null;
  endedAt: string | null;
  concurrentComparison: boolean;
  interventionShare: number;
  supervisedReviewFirstN: number;
  costRates: {
    voicePerMinuteInr: number;
    messageInr: number;
    modelPerCaseInr: number;
    directSupportPerMonthInr: number;
  };
  pricing: { sitePerMonthInr: number; perEnrolledCaseInr: number };
}

const DEFAULTS: Config = {
  phase: 'NOT_STARTED',
  baselineStartedAt: null,
  interventionStartedAt: null,
  endedAt: null,
  concurrentComparison: true,
  interventionShare: 0.5,
  supervisedReviewFirstN: 50,
  costRates: {
    voicePerMinuteInr: 0,
    messageInr: 0,
    modelPerCaseInr: 0,
    directSupportPerMonthInr: 0,
  },
  pricing: { sitePerMonthInr: 2999, perEnrolledCaseInr: 25 },
};
const PHASES: [Phase, string, string][] = [
  ['NOT_STARTED', 'Not started', ''],
  [
    'BASELINE',
    'Baseline',
    'Observe the usual process for ~2 weeks. Approved cases are tracked; CareLoop contacts no one.',
  ],
  [
    'INTERVENTION',
    'Intervention',
    '~4 weeks. New approvals are allocated to CareLoop or usual care. Only the CareLoop group is contacted.',
  ],
  ['ENDED', 'Ended', 'No new allocations. Finish evidence collection, then read the report.'],
];

export default function PilotPage() {
  const { hasRole } = useAuth();
  const [tab, setTab] = useState<'setup' | 'reviews' | 'report'>('report');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Pilot</h1>
        <p className="text-sm text-[var(--muted)]">
          Supervised pilot protocol (baseline, then intervention with a concurrent usual-care
          comparison). Measures operational follow-through only.
        </p>
      </div>
      <div role="tablist" className="flex gap-1">
        {(
          [
            ['report', 'Report'],
            ['reviews', 'Call reviews'],
            ['setup', 'Setup'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx(
              'rounded-md px-3 py-1.5 text-sm',
              tab === k ? 'bg-[var(--surface-2)] font-medium' : 'text-[var(--muted)]',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'setup' && <Setup canEdit={hasRole('OWNER')} />}
      {tab === 'reviews' && <Reviews canReview={hasRole('REVIEWER', 'OWNER')} />}
      {tab === 'report' && <Report />}
    </div>
  );
}

function Setup({ canEdit }: { canEdit: boolean }) {
  const { data, error, loading, refresh } = useData<{ config: Config | null }>(
    () => api('/v1/pilot/config'),
    [],
  );
  const [draft, setDraft] = useState<Config | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [confirmPhase, setConfirmPhase] = useState<Phase | null>(null);
  if (loading && !data) return <Skeleton rows={4} />;
  if (error && !data) return <LoadError message={error} onRetry={refresh} />;
  const c = draft ?? data?.config ?? DEFAULTS;
  const set = (patch: Partial<Config>) => setDraft({ ...c, ...patch });
  const num = (label: string, v: number, on: (n: number) => void, step = 1) => (
    <Field label={label}>
      <input
        type="number"
        step={step}
        className={inputClass}
        disabled={!canEdit}
        value={v}
        onChange={(e) => on(Number(e.target.value) || 0)}
      />
    </Field>
  );
  async function save(phase: Phase) {
    try {
      const {
        phase: _p,
        baselineStartedAt: _a,
        interventionStartedAt: _b,
        endedAt: _c,
        ...rest
      } = c;
      await api('/v1/pilot/config', { method: 'POST', body: { ...rest, phase } });
      setDraft(null);
      setConfirmPhase(null);
      setMsg({ tone: 'ok', text: 'Saved.' });
      void refresh();
    } catch (e) {
      setMsg({ tone: 'error', text: describeError(e) });
    }
  }
  const current = data?.config?.phase ?? 'NOT_STARTED';
  const idx = PHASES.findIndex(([p]) => p === current);
  const next = PHASES[idx + 1];
  const locked = current === 'INTERVENTION' || current === 'ENDED';
  return (
    <div className="space-y-4">
      <Card title="Phase">
        <ol className="space-y-2 text-sm">
          {PHASES.slice(1).map(([p, l, d]) => (
            <li key={p} className={cx(p === current && 'font-medium')}>
              {p === current ? '● ' : PHASES.findIndex(([x]) => x === p) < idx ? '✓ ' : '○ '}
              {l}
              {p === 'BASELINE' &&
                data?.config?.baselineStartedAt &&
                ` — since ${formatDateTime(data.config.baselineStartedAt)}`}
              {p === 'INTERVENTION' &&
                data?.config?.interventionStartedAt &&
                ` — since ${formatDateTime(data.config.interventionStartedAt)}`}
              {p === 'ENDED' &&
                data?.config?.endedAt &&
                ` — ${formatDateTime(data.config.endedAt)}`}
              <div className="text-xs font-normal text-[var(--muted)]">{d}</div>
            </li>
          ))}
        </ol>
        {canEdit && next && (
          <div className="mt-3">
            {confirmPhase !== next[0] ? (
              <Button variant="primary" onClick={() => setConfirmPhase(next[0])}>
                Move to {next[1].toLowerCase()}…
              </Button>
            ) : (
              <Notice tone="warn">
                Phases only move forward, and the change is audited.{' '}
                {next[0] === 'INTERVENTION'
                  ? 'Allocation settings lock once the intervention starts. '
                  : ''}
                <Button variant="primary" className="ml-2" onClick={() => save(next[0])}>
                  Confirm
                </Button>
              </Notice>
            )}
          </div>
        )}
      </Card>
      <Card title="Design, costs and price">
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <label className="flex items-center gap-2 md:col-span-3">
            <input
              type="checkbox"
              disabled={!canEdit || locked}
              checked={c.concurrentComparison}
              onChange={(e) => set({ concurrentComparison: e.target.checked })}
            />{' '}
            Concurrent usual-care comparison during the intervention
          </label>
          {num(
            'Share allocated to CareLoop',
            c.interventionShare,
            (n) => set({ interventionShare: n }),
            0.05,
          )}
          {num('Calls needing supervised review', c.supervisedReviewFirstN, (n) =>
            set({ supervisedReviewFirstN: n }),
          )}
          <div />
          {num(
            'Voice ₹ / min',
            c.costRates.voicePerMinuteInr,
            (n) => set({ costRates: { ...c.costRates, voicePerMinuteInr: n } }),
            0.1,
          )}
          {num(
            'Message ₹ each',
            c.costRates.messageInr,
            (n) => set({ costRates: { ...c.costRates, messageInr: n } }),
            0.1,
          )}
          {num(
            'Model ₹ / case',
            c.costRates.modelPerCaseInr,
            (n) => set({ costRates: { ...c.costRates, modelPerCaseInr: n } }),
            0.1,
          )}
          {num('Direct support ₹ / month', c.costRates.directSupportPerMonthInr, (n) =>
            set({ costRates: { ...c.costRates, directSupportPerMonthInr: n } }),
          )}
          {num('Price: site ₹ / month', c.pricing.sitePerMonthInr, (n) =>
            set({ pricing: { ...c.pricing, sitePerMonthInr: n } }),
          )}
          {num('Price: ₹ / enrolled case', c.pricing.perEnrolledCaseInr, (n) =>
            set({ pricing: { ...c.pricing, perEnrolledCaseInr: n } }),
          )}
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Rates should come from real invoices (Gemini, telephony, messaging). Using the
          blueprint&apos;s assumptions only reproduces the blueprint.
        </p>
        {canEdit && draft && (
          <Button className="mt-3" variant="primary" onClick={() => save(current)}>
            Save settings
          </Button>
        )}
      </Card>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

interface ReviewItem {
  interactionId: string;
  caseId: string;
  createdAt: string;
  disposition?: string;
  endReason?: string;
  toolCalls?: { name: string; outcome: string }[];
  safetyEvents?: { kind: string }[];
  unsupportedClaims?: number;
  review?: { outcome: string; issues: string[]; note: string | null };
}
const ISSUES = [
  'UNSUPPORTED_CLAIM',
  'MEDICAL_CONTENT',
  'IDENTITY',
  'LANGUAGE',
  'TONE',
  'TOOL_MISUSE',
  'OTHER',
];

function Reviews({ canReview }: { canReview: boolean }) {
  const { data, error, loading, refresh } = useData<{
    pending: ReviewItem[];
    reviewed: ReviewItem[];
    counts: { pending: number; reviewed: number };
  }>(() => api('/v1/reviews'), [], { pollMs: 30_000 });
  if (loading && !data) return <Skeleton rows={3} />;
  if (error && !data) return <LoadError message={error} onRetry={refresh} />;
  if (!data) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">
        The first calls of the intervention period are reviewed under the protocol. Transcripts
        aren&apos;t stored: record what the supervising staff member observed.{' '}
        {data.counts.reviewed} reviewed · {data.counts.pending} waiting.
      </p>
      {data.pending.length === 0 && <Notice>No calls are waiting for review.</Notice>}
      {data.pending.map((r) => (
        <ReviewCard key={r.interactionId} r={r} canReview={canReview} onDone={refresh} />
      ))}
      {data.reviewed.length > 0 && (
        <Card title="Recently reviewed">
          <ul className="space-y-1 text-sm">
            {data.reviewed.map((r) => (
              <li key={r.interactionId}>
                {r.review?.outcome === 'OK' ? '✓' : '⚠'}{' '}
                <Link className="text-[var(--accent)] hover:underline" href={`/cases/${r.caseId}`}>
                  {r.caseId}
                </Link>{' '}
                · {formatDateTime(r.createdAt)}{' '}
                {r.review?.issues.length
                  ? `· ${r.review.issues.join(', ').toLowerCase().replaceAll('_', ' ')}`
                  : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ReviewCard({
  r,
  canReview,
  onDone,
}: {
  r: ReviewItem;
  canReview: boolean;
  onDone: () => void;
}) {
  const [issues, setIssues] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function submit(outcome: 'OK' | 'ISSUE') {
    try {
      await api(`/v1/reviews/${r.interactionId}`, {
        method: 'POST',
        body: { outcome, issues: outcome === 'OK' ? [] : issues, note: note.trim() || undefined },
      });
      onDone();
    } catch (e) {
      setErr(describeError(e));
    }
  }
  return (
    <Card
      title={
        <span>
          Call on{' '}
          <Link className="text-[var(--accent)] hover:underline" href={`/cases/${r.caseId}`}>
            {r.caseId}
          </Link>{' '}
          · {formatDateTime(r.createdAt)}
        </span>
      }
    >
      <div className="space-y-2 text-sm">
        <p>
          Outcome: {r.disposition?.toLowerCase().replaceAll('_', ' ') ?? 'not finished'} · ended:{' '}
          {r.endReason?.toLowerCase().replaceAll('_', ' ') ?? '—'}
          {r.unsupportedClaims
            ? ` · ⚠ ${r.unsupportedClaims} premature "booked" claim(s) flagged`
            : ''}
        </p>
        <p className="text-[var(--muted)]">
          Tools:{' '}
          {r.toolCalls?.map((t) => `${t.name} → ${t.outcome.toLowerCase()}`).join(' · ') || 'none'}
          {r.safetyEvents?.length
            ? ` · Safety: ${r.safetyEvents.map((s) => s.kind.toLowerCase().replaceAll('_', ' ')).join(', ')}`
            : ''}
        </p>
        {canReview && (
          <>
            <div className="flex flex-wrap gap-3">
              {ISSUES.map((i) => (
                <label key={i} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={issues.includes(i)}
                    onChange={(e) =>
                      setIssues((s) => (e.target.checked ? [...s, i] : s.filter((x) => x !== i)))
                    }
                  />
                  {i.toLowerCase().replaceAll('_', ' ')}
                </label>
              ))}
            </div>
            <input
              className={inputClass}
              placeholder="What the supervisor observed (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="primary" disabled={issues.length > 0} onClick={() => submit('OK')}>
                No issues
              </Button>
              <Button disabled={issues.length === 0} onClick={() => submit('ISSUE')}>
                Record issues
              </Button>
            </div>
          </>
        )}
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Card>
  );
}

const ARM_LABEL = {
  BASELINE: 'Baseline (before)',
  USUAL_CARE: 'Usual care (concurrent)',
  INTERVENTION: 'CareLoop',
} as const;
const p100 = (x: number | null | undefined) =>
  x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`;

function Report() {
  const { data, error, loading, refresh } = useData<PilotReport>(() => api('/v1/pilot/report'), []);
  if (loading && !data) return <Skeleton rows={6} />;
  if (error && !data)
    return error.includes('PILOT_NOT_STARTED') ? (
      <Notice>The pilot hasn&apos;t started. An owner starts it from Setup.</Notice>
    ) : (
      <LoadError message={error} onRetry={refresh} />
    );
  if (!data) return null;
  const tone = {
    MET: '✓ Met',
    NOT_MET: '✕ Not met',
    NOT_ENOUGH_DATA: '… Not enough data',
    RECORD_MANUALLY: '✎ Record manually',
  } as const;
  return (
    <div className="space-y-4">
      <Card
        title="Decision gates (Blueprint p.11)"
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
              );
              Object.assign(document.createElement('a'), {
                href: url,
                download: `pilot-report-${data.generatedAt.slice(0, 10)}.json`,
              }).click();
              URL.revokeObjectURL(url);
            }}
          >
            Download
          </Button>
        }
      >
        <table className="w-full text-sm">
          <tbody>
            {data.gates.map((g) => (
              <tr key={g.name} className="border-b border-[var(--line)] last:border-0 align-top">
                <td className="py-1.5 pr-2">{g.name}</td>
                <td className="py-1.5 pr-2 text-[var(--muted)]">{g.target}</td>
                <td className="py-1.5 pr-2 tabular-nums">{g.value}</td>
                <td className="whitespace-nowrap py-1.5">{tone[g.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Primary outcome: verified completion by the due date">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1">Group</th>
                <th className="py-1">Rate (95% CI)</th>
                <th className="py-1">On time / eligible</th>
                <th className="py-1">Excluded (open · cancelled)</th>
                <th className="py-1">Self-report only</th>
                <th className="py-1">Staff min / 100 cases</th>
              </tr>
            </thead>
            <tbody>
              {(['BASELINE', 'USUAL_CARE', 'INTERVENTION'] as const).map((a) => {
                const x = data.arms[a];
                return (
                  <tr key={a} className="border-t border-[var(--line)]">
                    <td className="py-1.5">{ARM_LABEL[a]}</td>
                    <td className="py-1.5 tabular-nums">
                      {x.rate
                        ? `${p100(x.rate.p)} (${p100(x.rate.low)}–${p100(x.rate.high)})`
                        : '—'}
                    </td>
                    <td className="py-1.5 tabular-nums">
                      {x.verifiedOnTime} / {x.eligible}
                    </td>
                    <td className="py-1.5 tabular-nums">
                      {x.excludedWindowOpen} · {x.excludedCancelled}
                    </td>
                    <td className="py-1.5 tabular-nums">{x.selfReportedOnly}</td>
                    <td className="py-1.5 tabular-nums">
                      {x.staffMinutesPer100 ?? '—'}
                      {x.timeLogCoverage !== null ? ` (${p100(x.timeLogCoverage)} logged)` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          CareLoop vs usual care:{' '}
          {data.comparisons.interventionVsUsualCare
            ? `${(data.comparisons.interventionVsUsualCare.diff * 100).toFixed(1)} pp (95% CI ${(data.comparisons.interventionVsUsualCare.low * 100).toFixed(1)} to ${(data.comparisons.interventionVsUsualCare.high * 100).toFixed(1)})`
            : '—'}
          . CareLoop vs baseline (before/after, not causal):{' '}
          {data.comparisons.interventionVsBaseline
            ? `${(data.comparisons.interventionVsBaseline.diff * 100).toFixed(1)} pp`
            : '—'}
          .
        </p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Feasibility (CareLoop group)">
          <p className="text-sm">
            Identity-verified contact before the due date: {data.feasibility.verifiedContact} /{' '}
            {data.feasibility.denominator} · Hindi {p100(data.feasibility.byLanguage['hi-IN']?.p)} ·
            English {p100(data.feasibility.byLanguage['en-IN']?.p)}
          </p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Not reached: unreachable {data.feasibility.failureCauses.unreachable} · declined{' '}
            {data.feasibility.failureCauses.declined} · opted out{' '}
            {data.feasibility.failureCauses.optedOut} · never contacted{' '}
            {data.feasibility.failureCauses.neverContacted}
          </p>
        </Card>
        <Card title="Cost at metered usage">
          <ul className="space-y-1 text-sm">
            <li>
              Voice: {data.cost.voiceMinutes} min · messages: {data.cost.messagesSent}
            </li>
            <li>
              Variable cost: ₹{data.cost.variableCostInr.toLocaleString('en-IN')} (
              {data.cost.variableCostPerCaseInr ?? '—'} per case)
            </li>
            <li>
              Direct support (allocated): ₹{data.cost.directSupportInr.toLocaleString('en-IN')} over{' '}
              {data.cost.months} months
            </li>
            <li>
              Fee at the proposed price: ₹{data.cost.feeAtProposedPriceInr.toLocaleString('en-IN')}{' '}
              ·{' '}
              {data.cost.ratesConfigured
                ? `gross margin ${p100(data.cost.grossMargin)}`
                : 'margin not shown: enter real cost rates in Setup'}
            </li>
          </ul>
        </Card>
      </div>
      <Card title="Limitations">
        <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
          {data.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
