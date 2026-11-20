/**
 * Whether `now` falls inside a site's local contact window ("HH:MM"–"HH:MM",
 * end exclusive). Uses the site's IANA timezone, so quiet hours are local.
 */
export function withinContactWindow(
  now: Date,
  window: { start: string; end: string },
  timeZone: string,
): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const local = `${hh}:${mm}`;
  return window.start <= window.end
    ? local >= window.start && local < window.end
    : local >= window.start || local < window.end; // window crossing midnight
}
