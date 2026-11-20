import { randomBytes } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { sha256 } from './hashing';

/**
 * Short-lived, single-use, case-bound voice session tickets (MVP spec §11).
 * The ticket is random; only its hash is stored. It carries no health data
 * and no model credentials.
 */
export interface VoiceTicketDoc {
  tenantId: string;
  caseId: string;
  interactionId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

const COLLECTION = 'voice_tickets';
export const VOICE_TICKET_TTL_MS = 60_000;

export async function issueVoiceTicket(
  db: Firestore,
  t: { tenantId: string; caseId: string; interactionId: string; createdBy: string },
  now = new Date(),
): Promise<{ ticket: string; expiresAt: string }> {
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + VOICE_TICKET_TTL_MS).toISOString();
  const doc: VoiceTicketDoc = { ...t, createdAt: now.toISOString(), expiresAt, usedAt: null };
  await db.collection(COLLECTION).doc(sha256(ticket)).create(doc);
  return { ticket, expiresAt };
}

/** Atomically marks the ticket used. Returns null if unknown, expired or already used. */
export async function consumeVoiceTicket(
  db: Firestore,
  ticket: string,
  now = new Date(),
): Promise<VoiceTicketDoc | null> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(ticket)) return null;
  const ref = db.collection(COLLECTION).doc(sha256(ticket));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const d = snap.data() as VoiceTicketDoc;
    if (d.usedAt || Date.parse(d.expiresAt) <= now.getTime()) return null;
    tx.update(ref, { usedAt: now.toISOString() });
    return d;
  });
}
