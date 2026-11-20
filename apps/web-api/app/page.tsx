const NAV = [
  'Overview',
  'Cases',
  'Intake review',
  'Bookings',
  'Human queue',
  'Reports',
  'Settings',
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="flex items-center justify-between border-b border-[var(--line)] pb-4">
        <h1 className="text-lg font-semibold">CareLoop</h1>
        <span className="rounded border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--muted)]">
          Synthetic demo data
        </span>
      </header>
      <nav className="mt-4 flex flex-wrap gap-4 text-sm text-[var(--muted)]">
        {NAV.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </nav>
      <section className="mt-10 text-sm text-[var(--muted)]">
        <p>Phase 0 scaffold. The staff work queue arrives in Phase 2.</p>
        <p className="mt-2">A booking is not proof of completion.</p>
      </section>
    </main>
  );
}
