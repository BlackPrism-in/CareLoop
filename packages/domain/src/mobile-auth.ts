import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { sha256 } from './hashing';
import { tenantRecord } from './paths';

/**
 * Patient app sign-in by WhatsApp code. Possessing the phone number a lab
 * recorded for the patient is the gate. It proves possession of that number,
 * not who is holding the phone, so it is recorded as PHONE_OTP assurance.
 *
 * - Numbers are found through a hash index; the response never reveals
 *   whether a number is known.
 * - Codes: 6 digits, scrypt-hashed, 10 minutes, 5 wrong tries lock the code,
 *   at most 3 codes per number per 15 minutes.
 * - Sessions: opaque bearer token, stored hashed, 7 days, re-checked against
 *   the index on every request (a number removed by the lab ends access).
 */
export interface PatientRef {
  tenantId: string;
  patientId: string;
}

export interface PatientContactDoc {
  patientId: string;
  phoneE164: string;
  channel: 'WHATSAPP';
  updatedAt: string;
  updatedBy: string;
}

interface PhoneIndexDoc {
  entries: PatientRef[];
}

interface LoginCodeDoc {
  codeSalt: string;
  codeHash: string;
  expiresAt: string;
  failedAttempts: number;
  sentAt: string[];
}

export interface MobileSessionDoc {
  phoneHash: string;
  createdAt: string;
  expiresAt: string;
}

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const MOBILE_SESSION_TTL_MS = 7 * 86_400_000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_SENDS = 3;
const SEND_WINDOW_MS = 15 * 60_000;
const E164 = /^\+[1-9]\d{7,14}$/;
const TOKEN = /^[A-Za-z0-9_-]{40,60}$/;

const phoneKey = (phone: string) => sha256(`phone:${phone}`);
const hashCode = (code: string, salt: string) => scryptSync(code, salt, 32).toString('hex');

/** Normalises Indian-style input ("98000 00000", "+91 98000-00000") to E.164. */
export function normalisePhone(input: string, defaultCountry = '91'): string | null {
  const digits = input.replace(/[\s()-]/g, '');
  const e164 = digits.startsWith('+')
    ? digits
    : digits.length === 10
      ? `+${defaultCountry}${digits}`
      : digits.startsWith('00')
        ? `+${digits.slice(2)}`
        : `+${digits}`;
  return E164.test(e164) ? e164 : null;
}

/** Links (or replaces) a patient's WhatsApp number. Staff/admin only; the number is never shown in full. */
export async function setPatientWhatsApp(
  db: Firestore,
  ref: PatientRef,
  phoneE164: string,
  updatedBy: string,
  now = new Date(),
): Promise<void> {
  if (!E164.test(phoneE164)) throw new Error('phone must be E.164, e.g. +919800000000');
  const contactRef = db.doc(tenantRecord(ref.tenantId, 'patient_contacts', ref.patientId));
  await db.runTransaction(async (tx) => {
    const old = (await tx.get(contactRef)).data() as PatientContactDoc | undefined;
    const newIdx = db.collection('patient_phone_index').doc(phoneKey(phoneE164));
    const oldIdx = old ? db.collection('patient_phone_index').doc(phoneKey(old.phoneE164)) : null;
    const [n, o] = await Promise.all([
      tx.get(newIdx),
      oldIdx && old!.phoneE164 !== phoneE164 ? tx.get(oldIdx) : Promise.resolve(null),
    ]);
    const same = (e: PatientRef) => e.tenantId === ref.tenantId && e.patientId === ref.patientId;
    if (o?.exists) {
      const left = ((o.data() as PhoneIndexDoc).entries ?? []).filter((e) => !same(e));
      if (left.length) tx.set(oldIdx!, { entries: left });
      else tx.delete(oldIdx!);
    }
    const entries = ((n.data() as PhoneIndexDoc | undefined)?.entries ?? []).filter(
      (e) => !same(e),
    );
    tx.set(newIdx, { entries: [...entries, ref] });
    tx.set(contactRef, {
      patientId: ref.patientId,
      phoneE164,
      channel: 'WHATSAPP',
      updatedAt: now.toISOString(),
      updatedBy,
    } satisfies PatientContactDoc);
    tx.update(db.doc(tenantRecord(ref.tenantId, 'patients', ref.patientId)), {
      contactMasked: `${phoneE164.slice(0, 3)} •••••• ${phoneE164.slice(-4)}`,
    });
  });
}

export async function patientWhatsApp(db: Firestore, ref: PatientRef): Promise<string | null> {
  const d = (
    await db.doc(tenantRecord(ref.tenantId, 'patient_contacts', ref.patientId)).get()
  ).data() as PatientContactDoc | undefined;
  return d?.phoneE164 ?? null;
}

export type StartLogin =
  | { send: true; code: string; patients: PatientRef[] }
  | { send: false; reason: 'UNKNOWN_NUMBER' | 'RATE_LIMITED' };

/** Issues a code if the number belongs to a patient. The caller sends it and answers generically. */
export async function startPhoneLogin(
  db: Firestore,
  phoneE164: string,
  now = new Date(),
): Promise<StartLogin> {
  const key = phoneKey(phoneE164);
  const idx = (await db.collection('patient_phone_index').doc(key).get()).data() as
    PhoneIndexDoc | undefined;
  if (!idx?.entries?.length) return { send: false, reason: 'UNKNOWN_NUMBER' };
  const ref = db.collection('phone_login_codes').doc(key);
  return db.runTransaction(async (tx) => {
    const prev = (await tx.get(ref)).data() as LoginCodeDoc | undefined;
    const recent = (prev?.sentAt ?? []).filter(
      (t) => now.getTime() - Date.parse(t) < SEND_WINDOW_MS,
    );
    if (recent.length >= MAX_SENDS) return { send: false, reason: 'RATE_LIMITED' } as const;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    tx.set(ref, {
      codeSalt: salt,
      codeHash: hashCode(code, salt),
      expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MS).toISOString(),
      failedAttempts: 0,
      sentAt: [...recent, now.toISOString()],
    } satisfies LoginCodeDoc);
    return { send: true, code, patients: idx.entries } as const;
  });
}

export type VerifyLogin =
  | { ok: true; sessionToken: string; expiresAt: string }
  | { ok: false; reason: 'INVALID' | 'LOCKED' | 'EXPIRED' };

export async function verifyPhoneLogin(
  db: Firestore,
  phoneE164: string,
  code: string,
  now = new Date(),
): Promise<VerifyLogin> {
  if (!E164.test(phoneE164) || !/^\d{6}$/.test(code)) return { ok: false, reason: 'INVALID' };
  const key = phoneKey(phoneE164);
  const ref = db.collection('phone_login_codes').doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'INVALID' } as const;
    const l = snap.data() as LoginCodeDoc;
    if (!l.codeHash) return { ok: false, reason: 'INVALID' } as const;
    if (l.failedAttempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'LOCKED' } as const;
    if (Date.parse(l.expiresAt) <= now.getTime()) return { ok: false, reason: 'EXPIRED' } as const;
    const good = timingSafeEqual(
      Buffer.from(hashCode(code, l.codeSalt), 'hex'),
      Buffer.from(l.codeHash, 'hex'),
    );
    if (!good) {
      tx.update(ref, { failedAttempts: FieldValue.increment(1) });
      return {
        ok: false,
        reason: l.failedAttempts + 1 >= MAX_CODE_ATTEMPTS ? 'LOCKED' : 'INVALID',
      } as const;
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + MOBILE_SESSION_TTL_MS).toISOString();
    // A code works once.
    tx.update(ref, { codeHash: '', codeSalt: '', failedAttempts: 0 });
    tx.create(db.collection('mobile_sessions').doc(sha256(sessionToken)), {
      phoneHash: key,
      createdAt: now.toISOString(),
      expiresAt,
    } satisfies MobileSessionDoc);
    return { ok: true, sessionToken, expiresAt } as const;
  });
}

/** Bearer token → the patients this number belongs to right now. */
export async function resolveMobileSession(
  db: Firestore,
  token: string | undefined,
  now = new Date(),
): Promise<{ sessionHash: string; patients: PatientRef[] } | null> {
  if (!token || !TOKEN.test(token)) return null;
  const sessionHash = sha256(token);
  const s = (await db.collection('mobile_sessions').doc(sessionHash).get()).data() as
    MobileSessionDoc | undefined;
  if (!s || Date.parse(s.expiresAt) <= now.getTime()) return null;
  const idx = (await db.collection('patient_phone_index').doc(s.phoneHash).get()).data() as
    PhoneIndexDoc | undefined;
  if (!idx?.entries?.length) return null;
  return { sessionHash, patients: idx.entries };
}

export async function endMobileSession(db: Firestore, token: string | undefined): Promise<void> {
  if (!token || !TOKEN.test(token)) return;
  await db.collection('mobile_sessions').doc(sha256(token)).delete();
}
