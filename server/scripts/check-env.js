// server/scripts/check-env.js
//
//   npm run check-env
//
// Answers "is this machine configured to run the system?" before anyone finds
// out by failing to sign in. Reads .env, checks each setting for the specific
// way it usually goes wrong, and prints what to do about it.
//
// Writes nothing, connects to nothing, and never prints a secret's value —
// only whether it is set and whether it looks usable.
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

let problems = 0;
let warnings = 0;

const ok   = (m) => console.log(`  ✓ ${m}`);
const bad  = (m, fix) => { problems++; console.log(`  ✗ ${m}`); if (fix) console.log(`      → ${fix}`); };
const warn = (m, fix) => { warnings++; console.log(`  ! ${m}`);      if (fix) console.log(`      → ${fix}`); };

console.log('\n نظام تسجيل الجودة — فحص الإعدادات\n');

// ── .env exists at all ──
const envPath = path.join(__dirname, '..', '.env');
console.log('.env');
if (!fs.existsSync(envPath)) {
  bad('server/.env is missing', 'copy server/.env.example to server/.env and fill it in');
} else {
  ok('server/.env found');
}

// ── JWT ──
console.log('\nJWT');
const secret = process.env.JWT_SECRET || '';
if (!secret) {
  bad('JWT_SECRET is not set — the server will refuse to start',
      'node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
} else if (secret.startsWith('replace_with')) {
  bad('JWT_SECRET is still the placeholder from .env.example',
      'node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
} else if (secret.length < 32) {
  // Short secrets are the ones that get brute-forced offline, and a forged
  // token is indistinguishable from a real one.
  warn(`JWT_SECRET is only ${secret.length} characters`, 'use at least 64');
} else {
  ok(`JWT_SECRET set (${secret.length} chars)`);
}
ok(`JWT_EXPIRES_IN = ${process.env.JWT_EXPIRES_IN || '8h (default)'}`);

// ── LDAP ──
console.log('\nActive Directory');
if (!process.env.LDAP_URL) {
  warn('LDAP_URL is not set — only local accounts can sign in',
       'set LDAP_URL=ldap://10.27.16.5 to enable directory sign-in');
} else {
  ok(`LDAP_URL = ${process.env.LDAP_URL}`);
  if (!process.env.LDAP_BASE_DN) {
    bad('LDAP_BASE_DN is not set — the user search will find nothing', 'e.g. DC=swd,DC=local');
  } else {
    ok(`LDAP_BASE_DN = ${process.env.LDAP_BASE_DN}`);
  }
  ok(`UPN suffixes = ${process.env.LDAP_DEFAULT_UPN || '(unset)'} / ${process.env.LDAP_ALT_UPN || '(unset)'}`);
  ok(`NETBIOS = ${process.env.LDAP_NETBIOS || '(unset)'}`);

  // The two must be set together: a DN with no password cannot bind, and the
  // browse screen fails with an error that looks like a directory outage.
  const hasDn = !!process.env.LDAP_BIND_DN;
  const hasPw = !!process.env.LDAP_BIND_PASSWORD;
  if (hasDn && hasPw) {
    ok(`service account configured (${process.env.LDAP_BIND_DN})`);
  } else if (hasDn !== hasPw) {
    bad('LDAP_BIND_DN and LDAP_BIND_PASSWORD must BOTH be set',
        hasDn ? 'LDAP_BIND_PASSWORD is missing' : 'LDAP_BIND_DN is missing');
  } else {
    warn('no service account — the "استيراد من Active Directory" screen is disabled',
         'directory sign-in still works without it');
  }
}

// ── Admin failsafe ──
console.log('\nمدير النظام');
const overrides = (process.env.SUPER_ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!overrides.length) {
  warn('SUPER_ADMIN_USERS is empty — no lockout failsafe',
       'if the last admin account is disabled, nobody can re-enable it');
} else {
  ok(`always admin: ${overrides.join(', ')}`);
}
ok(process.env.ADMIN_DEPT_PREFIX
  ? `everyone in the "${process.env.ADMIN_DEPT_PREFIX}" department is admin`
  : 'ADMIN_DEPT_PREFIX unset — admin comes from the flag and the override only');

// ── Database ──
console.log('\nDatabase');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'iso-quality.db');
if (fs.existsSync(dbPath)) {
  const size = (fs.statSync(dbPath).size / 1024).toFixed(0);
  ok(`${dbPath} (${size} KB)`);
  try {
    const { db } = require('../db');
    const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    const r = db.prepare('SELECT COUNT(*) n FROM requests').get().n;
    const d = db.prepare('SELECT COUNT(*) n FROM departments').get().n;
    ok(`${d} department(s), ${n} user(s), ${r} request(s)`);
    if (!n) warn('no users yet', 'npm run seed');
  } catch (e) {
    bad(`could not read the database: ${e.message}`);
  }
} else {
  warn('database file does not exist yet', 'npm run seed — it is created on first run');
}

// ── Working week ──
console.log('\nWorking week');
const weekend = (process.env.WEEKEND_DAYS || '5,6').split(',').map(s => s.trim());
const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
ok(`weekend: ${weekend.map(d => dayNames[Number(d)] || `?${d}`).join(' + ')}`);

// ── Verdict ──
console.log('');
if (problems) {
  console.log(`${problems} problem(s), ${warnings} warning(s). The server will not work correctly until the problems above are fixed.\n`);
  process.exit(1);
}
console.log(warnings ? `Ready, with ${warnings} warning(s).\n` : 'Ready.\n');
