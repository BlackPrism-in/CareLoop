export const SITE_TZ = 'Asia/Kolkata';

export function formatDateTime(iso: string | null | undefined, tz = SITE_TZ): string {
  if (!iso) return '—';
  return (
    new Intl.DateTimeFormat('en-IN', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso)) + ' IST'
  );
}

export function formatDate(iso: string | null | undefined, tz = SITE_TZ): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short' }).format(
    new Date(iso),
  );
}

export function isOverdue(dueAt: string, workflowState: string): boolean {
  return (
    Date.parse(dueAt) < Date.now() && !['COMPLETED_VERIFIED', 'CANCELLED'].includes(workflowState)
  );
}

/** datetime-local value (site time) → ISO UTC. */
export function localInputToIso(value: string): string {
  // Site timezone is IST (UTC+05:30, no DST) for the MVP.
  return new Date(`${value}:00+05:30`).toISOString();
}

export function isoToLocalInput(iso: string): string {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  return d.toISOString().slice(0, 16);
}

export const ACTION_LABEL: Record<string, string> = {
  CONSULTATION: 'Consultation',
  ORDERED_TEST: 'Ordered test',
};
