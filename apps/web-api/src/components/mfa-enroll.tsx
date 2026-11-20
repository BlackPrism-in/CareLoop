'use client';
import { multiFactor, TotpMultiFactorGenerator, type TotpSecret } from 'firebase/auth';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Button, Field, inputClass, Notice } from './ui';

/**
 * Pilot requirement: every staff member signs in with an authenticator app
 * (TOTP). Shown when the API answers MFA_REQUIRED. After enrolling, staff sign
 * in again so the new session carries the second factor.
 */
export function MfaEnroll() {
  const { user, signOut } = useAuth();
  const [secret, setSecret] = useState<TotpSecret | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      setSecret(
        await TotpMultiFactorGenerator.generateSecret(await multiFactor(user).getSession()),
      );
    } catch (e) {
      const c = (e as { code?: string }).code;
      setError(
        c === 'auth/requires-recent-login'
          ? 'For security, sign out and sign in again, then set this up.'
          : 'Two-step sign-in is not available for this project yet. Ask the CareLoop operator.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!user || !secret) return;
    setBusy(true);
    setError(null);
    try {
      await multiFactor(user).enroll(
        TotpMultiFactorGenerator.assertionForEnrollment(secret, code.trim()),
        'Authenticator app',
      );
      setDone(true);
    } catch {
      setError('That code did not match. Check the time on your phone and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-12 max-w-md space-y-4 px-4">
      <h1 className="text-lg font-semibold">Set up two-step sign-in</h1>
      <p className="text-sm text-[var(--muted)]">
        CareLoop handles patient contact details, so every staff account needs an authenticator app
        (Google Authenticator, Microsoft Authenticator or similar).
      </p>
      {done ? (
        <>
          <Notice tone="ok">Done. Sign in again with your password and a code from the app.</Notice>
          <Button variant="primary" onClick={signOut}>
            Sign in again
          </Button>
        </>
      ) : !secret ? (
        <Button variant="primary" disabled={busy} onClick={start}>
          Start
        </Button>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            In your authenticator app, add an account using this key, or open{' '}
            <a
              className="text-[var(--accent)] underline"
              href={secret.generateQrCodeUrl(user?.email ?? 'staff', 'CareLoop')}
            >
              this setup link
            </a>{' '}
            on your phone:
          </p>
          <p className="break-all rounded-md border border-[var(--line)] bg-[var(--surface-2)] p-2 font-mono">
            {secret.secretKey}
          </p>
          <Field label="6-digit code from the app">
            <input
              className={inputClass}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Button variant="primary" disabled={busy || code.length !== 6} onClick={confirm}>
            Confirm
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {!done && (
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      )}
    </div>
  );
}
