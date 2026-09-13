// server/scripts/export-directory-link.js
//
//   npm run export-link -- --from "E:\Apps\docTracking\server\data\doctracking.db"
//
// Pass 1 of 2. Reads the department assignments docTracking already holds —
// 119 people, linked to Active Directory accounts and confirmed by hand — and
// writes them out as a CSV of "which ISO department does this person belong to".
//
// It writes NOTHING to either database. docTracking's file is opened read-only,
// which is not a courtesy: it is a live system, and a script that only needs to
// read it has no business being able to write to it.
//
// Two passes, for the same reason docTracking's own link-directory.js uses two:
// the mapping contains judgement calls, and a judgement call should be visible
// to a person before it becomes data. Correct the CSV, then run the import.
//
// To EXCLUDE someone, blank their iso_dept_prefix cell. The import skips any row
// without one.
const fs     = require('fs');
const path   = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const argFrom = process.argv.indexOf('--from');
const CANDIDATES = [
  (argFrom > -1 && process.argv[argFrom + 1]) || null,
  process.env.DOCTRACKING_DB,
  'E:\\Apps\\docTracking\\server\\data\\doctracking.db',
  path.join(__dirname, '..', '..', '..', 'docTracking', 'server', 'data', 'doctracking.db'),
  'C:\\Users\\DELL\\docTracking\\server\\data\\doctracking.db',
].filter(Boolean);

const SOURCE = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!SOURCE) {
  console.error('\n  Could not find docTracking\'s database. Looked in:');
  CANDIDATES.forEach(p => console.error(`    ${p}`));
  console.error('\n  Point at it directly:');
  console.error('    npm run export-link -- --from "E:\\Apps\\docTracking\\server\\data\\doctracking.db"\n');
  process.exit(1);
}

/**
 * docTracking department → ISO department, by service-code prefix.
 *
 * Four of these are the same department under the same Arabic name. The other
 * three are the judgement calls, and they are the reason this file produces a
 * CSV to read rather than writing straight to the database:
 *
 *   قسم الموارد والمعلومات is broader than any single docTracking department —
 *   it covers IT and HR, and possibly الحسابات. The first two are confirmed;
 *   accounts_dept is marked uncertain so it arrives needing a decision rather
 *   than quietly assigning seven people to a department they may not be in.
 */
const DEPT_MAP = {
  maintenance_dept:        { prefix: 'MNT', confidence: 'exact',     note: 'same department, same name' },
  mosques_guidance_dept:   { prefix: 'MSJ', confidence: 'exact',     note: 'same department, same name' },
  investments_dept:        { prefix: 'INV', confidence: 'exact',     note: 'same department, same name' },
  community_relations_dept:{ prefix: 'COM', confidence: 'near',      note: 'قسم الاتصال وخدمة العملاء → مجموعة الاتصال وخدمة العملاء' },
  it_dept:                 { prefix: 'IT',  confidence: 'confirmed', note: 'الموارد والمعلومات covers IT' },
  hr_dept:                 { prefix: 'IT',  confidence: 'confirmed', note: 'الموارد والمعلومات covers HR' },
  accounts_dept:           { prefix: 'IT',  confidence: 'UNCERTAIN', note: 'CHECK: is الحسابات part of الموارد والمعلومات? Blank the prefix to exclude these people.' },
};

// A docTracking MANAGER heads their department, which is what مشرف قسم means
// here — they see their whole department rather than only their own requests.
// A starting point, not a ruling: correct the column if it is wrong.
const ROLE_MAP = { MANAGER: 'supervisor', STAFF: 'user' };

const src = new Database(SOURCE, { readonly: true });
const { db } = require('../db');

// The ISO departments this instance actually has, so the CSV can carry their
// real names and the import can refuse a prefix that does not exist.
const isoDepts = {};
db.prepare('SELECT id, name, prefix FROM departments').all()
  .forEach(d => { isoDepts[d.prefix.toUpperCase()] = d; });

const missing = [...new Set(Object.values(DEPT_MAP).map(m => m.prefix))]
  .filter(p => !isoDepts[p]);
if (missing.length) {
  console.error(`\n  These ISO departments do not exist in this database: ${missing.join(', ')}`);
  console.error('  Run `npm run seed` first, or correct DEPT_MAP in this script.\n');
  process.exit(1);
}

const people = src.prepare(`
  SELECT username, full_name, email, role, dept_id, is_active
    FROM users
   WHERE username IS NOT NULL AND username <> ''
   ORDER BY dept_id, role DESC, full_name
`).all();

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const HEADER = [
  'iso_dept_prefix', 'iso_dept_name', 'iso_role',
  'username', 'full_name', 'email',
  'source_dept', 'source_role', 'active', 'confidence', 'note',
];

const rows = [];
let included = 0, skipped = 0, uncertain = 0;

for (const p of people) {
  const map = DEPT_MAP[p.dept_id];
  if (!map) { skipped++; continue; }            // a department ISO Phase 1 does not cover
  if (!p.is_active) { skipped++; continue; }    // left the organisation

  const dept = isoDepts[map.prefix];
  if (map.confidence === 'UNCERTAIN') uncertain++;
  included++;

  rows.push([
    map.prefix, dept.name, ROLE_MAP[p.role] || 'user',
    p.username, p.full_name, p.email || '',
    p.dept_id, p.role, p.is_active ? 'yes' : 'no',
    map.confidence, map.note,
  ]);
}

const OUT = path.join(__dirname, '..', 'data', 'directory-link.csv');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
// A BOM, so Excel opens the Arabic as UTF-8 rather than as mojibake. Without it
// Excel guesses the system codepage and every name arrives unreadable.
fs.writeFileSync(OUT, '\uFEFF' + [HEADER, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

console.log('');
console.log(`  read     ${SOURCE}  (read-only)`);
console.log(`  people   ${people.length} in docTracking, ${included} in an ISO Phase 1 department, ${skipped} outside it`);
console.log('');
const byPrefix = {};
rows.forEach(r => { byPrefix[r[0]] = (byPrefix[r[0]] || 0) + 1; });
Object.entries(byPrefix).sort((a, b) => b[1] - a[1])
  .forEach(([p, n]) => console.log(`    ${String(n).padStart(3)}  ${p.padEnd(5)} ${isoDepts[p].name}`));
console.log('');
console.log(`  written  ${OUT}`);
console.log('');
console.log('  NOW READ IT. Open it in Excel and check the mapping before importing.');
if (uncertain) {
  console.log(`  ${uncertain} row(s) are marked UNCERTAIN — decide on those first.`);
}
console.log('  To exclude someone, blank their iso_dept_prefix cell.');
console.log('');
console.log('  Then:  npm run import-link');
console.log('');
