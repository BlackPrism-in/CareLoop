import { z } from 'zod';

/**
 * LIMS / hospital order intake (Phase 9). Orders arrive as signed JSON or as
 * an HL7 v2 ORM^O01 message. Either way they become a DRAFT case that a
 * reviewer must approve; intake never authorizes outreach.
 */
export const LimsOrder = z.strictObject({
  /** The sending system's order number (ORC-2 / OBR-2). Unique per account. */
  orderId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  /** The lab's patient reference (PID-3), matched against patients.externalRef. */
  patientRef: z.string().min(1).max(64),
  actionType: z.enum(['CONSULTATION', 'ORDERED_TEST']),
  actionText: z.string().trim().min(1).max(300),
  /** YYYY-MM-DD (end of that day, IST) or an ISO datetime. */
  due: z.string().min(10).max(40),
  /** Who ordered it (ORC-12 / OBR-16); kept as the source authority. */
  orderingAuthority: z.string().trim().min(1).max(120),
  messageId: z.string().max(64).optional(),
});
export type LimsOrder = z.infer<typeof LimsOrder>;

export function limsDueAt(due: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return new Date(`${due}T23:59:00+05:30`);
  // HL7 TS: YYYYMMDD[HHMM[SS]][+/-ZZZZ]
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?([+-]\d{4})?$/.exec(due);
  if (m) {
    const [, y, mo, d, h, mi, s, tz] = m;
    if (!h) return new Date(`${y}-${mo}-${d}T23:59:00+05:30`);
    const off = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : '+05:30';
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${off}`);
  }
  const t = new Date(due);
  return Number.isNaN(t.getTime()) || !/T/.test(due) ? null : t;
}

export type Hl7Result = { ok: true; order: LimsOrder } | { ok: false; error: string };

/**
 * Minimal HL7 v2 ORM^O01 reader: MSH, PID, ORC, OBR (and TQ1 for timing).
 * Only new orders (ORC-1 = NW) are accepted; cancels and changes go to staff.
 * One order per message: a message with several OBR segments is refused.
 */
export function parseHl7Orm(message: string): Hl7Result {
  const segments = message
    .replace(/^\u000b|\u001c\r?$/g, '') // MLLP framing, if a gateway left it in
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const msh = segments[0];
  if (!msh?.startsWith('MSH') || msh.length < 8) return { ok: false, error: 'MSH_MISSING' };
  const fieldSep = msh[3]!;
  const encoding = msh.slice(4, 8);
  const comp = encoding[0]!;
  const rep = encoding[1]!;
  const esc = encoding[2]!;
  const unescape = (v: string) =>
    v
      .split(`${esc}F${esc}`).join(fieldSep)
      .split(`${esc}S${esc}`).join(comp)
      .split(`${esc}R${esc}`).join(rep)
      .split(`${esc}T${esc}`).join(encoding[3] ?? '&')
      .split(`${esc}E${esc}`).join(esc);
  const seg = (name: string) => segments.filter((s) => s.startsWith(name + fieldSep));
  // MSH-1 is the separator itself, so MSH field n is at split index n-1.
  const field = (s: string, n: number) => (s.startsWith('MSH') ? s.split(fieldSep)[n - 1] : s.split(fieldSep)[n]) ?? '';
  const comps = (v: string) => v.split(rep)[0]!.split(comp).map(unescape);

  const type = comps(field(msh, 9));
  if (type[0] !== 'ORM' || (type[1] && type[1] !== 'O01')) return { ok: false, error: 'NOT_ORM_O01' };
  const messageId = unescape(field(msh, 10)) || undefined;

  const pid = seg('PID')[0];
  if (!pid) return { ok: false, error: 'PID_MISSING' };
  const patientRef = comps(field(pid, 3))[0] ?? '';
  if (!patientRef) return { ok: false, error: 'PATIENT_REF_MISSING' };

  const orcs = seg('ORC');
  const obrs = seg('OBR');
  if (obrs.length !== 1 || orcs.length > 1) return { ok: false, error: 'ONE_ORDER_PER_MESSAGE' };
  const orc = orcs[0];
  const obr = obrs[0]!;
  if (orc && field(orc, 1) !== 'NW') return { ok: false, error: `ORDER_CONTROL_${field(orc, 1) || 'MISSING'}_NEEDS_STAFF` };

  const orderId = comps(orc ? field(orc, 2) : '')[0] || comps(field(obr, 2))[0] || '';
  const service = comps(field(obr, 4));
  const actionText = service[1] || service[0] || '';
  const provider = comps((orc && field(orc, 12)) || field(obr, 16));
  // XCN: id^family^given^...
  const orderingAuthority = [provider[2], provider[1]].filter(Boolean).join(' ') || provider[0] || '';
  // Timing: TQ1-7 (v2.5+), else OBR-27 component 4 (older TQ), else OBR-7 observation time.
  const tq1 = seg('TQ1')[0];
  const due = (tq1 && comps(field(tq1, 7))[0]) || comps(field(obr, 27))[3] || comps(field(obr, 7))[0] || '';
  if (!due) return { ok: false, error: 'DUE_DATE_MISSING' };
  const dueAt = limsDueAt(due);
  if (!dueAt || Number.isNaN(dueAt.getTime())) return { ok: false, error: 'DUE_DATE_INVALID' };

  const parsed = LimsOrder.safeParse({
    orderId,
    patientRef,
    actionType: /consult|referral|review/i.test(actionText) ? 'CONSULTATION' : 'ORDERED_TEST',
    actionText,
    due: dueAt.toISOString(),
    orderingAuthority,
    ...(messageId ? { messageId: messageId.slice(0, 64) } : {}),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `INVALID_${String(first?.path[0] ?? 'ORDER').toUpperCase()}` };
  }
  return { ok: true, order: parsed.data };
}
