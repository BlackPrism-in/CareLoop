'use client';
import { useState } from 'react';
import { Button, Card, cx, Notice } from './ui';
import { api, describeError } from '@/lib/api';
import { formatDate } from '@/lib/format';

interface Preview {
  previewHash: string;
  headerErrors: string[];
  summary: { ok: number; errors: number; duplicates: number };
  rows: {
    line: number;
    status: 'OK' | 'ERROR' | 'DUPLICATE';
    errors: string[];
    warnings: string[];
    existingCaseId?: string;
    actionType?: string;
    dueAt?: string;
  }[];
}
interface Commit {
  committed: boolean;
  outcomes: {
    line: number;
    status: 'CREATED' | 'EXISTING' | 'FAILED';
    caseId?: string;
    reason?: string;
  }[];
}

const TEMPLATE =
  'patient_ref,action_type,action_text,due_date,source_authority,reference,owner_id,language\n';

/** Bulk import of approved actions: full preview first; commit only with zero errors. Creates drafts only. */
export function CsvImport({ onDone }: { onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Commit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (commit) {
        setResult(
          await api<Commit>('/v1/intake/csv', {
            method: 'POST',
            body: { csv, commit: true, previewHash: preview!.previewHash },
          }),
        );
        onDone();
      } else {
        setResult(null);
        setPreview(await api<Preview>('/v1/intake/csv', { method: 'POST', body: { csv } }));
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Import approved actions (CSV)">
      <div className="space-y-3 text-sm">
        <p className="text-[var(--muted)]">
          One row per approved action, up to 100. Columns:{' '}
          <code className="text-xs">{TEMPLATE.trim()}</code> (owner and language optional). Rows
          become drafts; nothing is contacted until a reviewer approves each one.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Choose CSV file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              setCsv(await f.text());
              setPreview(null);
              setResult(null);
            }
          }}
        />
        <div className="flex gap-2">
          <Button disabled={!csv || busy} onClick={() => run(false)}>
            Preview
          </Button>
          {preview && !result && (
            <Button
              variant="primary"
              disabled={
                busy ||
                preview.summary.errors > 0 ||
                preview.headerErrors.length > 0 ||
                preview.summary.ok === 0
              }
              onClick={() => run(true)}
            >
              Create {preview.summary.ok} draft{preview.summary.ok === 1 ? '' : 's'}
            </Button>
          )}
        </div>
        {preview?.headerErrors.length ? (
          <Notice tone="error">{preview.headerErrors.join(' · ')}</Notice>
        ) : null}
        {preview && !preview.headerErrors.length && (
          <>
            <p>
              {preview.summary.ok} ready · {preview.summary.duplicates} already exist ·{' '}
              <span className={cx(preview.summary.errors > 0 && 'font-semibold')}>
                {preview.summary.errors} with errors
              </span>
              {preview.summary.errors > 0 &&
                ' — fix them in the file and preview again. Nothing is imported while any row has an error.'}
            </p>
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--muted)]">
                    <th className="py-1 pr-2">Line</th>
                    <th className="py-1 pr-2">Result</th>
                    <th className="py-1">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const o = result?.outcomes.find((x) => x.line === r.line);
                    return (
                      <tr key={r.line} className="border-t border-[var(--line)]">
                        <td className="py-1 pr-2">{r.line}</td>
                        <td className="py-1 pr-2">
                          {o
                            ? `${o.status === 'CREATED' ? '✓ Created' : o.status === 'EXISTING' ? '= Existing' : '✕ Failed'} ${o.caseId ?? ''}`
                            : r.status === 'OK'
                              ? '✓ Ready'
                              : r.status === 'DUPLICATE'
                                ? `= Exists (${r.existingCaseId})`
                                : '✕ Error'}
                        </td>
                        <td className="py-1">
                          {[...r.errors, ...r.warnings, r.dueAt ? `due ${formatDate(r.dueAt)}` : '']
                            .filter(Boolean)
                            .join(' · ')}
                          {o?.reason ? ` · ${o.reason}` : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {result &&
          (result.committed ? (
            <Notice tone="ok">Import finished. The drafts are in Intake review.</Notice>
          ) : (
            <Notice tone="warn">
              Some rows failed (listed above). Preview and import again — rows already created
              won&apos;t be duplicated.
            </Notice>
          ))}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
