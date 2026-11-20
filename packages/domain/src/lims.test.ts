import { describe, expect, it } from 'vitest';
import { limsDueAt, parseHl7Orm } from './lims';

const msg = (orc = 'ORC|NW|ORD-77||||||||||1234^Rao^Meera', extra = '') =>
  [
    'MSH|^~\\&|LIMS|LAB|CARELOOP|CL|20261120093000||ORM^O01|MSG001|P|2.5',
    'PID|1||PREF-9^^^LAB^MR||Synthetic^Patient',
    orc,
    'OBR|1|ORD-77||HBA1C^HbA1c repeat test^L|||20261120',
    'TQ1|1||||||20261205',
    extra,
  ].filter(Boolean).join('\r');

describe('HL7 v2 ORM^O01 intake', () => {
  it('reads a new order into a draft-ready order', () => {
    const r = parseHl7Orm(msg());
    expect(r).toEqual({
      ok: true,
      order: {
        orderId: 'ORD-77',
        patientRef: 'PREF-9',
        actionType: 'ORDERED_TEST',
        actionText: 'HbA1c repeat test',
        due: '2026-12-05T18:29:00.000Z',
        orderingAuthority: 'Meera Rao',
        messageId: 'MSG001',
      },
    });
  });

  it('accepts LF line endings and a consultation', () => {
    const r = parseHl7Orm(msg().replace('HBA1C^HbA1c repeat test', 'CONS^Endocrinology consultation').replaceAll('\r', '\n'));
    expect(r.ok && r.order.actionType).toBe('CONSULTATION');
  });

  it('decodes escapes', () => {
    const r = parseHl7Orm(msg().replace('HbA1c repeat test', 'Lipid \\T\\ thyroid'));
    expect(r.ok && r.order.actionText).toBe('Lipid & thyroid');
  });

  it('sends cancels and changes to staff instead of acting on them', () => {
    expect(parseHl7Orm(msg('ORC|CA|ORD-77'))).toEqual({ ok: false, error: 'ORDER_CONTROL_CA_NEEDS_STAFF' });
  });

  it('refuses other message types, several orders, and missing parts', () => {
    expect(parseHl7Orm(msg().replace('ORM^O01', 'ADT^A01'))).toMatchObject({ ok: false, error: 'NOT_ORM_O01' });
    expect(parseHl7Orm(msg(undefined, 'OBR|2|ORD-78||X^Y'))).toMatchObject({ ok: false, error: 'ONE_ORDER_PER_MESSAGE' });
    expect(parseHl7Orm(msg().replace('TQ1|1||||||20261205', ''))).toMatchObject({ ok: true }); // falls back to OBR-7
    expect(parseHl7Orm(msg().replace('TQ1|1||||||20261205', '').replace('|||20261120', '|||'))).toMatchObject({ ok: false, error: 'DUE_DATE_MISSING' });
    expect(parseHl7Orm('PID|1')).toMatchObject({ ok: false, error: 'MSH_MISSING' });
    expect(parseHl7Orm(msg().replace('PREF-9^^^LAB^MR', ''))).toMatchObject({ ok: false, error: 'PATIENT_REF_MISSING' });
  });

  it('reads HL7 timestamps with and without a zone', () => {
    expect(limsDueAt('202612051030+0000')?.toISOString()).toBe('2026-12-05T10:30:00.000Z');
    expect(limsDueAt('2026-12-05')?.toISOString()).toBe('2026-12-05T18:29:00.000Z');
    expect(limsDueAt('nonsense')).toBeNull();
  });
});
