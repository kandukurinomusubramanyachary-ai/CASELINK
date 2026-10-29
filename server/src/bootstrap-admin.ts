/** Explicit first-account provisioning. Never seeds demo users, cases, policies or institutions. */
import { db, nowIso, uid } from './db.js';
import { hashPassword } from './auth.js';

try {
  const username = (process.env.CASELINK_ADMIN_USERNAME ?? '').trim();
  const password = process.env.CASELINK_ADMIN_PASSWORD ?? '';
  const displayName = (process.env.CASELINK_ADMIN_NAME ?? 'System Administrator').trim();
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username) || password.length < 16 || password.length > 256 || !displayName || displayName.length > 120) {
    throw new Error('Set CASELINK_ADMIN_USERNAME (3–60 letters/digits/._-) and a unique CASELINK_ADMIN_PASSWORD (16–256 characters).');
  }
  db.transaction(() => {
    if ((db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n !== 0) {
      throw new Error('Bootstrap requires an empty account directory. Existing accounts were preserved.');
    }
    db.prepare(`INSERT INTO users (id,username,password_hash,display_name,role,bureau,region,active,created_at)
      VALUES (?,?,?,?,'admin',NULL,NULL,1,?)`).run(uid(), username, hashPassword(password), displayName, nowIso());
  })();
  console.log('Initial administrator created. No demo data was added.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally { db.close(); }
