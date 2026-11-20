import {
  INTAKE_FIELD_KEYS,
  IntakeInput,
  IntakeModelOutput,
  REQUIRED_FIELD_KEYS,
  type IntakeField,
  type IntakeFieldKey,
  type IntakeProposal,
} from '@careloop/contracts';

export const FIELD_KEYS = INTAKE_FIELD_KEYS;
export { IntakeInput, REQUIRED_FIELD_KEYS };
export type { IntakeField, IntakeFieldKey, IntakeProposal };

export function parseIntakeInput(raw: unknown): IntakeInput {
  return IntakeInput.parse(raw);
}

export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

export function normalizeDate(value: string): string | null {
  const input = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(input);
  const textual = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(input);
  const monthFirst = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(input);
  const months: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const year = Number(iso?.[1] ?? dmy?.[3] ?? textual?.[3] ?? monthFirst?.[3]);
  const month = Number(
    iso?.[2] ?? dmy?.[2] ?? months[(textual?.[2] ?? monthFirst?.[1] ?? '').toLowerCase()],
  );
  const day = Number(iso?.[3] ?? dmy?.[1] ?? textual?.[1] ?? monthFirst?.[2]);
  if (!iso && !dmy && !textual && !monthFirst) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function canonicalActionName(value: string): string {
  return value
    .trim()
    .replace(/^(?:repeat|recheck|dobara)\s+/i, '')
    .replace(/\s+(?:test|test\s+ordered)$/i, '')
    .trim();
}

function canonicalClinician(value: string, quote: string): string {
  const title = quote.match(
    /\bDr\.?\s+(?:[\p{L}]\.\s*)*[\p{Lu}][\p{L}'-]*(?:\s+[\p{Lu}][\p{L}'-]*)*/u,
  )?.[0];
  const sourceLastName = title?.split(/\s+/).at(-1)?.toLocaleLowerCase();
  const valueLastName = value.trim().split(/\s+/).at(-1)?.replace(/[.,]$/, '').toLocaleLowerCase();
  return title && sourceLastName === valueLastName ? title : value.trim();
}

function findUniqueQuote(
  sourceText: string,
  quote: string,
): { start: number; end: number; unique: boolean } | null {
  const start = sourceText.indexOf(quote);
  if (start < 0) return null;
  const next = sourceText.indexOf(quote, start + 1);
  return { start, end: start + quote.length, unique: next < 0 };
}

function spanFor(sourceText: string, field: IntakeField): { start: number; end: number } | null {
  const { start, end, quote } = field.sourceSpan;
  if (sourceText.slice(start, end) === quote && end - start === quote.length) return { start, end };
  const found = findUniqueQuote(sourceText, quote);
  return found?.unique ? { start: found.start, end: found.end } : null;
}

function valueSupported(key: IntakeFieldKey, value: string, quote: string): boolean {
  const q = quote.toLocaleLowerCase();
  const v = value.trim().toLocaleLowerCase();
  if (key === 'patient_phone') return normalizePhone(quote) === normalizePhone(value);
  if (key === 'due_date') {
    const dates =
      quote.match(
        /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/g,
      ) ?? [];
    return dates.some((date) => normalizeDate(date) === normalizeDate(value));
  }
  if (key === 'action_type') {
    return value === 'ordered_test'
      ? /\b(order(?:ed)?|test|likha|likhi|likhe|karwana|test kar|test likha)\b/i.test(quote)
      : value === 'consultation' &&
          /\b(consult(?:ation)?|appointment|visit|check-up)\b/i.test(quote);
  }
  if (key === 'patient_ref' && !/\b(?:MRN|UHID|patient\s*(?:ref(?:erence)?|id))\b/i.test(quote))
    return false;
  return Boolean(v) && q.includes(v);
}

type ValidationMeta = IntakeProposal['meta'];
type ValidationResult = { ok: true; proposal: IntakeProposal } | { ok: false; reason: string };

export function validateIntake(args: {
  sourceText: string;
  raw: unknown;
  meta: ValidationMeta;
  now?: Date;
}): ValidationResult {
  const parsed = IntakeModelOutput.safeParse(args.raw);
  if (!parsed.success)
    return {
      ok: false,
      reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid response'}`,
    };

  const warnings = [...parsed.data.warnings];
  const accepted: IntakeField[] = [];
  const conflictKeys = new Set<IntakeFieldKey>();
  const datePattern =
    /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/g;
  const dates = [...args.sourceText.matchAll(datePattern)];
  const hasCompetingDueDates = dates.some((left, index) =>
    dates.slice(index + 1).some((right) => {
      const leftDate = normalizeDate(left[0]);
      const rightDate = normalizeDate(right[0]);
      const between = args.sourceText.slice((left.index ?? 0) + left[0].length, right.index ?? 0);
      const context = args.sourceText.slice(
        Math.max(0, (left.index ?? 0) - 50),
        (right.index ?? 0) + right[0].length,
      );
      return (
        leftDate &&
        rightDate &&
        leftDate !== rightDate &&
        between.length <= 80 &&
        /\b(?:or|alternatively|ya)\b/i.test(between) &&
        /\b(?:due|complete|by|date|tak|karwana)\b/i.test(context)
      );
    }),
  );
  if (hasCompetingDueDates) conflictKeys.add('due_date');
  if (/\b(?:Patient|Pt)\s*:?\s+[^,.;]+?\s+(?:or|\/|aka)\s+[^,.;]+/i.test(args.sourceText))
    conflictKeys.add('patient_name');
  for (const key of conflictKeys)
    warnings.push(`Conflicting ${key} values were found in the source and dropped.`);

  for (const field of parsed.data.fields) {
    if (conflictKeys.has(field.key)) continue;
    const span = spanFor(args.sourceText, field);
    if (!span) {
      warnings.push(
        `Dropped ${field.key}: source quote is absent, ambiguous, or has invalid offsets.`,
      );
      continue;
    }
    if (span.start !== field.sourceSpan.start || span.end !== field.sourceSpan.end) {
      warnings.push(
        `Repaired ${field.key} source offsets because its quote occurs uniquely in the note.`,
      );
    }

    let value = field.value.trim();
    if (field.key === 'action_type' && value !== 'consultation' && value !== 'ordered_test') {
      warnings.push('Dropped action_type: unsupported value.');
      continue;
    }
    if (field.key === 'action_name') value = canonicalActionName(value);
    if (field.key === 'ordering_clinician')
      value = canonicalClinician(value, field.sourceSpan.quote);
    if (!valueSupported(field.key, value, field.sourceSpan.quote)) {
      warnings.push(`Dropped ${field.key}: value is not supported by its source quote.`);
      continue;
    }

    if (field.key === 'patient_phone') {
      const normalized = normalizePhone(value);
      if (!normalized) {
        warnings.push('Dropped patient_phone: invalid Indian phone number.');
        continue;
      }
      value = normalized;
    }
    if (field.key === 'due_date') {
      const normalized = normalizeDate(value);
      if (!normalized) {
        warnings.push('Dropped due_date: invalid calendar date.');
        continue;
      }
      value = normalized;
      const today = (args.now ?? new Date()).toISOString().slice(0, 10);
      if (normalized < today) warnings.push('Due date is in the past; reviewer must confirm it.');
    }

    accepted.push({
      ...field,
      value,
      sourceSpan: { start: span.start, end: span.end, quote: field.sourceSpan.quote },
    });
  }

  const valuesByKey = new Map<IntakeFieldKey, Set<string>>();
  for (const field of accepted) {
    const values = valuesByKey.get(field.key) ?? new Set<string>();
    values.add(field.value.toLocaleLowerCase());
    valuesByKey.set(field.key, values);
  }
  const conflicts = new Set(
    [...valuesByKey].filter(([, values]) => values.size > 1).map(([key]) => key),
  );
  for (const key of conflicts) warnings.push(`Conflicting ${key} values were dropped.`);
  for (const key of conflicts) conflictKeys.add(key);
  const fields = accepted
    .filter((field) => !conflictKeys.has(field.key))
    .filter(
      (field, index, all) =>
        all.findIndex(
          (other) =>
            other.key === field.key &&
            other.value.toLocaleLowerCase() === field.value.toLocaleLowerCase(),
        ) === index,
    );

  const present = new Set(fields.map((field) => field.key));
  const missing = REQUIRED_FIELD_KEYS.filter((key) => !present.has(key));
  return {
    ok: true,
    proposal: { fields, missing, warnings, duplicateFingerprint: null, meta: args.meta },
  };
}
