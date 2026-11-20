'use client';
import { useState } from 'react';
import type { IntakeResult } from '@careloop/ai';
import { api, describeError } from '@/lib/api';
import { Button, Card, inputClass, Notice } from './ui';

const LABEL: Record<string, string> = {
  actionType: 'Action type',
  actionText: 'Instruction',
  dueDate: 'Due date',
  sourceAuthority: 'Approving authority',
  reference: 'Reference',
  language: 'Language',
};

/**
 * Optional intake agent. Pre-fills the form from pasted approved-instruction
 * text; every value shows the exact source text it came from. Nothing is
 * saved until staff submit the form, and a reviewer still approves the case.
 */
export function IntakeAssist({ onApply }: { onApply: (fields: Record<string, string>) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntakeResult | null>(null);

  async function extract() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<IntakeResult>('/v1/intake', { method: 'POST', body: { text } });
      setResult(r);
      onApply(Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v!.value])));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Start from the approved instruction (optional)">
      <div className="space-y-3 text-sm">
        <textarea
          className={`${inputClass} min-h-28`}
          aria-label="Approved instruction text"
          placeholder="Paste the clinician-approved instruction. Administrative fields only — results and diagnoses are ignored."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button onClick={extract} disabled={busy || text.trim().length < 20}>
          {busy ? 'Reading…' : 'Fill the form from this text'}
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
        {result && (
          <div className="space-y-2">
            <ul className="space-y-1">
              {Object.entries(result.fields).map(([k, f]) => (
                <li key={k}>
                  <span className="font-medium">{LABEL[k]}:</span> {f!.value}{' '}
                  <span className="text-[var(--muted)]">— from “{f!.sourceSpan}”</span>
                </li>
              ))}
            </ul>
            {result.missingFields.length > 0 && (
              <Notice tone="warn">
                Not found in the text — fill in by hand:{' '}
                {result.missingFields.map((f) => LABEL[f]).join(', ')}.
              </Notice>
            )}
            {result.rejected.length > 0 && (
              <p className="text-xs text-[var(--muted)]">
                {result.rejected.length} suggested value(s) were discarded because they
                couldn&apos;t be traced to the text.
              </p>
            )}
            <p className="text-xs text-[var(--muted)]">
              Check every value below before creating the draft. Model {result.model} ·{' '}
              {result.promptVersion}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
