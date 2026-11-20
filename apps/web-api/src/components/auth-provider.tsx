'use client';
import { onIdTokenChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { clientAuth } from '@/lib/firebase-client';

export interface Me {
  uid: string;
  displayName: string;
  roles: string[];
  tenant: { tenantId: string; displayName: string; simulation: boolean } | null;
}

interface AuthState {
  user: User | null;
  me: Me | null;
  status: 'loading' | 'signed-out' | 'ready' | 'no-access' | 'mfa-enroll';
  signOut: () => Promise<void>;
  hasRole: (...roles: string[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');

  useEffect(
    () =>
      onIdTokenChanged(clientAuth(), async (u) => {
        setUser(u);
        if (!u) {
          setMe(null);
          setStatus('signed-out');
          return;
        }
        try {
          setMe(await api<Me>('/v1/me'));
          setStatus('ready');
        } catch (e) {
          setMe(null);
          setStatus(
            e instanceof ApiError && (e.status === 403 || e.status === 401)
              ? 'no-access'
              : 'signed-out',
          );
        }
      }),
    [],
  );

  const signOut = useCallback(async () => {
    await fbSignOut(clientAuth());
  }, []);
  const hasRole = useCallback(
    (...roles: string[]) => !!me && me.roles.some((r) => roles.includes(r)),
    [me],
  );

  return <Ctx.Provider value={{ user, me, status, signOut, hasRole }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Redirects to sign-in when there is no session. */
export function useRequireStaff(): AuthState {
  const auth = useAuth();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (auth.status === 'signed-out') router.replace(`/sign-in?next=${encodeURIComponent(path)}`);
  }, [auth.status, router, path]);
  return auth;
}
