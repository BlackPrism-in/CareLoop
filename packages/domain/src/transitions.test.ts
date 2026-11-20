import { describe, expect, it } from 'vitest';
import type { Case } from '@careloop/contracts';
import { approvalHash, approvalIsCurrent } from './approval';
import { withinContactWindow } from './contact-window';
import { assertPermitted, PERMISSIONS } from './context';
import { canonicalJson } from './hashing';
import { editDraft } from './transitions';

const base = {
  caseId: 'c',
  siteId: 's',
  patientId: 'p',
  sourceId: 'src',
  consentId: 'k',
  actionType: 'CONSULTATION',
  actionText: 'x',
  dueAt: '2026-11-28T00:00:00.000Z',
  ownerId: 'o',
  language: 'hi-IN',
  approvalRevision: 1,
  approvedAt: '2026-11-21T00:00:00.000Z',
  approvedBy: 'r',
  contactAttempts: 0,
  audioSecondsUsed: 0,
  bookedStartsAt: null,
  bookingRef: null,
  activeHandoffId: null,
  workflowState: 'READY',
  outreachDisposition: 'NOT_STARTED',
  handoffState: 'NONE',
  evidenceState: 'NONE',
  bookingState: 'NONE',
  automationPausedReason: null,
  fingerprint: 'f',
  version: 2,
  createdBy: 'u',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
} satisfies Omit<Case, 'approvalHash'>;
const approved: Case = { ...base, approvalHash: approvalHash(base) };

describe('approval hash', () => {
  it('is current until a material field changes', () => {
    expect(approvalIsCurrent(approved)).toBe(true);
    expect(approvalIsCurrent({ ...approved, dueAt: '2026-11-29T00:00:00.000Z' })).toBe(false);
    expect(approvalIsCurrent({ ...approved, ownerId: 'someone-else' })).toBe(true);
  });
  it('non-material edits keep approval; material ones invalidate', () => {
    expect(editDraft(approved, { ownerId: 'o2' }).patch.workflowState).toBeUndefined();
    expect(editDraft(approved, { actionText: 'changed' }).patch.workflowState).toBe('DRAFT');
  });
});

describe('contact window', () => {
  it('uses the site timezone', () => {
    const w = { start: '09:00', end: '19:00' };
    expect(withinContactWindow(new Date('2026-11-21T03:29:00Z'), w, 'Asia/Kolkata')).toBe(false); // 08:59 IST
    expect(withinContactWindow(new Date('2026-11-21T03:30:00Z'), w, 'Asia/Kolkata')).toBe(true); // 09:00 IST
    expect(withinContactWindow(new Date('2026-11-21T13:30:00Z'), w, 'Asia/Kolkata')).toBe(false); // 19:00 IST
  });
});

describe('permissions', () => {
  it('auditors and owners never approve; agents never approve, cancel, verify or reopen', () => {
    expect(PERMISSIONS.approve.roles).toEqual(['REVIEWER']);
    for (const cmd of [
      'approve',
      'cancelCase',
      'verifyCompletion',
      'reopenCase',
      'acknowledgeHandoff',
    ] as const) {
      expect(PERMISSIONS[cmd].actors).not.toContain('AGENT');
    }
    for (const rule of Object.values(PERMISSIONS)) expect(rule.roles).not.toContain('AUDITOR');
    expect(() =>
      assertPermitted(
        { tenantId: 't', actorType: 'STAFF', actorId: 'o', roles: ['OWNER'], correlationId: 'c' },
        'approve',
      ),
    ).toThrow();
  });
});

describe('canonicalJson', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }),
    );
  });
});
