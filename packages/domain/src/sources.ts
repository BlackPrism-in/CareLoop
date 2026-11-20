import { sha256 } from './hashing';

/** Deterministic source id for an upstream authority + reference (e.g. a clinic order number). */
export function sourceIdFor(s: { sourceAuthority: string; reference: string }): string {
  return `src_${sha256(`${s.sourceAuthority.trim().toLowerCase()}\u001f${s.reference.trim().toLowerCase()}`).slice(0, 24)}`;
}
