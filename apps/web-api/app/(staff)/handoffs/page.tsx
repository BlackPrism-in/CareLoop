'use client';
import { CaseTable } from '@/components/case-table';

export default function HandoffsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Human queue</h1>
        <p className="text-sm text-[var(--muted)]">
          Cases that need a named person. Acknowledging a handoff takes responsibility; it does not
          complete the follow-up.
        </p>
      </div>
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <CaseTable query={{ view: 'handoffs' }} empty="No handoffs are waiting." />
      </div>
    </div>
  );
}
