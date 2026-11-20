import { loadConfig, type Consent, type Member, type Patient } from '@careloop/contracts';
import {
  consentIsActive,
  sha256,
  tenantCollection,
  tenantRecord,
  validateCsv,
  type CsvRowResult,
} from '@careloop/domain';
import { filterBySite } from '@/server/case-helpers';
import { HttpError } from '@/server/errors';
import { firestore } from '@/server/firebase';
import { jsonBody, staffRoute } from '@/server/handler';
import { CsvIntakeBody } from '@/server/schemas';
import { caseCommands, queries } from '@/server/services';

export const dynamic = 'force-dynamic';

/**
 * CSV bulk intake (P1). Without `commit` it returns a full per-row preview.
 * With `commit` it requires the preview hash and zero error rows, then
 * creates DRAFT cases for the OK rows. Each row has its own idempotency key,
 * so a retried commit completes the rest without duplicates, and the response
 * lists every row's outcome (no silent partial import).
 */
export const POST = staffRoute(async ({ req, session }) => {
  if (!session.ctx.roles.some((r) => r === 'COORDINATOR' || r === 'REVIEWER'))
    throw new HttpError('FORBIDDEN', 'Not permitted');
  const body = CsvIntakeBody.parse(await jsonBody(req));
  const t = session.ctx.tenantId;
  const db = firestore();
  const now = new Date();
  const [patients, consents, members] = await Promise.all([
    db.collection(tenantCollection(t, 'patients')).limit(5000).get(),
    db.collection(tenantCollection(t, 'consents')).limit(10000).get(),
    db.collection(tenantCollection(t, 'members')).where('status', '==', 'ACTIVE').get(),
  ]);
  const activeConsentByPatient = new Map<string, Consent>();
  for (const d of consents.docs) {
    const k = d.data() as Consent;
    if (consentIsActive(k, now)) activeConsentByPatient.set(k.patientId, k);
  }
  const preliminary = validateCsv(body.csv, {
    tenantId: t,
    now,
    defaultOwnerId: session.ctx.actorId,
    activeOwnerIds: new Set(members.docs.map((d) => (d.data() as Member).uid)),
    patientsByRef: new Map(
      patients.docs.map((d) => [(d.data() as Patient).externalRef, d.data() as Patient]),
    ),
    activeConsentByPatient,
    enabledLanguages: loadConfig().ENABLED_LANGUAGES,
    existingCaseByFingerprint: new Map(),
  });
  // Existing-case check: look up only the fingerprints in this file.
  const fps = preliminary.rows.flatMap((r) => (r.input ? [r.input.fingerprint] : []));
  const existing = new Map<string, string>();
  for (let i = 0; i < fps.length; i += 100) {
    const refs = fps
      .slice(i, i + 100)
      .map((fp) => db.doc(tenantRecord(t, 'case_fingerprints', fp)));
    for (const s of refs.length ? await db.getAll(...refs) : [])
      if (s.exists) existing.set(s.id, s.data()!.caseId as string);
  }
  // A duplicate at a site the caller does not manage is reported without its case id.
  const visible = new Set(
    (await filterBySite(t, [...existing.values()].map((caseId) => ({ caseId })), session.ctx.siteIds)).map((x) => x.caseId),
  );
  const rows: CsvRowResult[] = preliminary.rows.map((r) => {
    if (!(r.status === 'OK' && r.input && existing.has(r.input.fingerprint))) return r;
    const id = existing.get(r.input.fingerprint)!;
    const shown = visible.has(id) ? id : undefined;
    return {
      ...r,
      status: 'DUPLICATE',
      existingCaseId: shown,
      warnings: [...r.warnings, shown ? `Already a case: ${shown}` : 'Already a case at another site'],
    };
  });
  const previewHash = sha256(body.csv);
  const summary = {
    ok: rows.filter((r) => r.status === 'OK').length,
    errors: rows.filter((r) => r.status === 'ERROR').length,
    duplicates: rows.filter((r) => r.status === 'DUPLICATE').length,
  };
  // The preview shows outcomes and normalised values, not patient identifiers.
  const publicRows = rows.map(({ input, ...r }) => ({
    ...r,
    actionType: input?.actionType,
    dueAt: input?.dueAt,
  }));

  if (!body.commit)
    return Response.json({
      previewHash,
      headerErrors: preliminary.headerErrors,
      summary,
      rows: publicRows,
    });
  if (body.previewHash !== previewHash)
    throw new HttpError(
      'VERSION_CONFLICT',
      'The file changed since the preview. Preview it again.',
    );
  if (preliminary.headerErrors.length || summary.errors > 0)
    throw new HttpError('DOMAIN_GUARD_FAILED', 'CSV_HAS_ERRORS');

  const lab = await queries().lookups(t, session.ctx.siteIds);
  const siteId = lab.sites[0]?.siteId;
  if (!siteId) throw new HttpError('DOMAIN_GUARD_FAILED', 'NO_SITE');
  const outcomes: {
    line: number;
    status: 'CREATED' | 'EXISTING' | 'FAILED';
    caseId?: string;
    reason?: string;
  }[] = [];
  for (const r of rows) {
    if (r.status === 'DUPLICATE') {
      outcomes.push({ line: r.line, status: 'EXISTING', caseId: r.existingCaseId });
      continue;
    }
    const i = r.input!;
    try {
      const sourceId = await queries().ensureSource(t, i.source);
      const res = await caseCommands().createCase(session.ctx, {
        idempotencyKey: `csv:${previewHash}:${r.line}`,
        input: {
          caseId: `CL-${sha256(`${previewHash}:${r.line}`).slice(0, 8).toUpperCase()}`,
          siteId,
          patientId: i.patientId,
          sourceId,
          consentId: i.consentId,
          actionType: i.actionType,
          actionText: i.actionText,
          dueAt: i.dueAt,
          ownerId: i.ownerId,
          language: i.language,
        },
      });
      outcomes.push({
        line: r.line,
        status: res.warnings.length ? 'EXISTING' : 'CREATED',
        caseId: res.caseId,
      });
    } catch (e) {
      outcomes.push({
        line: r.line,
        status: 'FAILED',
        reason: (e as { reason?: string }).reason ?? 'ERROR',
      });
    }
  }
  const failed = outcomes.filter((o) => o.status === 'FAILED').length;
  return Response.json(
    { previewHash, committed: failed === 0, outcomes },
    { status: failed ? 207 : 201 },
  );
});
