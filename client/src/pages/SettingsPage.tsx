import { useEffect, useState } from 'react';
import { api, type StorageStats, type User } from '../lib/api';
import { ACCENTS, useApp, type Density, type ThemeName } from '../state/AppState';
import { Avatar, Field, Icon, Meter } from '../components/ui';
import { formatBytes } from '../lib/format';

const THEMES: Array<{ id: ThemeName; label: string; colors: [string, string, string] }> = [
  { id: 'dark', label: 'Dark', colors: ['#0c0d12', '#171a24', '#e8eaf2'] },
  { id: 'midnight', label: 'Midnight', colors: ['#000000', '#0c0d11', '#eceef5'] },
  { id: 'light', label: 'Light', colors: ['#f4f5f9', '#ffffff', '#171923'] },
];

const DENSITIES: Array<{ id: Density; label: string }> = [
  { id: 'compact', label: 'Compact' },
  { id: 'cosy', label: 'Cosy' },
  { id: 'roomy', label: 'Roomy' },
];

export function SettingsPage() {
  const { user, setUser, appearance, setAppearance, toast } = useApp();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [avatarColor, setAvatarColor] = useState(user?.avatarColor ?? ACCENTS[0]);
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [storage, setStorage] = useState<StorageStats | null>(null);

  useEffect(() => {
    api.get<StorageStats>('/uploads/stats').then(setStorage).catch(() => undefined);
  }, []);

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const res = await api.patch<{ user: User }>('/auth/me', { displayName, avatarColor });
      setUser(res.user);
      toast('Profile saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async () => {
    if (newPassword !== confirmPassword) {
      toast('The new passwords do not match', 'error');
      return;
    }
    setSavingPassword(true);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('Password changed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the password', 'error');
    } finally {
      setSavingPassword(false);
    }
  };

  if (!user) return null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Your profile and how the app looks.</div>
        </div>
      </div>

      {/* ---- appearance ---- */}
      <section className="panel">
        <h2>Appearance</h2>

        <Field label="Theme">
          <div className="theme-options">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className="theme-option"
                data-active={appearance.theme === t.id}
                onClick={() => setAppearance({ theme: t.id })}
              >
                <span className="theme-preview">
                  <i style={{ background: t.colors[0], width: '45%' }} />
                  <i style={{ background: t.colors[1], width: '35%' }} />
                  <i style={{ background: appearance.accent, width: '20%' }} />
                </span>
                {t.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Accent colour">
          <div className="swatches">
            {ACCENTS.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c }}
                data-active={appearance.accent.toLowerCase() === c.toLowerCase()}
                onClick={() => setAppearance({ accent: c })}
                aria-label={`Accent ${c}`}
              />
            ))}
            <label
              className="swatch center"
              style={{
                background: 'var(--surface-3)',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--text-dim)',
              }}
              title="Custom colour"
            >
              +
              <input
                type="color"
                value={appearance.accent}
                onChange={(e) => setAppearance({ accent: e.target.value })}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
            </label>
          </div>
        </Field>

        <Field label="Density">
          <div className="row" style={{ gap: 8 }}>
            {DENSITIES.map((d) => (
              <button
                key={d.id}
                className={`btn sm${appearance.density === d.id ? ' primary' : ''}`}
                onClick={() => setAppearance({ density: d.id })}
              >
                {d.label}
              </button>
            ))}
          </div>
        </Field>
      </section>

      {/* ---- profile ---- */}
      <section className="panel">
        <h2>Profile</h2>
        <div className="row" style={{ gap: 14 }}>
          <Avatar name={displayName || user.username} color={avatarColor} size="lg" />
          <div className="grow col" style={{ gap: 10 }}>
            <Field label="Display name">
              <input
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={32}
              />
            </Field>
            <Field label="Avatar colour">
              <div className="swatches">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    className="swatch"
                    style={{ background: c }}
                    data-active={avatarColor.toLowerCase() === c.toLowerCase()}
                    onClick={() => setAvatarColor(c)}
                    aria-label={`Avatar colour ${c}`}
                  />
                ))}
              </div>
            </Field>
          </div>
        </div>
        <div className="row between">
          <span className="tiny faint">
            Signed in as @{user.username}
            {user.isAdmin ? ' · administrator' : ''}
          </span>
          <button className="btn primary" onClick={saveProfile} disabled={savingProfile || !displayName.trim()}>
            {savingProfile ? <span className="spinner" /> : 'Save profile'}
          </button>
        </div>
      </section>

      {/* ---- storage ---- */}
      {storage && storage.enabled && (
        <section className="panel">
          <h2>Your uploads</h2>
          <div className="row between small">
            <span className="muted">
              {formatBytes(storage.userUsed)} used of {formatBytes(storage.userLimit)}
            </span>
            <span className="faint tiny">max {formatBytes(storage.maxFileSize)} per file</span>
          </div>
          <Meter used={storage.userUsed} total={storage.userLimit} />
          <p className="tiny faint">
            Manage individual files from a room: Add media → Upload. Ask an admin if you need more space.
          </p>
        </section>
      )}

      {/* ---- password ---- */}
      <section className="panel">
        <h2>Change password</h2>
        <Field label="Current password">
          <input
            className="input"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div className="grow">
            <Field label="New password" hint="At least 8 characters">
              <input
                className="input"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div className="grow">
            <Field label="Repeat new password">
              <input
                className="input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="btn primary"
            onClick={changePassword}
            disabled={savingPassword || !currentPassword || newPassword.length < 8}
          >
            {savingPassword ? <span className="spinner" /> : 'Change password'}
          </button>
        </div>
      </section>

      {/* ---- shortcuts ---- */}
      <section className="panel">
        <h2>Keyboard shortcuts</h2>
        <div className="stat-grid">
          {[
            ['Space / K', 'Play or pause'],
            ['← / →', 'Skip 5 seconds'],
            ['Shift + ← / →', 'Skip 30 seconds'],
            ['N', 'Next in queue'],
            ['M', 'Mute'],
            ['F', 'Fullscreen'],
            ['T', 'Theater mode'],
          ].map(([key, what]) => (
            <div className="row between" key={key} style={{ gap: 8 }}>
              <span className="code-chip" style={{ fontSize: '0.74rem' }}>{key}</span>
              <span className="tiny muted">{what}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
