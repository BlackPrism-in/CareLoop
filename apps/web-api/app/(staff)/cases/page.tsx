'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CaseTable } from '@/components/case-table';
import { Button, inputClass } from '@/components/ui';

const STATES = [
  ['', 'All statuses'],
  ['DRAFT', 'Needs approval'],
  ['READY', 'Approved'],
  ['CONTACTING', 'Contacting'],
  ['AWAITING_BOOKING', 'Booking requested'],
  ['BOOKED', 'Booked'],
  ['AWAITING_EVIDENCE', 'Awaiting proof'],
  ['COMPLETED_VERIFIED', 'Completed · verified'],
  ['CANCELLED', 'Cancelled'],
] as const;

function Cases() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const query: Record<string, string> = {};
  for (const k of ['workflowState', 'owner', 'view'] as const) {
    const v = params.get(k);
    if (v) query[k] = v;
  }
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'workflowState') next.delete('view');
    router.replace(`${path}?${next}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Cases</h1>
        <Link href="/cases/new">
          <Button variant="primary">+ New follow-up</Button>
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Status"
          className={`${inputClass} w-auto`}
          value={query.workflowState ?? ''}
          onChange={(e) => set('workflowState', e.target.value)}
        >
          {STATES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={query.owner === 'me'}
            onChange={(e) => set('owner', e.target.checked ? 'me' : '')}
          />
          Only mine
        </label>
        {query.view === 'proof' && (
          <span className="text-sm text-[var(--muted)]">Showing: proof to review</span>
        )}
      </div>
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <CaseTable query={query} empty="No cases match these filters." />
      </div>
    </div>
  );
}

export default function CasesPage() {
  return (
    <Suspense>
      <Cases />
    </Suspense>
  );
}
