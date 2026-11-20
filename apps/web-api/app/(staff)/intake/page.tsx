'use client';
import { useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { CaseTable } from '@/components/case-table';
import { CsvImport } from '@/components/csv-import';

export default function IntakePage() {
  const { hasRole } = useAuth();
  const [n, setN] = useState(0);
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
          key={n}
          query={{ workflowState: 'DRAFT' }}
          empty="No drafts need review."
          hrefFor={(c) => `/intake/${c.caseId}`}
        />
      </div>
      {hasRole('COORDINATOR', 'REVIEWER') && <CsvImport onDone={() => setN((x) => x + 1)} />}
    </div>
  );
}
