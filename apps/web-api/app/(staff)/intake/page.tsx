'use client';
import { CaseTable } from '@/components/case-table';

export default function IntakePage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Intake review</h1>
        <p className="text-sm text-[var(--muted)]">
          Drafts wait here until a reviewer confirms the source, patient, action, deadline, owner,
          language and contact permission. Nothing is contacted before approval.
        </p>
      </div>
      <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
        <CaseTable
          query={{ workflowState: 'DRAFT' }}
          empty="No drafts need review."
          hrefFor={(c) => `/intake/${c.caseId}`}
        />
      </div>
    </div>
  );
}
