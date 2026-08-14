import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type User } from '../lib/api';
import { closeSocket } from '../lib/socket';

/* ---------------------------------------------------------------- */
/* Theme                                                             */
/* ---------------------------------------------------------------- */

export type ThemeName = 'dark' | 'midnight' | 'light';
export type Density = 'compact' | 'cosy' | 'roomy';

export interface Appearance {
  theme: ThemeName;
  accent: string;
  density: Density;
  chatSide: 'right' | 'left';
}

export const ACCENTS = [
  '#7c5cff', '#4f8cff', '#17c1c4', '#3ecf8e',
  '#f5b544', '#fb7185', '#f472b6', '#a855f7',
  '#ef4444', '#64748b',
];

const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark',
  accent: '#7c5cff',
  density: 'cosy',
  chatSide: 'right',
};

function readStoredAppearance(): Appearance {
  try {
    const raw = localStorage.getItem('wwf.appearance');
    if (!raw) return DEFAULT_APPEARANCE;
    return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<Appearance>) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  root.dataset.density = a.density;
  root.style.setProperty('--accent', a.accent);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', a.theme === 'light' ? '#f4f5f9' : a.theme === 'midnight' ? '#000000' : '#0c0d12');
}

/* ---------------------------------------------------------------- */
/* Toasts                                                            */
/* ---------------------------------------------------------------- */

export interface Toast {
  id: number;
  message: string;
  type: 'info' | 'error' | 'success';
}

/* ---------------------------------------------------------------- */
/* Context                                                           */
/* ---------------------------------------------------------------- */

interface AppContextValue {
  user: User | null;
  loading: boolean;
  registrationOpen: boolean;
  siteName: string;
  setUser: (user: User | null) => void;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;

  appearance: Appearance;
  setAppearance: (patch: Partial<Appearance>) => void;

  toasts: Toast[];
  toast: (message: string, type?: Toast['type']) => void;
  dismissToast: (id: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [siteName, setSiteName] = useState('Watch With Friends');
  const [appearance, setAppearanceState] = useState<Appearance>(readStoredAppearance);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const syncedFromServer = useRef(false);

  useEffect(() => {
    applyAppearance(appearance);
    localStorage.setItem('wwf.appearance', JSON.stringify(appearance));
  }, [appearance]);

  const setAppearance = useCallback((patch: Partial<Appearance>) => {
    setAppearanceState((prev) => {
      const next = { ...prev, ...patch };
      // Persist to the account so the look follows you between devices.
      api.patch('/auth/me', { prefs: { appearance: next } }).catch(() => undefined);
      return next;
    });
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const data = await api.get<{ user: User | null; registrationOpen: boolean }>('/auth/me');
      setUser(data.user);
      setRegistrationOpen(data.registrationOpen);
      const stored = data.user?.prefs?.appearance as Partial<Appearance> | undefined;
      if (stored && !syncedFromServer.current) {
        syncedFromServer.current = true;
        setAppearanceState((prev) => ({ ...prev, ...stored }));
      }
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshUser();
      try {
        const cfg = await api.get<{ siteName: string }>('/config');
        if (cfg.siteName) setSiteName(cfg.siteName);
      } catch {
        /* keep the default name */
      }
      setLoading(false);
    })();
  }, [refreshUser]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    // The socket authenticated with the old cookie; drop it so the next sign-in
    // does not inherit the previous identity.
    closeSocket();
    syncedFromServer.current = false;
    setUser(null);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: Toast['type'] = 'info') => {
      const id = ++toastId.current;
      setToasts((prev) => [...prev.slice(-3), { id, message, type }]);
      setTimeout(() => dismissToast(id), type === 'error' ? 6000 : 3800);
    },
    [dismissToast]
  );

  const value = useMemo<AppContextValue>(
    () => ({
      user,
      loading,
      registrationOpen,
      siteName,
      setUser,
      refreshUser,
      logout,
      appearance,
      setAppearance,
      toasts,
      toast,
      dismissToast,
    }),
    [user, loading, registrationOpen, siteName, refreshUser, logout, appearance, setAppearance, toasts, toast, dismissToast]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
