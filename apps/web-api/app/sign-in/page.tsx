'use client';
import {
  getMultiFactorResolver,
  signInWithEmailAndPassword,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
} from 'firebase/auth';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Button, Field, inputClass, Notice } from '@/components/ui';
import { clientAuth } from '@/lib/firebase-client';

function SignInForm() {
  const { status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/overview';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    if (status === 'ready') router.replace(safeNext);
  }, [status, router, safeNext]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (resolver) {
        const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
        if (!hint) throw new Error('no totp');
        await resolver.resolveSignIn(
          TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.trim()),
        );
      } else {
        await signInWithEmailAndPassword(clientAuth(), email.trim(), password);
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/multi-factor-auth-required') {
        setResolver(getMultiFactorResolver(clientAuth(), err as MultiFactorError));
      } else {
        setError(resolver ? 'That code did not match.' : 'Email or password is incorrect.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto mt-16 max-w-sm px-4">
      <h1 className="text-xl font-semibold">CareLoop</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">Staff sign-in. Invite-only.</p>
      <form
        onSubmit={submit}
        className="mt-6 space-y-4 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-5"
      >
        <Field label="Work email">
          <input
            className={inputClass}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {resolver && (
          <Field label="Code from your authenticator app">
            <input
              className={inputClass}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {status === 'no-access' && (
          <Notice tone="error">This account isn't an active member of a lab.</Notice>
        )}
        <Button variant="primary" type="submit" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
