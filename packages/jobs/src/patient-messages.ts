import type { Firestore } from 'firebase-admin/firestore';
import type { Case, Consent, Site, Tenant } from '@careloop/contracts';
import {
  followUpWord,
  maskPhone,
  type PatientTemplate,
  type SendResult,
  type WhatsAppSender,
} from '@careloop/adapters';
import { consentIsActive, patientWhatsApp, sha256, tenantRecord } from '@careloop/domain';
import type { Logger } from '@careloop/observability';

/** tenants/{t}/messages/{id}: one per case, template and occasion. Never holds the text or a code. */
export interface MessageDoc {
  messageId: string;
  caseId: string;
  patientId: string;
  template: PatientTemplate;
  status: SendResult['status'] | 'SKIPPED';
  reason: string | null;
  providerRef: string | null;
  toMasked: string | null;
  createdAt: string;
}

export interface PatientMessengerDeps {
  db: Firestore;
  whatsapp: WhatsAppSender;
  appUrl: string;
  log: Logger;
  clock?: () => Date;
}

const fmt = (iso: string, timeZone: string, lang: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(lang === 'hi-IN' ? 'hi-IN' : 'en-IN', { timeZone, ...o }).format(
    new Date(iso),
  );

/**
 * Sends a case's patient messages over WhatsApp. Each message is sent at most
 * once per occasion (retries and duplicate jobs find the record and stop), and
 * only while the patient's consent covers WhatsApp.
 */
export class PatientMessenger {
  private readonly clock: () => Date;
  constructor(private readonly deps: PatientMessengerDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async send(
    tenantId: string,
    c: Case,
    template: Exclude<PatientTemplate, 'LOGIN_CODE'>,
    occasion: string,
  ): Promise<MessageDoc> {
    const { db, whatsapp } = this.deps;
    const messageId = sha256(`${c.caseId}:${template}:${occasion}`).slice(0, 32);
    const ref = db.doc(tenantRecord(tenantId, 'messages', messageId));
    const prior = (await ref.get()).data() as MessageDoc | undefined;
    if (prior && prior.status !== 'FAILED') return prior;

    const now = this.clock();
    const record = async (
      d: Omit<MessageDoc, 'messageId' | 'caseId' | 'patientId' | 'template' | 'createdAt'>,
    ) => {
      const doc: MessageDoc = {
        messageId,
        caseId: c.caseId,
        patientId: c.patientId,
        template,
        createdAt: now.toISOString(),
        ...d,
      };
      await ref.set(doc);
      this.deps.log.info('patient message', {
        caseId: c.caseId,
        template,
        status: doc.status,
        reason: doc.reason,
      });
      return doc;
    };

    const [tenantSnap, siteSnap, consentSnap, phone] = await Promise.all([
      db.doc(`tenants/${tenantId}`).get(),
      db.doc(tenantRecord(tenantId, 'sites', c.siteId)).get(),
      db.doc(tenantRecord(tenantId, 'consents', c.consentId)).get(),
      patientWhatsApp(db, { tenantId, patientId: c.patientId }),
    ]);
    const consent = consentSnap.data() as Consent | undefined;
    if (!consent || !consentIsActive(consent, now, 'WHATSAPP'))
      return record({
        status: 'SKIPPED',
        reason: 'NO_WHATSAPP_CONSENT',
        providerRef: null,
        toMasked: null,
      });
    if (c.outreachDisposition === 'OPTED_OUT')
      return record({ status: 'SKIPPED', reason: 'OPTED_OUT', providerRef: null, toMasked: null });
    if (!phone)
      return record({
        status: 'SKIPPED',
        reason: 'NO_WHATSAPP_NUMBER',
        providerRef: null,
        toMasked: null,
      });

    const tenant = tenantSnap.data() as Tenant;
    const site = siteSnap.data() as Site | undefined;
    const tz = site?.timeZone ?? tenant.timeZone;
    const kind = followUpWord(c.actionType, c.language);
    const place = site?.displayName ?? tenant.displayName;
    const at = c.bookedStartsAt ?? c.dueAt;
    const day = fmt(at, tz, c.language, { weekday: 'short', day: 'numeric', month: 'short' });
    const time = fmt(at, tz, c.language, { hour: 'numeric', minute: '2-digit' });
    const params =
      template === 'FOLLOWUP_INVITE'
        ? [
            tenant.displayName,
            kind,
            fmt(c.dueAt, tz, c.language, { day: 'numeric', month: 'short' }),
            this.deps.appUrl,
          ]
        : [kind, place, day, time];

    const r = await whatsapp.send({ to: phone, template, language: c.language, params });
    return record({
      status: r.status,
      reason: r.reason ?? null,
      providerRef: r.providerRef ?? null,
      toMasked: maskPhone(phone),
    });
  }
}
