'use client';
import { use, useEffect, useState, type FormEvent } from 'react';

interface View {
  labName: string;
  siteName: string | null;
  timeZone: string;
  followUp: 'CONSULTATION' | 'ORDERED_TEST';
  dueAt: string;
  status: 'NOT_BOOKED' | 'REQUEST_RECEIVED' | 'BOOKED' | 'DONE' | 'CLOSED';
  appointment: { startsAt: string | null; location: string | null } | null;
  labWillCall: boolean;
  automatedContact: boolean;
  simulation: boolean;
  language?: 'hi-IN' | 'en-IN' | 'bn-IN';
}

// [English, Hindi, Bengali]. Each line shows English plus the patient's language.
const T = {
  title: ['Your follow-up', 'आपका फ़ॉलो-अप', 'আপনার ফলো-আপ'],
  code: [
    'Enter the 6-digit code the lab sent you',
    'लैब द्वारा भेजा गया 6 अंकों का कोड डालें',
    'ল্যাব থেকে পাঠানো ৬ সংখ্যার কোডটি লিখুন',
  ],
  go: ['Continue', 'आगे बढ़ें', 'এগিয়ে যান'],
  consult: ['Clinic consultation', 'क्लिनिक में परामर्श', 'ক্লিনিকে পরামর্শ'],
  test: [
    'A test your doctor has already ordered',
    'डॉक्टर द्वारा पहले से बताया गया टेस्ट',
    'আপনার ডাক্তার আগেই যে পরীক্ষা লিখে দিয়েছেন',
  ],
  change: ['Ask for a different time', 'दूसरा समय माँगें', 'অন্য সময় চান'],
  call: ['Ask the lab to call me', 'लैब मुझे कॉल करे', 'ল্যাব আমাকে ফোন করুক'],
  stop: [
    'Stop automated calls and messages',
    'स्वचालित कॉल और संदेश बंद करें',
    'স্বয়ংক্রিয় কল ও বার্তা বন্ধ করুন',
  ],
  noMedical: [
    'This page has no medical details. For medical questions, please speak to your doctor or the lab.',
    'इस पेज पर कोई मेडिकल जानकारी नहीं है। मेडिकल सवालों के लिए अपने डॉक्टर या लैब से बात करें।',
    'এই পাতায় কোনো চিকিৎসা-সংক্রান্ত তথ্য নেই। চিকিৎসা নিয়ে প্রশ্ন থাকলে আপনার ডাক্তার বা ল্যাবের সঙ্গে কথা বলুন।',
  ],
} as const;

function L({ t, s }: { t: readonly [string, string, string]; s: 'hi' | 'bn' }) {
  return (
    <>
      {t[0]}
      <span className="block text-sm font-normal opacity-75" lang={s}>
        {s === 'bn' ? t[2] : t[1]}
      </span>
    </>
  );
}

/**
 * Minimal patient action page (MVP spec §03, §07). The link alone shows
 * nothing; the one-time code opens a 15-minute session. No account, no name,
 * no report content.
 */
export default function PatientPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [view, setView] = useState<View | null>(null);
  const [phase, setPhase] = useState<'loading' | 'code' | 'view'>('loading');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const second = view?.language === 'bn-IN' ? 'bn' : 'hi';

  async function load() {
    const r = await fetch('/v1/p/me', { cache: 'no-store' });
    if (r.ok) {
      setView(await r.json());
      setPhase('view');
    } else setPhase('code');
  }
  useEffect(() => {
    void load();
  }, []);

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await fetch('/v1/p/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, code }),
    });
    setBusy(false);
    if (r.ok) return load();
    const j = await r.json().catch(() => ({}));
    setMsg({ tone: 'error', text: j.message ?? 'That did not work. Please call the lab.' });
  }

  async function act(action: 'REQUEST_CHANGE' | 'REQUEST_CALLBACK' | 'STOP_CONTACT') {
    setBusy(true);
    setMsg(null);
    const r = await fetch('/v1/p/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    setConfirmStop(false);
    if (r.status === 401) return setPhase('code');
    if (!r.ok)
      return setMsg({
        tone: 'error',
        text: 'Something went wrong. Please call the lab. / कुछ गड़बड़ हुई, कृपया लैब को कॉल करें।',
      });
    setMsg({
      tone: 'ok',
      text:
        action === 'STOP_CONTACT'
          ? 'Done. We will not call or message you automatically again. / हो गया। अब आपको स्वचालित कॉल या संदेश नहीं आएँगे।'
          : 'Thank you. Someone from the lab will call you. Your current appointment is not cancelled. / धन्यवाद। लैब से कोई आपको कॉल करेगा। आपकी मौजूदा अपॉइंटमेंट रद्द नहीं हुई है।',
    });
    void load();
  }

  const big =
    'block w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-left text-base font-medium hover:bg-[var(--surface-2)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--accent)]';
  const when = (iso: string | null, tz: string) =>
    iso
      ? new Intl.DateTimeFormat('en-IN', {
          timeZone: tz,
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          hour: 'numeric',
          minute: '2-digit',
        }).format(new Date(iso))
      : '';

  return (
    <main className="mx-auto max-w-md space-y-5 px-4 py-8 text-base">
      <h1 className="text-xl font-semibold">
        <L s={second} t={T.title} />
      </h1>
      {phase === 'loading' && <p className="text-[var(--muted)]">…</p>}

      {phase === 'code' && (
        <form onSubmit={submitCode} className="space-y-3">
          <label className="block font-medium" htmlFor="code">
            <L s={second} t={T.code} />
          </label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-4 py-3 text-center font-mono text-2xl tracking-[0.5em]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className={`${big} bg-[var(--accent)] text-center text-[var(--on-accent)] hover:bg-[var(--accent-strong)]`}
          >
            <L s={second} t={T.go} />
          </button>
        </form>
      )}

      {phase === 'view' && view && (
        <div className="space-y-4">
          {view.simulation && (
            <p className="rounded border border-dashed border-[var(--line)] px-2 py-1 text-xs uppercase tracking-wide text-[var(--muted)]">
              Demo — synthetic data
            </p>
          )}
          <div className="rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
            <p className="text-sm text-[var(--muted)]">{view.labName}</p>
            <p className="mt-1 text-lg font-semibold">
              <L s={second} t={view.followUp === 'ORDERED_TEST' ? T.test : T.consult} />
            </p>
            <div className="mt-3">
              {view.status === 'BOOKED' && view.appointment && (
                <p>
                  <strong>{when(view.appointment.startsAt, view.timeZone)}</strong>
                  <br />
                  {view.appointment.location}
                </p>
              )}
              {view.status === 'REQUEST_RECEIVED' && (
                <p>
                  Your request is with the lab. They will confirm the time. / आपका अनुरोध लैब को मिल
                  गया है।
                </p>
              )}
              {view.status === 'NOT_BOOKED' && <p>Not booked yet. / अभी बुक नहीं हुआ है।</p>}
              {view.status === 'DONE' && <p>Completed. Thank you. / पूरा हो गया। धन्यवाद।</p>}
              {view.status === 'CLOSED' && <p>This follow-up is closed. / यह फ़ॉलो-अप बंद है।</p>}
              {view.labWillCall && (
                <p className="mt-2 text-sm">The lab will call you. / लैब आपको कॉल करेगी।</p>
              )}
            </div>
          </div>

          {['NOT_BOOKED', 'REQUEST_RECEIVED', 'BOOKED'].includes(view.status) && (
            <div className="space-y-3">
              <button className={big} disabled={busy} onClick={() => act('REQUEST_CHANGE')}>
                <L s={second} t={T.change} />
              </button>
              <button className={big} disabled={busy} onClick={() => act('REQUEST_CALLBACK')}>
                <L s={second} t={T.call} />
              </button>
              {view.automatedContact &&
                (!confirmStop ? (
                  <button className={big} disabled={busy} onClick={() => setConfirmStop(true)}>
                    <L s={second} t={T.stop} />
                  </button>
                ) : (
                  <div className="space-y-2 rounded-lg border border-[var(--warn-line)] bg-[var(--warn-bg)] p-3">
                    <p>
                      Stop all automated calls and messages from the lab? You can still call them. /
                      क्या सभी स्वचालित कॉल और संदेश बंद करें?
                    </p>
                    <div className="flex gap-2">
                      <button className={big} disabled={busy} onClick={() => act('STOP_CONTACT')}>
                        Yes, stop / हाँ, बंद करें
                      </button>
                      <button className={big} onClick={() => setConfirmStop(false)}>
                        No / नहीं
                      </button>
                    </div>
                  </div>
                ))}
              {!view.automatedContact && (
                <p className="text-sm text-[var(--muted)]">
                  Automated calls and messages are off. / स्वचालित कॉल और संदेश बंद हैं।
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {msg && (
        <p
          role={msg.tone === 'error' ? 'alert' : 'status'}
          className={`rounded-lg border p-3 ${msg.tone === 'error' ? 'border-[var(--err-line)] bg-[var(--err-bg)]' : 'border-[var(--ok-line)] bg-[var(--ok-bg)]'}`}
        >
          {msg.text}
        </p>
      )}
      <p className="text-sm text-[var(--muted)]">
        <L s={second} t={T.noMedical} />
      </p>
    </main>
  );
}
