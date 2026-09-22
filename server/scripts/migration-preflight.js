// server/scripts/migration-preflight.js
//
//   npm run migration-preflight
//   npm run migration-preflight -- path/to/migration-review-data.json
//
// Read-only readiness check. It never stages or imports historical records.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'iso-quality.db'));
const packagePath = process.argv[2] ? path.resolve(process.argv[2]) : null;

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
let failures = 0;

function check(label, ok, detail = '') {
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columns(name) {
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name));
}

console.log('\nMigration readiness preflight\n');
console.log(`database: ${dbPath}\n`);

const requiredTables = [
  'migration_batches',
  'migration_request_stage',
  'migration_closure_stage',
  'migration_user_map',
  'migration_department_map',
  'migration_service_map',
  'request_sequences',
];

console.log('schema');
for (const table of requiredTables) check(`table ${table}`, tableExists(table));

const requestColumns = columns('requests');
for (const column of [
  'is_migrated', 'migration_batch_id', 'legacy_source_row', 'original_email',
  'closure_original_email', 'responsible_name_snapshot',
]) {
  check(`requests.${column}`, requestColumns.has(column));
}

console.log('\nreference data');
const counts = Object.fromEntries(['departments', 'services', 'users', 'holidays'].map(table => [
  table,
  db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
]));
check('departments exist', counts.departments > 0, String(counts.departments));
check('services exist', counts.services > 0, String(counts.services));
check('users exist', counts.users > 0, String(counts.users));
check('holiday calendar needs production review', counts.holidays > 1, String(counts.holidays));

if (packagePath) {
  console.log('\nreview package');
  if (!fs.existsSync(packagePath)) {
    check('review package exists', false, packagePath);
  } else {
    const payload = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const summary = payload.summary || {};
    check('request source total', summary.request_source_rows === 10350, String(summary.request_source_rows));
    check('closure source total', summary.closure_source_rows === 9261, String(summary.closure_source_rows));
    check('missing request codes resolved', summary.request_rows_without_code === 0,
      `${summary.request_rows_without_code ?? 'unknown'} unresolved`);
    check('duplicate request codes resolved', summary.duplicate_request_codes === 0,
      `${summary.duplicate_request_codes ?? 'unknown'} unresolved`);
    check('orphan closures resolved', summary.orphan_closure_codes === 0,
      `${summary.orphan_closure_codes ?? 'unknown'} unresolved`);

    const pending = ['departments', 'services', 'users']
      .flatMap(key => payload[key] || [])
      .filter(row => !['Approved', 'approved'].includes(row.approval_status));
    check('all mappings approved', pending.length === 0, `${pending.length} pending`);
  }
}

db.close();
console.log('');
if (failures) {
  console.log(`${failures} readiness check(s) require action. No data was changed.\n`);
  process.exit(1);
}
console.log('Migration preparation checks passed. No data was changed.\n');

