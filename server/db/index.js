// server/db/index.js
//
// The database. Same shape as docTracking's: better-sqlite3, WAL, foreign keys
// on, the schema declared here with CREATE TABLE IF NOT EXISTS, and every later
// column added through an idempotent PRAGMA-guarded ALTER below it. Requiring
// this file is what creates or upgrades the file on disk, so server/index.js
// requires it before any route.
//
// WAL is not decoration: it lets the nightly copy and the read-only check
// scripts run while people are using the site.
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  || path.join(__dirname, '..', 'data', 'iso-quality.db');

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────
//
// Dates are stored as 'YYYY-MM-DD' text and timestamps as
// 'YYYY-MM-DD HH:MM:SS' local text — the same strings the UI compares with <
// and >. SQLite has no date type, and ISO-8601 text sorts correctly as text, so
// this is the format that makes a query and a screen agree.
db.exec(`
  -- الأقسام. 'prefix' is the service-code prefix (IT-001, MNT-002 …) and is
  -- UNIQUE because a shared prefix would make two departments mint the same
  -- service code.
  CREATE TABLE IF NOT EXISTS departments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    prefix      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    ldap_group  TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- الخدمات. 'duration' is the promised turnaround in WORKING days; the
  -- deadline engine in utils/workdays.js is the only thing that interprets it.
  CREATE TABLE IF NOT EXISTS services (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    department_id INTEGER NOT NULL,
    duration      INTEGER NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(department_id) REFERENCES departments(id),
    CHECK (duration > 0)
  );

  -- Two services with the same name inside one department are a data-entry
  -- mistake, not a legitimate pair — the prototype checked this in the browser,
  -- where a second tab could defeat it. Here the database refuses it.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_services_dept_name
    ON services(department_id, name COLLATE NOCASE);

  -- المستخدمون.
  --
  -- password_hash NULL is the marker for an Active Directory account: there is
  -- no local password to check, so routes/auth.js goes to the directory. A row
  -- still exists for them because role, department and الحالة are OURS to
  -- decide — AD says who someone is, this table says what they may do here.
  --
  -- username is the sAMAccountName and is what AD logins match on; email is the
  -- البريد الرسمي the prototype signed in with and the requests table copies.
  -- Both are unique and case-insensitive.
  CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    username              TEXT UNIQUE COLLATE NOCASE,
    email                 TEXT UNIQUE COLLATE NOCASE,
    password_hash         TEXT,
    full_name             TEXT NOT NULL,
    department_id         INTEGER,
    role                  TEXT NOT NULL DEFAULT 'user',
    is_admin              INTEGER NOT NULL DEFAULT 0,
    is_active             INTEGER NOT NULL DEFAULT 1,
    force_password_change INTEGER NOT NULL DEFAULT 0,
    last_login_at         TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    created_by            TEXT,
    updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(department_id) REFERENCES departments(id),
    CHECK (role IN ('user','supervisor','power'))
  );

  -- العطلات الرسمية. end_date is stored rather than derived because the
  -- deadline engine reads it on every single date comparison, and recomputing
  -- start+duration inside that loop would be the hot path.
  CREATE TABLE IF NOT EXISTS holidays (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    start_date  TEXT NOT NULL,
    duration    INTEGER NOT NULL,
    end_date    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK (duration > 0),
    CHECK (end_date >= start_date)
  );

  -- الطلبات.
  --
  -- The _snapshot columns are deliberate duplication. A request is an ISO
  -- record: it must still read the way it read on the day it was filed, even
  -- after the department is renamed or the service's duration is changed. So
  -- the name, the code and the promised duration are COPIED in at creation and
  -- never updated — the foreign keys are there to join on, not to read through.
  --
  -- due_date is derived (request_date + duration working days) but stored,
  -- because every dashboard filter compares against it and recomputing it per
  -- row per request would mean loading every holiday to render one table.
  -- routes/holidays.js recomputes it for open requests whenever a holiday moves.
  CREATE TABLE IF NOT EXISTS requests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    req_code            TEXT NOT NULL UNIQUE,
    user_id             INTEGER NOT NULL,
    requester_name      TEXT NOT NULL,
    office_email        TEXT,
    department_id       INTEGER NOT NULL,
    department_snapshot TEXT NOT NULL,
    service_id          INTEGER NOT NULL,
    service_code        TEXT NOT NULL,
    service_name        TEXT NOT NULL,
    duration            INTEGER NOT NULL,
    subject             TEXT NOT NULL,
    notes               TEXT,
    request_date        TEXT NOT NULL,
    due_date            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'Open',
    close_date          TEXT,
    closed_at           TEXT,
    delay_reason        TEXT,
    other_delay_reason  TEXT,
    closure_notes       TEXT,
    delay_days          INTEGER NOT NULL DEFAULT 0,
    is_on_time          INTEGER,
    is_migrated         INTEGER NOT NULL DEFAULT 0,
    migration_batch_id  INTEGER,
    legacy_source_row   INTEGER,
    original_email      TEXT,
    closure_original_email TEXT,
    responsible_name_snapshot TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(user_id)       REFERENCES users(id),
    FOREIGN KEY(department_id) REFERENCES departments(id),
    FOREIGN KEY(service_id)    REFERENCES services(id),
    CHECK (status IN ('Open','Closed')),
    -- A closed request without a closing date is not a closed request. The
    -- prototype could produce one by throwing; here it cannot be written.
    CHECK (status = 'Open' OR close_date IS NOT NULL)
  );

  CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_requests_user   ON requests(user_id);
  CREATE INDEX IF NOT EXISTS idx_requests_dept   ON requests(department_id, status);
  CREATE INDEX IF NOT EXISTS idx_requests_due    ON requests(due_date);
  CREATE INDEX IF NOT EXISTS idx_requests_date   ON requests(request_date);
  CREATE INDEX IF NOT EXISTS idx_requests_svc    ON requests(service_id);

  -- The life of one request, append-only. The prototype had no such trail: a
  -- closure overwrote the row and the previous state was gone. ISO wants to see
  -- the sequence, not just the endpoint.
  CREATE TABLE IF NOT EXISTS request_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  INTEGER NOT NULL,
    type        TEXT NOT NULL,
    actor_id    INTEGER,
    actor_name  TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(request_id) REFERENCES requests(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_req_events ON request_events(request_id, id);

  -- One row per live sign-in. This table — not the token's expiry — is what
  -- actually revokes a session: delete the row and the next request with that
  -- token is refused. Without it a stolen token is valid until it expires and
  -- nothing can stop it.
  --
  -- user_id is the authoritative binding, and it is what authMiddleware loads
  -- the account from. Binding on the username instead — and then loading the
  -- account by an id taken from the TOKEN — leaves the two free to disagree: a
  -- token carrying an honest jti and its own username, with someone else's id,
  -- passes the session check and is then served as that other person. Verified
  -- as a live escalation before this column existed.
  CREATE TABLE IF NOT EXISTS sessions (
    jti        TEXT PRIMARY KEY,
    user_id    INTEGER,
    username   TEXT NOT NULL,
    full_name  TEXT,
    role       TEXT,
    ip         TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    expires_at TEXT NOT NULL
  );
  -- The index on user_id is created after the migrations below, not here: on a
  -- database that predates the column, CREATE TABLE IF NOT EXISTS does nothing
  -- and an index over a column the existing table lacks fails outright.
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);

  -- سجل التدقيق. Append-only by convention — nothing in the API updates or
  -- deletes a row here, and the audit screen is read-only.
  --
  -- old_value/new_value are the human-readable Arabic pair the audit table
  -- renders; details is the machine-readable JSON beside it. Both, because a
  -- reviewer needs the sentence and an investigation needs the fields.
  CREATE TABLE IF NOT EXISTS audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_username TEXT NOT NULL,
    actor_role     TEXT,
    action         TEXT NOT NULL,
    target_type    TEXT,
    target_id      TEXT,
    old_value      TEXT,
    new_value      TEXT,
    details        TEXT,
    ip             TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_username);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action);

  -- Switches an administrator flips at runtime. In the database rather than in
  -- .env deliberately: .env needs a file edit on the server and a restart,
  -- which is exactly what you cannot do mid-demo.
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_by TEXT
  );

  -- New operational request numbers must not depend on the greatest imported
  -- historical code. Historical codes were random and may sit near 999999;
  -- treating their maximum as a sequence would exhaust the eight-digit format.
  CREATE TABLE IF NOT EXISTS request_sequences (
    year_prefix TEXT PRIMARY KEY,
    last_number INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK (length(year_prefix) = 2),
    CHECK (last_number BETWEEN 0 AND 999999)
  );

  -- One row per controlled migration attempt. Raw rows remain linked to the
  -- batch even if they are exceptions and never become canonical requests.
  CREATE TABLE IF NOT EXISTS migration_batches (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT NOT NULL,
    source_filename       TEXT NOT NULL,
    source_sha256         TEXT NOT NULL,
    source_exported_at    TEXT,
    source_timezone       TEXT,
    status                TEXT NOT NULL DEFAULT 'planned',
    raw_request_count     INTEGER NOT NULL DEFAULT 0,
    raw_closure_count     INTEGER NOT NULL DEFAULT 0,
    canonical_request_count INTEGER NOT NULL DEFAULT 0,
    exception_count       INTEGER NOT NULL DEFAULT 0,
    created_by            TEXT NOT NULL,
    created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    completed_at          TEXT,
    notes                 TEXT,
    CHECK (status IN ('planned','staged','validated','applied','failed'))
  );

  CREATE TABLE IF NOT EXISTS migration_request_stage (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id              INTEGER NOT NULL,
    source_sheet          TEXT NOT NULL,
    source_row            INTEGER NOT NULL,
    raw_json              TEXT NOT NULL,
    req_code_raw          TEXT,
    req_code_normalized   TEXT,
    validation_status     TEXT NOT NULL DEFAULT 'pending',
    exception_codes       TEXT,
    canonical_request_id  INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(batch_id) REFERENCES migration_batches(id),
    FOREIGN KEY(canonical_request_id) REFERENCES requests(id),
    UNIQUE(batch_id, source_sheet, source_row),
    CHECK (validation_status IN ('pending','valid','exception','approved','imported'))
  );

  CREATE TABLE IF NOT EXISTS migration_closure_stage (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id              INTEGER NOT NULL,
    source_sheet          TEXT NOT NULL,
    source_row            INTEGER NOT NULL,
    raw_json              TEXT NOT NULL,
    req_code_entered      TEXT,
    req_code_derived      TEXT,
    req_code_normalized   TEXT,
    validation_status     TEXT NOT NULL DEFAULT 'pending',
    exception_codes       TEXT,
    is_canonical          INTEGER NOT NULL DEFAULT 0,
    canonical_request_id  INTEGER,
    created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(batch_id) REFERENCES migration_batches(id),
    FOREIGN KEY(canonical_request_id) REFERENCES requests(id),
    UNIQUE(batch_id, source_sheet, source_row),
    CHECK (validation_status IN ('pending','valid','exception','approved','imported')),
    CHECK (is_canonical IN (0,1))
  );

  CREATE TABLE IF NOT EXISTS migration_user_map (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        INTEGER NOT NULL,
    old_email       TEXT,
    historical_name TEXT,
    office_email    TEXT,
    target_user_id  INTEGER,
    decision_status TEXT NOT NULL DEFAULT 'pending',
    notes           TEXT,
    FOREIGN KEY(batch_id) REFERENCES migration_batches(id),
    FOREIGN KEY(target_user_id) REFERENCES users(id),
    UNIQUE(batch_id, old_email, historical_name),
    CHECK (decision_status IN ('pending','approved','rejected'))
  );

  CREATE TABLE IF NOT EXISTS migration_department_map (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id            INTEGER NOT NULL,
    source_department   TEXT NOT NULL,
    target_department_id INTEGER,
    decision_status     TEXT NOT NULL DEFAULT 'pending',
    notes               TEXT,
    FOREIGN KEY(batch_id) REFERENCES migration_batches(id),
    FOREIGN KEY(target_department_id) REFERENCES departments(id),
    UNIQUE(batch_id, source_department),
    CHECK (decision_status IN ('pending','approved','rejected'))
  );

  CREATE TABLE IF NOT EXISTS migration_service_map (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id          INTEGER NOT NULL,
    source_department TEXT NOT NULL,
    source_service    TEXT NOT NULL,
    target_service_id INTEGER,
    historical_duration INTEGER,
    decision_status   TEXT NOT NULL DEFAULT 'pending',
    notes             TEXT,
    FOREIGN KEY(batch_id) REFERENCES migration_batches(id),
    FOREIGN KEY(target_service_id) REFERENCES services(id),
    UNIQUE(batch_id, source_department, source_service),
    CHECK (historical_duration IS NULL OR historical_duration > 0),
    CHECK (decision_status IN ('pending','approved','rejected'))
  );

  CREATE INDEX IF NOT EXISTS idx_migration_request_batch
    ON migration_request_stage(batch_id, validation_status);
  CREATE INDEX IF NOT EXISTS idx_migration_closure_batch
    ON migration_closure_stage(batch_id, validation_status);
  CREATE INDEX IF NOT EXISTS idx_migration_request_code
    ON migration_request_stage(batch_id, req_code_normalized);
  CREATE INDEX IF NOT EXISTS idx_migration_closure_code
    ON migration_closure_stage(batch_id, req_code_normalized);
`);

// ── Migrations for columns added after first release ─────────
//
// The pattern, same as docTracking: read PRAGMA table_info, add what is
// missing. Safe to run on every boot, on an empty database or a full one.
function columns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}
function addColumn(table, name, decl) {
  if (!columns(table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    console.log(`[DB] migrated: ${table}.${name}`);
  }
}

// The job title AD already knows. Worth carrying so the requests table can show
// who filed something without a second lookup.
addColumn('users', 'title', 'TEXT');
// AD's own department string, kept verbatim next to our department_id. They are
// not the same thing: AD's is free text typed by whoever created the account,
// ours is a row with a service-code prefix. Keeping both is what makes the
// import screen able to suggest a match instead of guessing silently.
addColumn('users', 'ad_department', 'TEXT');

// Set when مدير النظام gives an Active Directory account a local password on the
// المستخدمون screen. The password itself is in password_hash like any other, and
// sign-in needs nothing else — so this column exists for the two questions the
// hash alone can no longer answer:
//
//   • is this row still an AD person? The screen says so, and the import path
//     needs it: a hash used to be proof of a separate local account, and since
//     the override it is not.
//   • was the directory deliberately bypassed for this account? That is worth
//     being able to read off the row rather than digging through the audit log.
addColumn('users', 'ad_password_override', 'INTEGER NOT NULL DEFAULT 0');

// Historical-import provenance. Defaults keep every request created through
// the normal application path operational rather than migrated.
addColumn('requests', 'is_migrated', 'INTEGER NOT NULL DEFAULT 0');
addColumn('requests', 'migration_batch_id', 'INTEGER');
addColumn('requests', 'legacy_source_row', 'INTEGER');
addColumn('requests', 'original_email', 'TEXT');
addColumn('requests', 'closure_original_email', 'TEXT');
addColumn('requests', 'responsible_name_snapshot', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_requests_migration_batch ON requests(migration_batch_id, is_migrated)');

// The session's authoritative link to an account. Existing rows are backfilled
// from the username they already carry; any that cannot be matched are deleted
// rather than left with a NULL user_id, because a session that cannot say whose
// it is must not be honoured — those people simply sign in again.
if (!columns('sessions').includes('user_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');
  db.exec('UPDATE sessions SET user_id = (SELECT u.id FROM users u WHERE u.username = sessions.username)');
  const orphaned = db.prepare('DELETE FROM sessions WHERE user_id IS NULL').run().changes;
  console.log(`[DB] migrated: sessions.user_id${orphaned ? ` (${orphaned} unmatched session(s) dropped)` : ''}`);
}
// Unconditional, and after the ALTER above: on a fresh database the column came
// from CREATE TABLE and the migration did not run, so this is the only place
// that reaches both cases.
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');

// ── Reference data helpers ───────────────────────────────────

/**
 * The next رقم الطلب. Format is the prototype's: two-digit year + six digits,
 * e.g. 26010001.
 *
 * The prototype drew those six digits at random and re-drew on collision. The
 * application now keeps a separate operational sequence and skips any code
 * already occupied by imported history. A historical random maximum therefore
 * cannot force the sequence past the eight-digit format.
 *
 * Callers must run this inside the same transaction as the INSERT; the UNIQUE
 * index on req_code is the real guarantee.
 */
function nextReqCode() {
  const yy = String(new Date().getFullYear()).slice(-2);
  let sequence = db.prepare(
    'SELECT last_number FROM request_sequences WHERE year_prefix = ?'
  ).get(yy);

  // Upgrade path for an existing installation: seed the operational sequence
  // from requests created by the app, explicitly excluding imported history.
  if (!sequence) {
    const existing = db.prepare(`
      SELECT MAX(CAST(substr(req_code, 3) AS INTEGER)) AS last_number
        FROM requests
       WHERE is_migrated = 0
         AND length(req_code) = 8
         AND substr(req_code, 1, 2) = ?
         AND req_code NOT GLOB '*[^0-9]*'
    `).get(yy);
    const last = Number(existing?.last_number || 0);
    db.prepare('INSERT INTO request_sequences (year_prefix, last_number) VALUES (?, ?)')
      .run(yy, Math.min(last, 999999));
    sequence = { last_number: Math.min(last, 999999) };
  }

  let number = Number(sequence.last_number || 0);
  while (number < 999999) {
    number += 1;
    const candidate = yy + String(number).padStart(6, '0');
    if (!db.prepare('SELECT 1 FROM requests WHERE req_code = ?').get(candidate)) {
      db.prepare(`
        UPDATE request_sequences
           SET last_number = ?, updated_at = datetime('now','localtime')
         WHERE year_prefix = ?
      `).run(number, yy);
      return candidate;
    }
  }

  throw new Error(`No eight-digit request numbers remain for year prefix ${yy}`);
}

/**
 * The next service code for a department: PREFIX-001, PREFIX-002 …
 * Counts only codes already using that prefix, so renaming a department's
 * prefix does not renumber its existing services.
 */
function nextServiceCode(departmentId) {
  const dept = db.prepare('SELECT prefix FROM departments WHERE id = ?').get(departmentId);
  const prefix = dept?.prefix || 'SRV';
  const rows = db.prepare(
    "SELECT code FROM services WHERE department_id = ? AND code LIKE ?"
  ).all(departmentId, `${prefix}-%`);

  const nums = rows
    .map(r => Number(String(r.code).split('-').pop()))
    .filter(Number.isFinite);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

console.log(`[DB] SQLite ready: ${DB_PATH}`);

module.exports = { db, nextReqCode, nextServiceCode, DB_PATH };
