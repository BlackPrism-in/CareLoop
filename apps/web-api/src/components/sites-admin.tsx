'use client';
import { useState } from 'react';
import { Button, Card, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { useData } from '@/lib/use-data';

interface SiteRow {
  siteId: string;
  displayName: string;
  timeZone: string;
  contactWindow: { start: string; end: string };
}
interface MemberRow {
  uid: string;
  displayName: string;
  roleSet: string[];
  status: string;
  permittedSiteIds: string[];
}

/**
 * Multi-site labs (Phase 9). Owners and auditors see every site; everyone
 * else sees only the sites ticked here. Changes apply on the staff member's
 * next request and are audited.
 */
export function SitesAdmin() {
  const sites = useData<{ items: SiteRow[] }>(() => api('/v1/sites'), []);
  const members = useData<{ items: MemberRow[] }>(() => api('/v1/members'), []);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [form, setForm] = useState({
    siteId: '',
    displayName: '',
    timeZone: 'Asia/Kolkata',
    start: '09:00',
    end: '19:00',
  });

  async function addSite() {
    try {
      await api('/v1/sites', {
        method: 'POST',
        body: {
          siteId: form.siteId.trim(),
          displayName: form.displayName.trim(),
          timeZone: form.timeZone.trim(),
          contactWindow: { start: form.start, end: form.end },
        },
      });
      setMsg({ tone: 'ok', text: `Site ${form.displayName.trim()} saved.` });
      setForm({ ...form, siteId: '', displayName: '' });
      void sites.refresh();
    } catch (e) {
      setMsg({ tone: 'error', text: describeError(e) });
    }
  }

  async function toggle(m: MemberRow, siteId: string) {
    const next = m.permittedSiteIds.includes(siteId)
      ? m.permittedSiteIds.filter((s) => s !== siteId)
      : [...m.permittedSiteIds, siteId];
    try {
      await api(`/v1/members/${encodeURIComponent(m.uid)}/sites`, {
        method: 'POST',
        body: { permittedSiteIds: next },
      });
      void members.refresh();
    } catch (e) {
      setMsg({ tone: 'error', text: describeError(e) });
    }
  }

  const siteList = sites.data?.items ?? [];
  return (
    <Card title="Sites and staff access">
      <div className="space-y-4 text-sm">
        {sites.loading && !sites.data ? (
          <Skeleton rows={2} />
        ) : sites.error && !sites.data ? (
          <LoadError message={sites.error} onRetry={sites.refresh} />
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {siteList.map((s) => (
              <li key={s.siteId} className="py-1.5">
                <span className="font-medium">{s.displayName}</span>{' '}
                <span className="text-[var(--muted)]">
                  · {s.siteId} · {s.timeZone} · calls {s.contactWindow.start}–{s.contactWindow.end}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 md:grid-cols-5">
          <Field label="Site ID">
            <input
              className={inputClass}
              value={form.siteId}
              onChange={(e) => setForm({ ...form, siteId: e.target.value })}
            />
          </Field>
          <Field label="Name">
            <input
              className={inputClass}
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <input
              className={inputClass}
              value={form.timeZone}
              onChange={(e) => setForm({ ...form, timeZone: e.target.value })}
            />
          </Field>
          <Field label="Calls from">
            <input
              type="time"
              className={inputClass}
              value={form.start}
              onChange={(e) => setForm({ ...form, start: e.target.value })}
            />
          </Field>
          <Field label="Calls until">
            <input
              type="time"
              className={inputClass}
              value={form.end}
              onChange={(e) => setForm({ ...form, end: e.target.value })}
            />
          </Field>
        </div>
        <Button disabled={!form.siteId.trim() || !form.displayName.trim()} onClick={addSite}>
          Save site
        </Button>

        {members.data && siteList.length > 1 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">Which sites each staff member can work at</caption>
              <thead className="text-xs text-[var(--muted)]">
                <tr>
                  <th className="py-1 pr-3 font-normal">Staff</th>
                  {siteList.map((s) => (
                    <th key={s.siteId} className="py-1 pr-3 font-normal">
                      {s.displayName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.data.items.map((m) => {
                  const all = m.roleSet.includes('OWNER') || m.roleSet.includes('AUDITOR');
                  return (
                    <tr key={m.uid} className="border-t border-[var(--line)]">
                      <td className="py-1.5 pr-3">
                        {m.displayName}
                        <div className="text-xs text-[var(--muted)]">
                          {m.roleSet.join(', ').toLowerCase()}
                        </div>
                      </td>
                      {siteList.map((s) => (
                        <td key={s.siteId} className="py-1.5 pr-3">
                          {all ? (
                            <span className="text-xs text-[var(--muted)]">all sites</span>
                          ) : (
                            <input
                              type="checkbox"
                              aria-label={`${m.displayName} at ${s.displayName}`}
                              checked={m.permittedSiteIds.includes(s.siteId)}
                              onChange={() => toggle(m, s.siteId)}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    </Card>
  );
}
