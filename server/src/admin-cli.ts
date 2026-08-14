/**
 * Recovery tool for when nobody can sign in.
 *
 *   docker exec -it watch-with-friends node server/dist/admin-cli.js list
 *   docker exec -it watch-with-friends node server/dist/admin-cli.js reset <username> <password>
 *   docker exec -it watch-with-friends node server/dist/admin-cli.js unlock <username>
 *
 * Deliberately separate from the server entry point so running it never starts
 * a second listener against the same database.
 */
import { db, migrate } from './db';
import { hashPassword, newId } from './auth';
import type { UserRow } from './types';

const [, , command, ...args] = process.argv;

function usage(): never {
  console.log(`
  Watch With Friends - admin recovery

    list                          show every account
    reset <username> <password>   set a password, grant admin, re-enable, clear lockouts
    unlock <username>             clear failed-login back-off only
    create <username> <password>  add a new admin account

  Example:
    node server/dist/admin-cli.js reset admin 'my new password'
`);
  process.exit(command ? 1 : 0);
}

function findUser(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

function clearLockFor(username: string): void {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(`u:${username.toLowerCase()}`);
}

function listUsers(): void {
  const rows = db
    .prepare('SELECT username, display_name, is_admin, is_disabled, last_login_at FROM users ORDER BY created_at')
    .all() as Array<{
    username: string;
    display_name: string;
    is_admin: number;
    is_disabled: number;
    last_login_at: number | null;
  }>;

  if (rows.length === 0) {
    console.log('\n  No accounts yet. Restart the container to bootstrap one.\n');
    return;
  }
  console.log(`\n  ${rows.length} account${rows.length === 1 ? '' : 's'}:\n`);
  for (const r of rows) {
    const flags = [r.is_admin ? 'admin' : null, r.is_disabled ? 'DISABLED' : null].filter(Boolean).join(', ');
    const last = r.last_login_at ? new Date(r.last_login_at).toISOString().slice(0, 16).replace('T', ' ') : 'never';
    console.log(`    ${r.username.padEnd(22)} ${flags.padEnd(18)} last login: ${last}`);
  }

  const locks = db.prepare('SELECT key, failures, locked_until FROM login_attempts').all() as Array<{
    key: string;
    failures: number;
    locked_until: number;
  }>;
  const active = locks.filter((l) => l.locked_until > Date.now());
  if (active.length > 0) {
    console.log(`\n  ${active.length} active lockout(s):`);
    for (const l of active) {
      console.log(`    ${l.key}  (${l.failures} failures, ${Math.ceil((l.locked_until - Date.now()) / 1000)}s left)`);
    }
  }
  console.log('');
}

migrate();

switch (command) {
  case 'list':
    listUsers();
    break;

  case 'reset': {
    const [username, password] = args;
    if (!username || !password) usage();
    if (password.length < 8) {
      console.error('\n  Password must be at least 8 characters.\n');
      process.exit(1);
    }
    const user = findUser(username);
    if (!user) {
      console.error(`\n  No account called "${username}".`);
      listUsers();
      process.exit(1);
    }
    db.prepare('UPDATE users SET password_hash = ?, is_admin = 1, is_disabled = 0 WHERE id = ?').run(
      hashPassword(password),
      user.id
    );
    clearLockFor(username);
    console.log(`\n  Password reset for "${username}". It is now an enabled admin account.\n`);
    break;
  }

  case 'unlock': {
    const [username] = args;
    if (!username) usage();
    clearLockFor(username);
    console.log(`\n  Cleared the login back-off for "${username}".\n`);
    break;
  }

  case 'create': {
    const [username, password] = args;
    if (!username || !password) usage();
    if (password.length < 8) {
      console.error('\n  Password must be at least 8 characters.\n');
      process.exit(1);
    }
    if (findUser(username)) {
      console.error(`\n  "${username}" already exists - use "reset" instead.\n`);
      process.exit(1);
    }
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, is_admin, avatar_color, prefs, created_at)
       VALUES (?, ?, ?, ?, 1, '#7c5cff', '{}', ?)`
    ).run(newId(), username, username, hashPassword(password), Date.now());
    console.log(`\n  Created admin account "${username}".\n`);
    break;
  }

  default:
    usage();
}
