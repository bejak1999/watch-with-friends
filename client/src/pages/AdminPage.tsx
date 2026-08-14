import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../state/AppState';
import { Avatar, CopyButton, Field, Icon, Meter, Modal, Spinner, Toggle } from '../components/ui';
import { AvatarPicker } from '../components/AvatarPicker';
import { formatBytes, relativeTime } from '../lib/format';

type Tab = 'overview' | 'codes' | 'users' | 'settings';

interface InviteCode {
  code: string;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number;
  uses: number;
  note: string | null;
  revoked: boolean;
  grantsAdmin: boolean;
  creator: string | null;
  redeemedBy: string | null;
}

interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isDisabled: boolean;
  avatarColor: string;
  avatarUrl: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  storageUsed: number;
  quotaBytes: number | null;
  roomsOwned: number;
}

const GB = 1024 * 1024 * 1024;

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <div className="sub">Registration codes, accounts, storage and integrations.</div>
        </div>
      </div>

      <div className="tabs" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', maxWidth: 520 }}>
        {(['overview', 'codes', 'users', 'settings'] as Tab[]).map((t) => (
          <button key={t} className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : t === 'codes' ? 'Codes' : t === 'users' ? 'Users' : 'Settings'}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'codes' && <CodesTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Overview                                                          */
/* ---------------------------------------------------------------- */

function OverviewTab() {
  const { toast } = useApp();
  const [data, setData] = useState<any>(null);

  const load = useCallback(() => {
    api.get('/admin/overview').then(setData).catch(() => setData({ counts: {}, rooms: [] }));
  }, []);

  useEffect(load, [load]);

  if (!data) return <Spinner />;

  const c = data.counts ?? {};
  const storage = data.storage;

  const deleteRoom = async (id: string, name: string) => {
    if (!confirm(`Delete the room "${name}"?`)) return;
    await api.del(`/admin/rooms/${id}`);
    toast('Room deleted', 'success');
    load();
  };

  return (
    <>
      <div className="stat-grid">
        {[
          ['Users', c.users],
          ['Rooms', c.rooms],
          ['Playlists', c.playlists],
          ['Queued items', c.queueItems],
          ['Chat messages', c.messages],
          ['Uploaded files', c.uploads],
          ['Active codes', c.activeCodes],
        ].map(([label, value]) => (
          <div className="stat" key={String(label)}>
            <div className="value">{value ?? 0}</div>
            <div className="label">{label}</div>
          </div>
        ))}
      </div>

      {storage && (
        <section className="panel">
          <h2>Upload storage</h2>
          <div className="row between small">
            <span className="muted">
              {formatBytes(storage.globalUsed)} used of {formatBytes(storage.globalLimit)} server-wide
            </span>
            <span className="faint tiny">
              {storage.globalLimit > 0
                ? `${Math.round((storage.globalUsed / storage.globalLimit) * 100)}%`
                : 'no limit set'}
            </span>
          </div>
          <Meter used={storage.globalUsed} total={storage.globalLimit} />
        </section>
      )}

      <section className="panel">
        <h2>Rooms</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Owner</th>
                <th>Members</th>
                <th>Visibility</th>
                <th>Last active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data.rooms ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 550 }}>{r.name}</td>
                  <td className="muted">{r.owner ?? '—'}</td>
                  <td>{r.members}</td>
                  <td>
                    <span className="tag">{r.is_public ? 'public' : 'invite only'}</span>
                  </td>
                  <td className="faint tiny">{relativeTime(r.updated_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn ghost icon sm danger" onClick={() => deleteRoom(r.id, r.name)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {(data.rooms ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="faint small" style={{ textAlign: 'center', padding: 20 }}>
                    No rooms yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Codes                                                             */
/* ---------------------------------------------------------------- */

function CodesTab() {
  const { toast } = useApp();
  const [codes, setCodes] = useState<InviteCode[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [fresh, setFresh] = useState<string[] | null>(null);

  const load = useCallback(() => {
    api.get<{ codes: InviteCode[] }>('/admin/codes').then((r) => setCodes(r.codes)).catch(() => setCodes([]));
  }, []);

  useEffect(load, [load]);

  const revoke = async (code: string) => {
    await api.post(`/admin/codes/${code}/revoke`);
    toast('Code revoked', 'success');
    load();
  };

  const remove = async (code: string) => {
    await api.del(`/admin/codes/${code}`);
    load();
  };

  const registerUrl = (code: string) => `${window.location.origin}/register?code=${code}`;

  return (
    <>
      <section className="panel">
        <div className="row between">
          <div>
            <h2>Registration codes</h2>
            <p className="tiny faint">
              Send a code to a friend. They pick their own username and password at sign-up.
            </p>
          </div>
          <button className="btn primary" onClick={() => setGenerating(true)}>
            <Icon name="plus" size={16} /> Generate codes
          </button>
        </div>

        {fresh && (
          <div className="form-ok col" style={{ gap: 8 }}>
            <div style={{ fontWeight: 600 }}>
              {fresh.length} new code{fresh.length === 1 ? '' : 's'} — copy them now, they are listed below too.
            </div>
            {fresh.map((code) => (
              <div className="row between" key={code} style={{ gap: 8 }}>
                <span className="code-chip">{code}</span>
                <div className="row" style={{ gap: 6 }}>
                  <CopyButton value={code} label="Code" />
                  <CopyButton value={registerUrl(code)} label="Sign-up link" />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {codes === null ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Status</th>
                <th>Uses</th>
                <th>Note</th>
                <th>Used by</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => {
                const expired = c.expiresAt != null && c.expiresAt < Date.now();
                const exhausted = c.maxUses > 0 && c.uses >= c.maxUses;
                const dead = c.revoked || expired || exhausted;
                return (
                  <tr key={c.code}>
                    <td>
                      <span className="code-chip" style={{ opacity: dead ? 0.5 : 1 }}>
                        {formatCode(c.code)}
                      </span>
                    </td>
                    <td>
                      {c.revoked ? (
                        <span className="tag">revoked</span>
                      ) : expired ? (
                        <span className="tag">expired</span>
                      ) : exhausted ? (
                        <span className="tag">used up</span>
                      ) : (
                        <span className="tag ok">active</span>
                      )}
                      {c.grantsAdmin && <span className="tag accent" style={{ marginLeft: 4 }}>admin</span>}
                    </td>
                    <td className="mono tiny">
                      {c.uses}/{c.maxUses === 0 ? '∞' : c.maxUses}
                    </td>
                    <td className="muted small">{c.note || '—'}</td>
                    <td className="muted small">{c.redeemedBy || '—'}</td>
                    <td className="faint tiny">{relativeTime(c.createdAt)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {!dead && <CopyButton value={registerUrl(formatCode(c.code))} label="Link" />}
                      {!c.revoked && (
                        <button className="btn ghost sm" onClick={() => revoke(c.code)} title="Revoke">
                          Revoke
                        </button>
                      )}
                      <button className="btn ghost icon sm danger" onClick={() => remove(c.code)} title="Delete">
                        <Icon name="trash" size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {codes.length === 0 && (
                <tr>
                  <td colSpan={7} className="faint small" style={{ textAlign: 'center', padding: 20 }}>
                    No codes yet — generate one to invite your first friend.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {generating && (
        <GenerateCodesModal
          onClose={() => setGenerating(false)}
          onDone={(created) => {
            setFresh(created);
            setGenerating(false);
            load();
          }}
        />
      )}
    </>
  );
}

function formatCode(raw: string): string {
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

function GenerateCodesModal({ onClose, onDone }: { onClose: () => void; onDone: (codes: string[]) => void }) {
  const { toast } = useApp();
  const [count, setCount] = useState(1);
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [note, setNote] = useState('');
  const [grantsAdmin, setGrantsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ codes: string[] }>('/admin/codes', {
        count,
        maxUses,
        expiresInDays,
        note: note.trim() || undefined,
        grantsAdmin,
      });
      onDone(res.codes);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not generate codes', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Generate registration codes"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={generate} disabled={busy}>
            {busy ? <span className="spinner" /> : `Generate ${count}`}
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="grow">
          <Field label="How many codes">
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value))))}
            />
          </Field>
        </div>
        <div className="grow">
          <Field label="Uses per code" hint="0 = unlimited">
            <input
              className="input"
              type="number"
              min={0}
              max={1000}
              value={maxUses}
              onChange={(e) => setMaxUses(Math.max(0, Number(e.target.value)))}
            />
          </Field>
        </div>
      </div>

      <Field label="Expires after" hint="0 = never expires">
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input grow"
            type="number"
            min={0}
            max={3650}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Math.max(0, Number(e.target.value)))}
          />
          <span className="muted small" style={{ whiteSpace: 'nowrap' }}>days</span>
        </div>
      </Field>

      <Field label="Note" hint="Just for you - who is this for?">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
      </Field>

      <Toggle
        checked={grantsAdmin}
        onChange={setGrantsAdmin}
        label="Grant admin rights"
        hint="Whoever redeems this code becomes an administrator."
      />
    </Modal>
  );
}

/* ---------------------------------------------------------------- */
/* Users                                                             */
/* ---------------------------------------------------------------- */

function UsersTab() {
  const { user: me, toast } = useApp();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const load = useCallback(() => {
    api.get<{ users: AdminUser[] }>('/admin/users').then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, []);

  useEffect(load, [load]);

  const patch = async (id: string, body: Record<string, unknown>, message: string) => {
    try {
      await api.patch(`/admin/users/${id}`, body);
      toast(message, 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work', 'error');
    }
  };

  const remove = async (u: AdminUser) => {
    if (!confirm(`Delete @${u.username}? Their uploads and rooms are removed too.`)) return;
    try {
      await api.del(`/admin/users/${u.id}`);
      toast('Account deleted', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete', 'error');
    }
  };

  if (!users) return <Spinner />;

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Storage</th>
              <th>Rooms</th>
              <th>Last login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={u.isDisabled ? { opacity: 0.55 } : undefined}>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <Avatar name={u.displayName} color={u.avatarColor} url={u.avatarUrl} size="sm" />
                    <div>
                      <div style={{ fontWeight: 550 }}>{u.displayName}</div>
                      <div className="tiny faint">@{u.username}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {u.isAdmin && <span className="tag accent">admin</span>}
                  {u.isDisabled && <span className="tag">disabled</span>}
                  {!u.isAdmin && !u.isDisabled && <span className="tag">member</span>}
                </td>
                <td className="small">
                  {formatBytes(u.storageUsed)}
                  <div className="tiny faint">
                    {u.quotaBytes == null ? 'default quota' : `${(u.quotaBytes / GB).toFixed(1)} GB quota`}
                  </div>
                </td>
                <td>{u.roomsOwned}</td>
                <td className="faint tiny">{relativeTime(u.lastLoginAt)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" onClick={() => setEditing(u)}>
                    <Icon name="edit" size={13} /> Edit
                  </button>
                  {u.id !== me?.id && (
                    <>
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          patch(
                            u.id,
                            { isDisabled: !u.isDisabled },
                            u.isDisabled ? 'Account enabled' : 'Account disabled'
                          )
                        }
                      >
                        {u.isDisabled ? 'Enable' : 'Disable'}
                      </button>
                      <button className="btn ghost icon sm danger" onClick={() => remove(u)} title="Delete account">
                        <Icon name="trash" size={13} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LockoutsPanel />

      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Login back-off                                                    */
/* ---------------------------------------------------------------- */

interface Lockout {
  key: string;
  kind: 'account' | 'address';
  label: string;
  failures: number;
  lockedForMs: number;
  lastFailureAt: number;
}

function LockoutsPanel() {
  const { toast } = useApp();
  const [lockouts, setLockouts] = useState<Lockout[] | null>(null);

  const load = useCallback(() => {
    api
      .get<{ lockouts: Lockout[] }>('/admin/lockouts')
      .then((r) => setLockouts(r.lockouts))
      .catch(() => setLockouts([]));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const unlock = async (key: string) => {
    await api.del(`/admin/lockouts/${encodeURIComponent(key)}`);
    toast('Unlocked', 'success');
    load();
  };

  return (
    <section className="panel">
      <div className="row between">
        <div>
          <h2>Failed sign-ins</h2>
          <p className="tiny faint">
            Three mistakes are free, then each wrong attempt doubles the wait up to 15 minutes.
            Counters clear on a successful sign-in, or after an hour of quiet.
          </p>
        </div>
        <button className="btn sm" onClick={load}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
      </div>

      {!lockouts ? (
        <Spinner />
      ) : lockouts.length === 0 ? (
        <div className="tiny faint" style={{ padding: '10px 2px' }}>
          Nothing to show — no recent failed attempts. ✅
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Target</th>
                <th>Type</th>
                <th>Failures</th>
                <th>Status</th>
                <th>Last try</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lockouts.map((l) => (
                <tr key={l.key}>
                  <td className="mono small">{l.label}</td>
                  <td>
                    <span className="tag">{l.kind}</span>
                  </td>
                  <td>{l.failures}</td>
                  <td>
                    {l.lockedForMs > 0 ? (
                      <span className="tag live">locked {Math.ceil(l.lockedForMs / 1000)}s</span>
                    ) : (
                      <span className="tag">cooling down</span>
                    )}
                  </td>
                  <td className="faint tiny">{relativeTime(l.lastFailureAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm" onClick={() => unlock(l.key)}>
                      Unlock
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [avatar, setAvatar] = useState(user.avatarUrl);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [customQuota, setCustomQuota] = useState(user.quotaBytes != null);
  const [quotaGb, setQuotaGb] = useState(user.quotaBytes != null ? user.quotaBytes / GB : 5);
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/admin/users/${user.id}`, {
        displayName,
        isAdmin,
        quotaGb: customQuota ? quotaGb : null,
        newPassword: newPassword.length >= 8 ? newPassword : undefined,
      });
      toast('User updated', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit @${user.username}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Save'}
          </button>
        </>
      }
    >
      <AvatarPicker
        user={{ id: user.id, displayName, avatarColor: user.avatarColor, avatarUrl: avatar }}
        targetId={user.id}
        onChanged={setAvatar}
      />

      <Field label="Display name">
        <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
      </Field>

      <Toggle checked={isAdmin} onChange={setIsAdmin} label="Administrator" hint="Full access to this admin panel." />

      <Toggle
        checked={customQuota}
        onChange={setCustomQuota}
        label="Custom upload quota"
        hint={`Currently using ${formatBytes(user.storageUsed)}. Off means the server default applies.`}
      />
      {customQuota && (
        <Field label="Quota (GB)">
          <input
            className="input"
            type="number"
            min={0}
            step={0.5}
            value={quotaGb}
            onChange={(e) => setQuotaGb(Math.max(0, Number(e.target.value)))}
          />
        </Field>
      )}

      <Field label="Reset password" hint="Leave empty to keep the current password. Minimum 8 characters.">
        <input
          className="input"
          type="text"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password"
          autoComplete="off"
        />
      </Field>
    </Modal>
  );
}

/* ---------------------------------------------------------------- */
/* Server settings                                                   */
/* ---------------------------------------------------------------- */

function SettingsTab() {
  const { toast } = useApp();
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/admin/settings').then((res: any) => {
      setData(res);
      setForm({
        site_name: res.settings.site_name,
        registration_open: res.settings.registration_open === '1',
        upload_enabled: res.settings.upload_enabled === '1',
        upload_global_limit_gb: Number(res.settings.upload_global_limit_gb),
        upload_default_user_quota_gb: Number(res.settings.upload_default_user_quota_gb),
        max_upload_size_gb: Number(res.settings.max_upload_size_gb),
        chat_history_limit: Number(res.settings.chat_history_limit),
      });
    });
  }, []);

  useEffect(load, [load]);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch('/admin/settings', { ...form, youtube_api_key: apiKey || undefined });
      setApiKey('');
      toast('Settings saved', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <Spinner />;

  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <>
      <section className="panel">
        <h2>General</h2>
        <Field label="Site name" hint="Shown in the sidebar and on the sign-in screen">
          <input className="input" value={form.site_name ?? ''} onChange={(e) => set('site_name', e.target.value)} />
        </Field>
        <Toggle
          checked={Boolean(form.registration_open)}
          onChange={(v) => set('registration_open', v)}
          label="Registration open"
          hint="When off, nobody can redeem a code - useful once everyone has joined."
        />
        <Field label="Chat history per room" hint="Older messages are pruned automatically">
          <input
            className="input"
            type="number"
            min={20}
            max={5000}
            value={form.chat_history_limit ?? 300}
            onChange={(e) => set('chat_history_limit', Number(e.target.value))}
          />
        </Field>
      </section>

      <section className="panel">
        <h2>Integrations</h2>
        <Field
          label="YouTube Data API key"
          hint={
            data.youtubeKeyFromEnv
              ? 'A key is also configured through the YOUTUBE_API_KEY environment variable. A key saved here takes priority.'
              : 'Needed for playlist import and in-app search. Create one at console.cloud.google.com → YouTube Data API v3.'
          }
        >
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input grow"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data.settings.youtube_api_key || 'AIza…'}
              autoComplete="off"
              spellCheck={false}
            />
            {data.settings.youtube_api_key && (
              <button
                className="btn danger"
                onClick={async () => {
                  await api.post('/admin/settings/clear-youtube-key');
                  toast('Key removed', 'success');
                  load();
                }}
              >
                Remove
              </button>
            )}
          </div>
        </Field>
        <div className="row" style={{ gap: 8 }}>
          <span className={`tag ${data.hasYoutubeKey ? 'ok' : ''}`}>
            {data.hasYoutubeKey ? '✓ Playlist import and search enabled' : 'No key — links still work, search does not'}
          </span>
        </div>
      </section>

      <section className="panel">
        <h2>Uploads</h2>
        <Toggle
          checked={Boolean(form.upload_enabled)}
          onChange={(v) => set('upload_enabled', v)}
          label="Allow file uploads"
          hint="Users can upload video files that are streamed from this server."
        />
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div className="grow">
            <Field label="Server-wide limit (GB)" hint="Total disk budget for all uploads">
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                value={form.upload_global_limit_gb ?? 50}
                onChange={(e) => set('upload_global_limit_gb', Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="grow">
            <Field label="Default per-user quota (GB)" hint="Override individual users on the Users tab">
              <input
                className="input"
                type="number"
                min={0}
                step={0.5}
                value={form.upload_default_user_quota_gb ?? 5}
                onChange={(e) => set('upload_default_user_quota_gb', Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="grow">
            <Field label="Max file size (GB)">
              <input
                className="input"
                type="number"
                min={0.1}
                step={0.5}
                value={form.max_upload_size_gb ?? 4}
                onChange={(e) => set('max_upload_size_gb', Number(e.target.value))}
              />
            </Field>
          </div>
        </div>
        {data.storage && (
          <>
            <div className="row between small">
              <span className="muted">
                {formatBytes(data.storage.globalUsed)} of {formatBytes(data.storage.globalLimit)} used
              </span>
            </div>
            <Meter used={data.storage.globalUsed} total={data.storage.globalLimit} />
          </>
        )}
      </section>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? <span className="spinner" /> : 'Save settings'}
        </button>
      </div>
    </>
  );
}
