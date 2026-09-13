// server/scripts/data-check.js
//
//   npm run data-check
//
// Reads the database and looks for records that contradict the rules the system
// is supposed to guarantee. Everything here SHOULD find nothing — each check
// exists because that particular shape of wrong data would be invisible on
// screen while quietly changing an ISO figure.
//
// Read-only: it opens the database, runs SELECTs, and changes nothing.
require('dotenv').config();
const { db } = require('../db');
const { today, addWorkingDays, workingDaysBetween, loadHolidays } = require('../utils/workdays');

let issues = 0;
function report(title, rows, explain) {
  if (!rows.length) { console.log(`  ✓ ${title}`); return; }
  issues += rows.length;
  console.log(`  ✗ ${title} — ${rows.length}`);
  if (explain) console.log(`      ${explain}`);
  rows.slice(0, 10).forEach(r => console.log(`      · ${JSON.stringify(r)}`));
  if (rows.length > 10) console.log(`      … and ${rows.length - 10} more`);
}

console.log('\n نظام تسجيل الجودة — فحص البيانات\n');
console.log(`today = ${today()}\n`);

// ── Deadlines ──
// The stored الموعد النهائي must equal what the engine computes from the
// request date, the promised duration and the holiday calendar. A mismatch on
// an OPEN request means a deadline was written by something other than the
// engine — which is exactly the class of bug that moving this logic to the
// server was meant to end.
console.log('deadlines');
const holidays = loadHolidays();
const openRows = db.prepare("SELECT id, req_code, request_date, duration, due_date FROM requests WHERE status='Open'").all();
const wrongDue = openRows
  .map(r => ({ ...r, expected: addWorkingDays(r.request_date, r.duration, holidays) }))
  .filter(r => r.expected !== r.due_date)
  .map(r => ({ req: r.req_code, stored: r.due_date, expected: r.expected }));
report('open requests whose deadline matches the calendar', wrongDue,
  'run the holidays endpoint once, or investigate — recalcOpenDueDates() should keep these in step');

// Closed requests keep the deadline they were judged against, so they are NOT
// checked against today's calendar. Their delay arithmetic still has to hold.
const closed = db.prepare(`
  SELECT id, req_code, due_date, close_date, delay_days, is_on_time
    FROM requests WHERE status='Closed'
`).all();

const wrongDelay = closed
  .map(r => {
    const late = r.close_date > r.due_date;
    const expected = late ? workingDaysBetween(r.due_date, r.close_date, holidays) : 0;
    return { ...r, late, expected };
  })
  .filter(r => Number(r.delay_days) !== r.expected)
  .map(r => ({ req: r.req_code, stored: r.delay_days, expected: r.expected }));
report('closed requests whose أيام التأخير matches the dates', wrongDelay);

const wrongOnTime = closed
  .filter(r => {
    const late = r.close_date > r.due_date;
    return (r.is_on_time === 1) === late; // on-time flag disagrees with the dates
  })
  .map(r => ({ req: r.req_code, close: r.close_date, due: r.due_date, isOnTime: r.is_on_time }));
report('closed requests whose الإنجاز في الوقت matches the dates', wrongOnTime,
  'this flag is what the on-time percentage is computed from');

// ── Request integrity ──
console.log('\nrequests');
report('closed requests have a closing date',
  db.prepare("SELECT req_code FROM requests WHERE status='Closed' AND (close_date IS NULL OR close_date='')").all());
report('closing dates are not before the request date',
  db.prepare('SELECT req_code, request_date, close_date FROM requests WHERE close_date IS NOT NULL AND close_date < request_date').all());
report('closing dates are not in the future',
  db.prepare('SELECT req_code, close_date FROM requests WHERE close_date > ?').all(today()));
report('request dates are not in the future',
  db.prepare('SELECT req_code, request_date FROM requests WHERE request_date > ?').all(today()));
report('late closures record a reason',
  db.prepare(`
    SELECT req_code FROM requests
     WHERE status='Closed' AND close_date > due_date AND (delay_reason IS NULL OR delay_reason='')
  `).all(),
  'the delay analysis counts these by reason; a blank one is uncountable');
report('"أسباب أخرى" closures say what the reason was',
  db.prepare(`
    SELECT req_code FROM requests
     WHERE delay_reason='أسباب أخرى' AND (other_delay_reason IS NULL OR other_delay_reason='')
  `).all());
report('every request points at a real user',
  db.prepare('SELECT r.req_code FROM requests r LEFT JOIN users u ON u.id=r.user_id WHERE u.id IS NULL').all());
report('every request points at a real service',
  db.prepare('SELECT r.req_code FROM requests r LEFT JOIN services s ON s.id=r.service_id WHERE s.id IS NULL').all());
report('request codes are unique',
  db.prepare('SELECT req_code, COUNT(*) n FROM requests GROUP BY req_code HAVING n > 1').all());

// The snapshot columns are supposed to be frozen at creation. A request whose
// department_snapshot no longer matches the department it points at is not
// necessarily wrong — the department may have been renamed since, which is the
// case the snapshot exists for — so this is reported as information.
const renamed = db.prepare(`
  SELECT r.req_code, r.department_snapshot, d.name AS current_name
    FROM requests r JOIN departments d ON d.id = r.department_id
   WHERE r.department_snapshot <> d.name
`).all();
if (renamed.length) {
  console.log(`  i ${renamed.length} request(s) recorded under a department name that has since changed — expected after a rename, not an error`);
}

// ── Reference data ──
console.log('\nreference data');
report('service codes are unique',
  db.prepare('SELECT code, COUNT(*) n FROM services GROUP BY code HAVING n > 1').all());
report('department prefixes are unique',
  db.prepare('SELECT prefix, COUNT(*) n FROM departments GROUP BY prefix COLLATE NOCASE HAVING n > 1').all());
report('service durations are positive',
  db.prepare('SELECT code, duration FROM services WHERE duration IS NULL OR duration < 1').all());
report('holiday end dates match start + duration',
  db.prepare('SELECT id, name, start_date, duration, end_date FROM holidays').all()
    .filter(h => {
      const d = new Date(h.start_date + 'T12:00:00');
      d.setDate(d.getDate() + Math.max(0, h.duration - 1));
      const expected = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      return expected !== h.end_date;
    })
    .map(h => ({ id: h.id, name: h.name, stored: h.end_date })));

// ── Accounts ──
console.log('\naccounts');
report('every active user has a department',
  db.prepare('SELECT id, full_name FROM users WHERE is_active=1 AND department_id IS NULL').all(),
  'a user with no department cannot file a request');
report('every user has a sign-in name (username or email)',
  db.prepare("SELECT id, full_name FROM users WHERE (username IS NULL OR username='') AND (email IS NULL OR email='')").all());
report('roles are known values',
  db.prepare("SELECT id, full_name, role FROM users WHERE role NOT IN ('user','supervisor','power')").all());
report('every user points at a real department',
  db.prepare('SELECT u.id, u.full_name FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.department_id IS NOT NULL AND d.id IS NULL').all());

// At least one person must be able to reach إدارة النظام. Zero is the state
// nobody notices until they need it.
const admins = db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin=1 AND is_active=1').get().n;
const override = (process.env.SUPER_ADMIN_USERS || '').split(',').filter(s => s.trim()).length;
if (admins || override) {
  console.log(`  ✓ ${admins} active admin account(s)${override ? ` + ${override} from SUPER_ADMIN_USERS` : ''}`);
} else {
  issues++;
  console.log('  ✗ nobody can reach إدارة النظام — no active admin and no SUPER_ADMIN_USERS override');
}

// ── Sessions ──
console.log('\nsessions');
const stale = db.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at < ?').get(new Date().toISOString()).n;
if (stale) {
  console.log(`  i ${stale} expired session row(s) — harmless, refused on use; delete them any time`);
} else {
  console.log('  ✓ no expired session rows');
}
report('sessions belong to real accounts',
  db.prepare('SELECT s.jti, s.username FROM sessions s LEFT JOIN users u ON u.username=s.username WHERE u.id IS NULL').all());

console.log('');
console.log(issues ? `${issues} issue(s) found.\n` : 'No issues found.\n');
process.exit(issues ? 1 : 0);
