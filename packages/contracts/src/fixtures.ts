import { z } from 'zod';
import { Case, Consent, Member, Patient, Site, Slot, Source, Tenant } from './records';

/** A complete synthetic tenant used for local dev, the emulator and the demo. */
export const FixtureBundle = z
  .strictObject({
    $comment: z.string().optional(),
    tenant: Tenant,
    sites: z.array(Site).min(1),
    members: z.array(Member).min(1),
    patients: z.array(Patient),
    consents: z.array(Consent),
    sources: z.array(Source),
    cases: z.array(Case),
    slots: z.array(Slot),
  })
  .superRefine((b, ctx) => {
    if (!b.tenant.simulation) {
      ctx.addIssue({ code: 'custom', message: 'fixture tenants must be marked simulation=true' });
    }
    const ids = (xs: { [k: string]: unknown }[], key: string) =>
      new Set(xs.map((x) => x[key] as string));
    const sites = ids(b.sites, 'siteId');
    const members = ids(b.members, 'uid');
    const patients = ids(b.patients, 'patientId');
    const consents = ids(b.consents, 'consentId');
    const sources = ids(b.sources, 'sourceId');
    const check = (ok: boolean, path: (string | number)[], message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path, message });
    };
    b.consents.forEach((c, i) =>
      check(patients.has(c.patientId), ['consents', i, 'patientId'], 'unknown patient'),
    );
    b.slots.forEach((s, i) => check(sites.has(s.siteId), ['slots', i, 'siteId'], 'unknown site'));
    b.cases.forEach((c, i) => {
      check(sites.has(c.siteId), ['cases', i, 'siteId'], 'unknown site');
      check(patients.has(c.patientId), ['cases', i, 'patientId'], 'unknown patient');
      check(consents.has(c.consentId), ['cases', i, 'consentId'], 'unknown consent');
      check(sources.has(c.sourceId), ['cases', i, 'sourceId'], 'unknown source');
      check(members.has(c.ownerId), ['cases', i, 'ownerId'], 'unknown owner');
      check(members.has(c.createdBy), ['cases', i, 'createdBy'], 'unknown creator');
    });
    const fps = b.cases.map((c) => c.fingerprint);
    check(new Set(fps).size === fps.length, ['cases'], 'duplicate case fingerprints');
  });
export type FixtureBundle = z.infer<typeof FixtureBundle>;
