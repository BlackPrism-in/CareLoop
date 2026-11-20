'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from './api';

/**
 * Loads data, optionally polling (case detail polls every 5 s per MVP spec §20).
 * On failure it keeps the last good data and reports the error; it never
 * substitutes zeros.
 */
export function useData<T>(
  load: () => Promise<T>,
  deps: unknown[],
  opts: { pollMs?: number } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      const d = await loadRef.current();
      setData(d);
      setError(null);
      setUpdatedAt(
        new Date().toLocaleTimeString('en-IN', {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    if (!opts.pollMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, opts.pollMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, updatedAt, refresh, setData };
}
