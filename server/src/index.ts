/**
 * Entry point. Its only job is to apply a staged restore before anything else
 * loads, because importing the app opens the database - and the database file
 * is exactly what a restore has to move.
 */
import { applyPendingRestore } from './services/backup-boot';

const restored = applyPendingRestore();
if (restored) {
  const when = new Date(restored.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  console.log('\n  =============== RESTORED ==================');
  console.log(`  Applied the backup taken on ${when} UTC`);
  console.log(`  users: ${restored.counts?.users ?? '?'}  rooms: ${restored.counts?.rooms ?? '?'}`);
  console.log('  The replaced files are kept next to them as *.replaced-*');
  console.log('  ===========================================\n');
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('./app');
