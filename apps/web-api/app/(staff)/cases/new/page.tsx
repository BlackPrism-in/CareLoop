'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '@/components/auth-provider';
import { IntakeAssist } from '@/components/intake-assist';
import { Button, Card, Field, inputClass, LoadError, Notice, Skeleton } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { localInputToIso } from '@/lib/format';
import type { CommandResult, Lookups } from '@/lib/types';
import { useData } from '@/lib/use-data';

/** Manual entry of an approved-action ticket (MVP-01). Creates a DRAFT; nothing is contacted. */
const LANGUAGE_NAMES = {
  'hi-IN': 'Hindi',
  'en-IN': 'English (India)',
  'bn-IN': 'Bengali',
} as const;

export default function NewFollowUp() {
  const { me, hasRole } = useAuth();
  const router = useRouter();
  const { data, error, loading, refresh } = useData<Lookups>(() => api<Lookups>('/v1/lookups'), []);
  const [form, setForm] = useState({
    patientId: '',
    consentId: '',
    siteId: '',
    actionType: 'CONSULTATION',
    actionText: '',
    due: '',
    ownerId: '',
    language: 'hi-IN',
    sourceAuthority: '',
    reference: '',
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setKey(crypto.randomUUID()); // a changed form is a new request
  };

  const consents = useMemo(
    () => data?.consents.filter((k) => k.patientId === form.patientId) ?? [],
    [data, form.patientId],
  );
  const patient = data?.patients.find((p) => p.patientId === form.patientId);

  if (!hasRole('COORDINATOR', 'REVIEWER'))
    return <Notice>Only coordinators and reviewers create follow-ups.</Notice>;
  if (loading && !data) return <Skeleton rows={6} />;
  if (error && !data) return <LoadError message={error} onRetry={refresh} />;
  if (!data) return null;
  const siteId = form.siteId || data.sites[0]?.siteId || '';
  const ownerId = form.ownerId || me?.uid || '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSubmitError(null);
    setDuplicate(null);
    try {
      const r = await api<CommandResult>('/v1/cases', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          siteId,
          patientId: form.patientId,
          consentId: form.consentId,
          source: { sourceAuthority: form.sourceAuthority, reference: form.reference },
          actionType: form.actionType,
          actionText: form.actionText,
          dueAt: localInputToIso(form.due),
          ownerId,
          language: form.language,
        },
      });
      if (r.warnings.includes('DUPLICATE_SOURCE_ACTION')) setDuplicate(r.caseId);
      else router.push(`/cases/${r.caseId}`);
    } catch (err) {
      setSubmitError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="text-sm">
        <Link href="/overview" className="text-[var(--accent)] hover:underline">
          ← Overview
        </Link>
      </div>
      <h1 className="text-lg font-semibold">New follow-up</h1>
      <Notice>
        Enter an action a clinician has already approved. CareLoop does not choose tests or
        interpret results. The case stays a draft until a reviewer approves it.
      </Notice>
      <IntakeAssist
        onApply={(f) => {
          setForm((cur) => ({
            ...cur,
            ...(f.actionType ? { actionType: f.actionType } : {}),
            ...(f.actionText ? { actionText: f.actionText } : {}),
            ...(f.dueDate ? { due: `${f.dueDate}T17:00` } : {}),
            ...(f.sourceAuthority ? { sourceAuthority: f.sourceAuthority } : {}),
            ...(f.reference ? { reference: f.reference } : {}),
            ...(f.language ? { language: f.language } : {}),
          }));
          setKey(crypto.randomUUID());
        }}
      />
      <form onSubmit={submit} className="space-y-4">
        <Card title="Source">
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Approving authority"
              hint="Clinic or pathologist that approved the next step."
            >
              <input
                className={inputClass}
                required
                value={form.sourceAuthority}
                onChange={(e) => set('sourceAuthority', e.target.value)}
              />
            </Field>
            <Field label="Order / instruction reference">
              <input
                className={inputClass}
                required
                value={form.reference}
                onChange={(e) => set('reference', e.target.value)}
              />
            </Field>
          </div>
        </Card>
        <Card title="Patient and permission">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Patient">
              <select
                className={inputClass}
                required
                value={form.patientId}
                onChange={(e) => {
                  const p = data.patients.find((x) => x.patientId === e.target.value);
                  setForm((f) => ({
                    ...f,
                    patientId: e.target.value,
                    consentId: '',
                    language: p?.language ?? f.language,
                  }));
                  setKey(crypto.randomUUID());
                }}
              >
                <option value="">Select…</option>
                {data.patients.map((p) => (
                  <option key={p.patientId} value={p.patientId}>
                    {p.alias} ({p.patientId})
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Contact permission"
              hint={
                form.patientId && consents.length === 0
                  ? '⚠ No active permission on file — the case can be drafted but not approved.'
                  : undefined
              }
            >
              <select
                className={inputClass}
                required
                value={form.consentId}
                onChange={(e) => set('consentId', e.target.value)}
                disabled={!form.patientId}
              >
                <option value="">Select…</option>
                {consents.map((k) => (
                  <option key={k.consentId} value={k.consentId}>
                    {k.consentId} · {k.channels.join(', ')}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {patient && patient.ageEligibility !== 'ADULT_CONFIRMED' && (
            <div className="mt-3">
              <Notice tone="warn">
                Adult eligibility is not confirmed for this patient. A reviewer won&apos;t be able
                to approve outreach.
              </Notice>
            </div>
          )}
        </Card>
        <Card title="Approved action">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Action type">
              <select
                className={inputClass}
                value={form.actionType}
                onChange={(e) => set('actionType', e.target.value)}
              >
                <option value="CONSULTATION">Consultation</option>
                <option value="ORDERED_TEST">Already-ordered test</option>
              </select>
            </Field>
            <Field label="Due (IST)">
              <input
                className={inputClass}
                type="datetime-local"
                required
                value={form.due}
                onChange={(e) => set('due', e.target.value)}
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Instruction exactly as approved">
                <input
                  className={inputClass}
                  required
                  maxLength={500}
                  value={form.actionText}
                  onChange={(e) => set('actionText', e.target.value)}
                />
              </Field>
            </div>
            <Field label="Accountable owner">
              <select
                className={inputClass}
                value={ownerId}
                onChange={(e) => set('ownerId', e.target.value)}
              >
                {data.members.map((m) => (
                  <option key={m.uid} value={m.uid}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Language">
              <select
                className={inputClass}
                value={form.language}
                onChange={(e) => set('language', e.target.value)}
              >
                {(data.enabledLanguages ?? ['hi-IN', 'en-IN']).map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_NAMES[l]}
                  </option>
                ))}
              </select>
            </Field>
            {data.sites.length > 1 && (
              <Field label="Site">
                <select
                  className={inputClass}
                  value={siteId}
                  onChange={(e) => set('siteId', e.target.value)}
                >
                  {data.sites.map((s) => (
                    <option key={s.siteId} value={s.siteId}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        </Card>
        {duplicate && (
          <Notice tone="warn">
            This order and action already has a case:{' '}
            <Link className="font-medium underline" href={`/cases/${duplicate}`}>
              {duplicate}
            </Link>
            . No new case was created.
          </Notice>
        )}
        {submitError && <Notice tone="error">{submitError}</Notice>}
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create draft'}
        </Button>
      </form>
    </div>
  );
}
