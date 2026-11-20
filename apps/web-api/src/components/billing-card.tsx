'use client';
import { useState } from 'react';
import { Button, Card, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { clientAuth } from '@/lib/firebase-client';
import { useData } from '@/lib/use-data';

interface Statement {
  month: string;
  totalInr: number;
  enrolledCases: number;
  simulation: boolean;
  issuedAt: string;
  lines: { siteId: string; description: string; quantity: number; unitInr: number; amountInr: number }[];
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Owner billing: site fee per month plus each newly enrolled follow-up, billed once. */
export function BillingCard() {
  const { data, error, loading, refresh } = useData<{ items: Statement[] }>(() => api('/v1/billing/statements'), []);
  const [month, setMonth] = useState(lastMonth());
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function issue() {
    try {
      const s = await api<Statement>('/v1/billing/statements', { method: 'POST', body: { month } });
      setMsg({ tone: 'ok', text: `Statement for ${s.month}: ${inr(s.totalInr)}.` });
      void refresh();
    } catch (e) {
      setMsg({ tone: 'error', text: describeError(e) });
    }
  }

  async function csv(m: string) {
    const token = await clientAuth().currentUser?.getIdToken();
    const res = await fetch(`/v1/billing/statements/${m}?format=csv`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return setMsg({ tone: 'error', text: 'Download failed.' });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: `careloop-statement-${m}.csv` }).click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card title="Billing">
      <div className="space-y-3 text-sm">
        <p className="text-[var(--muted)]">
          Each site is charged per month; each follow-up is charged once, in the month after a
          reviewer first approves it. Baseline and usual-care pilot cases are never charged. This is a
          usage statement, not a GST tax invoice.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Month">
            <input type="month" className={inputClass} value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          <Button onClick={issue} disabled={!month}>
            Issue statement
          </Button>
        </div>
        {loading && !data ? (
          <Skeleton rows={2} />
        ) : error && !data ? (
          <LoadError message={error} onRetry={refresh} />
        ) : data && data.items.length === 0 ? (
          <p className="text-[var(--muted)]">No statements yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {data?.items.map((s) => (
              <li key={s.month} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <span className="font-medium">{s.month}</span> ·{' '}
                  <span className="tabular-nums">{inr(s.totalInr)}</span>
                  <span className="text-[var(--muted)]">
                    {' '}
                    · {s.lines.filter((l) => l.description.includes('site fee')).length} site(s) · {s.enrolledCases} follow-up(s)
                    {s.simulation ? ' · synthetic lab' : ''}
                  </span>
                </div>
                <Button variant="ghost" onClick={() => csv(s.month)}>
                  CSV
                </Button>
              </li>
            ))}
          </ul>
        )}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}
