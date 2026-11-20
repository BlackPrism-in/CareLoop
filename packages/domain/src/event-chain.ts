import type { EventEnvelope } from '@careloop/contracts';
import { canonicalJson, sha256 } from './hashing';

export const GENESIS_HASH = '0'.repeat(64);

/** Hash of an event: canonical JSON of every field except `hash` itself. */
export function eventHash(e: EventEnvelope): string {
  const { hash: _omit, ...rest } = e;
  return sha256(canonicalJson(rest));
}

/** Seals an event onto the chain that ends at `prevHash`. */
export function sealEvent(
  e: Omit<EventEnvelope, 'prevHash' | 'hash'>,
  prevHash: string | undefined,
): EventEnvelope {
  const withPrev: EventEnvelope = { ...e, prevHash: prevHash ?? GENESIS_HASH };
  return { ...withPrev, hash: eventHash(withPrev) };
}

export interface ChainCheck {
  ok: boolean;
  /** Events checked against the chain. */
  checked: number;
  /** Events written before chaining existed (no hash); they precede the chain and are not covered. */
  unchained: number;
  /** First event whose hash or link does not match, if any. */
  brokenAt: string | null;
  reason: 'HASH_MISMATCH' | 'LINK_MISMATCH' | 'HEAD_MISMATCH' | 'VERSION_GAP' | null;
}

/**
 * Verifies a case's events (sorted by version) against the hash stored on the
 * case. Detects edited, deleted, reordered or inserted events. It cannot
 * detect a rewrite of the whole chain plus the case head by someone with
 * database write access; export the head hash elsewhere for that.
 */
export function verifyChain(events: EventEnvelope[], head: string | undefined): ChainCheck {
  const sorted = [...events].sort((a, b) => (a.nextVersion ?? 0) - (b.nextVersion ?? 0));
  let prev: string | null = null;
  let checked = 0;
  let unchained = 0;
  let lastVersion: number | null = null;
  const fail = (e: EventEnvelope, reason: ChainCheck['reason']): ChainCheck => ({
    ok: false,
    checked,
    unchained,
    brokenAt: e.eventId,
    reason,
  });
  for (const e of sorted) {
    if (!e.hash) {
      if (prev !== null) return fail(e, 'HASH_MISMATCH'); // a hash removed mid-chain
      unchained++;
      lastVersion = e.nextVersion ?? lastVersion;
      continue;
    }
    if (lastVersion !== null && e.nextVersion !== undefined && e.nextVersion !== lastVersion + 1)
      return fail(e, 'VERSION_GAP');
    if (eventHash(e) !== e.hash) return fail(e, 'HASH_MISMATCH');
    const expectedPrev = prev ?? (unchained === 0 ? GENESIS_HASH : e.prevHash);
    if (e.prevHash !== expectedPrev) return fail(e, 'LINK_MISMATCH');
    prev = e.hash;
    lastVersion = e.nextVersion ?? lastVersion;
    checked++;
  }
  if (prev !== null && head !== prev) {
    const last = sorted[sorted.length - 1]!;
    return { ok: false, checked, unchained, brokenAt: last.eventId, reason: 'HEAD_MISMATCH' };
  }
  if (prev === null && head)
    return { ok: false, checked, unchained, brokenAt: null, reason: 'HEAD_MISMATCH' };
  return { ok: true, checked, unchained, brokenAt: null, reason: null };
}
