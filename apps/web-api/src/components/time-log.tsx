'use client';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button, inputClass, Notice } from './ui';
import { api, describeError } from '@/lib/api';
import { useData } from '@/lib/use-data';

const ACTIVITIES = [
  ['CALL', 'Phone call'],
  ['BOOKING', 'Booking'],
  ['HANDOFF', 'Handoff'],
  ['EVIDENCE', 'Evidence'],
  ['REVIEW', 'Review'],
  ['INTAKE', 'Intake'],
  ['OTHER', 'Other'],
] as const;

/** Pilot workload measure: staff minutes per case, for every pilot group. */
export function TimeLog({ caseId }: { caseId: string }) {
  const { hasRole } = useAuth();
  const { data, refresh } = useData<{ totalMinutes: number }>(
    () => api(`/v1/time-logs?caseId=${encodeURIComponent(caseId)}`),
    [caseId],
  );
  const [minutes, setMinutes] = useState(5);
  const [activity, setActivity] = useState<string>('CALL');
  const [msg, setMsg] = useState<string | null>(null);
  if (!hasRole('OWNER', 'REVIEWER', 'COORDINATOR', 'VERIFIER')) return null;
  async function save() {
    try {
      await api('/v1/time-logs', { method: 'POST', body: { caseId, minutes, activity } });
      setMsg(null);
      void refresh();
    } catch (e) {
      setMsg(describeError(e));
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-[var(--muted)]">
        Staff time on this case: {data?.totalMinutes ?? 0} min
      </span>
      <input
        type="number"
        min={1}
        max={240}
        aria-label="Minutes"
        className={`${inputClass} w-20`}
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value) || 1)}
      />
      <select
        aria-label="Activity"
        className={`${inputClass} w-auto`}
        value={activity}
        onChange={(e) => setActivity(e.target.value)}
      >
        {ACTIVITIES.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <Button onClick={save}>Log time</Button>
      {msg && <Notice tone="error">{msg}</Notice>}
    </div>
  );
}
