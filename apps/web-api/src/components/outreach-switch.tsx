'use client';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button, Field, inputClass, Notice } from './ui';
import { api, describeError } from '@/lib/api';
import { useData } from '@/lib/use-data';

/** Owner-only site pause: stops future contact at execution time; evidence and staff work continue. */
export function OutreachSwitch() {
  const { hasRole, me } = useAuth();
  const { data, refresh } = useData<{ tenant: { outreachPaused?: boolean } | null }>(
    () => api('/v1/me/outreach'),
    [me?.uid],
  );
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!data?.tenant) return null;
  const paused = !!data.tenant.outreachPaused;
  if (!hasRole('OWNER'))
    return paused ? (
      <Notice tone="warn">Automated contact is paused for this lab by an owner.</Notice>
    ) : null;

  async function toggle() {
    try {
      await api('/v1/settings/outreach', {
        method: 'POST',
        body: { paused: !paused, reason: why.trim() },
      });
      setOpen(false);
      setWhy('');
      void refresh();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="space-y-2">
      {paused && (
        <Notice tone="warn">
          Automated contact is paused for this lab. Evidence and staff work continue.
        </Notice>
      )}
      {!open ? (
        <Button onClick={() => setOpen(true)}>
          {paused ? 'Resume automated contact…' : 'Pause automated contact…'}
        </Button>
      ) : (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-[var(--line)] p-3">
          <Field label="Reason (recorded)">
            <input className={inputClass} value={why} onChange={(e) => setWhy(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={!why.trim()} onClick={toggle}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
