import { cx } from './ui';

/** Status is always text + icon, never color alone (MVP spec §05). */
const WORKFLOW: Record<string, { label: string; icon: string; tone: Tone }> = {
  DRAFT: { label: 'Needs approval', icon: '◔', tone: 'warn' },
  READY: { label: 'Approved', icon: '◑', tone: 'info' },
  CONTACTING: { label: 'Contacting', icon: '☏', tone: 'info' },
  AWAITING_BOOKING: { label: 'Booking requested', icon: '⧗', tone: 'info' },
  BOOKED: { label: 'Booked · awaiting proof', icon: '▣', tone: 'info' },
  AWAITING_EVIDENCE: { label: 'Awaiting proof', icon: '⧗', tone: 'warn' },
  COMPLETED_VERIFIED: { label: 'Completed · verified', icon: '✓', tone: 'ok' },
  CANCELLED: { label: 'Cancelled', icon: '⊘', tone: 'muted' },
};

const PAUSE: Record<string, string> = {
  REVIEW_REQUIRED: 'Paused: needs review',
  CONSENT: 'Paused: no contact permission',
  LANGUAGE: 'Paused: language',
  BUDGET: 'Paused: contact budget used',
  HANDOFF: 'Paused: with staff',
  INTEGRATION: 'Paused: booking outcome unknown',
  SITE_PAUSED: 'Paused: site outreach off',
};

type Tone = 'ok' | 'warn' | 'info' | 'muted' | 'error';

function Pill({ tone, icon, children }: { tone: Tone; icon: string; children: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        tone === 'ok' && 'border-[var(--ok-line)] bg-[var(--ok-bg)]',
        tone === 'warn' && 'border-[var(--warn-line)] bg-[var(--warn-bg)]',
        tone === 'error' && 'border-[var(--err-line)] bg-[var(--err-bg)]',
        tone === 'info' && 'border-[var(--line)] bg-[var(--surface-2)]',
        tone === 'muted' && 'border-[var(--line)] text-[var(--muted)]',
      )}
    >
      <span aria-hidden>{icon}</span>
      {children}
    </span>
  );
}

export function WorkflowStatus({ state }: { state: string }) {
  const s = WORKFLOW[state] ?? { label: state, icon: '•', tone: 'muted' as Tone };
  return (
    <Pill tone={s.tone} icon={s.icon}>
      {s.label}
    </Pill>
  );
}

export function PausedBadge({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <Pill tone="muted" icon="⏸">
      {PAUSE[reason] ?? `Paused: ${reason}`}
    </Pill>
  );
}

export function HandoffBadge({ state }: { state: string }) {
  if (state === 'PENDING')
    return (
      <Pill tone="warn" icon="⚑">
        Handoff pending
      </Pill>
    );
  if (state === 'ACKNOWLEDGED')
    return (
      <Pill tone="info" icon="⚑">
        Handoff acknowledged
      </Pill>
    );
  return null;
}

export function OverdueBadge() {
  return (
    <Pill tone="error" icon="!">
      Past due date
    </Pill>
  );
}
