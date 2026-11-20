'use client';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button, Notice } from './ui';
import { clientAuth } from '@/lib/firebase-client';

/** Owner/auditor case export; the server records each export in the audit log. */
export function ExportButton({ caseId }: { caseId: string }) {
  const { hasRole } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (!hasRole('OWNER', 'AUDITOR')) return null;
  async function download() {
    setError(null);
    const token = await clientAuth().currentUser?.getIdToken();
    const res = await fetch(`/v1/cases/${caseId}/export`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return setError('Export failed.');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `${caseId}-export.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <Button variant="ghost" onClick={download}>
        Export (audited)
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
    </>
  );
}
