// server/scripts/import-directory-link.js
//
//   npm run import-link            — show what WOULD change, write nothing
//   npm run import-link -- --apply — write it
//
//   --uncertain=exclude   leave the rows marked UNCERTAIN out
//   --uncertain=include   bring them in as the CSV has them
//
// The UNCERTAIN rows are a question the export could not answer, and the import
// refuses to guess. Answering it by hand means editing a UTF-8 CSV full of
// Arabic on a Windows server, which is its own source of mistakes — so the
// answer can be given as a flag instead. Either way it is an explicit decision,
// and it is recorded in the audit log.
//
// If you are unsure, EXCLUDE. Someone left out arrives with no department, and
// the first thing they do is ask — the question surfaces itself. Someone filed
// under the wrong قسم goes on filing requests that are counted against a
// department they are not in, and nothing ever says so.
//
// Pass 2 of 2. Reads server/data/directory-link.csv — the one you corrected —
// and gives each person their ISO department and role.
//
// It defaults to a dry run. An import that writes on the first invocation is an
// import nobody reads the output of.
//
// The accounts it creates carry NO password: password_hash stays NULL, which is
// what sends the sign-in to Active Directory. Nobody gets a password out of
// this, and nobody needs one.
//
// Re-running is safe. Every write is an upsert keyed on the username, so a
// second run changes only what the CSV has changed. Corrections are made by
// editing the CSV and running it again.
const fs   = require('fs');
const path = require('path');
require('dotenv').config();
const { db } = require('../db');
const { logAudit } = require('../utils/audit');

const APPLY = process.argv.includes('--apply');
const CSV   = path.join(__dirname, '..', 'data', 'directory-link.csv');

// null = undecided, and the import will refuse to apply.
const uncertainArg = process.argv.find(a => a.startsWith('--uncertain='));
const UNCERTAIN = uncertainArg ? uncertainArg.split('=')[1] : null;
if (UNCERTAIN && !['include', 'exclude'].includes(UNCERTAIN)) {
  console.error(`\n  --uncertain must be "include" or "exclude", not "${UNCERTAIN}"\n`);
  process.exit(1);
}

if (!fs.existsSync(CSV)) {
  console.error(`\n  ${CSV} does not exist.`);
  console.error('  Generate it first:  npm run export-link\n');
  process.exit(1);
}

/** A CSV parser that handles quoted fields containing commas — Arabic names do. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

const raw  = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '');   // strip the Excel BOM
const rows = parseCsv(raw);
const header = rows.shift().map(h => h.trim());
const col = Object.fromEntries(header.map((h, i) => [h, i]));

for (const required of ['iso_dept_prefix', 'username', 'full_name']) {
  if (col[required] === undefined) {
    console.error(`\n  The CSV is missing the "${required}" column. Regenerate it with npm run export-link\n`);
    process.exit(1);
  }
}

const isoDepts = {};
db.prepare('SELECT id, name, prefix FROM departments').all()
  .forEach(d => { isoDepts[d.prefix.toUpperCase()] = d; });

const VALID_ROLES = ['user', 'supervisor', 'power'];

const plan = { create: [], update: [], unchanged: [], skipped: [], problems: [] };

for (const r of rows) {
  const prefix   = String(r[col.iso_dept_prefix] || '').trim().toUpperCase();
  const username = String(r[col.username] || '').trim();
  const fullName = String(r[col.full_name] || '').trim();
  const email    = String(r[col.email] || '').trim().toLowerCase();
  const role     = String(r[col.iso_role] || 'user').trim() || 'user';
  const confidence = String(r[col.confidence] || '').trim();

  if (!username) continue;

  // A blank prefix is how the CSV says "not this person". Deliberate, so it is
  // recorded as skipped rather than treated as an error.
  if (!prefix) { plan.skipped.push({ username, fullName, why: 'no department in the CSV' }); continue; }

  const dept = isoDepts[prefix];
  if (!dept) { plan.problems.push({ username, why: `unknown department prefix "${prefix}"` }); continue; }
  if (!VALID_ROLES.includes(role)) { plan.problems.push({ username, why: `unknown role "${role}"` }); continue; }
  if (confidence === 'UNCERTAIN') {
    if (UNCERTAIN === null) {
      plan.problems.push({ username, why: 'marked UNCERTAIN — pass --uncertain=exclude or --uncertain=include, or edit the CSV' });
      continue;
    }
    if (UNCERTAIN === 'exclude') {
      plan.skipped.push({ username, fullName, why: 'UNCERTAIN, excluded by --uncertain=exclude' });
      continue;
    }
    // include: falls through and is imported exactly as the CSV has it.
  }

  const existing = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.department_id, u.role, u.is_active,
           (u.password_hash IS NOT NULL) AS has_password, u.ad_password_override,
           d.name AS department_name
      FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.username = ?
  `).get(username);

  if (!existing) {
    plan.create.push({ username, fullName, email, deptId: dept.id, deptName: dept.name, role });
  } else if (Number(existing.department_id) === dept.id && existing.role === role && existing.is_active) {
    plan.unchanged.push({ username, deptName: dept.name });
  } else {
    plan.update.push({
      id: existing.id, username, fullName, email, deptId: dept.id, deptName: dept.name, role,
      from: `${existing.department_name || 'no department'} / ${existing.role}${existing.is_active ? '' : ' / inactive'}`,
      to:   `${dept.name} / ${role}`,
      // A hash no longer means "a separate local account": it may be an AD row
      // مدير النظام gave a local password to. Only the first is worth flagging
      // here, since this script updates department and role and leaves the
      // password alone either way.
      isLocal: !!existing.has_password && !existing.ad_password_override,
    });
  }
}

// ── Report ───────────────────────────────────────────────────
console.log('');
console.log(`  ${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'}`);
console.log(`  ${CSV}`);
console.log('');

if (plan.problems.length) {
  console.log(`  ${plan.problems.length} row(s) NEED A DECISION — these are not imported:`);
  plan.problems.forEach(p => console.log(`    · ${p.username.padEnd(24)} ${p.why}`));
  console.log('');
}

console.log(`  create    ${plan.create.length}`);
plan.create.slice(0, 40).forEach(p => console.log(`    + ${p.username.padEnd(24)} ${p.role.padEnd(11)} ${p.deptName}`));
if (plan.create.length > 40) console.log(`      … and ${plan.create.length - 40} more`);

console.log(`\n  update    ${plan.update.length}`);
plan.update.slice(0, 40).forEach(p =>
  console.log(`    ~ ${p.username.padEnd(24)} ${p.from}  →  ${p.to}${p.isLocal ? '   (local password account)' : ''}`));
if (plan.update.length > 40) console.log(`      … and ${plan.update.length - 40} more`);

console.log(`\n  unchanged ${plan.unchanged.length}`);
console.log(`  skipped   ${plan.skipped.length}  (blank department in the CSV)`);
console.log('');

if (UNCERTAIN) {
  console.log(`  --uncertain=${UNCERTAIN} — the UNCERTAIN rows are being ${UNCERTAIN === 'exclude' ? 'left out' : 'imported'}.`);
  console.log('');
}

if (!APPLY) {
  console.log('  Read the above. If it is right:');
  if (plan.problems.length) {
    console.log('    npm run import-link -- --apply --uncertain=exclude    (leave those 7 out)');
    console.log('    npm run import-link -- --apply --uncertain=include    (bring them in)');
    console.log('');
    console.log('  Unsure? Exclude. They arrive with no department and ask, which answers');
    console.log('  the question. A wrong department is counted silently and never does.');
  } else {
    console.log('    npm run import-link -- --apply' + (UNCERTAIN ? ` --uncertain=${UNCERTAIN}` : ''));
  }
  console.log('');
  process.exit(plan.problems.length ? 1 : 0);
}

if (plan.problems.length) {
  console.error('  Refusing to apply while rows still need a decision.');
  console.error('  Add --uncertain=exclude or --uncertain=include, or edit the CSV.\n');
  process.exit(1);
}

// ── Apply ────────────────────────────────────────────────────
// One transaction: a half-applied import would leave some people able to file
// requests and others not, with no way to tell which run did what.
const actor = { username: 'DIRECTORY_IMPORT', role: 'system' };

const apply = db.transaction(() => {
  for (const p of plan.create) {
    // password_hash NULL — an Active Directory account. Their password stays in
    // the directory, where it belongs.
    db.prepare(`
      INSERT INTO users (username, email, password_hash, full_name, department_id,
                         role, is_admin, is_active, created_by)
      VALUES (?, NULLIF(?,''), NULL, ?, ?, ?, 0, 1, 'DIRECTORY_IMPORT')
    `).run(p.username, p.email, p.fullName, p.deptId, p.role);
    logAudit(actor, 'استيراد حساب من الدليل', 'user', p.username,
      { newValue: `${p.deptName} / ${p.role}`,
        details: UNCERTAIN ? { uncertainRows: UNCERTAIN } : undefined });
  }

  for (const p of plan.update) {
    // full_name and email are NOT overwritten for an account that already
    // exists: a sign-in refreshes those from Active Directory, which is a better
    // source than a CSV someone edited last week. Only the department and role —
    // the things this system owns — are set.
    db.prepare(`
      UPDATE users SET department_id = ?, role = ?, is_active = 1,
                       updated_at = datetime('now','localtime')
       WHERE id = ?
    `).run(p.deptId, p.role, p.id);
    logAudit(actor, 'تحديث القسم من الدليل', 'user', p.username,
      { oldValue: p.from, newValue: p.to });
  }
});

apply();

console.log(`  done: ${plan.create.length} created, ${plan.update.length} updated.`);
console.log('');
console.log('  They can now sign in with their Active Directory account and will');
console.log('  land in the right department. No passwords were set or needed.');
console.log('');
console.log('  Check it:  npm run data-check');
console.log('');
