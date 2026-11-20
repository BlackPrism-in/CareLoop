import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { sha256 } from './hashing';

/**
 * Patient action links (MVP spec §03, §19): an opaque, expiring capability
 * plus a separate one-time code as the identity gate before anything is
 * shown. Only hashes are stored. Holding the link alone discloses nothing.
 */
export interface PatientLinkDoc {
  tenantId: string;
  caseId: string;
  patientId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  codeSalt: string;
  codeHash: string;
  failedAttempts: number;
  lockedAt: string | null;
}

export interface PatientSessionDoc {
  linkHash: string;
  tenantId: string;
  caseId: string;
  patientId: string;
  createdAt: string;
  expiresAt: string;
}

export const PATIENT_LINK_TTL_MS = 7 * 86_400_000;
export const PATIENT_SESSION_TTL_MS = 15 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const TOKEN = /^[A-Za-z0-9_-]{40,60}$/;

const hashCode = (code: string, salt: string) => scryptSync(code, salt, 32).toString('hex');

export async function createPatientLink(
  db: Firestore,
  t: { tenantId: string; caseId: string; patientId: string; createdBy: string },
  now = new Date(),
): Promise<{ token: string; code: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + PATIENT_LINK_TTL_MS).toISOString();
  const doc: PatientLinkDoc = {
    ...t,
    createdAt: now.toISOString(),
    expiresAt,
    revokedAt: null,
    codeSalt: salt,
    codeHash: hashCode(code, salt),
    failedAttempts: 0,
    lockedAt: null,
  };
  await db.collection('patient_links').doc(sha256(token)).create(doc);
  return { token, code, expiresAt };
}

export type CodeCheck =
  | { ok: true; sessionToken: string; expiresAt: string }
  | { ok: false; reason: 'INVALID' | 'LOCKED' | 'EXPIRED' };

/** Verifies the code; 5 wrong tries lock the link. Generic failures leak nothing about the case. */
export async function openPatientSession(
  db: Firestore,
  token: string,
  code: string,
  now = new Date(),
): Promise<CodeCheck> {
  if (!TOKEN.test(token) || !/^\d{6}$/.test(code)) return { ok: false, reason: 'INVALID' };
  const linkHash = sha256(token);
  const ref = db.collection('patient_links').doc(linkHash);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'INVALID' } as const;
    const l = snap.data() as PatientLinkDoc;
    if (l.revokedAt || Date.parse(l.expiresAt) <= now.getTime())
      return { ok: false, reason: 'EXPIRED' } as const;
    if (l.lockedAt) return { ok: false, reason: 'LOCKED' } as const;
    const good = timingSafeEqual(
      Buffer.from(hashCode(code, l.codeSalt), 'hex'),
      Buffer.from(l.codeHash, 'hex'),
    );
    if (!good) {
      const failed = l.failedAttempts + 1;
      tx.update(ref, {
        failedAttempts: failed,
        ...(failed >= MAX_CODE_ATTEMPTS ? { lockedAt: now.toISOString() } : {}),
      });
      return { ok: false, reason: failed >= MAX_CODE_ATTEMPTS ? 'LOCKED' : 'INVALID' } as const;
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + PATIENT_SESSION_TTL_MS).toISOString();
    const s: PatientSessionDoc = {
      linkHash,
      tenantId: l.tenantId,
      caseId: l.caseId,
      patientId: l.patientId,
      createdAt: now.toISOString(),
      expiresAt,
    };
    tx.create(db.collection('patient_sessions').doc(sha256(sessionToken)), s);
    tx.update(ref, { failedAttempts: 0 });
    return { ok: true, sessionToken, expiresAt } as const;
  });
}

/** Resolves a session cookie; also re-checks that the link is still valid. */
export async function resolvePatientSession(
  db: Firestore,
  sessionToken: string | undefined,
  now = new Date(),
): Promise<(PatientSessionDoc & { sessionHash: string }) | null> {
  if (!sessionToken || !TOKEN.test(sessionToken)) return null;
  const sessionHash = sha256(sessionToken);
  const s = (await db.collection('patient_sessions').doc(sessionHash).get()).data() as
    PatientSessionDoc | undefined;
  if (!s || Date.parse(s.expiresAt) <= now.getTime()) return null;
  const l = (await db.collection('patient_links').doc(s.linkHash).get()).data() as
    PatientLinkDoc | undefined;
  if (!l || l.revokedAt || l.lockedAt || Date.parse(l.expiresAt) <= now.getTime()) return null;
  return { ...s, sessionHash };
}
