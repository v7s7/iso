// server/scripts/seed.js
//
//   node scripts/seed.js            — reference data + test accounts, if absent
//   node scripts/seed.js --demo     — the above, plus the Build 0.8 sample requests
//   node scripts/seed.js --reset    — WIPE every table first, then seed
//
// Idempotent without --reset: it inserts what is missing and leaves everything
// else alone, so running it twice does not duplicate a department or reset a
// password someone has already changed.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { addWorkingDays, workingDaysBetween, loadHolidays } = require('../utils/workdays');

const RESET = process.argv.includes('--reset');
const DEMO  = process.argv.includes('--demo') || RESET;

// The Build 0.8 reference data, carried over unchanged so the seeded system
// matches what has already been tested against.
const DEPARTMENTS = [
  { name: 'قسم الموارد والمعلومات',       prefix: 'IT'  },
  { name: 'قسم الصيانة',                   prefix: 'MNT' },
  { name: 'قسم المساجد والإرشاد الديني',   prefix: 'MSJ' },
  { name: 'مجموعة الاتصال وخدمة العملاء',  prefix: 'COM' },
  { name: 'قسم الاستثمارات الوقفية',       prefix: 'INV' },
];

const SERVICES = [
  { code: 'IT-001',  name: 'الدعم الفني والتقني من الإدارة',              dept: 'IT',  duration: 3  },
  { code: 'IT-002',  name: 'إنشاء / تعديل حساب مستخدم',                    dept: 'IT',  duration: 2  },
  { code: 'MNT-001', name: 'الصيانة الخفيفة',                              dept: 'MNT', duration: 5  },
  { code: 'MNT-002', name: 'الصيانة الثقيلة',                              dept: 'MNT', duration: 10 },
  { code: 'MSJ-001', name: 'الزيارات الدورية',                             dept: 'MSJ', duration: 7  },
  { code: 'MSJ-002', name: 'اختبار المتقدمين لوظيفة الإمامة والأّذان',      dept: 'MSJ', duration: 10 },
  { code: 'COM-001', name: 'اعداد ونشر مطالعات الصحف اليومية',             dept: 'COM', duration: 1  },
  { code: 'INV-001', name: 'أخرى',                                          dept: 'INV', duration: 5  },
];

// Local test accounts — the same four the prototype documents, plus the three
// extra staff its dashboard filters need. Passwords are hashed with bcrypt; the
// plaintext is never stored, unlike the prototype where it sat in localStorage.
const TEST_PASSWORD = 'Test123';
const USERS = [
  { username: 'hisham',      email: 'hisham@test.local',      name: 'هشام محمد حياة',        dept: 'IT',  role: 'user',       admin: 0 },
  { username: 'supervisor',  email: 'supervisor@test.local',  name: 'مشرف الموارد والمعلومات', dept: 'IT',  role: 'supervisor', admin: 0 },
  { username: 'maintenance', email: 'maintenance@test.local', name: 'مستخدم الصيانة',         dept: 'MNT', role: 'user',       admin: 0 },
  { username: 'power',       email: 'power@test.local',       name: 'المستخدم الشامل',        dept: 'MSJ', role: 'power',      admin: 0 },
  { username: 'admin',       email: 'admin@test.local',       name: 'مدير النظام',            dept: 'IT',  role: 'power',      admin: 1 },
  { username: 'ahmed.it',    email: 'ahmed.it@test.local',    name: 'أحمد موظف الموارد',      dept: 'IT',  role: 'user',       admin: 0 },
  { username: 'sara.it',     email: 'sara.it@test.local',     name: 'سارة موظفة الموارد',     dept: 'IT',  role: 'user',       admin: 0 },
];

const HOLIDAYS = [
  { type: 'أخرى', name: 'عطلة تجريبية بعيدة عن اختبارنا الحالي', startDate: '2026-09-16', duration: 1 },
];

// [user, serviceCode, subject, requestDate, status, closeDate?, delayReason?]
const DEMO_REQUESTS = [
  ['hisham',      'IT-001',  'مشكلة في طابعة مكتب الاستقبال',  '2026-08-26', 'Open'],
  ['hisham',      'IT-002',  'إنشاء حساب لموظف جديد',           '2026-08-24', 'Closed', '2026-08-25'],
  ['hisham',      'IT-001',  'جهاز لا يتصل بالشبكة',            '2026-08-18', 'Open'],
  ['maintenance', 'MNT-001', 'صيانة مكيف في مسجد تجريبي',       '2026-08-20', 'Open'],
  ['maintenance', 'MNT-002', 'تسرب مياه في السقف',              '2026-08-10', 'Closed', '2026-08-27', 'الحاجة إلى وقت إضافي لاستكمال الطلب'],
  ['power',       'MSJ-001', 'زيارة مسجد تجريبية',              '2026-08-25', 'Open'],
  ['power',       'MSJ-002', 'اختبار متقدم للإمامة',            '2026-08-12', 'Closed', '2026-08-20'],
  ['ahmed.it',    'IT-001',  'فحص دوري لأجهزة القسم',           '2026-09-01', 'Open'],
  ['sara.it',     'IT-002',  'تعديل صلاحيات حساب',              '2026-09-02', 'Closed', '2026-09-03'],
];

function log(...a) { console.log('[seed]', ...a); }

if (RESET) {
  log('--reset: wiping every table');
  // Child tables first: foreign_keys is ON, so a parent cannot go before the
  // rows that reference it.
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM request_events;
    DELETE FROM requests;
    DELETE FROM sessions;
    DELETE FROM audit_log;
    DELETE FROM holidays;
    DELETE FROM services;
    DELETE FROM users;
    DELETE FROM departments;
    DELETE FROM sqlite_sequence;
    PRAGMA foreign_keys = ON;
  `);
}

const seed = db.transaction(() => {
  // ── Departments ──
  const deptIdByPrefix = {};
  for (const d of DEPARTMENTS) {
    let row = db.prepare('SELECT id FROM departments WHERE prefix = ?').get(d.prefix);
    if (!row) {
      const info = db.prepare('INSERT INTO departments (name, prefix, is_active) VALUES (?,?,1)').run(d.name, d.prefix);
      row = { id: info.lastInsertRowid };
      log(`department + ${d.name} (${d.prefix})`);
    }
    deptIdByPrefix[d.prefix] = row.id;
  }

  // ── Services ──
  for (const s of SERVICES) {
    const exists = db.prepare('SELECT 1 FROM services WHERE code = ?').get(s.code);
    if (!exists) {
      db.prepare('INSERT INTO services (code, name, department_id, duration, is_active) VALUES (?,?,?,?,1)')
        .run(s.code, s.name, deptIdByPrefix[s.dept], s.duration);
      log(`service + ${s.code} (${s.duration} يوم عمل)`);
    }
  }

  // ── Users ──
  const hash = bcrypt.hashSync(TEST_PASSWORD, 10);
  for (const u of USERS) {
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(u.username, u.email);
    if (!exists) {
      db.prepare(`
        INSERT INTO users (username, email, password_hash, full_name, department_id,
                           role, is_admin, is_active, force_password_change, created_by)
        VALUES (?,?,?,?,?,?,?,1,0,'SEED')
      `).run(u.username, u.email, hash, u.name, deptIdByPrefix[u.dept], u.role, u.admin);
      log(`user + ${u.email} (${u.role}${u.admin ? ', مدير نظام' : ''})`);
    }
  }

  // ── Holidays ──
  const { addCalendarDays } = require('../utils/workdays');
  for (const h of HOLIDAYS) {
    const exists = db.prepare('SELECT 1 FROM holidays WHERE name = ? AND start_date = ?').get(h.name, h.startDate);
    if (!exists) {
      db.prepare('INSERT INTO holidays (type, name, start_date, duration, end_date) VALUES (?,?,?,?,?)')
        .run(h.type, h.name, h.startDate, h.duration, addCalendarDays(h.startDate, h.duration));
      log(`holiday + ${h.name}`);
    }
  }
});

seed();

// ── Demo requests ──
// Separate from the transaction above, and skipped entirely when requests
// already exist: this is sample data, and it must never land on top of real
// records someone has filed.
if (DEMO) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  if (existing > 0) {
    log(`${existing} request(s) already present — skipping demo requests`);
  } else {
    const holidays = loadHolidays();
    const insert = db.transaction(() => {
      let n = 1;
      const yy = String(new Date().getFullYear()).slice(-2);

      for (const [username, code, subject, requestDate, status, closeDate, delayReason] of DEMO_REQUESTS) {
        const user = db.prepare(`
          SELECT u.*, d.name AS department_name FROM users u
            LEFT JOIN departments d ON d.id = u.department_id WHERE u.username = ?
        `).get(username);
        const svc = db.prepare('SELECT * FROM services WHERE code = ?').get(code);
        if (!user || !svc) { log(`skip: ${username}/${code} not found`); continue; }

        const dueDate = addWorkingDays(requestDate, svc.duration, holidays);
        const closed  = status === 'Closed';
        const late    = closed && closeDate > dueDate;
        const reqCode = yy + String(n++).padStart(6, '0');

        const info = db.prepare(`
          INSERT INTO requests (
            req_code, user_id, requester_name, office_email, department_id, department_snapshot,
            service_id, service_code, service_name, duration, subject, notes,
            request_date, due_date, status, close_date, closed_at,
            delay_reason, other_delay_reason, closure_notes, delay_days, is_on_time, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'',?,?,?,?,?,?,'','',?,?,?)
        `).run(
          reqCode, user.id, user.full_name, user.email, user.department_id, user.department_name,
          svc.id, svc.code, svc.name, svc.duration, subject,
          requestDate, dueDate, status,
          closed ? closeDate : null,
          closed ? `${closeDate} 14:00:00` : null,
          late ? (delayReason || '') : '',
          late ? workingDaysBetween(dueDate, closeDate, holidays) : 0,
          closed ? (late ? 0 : 1) : null,
          `${requestDate} 09:00:00`
        );

        db.prepare('INSERT INTO request_events (request_id, type, actor_id, actor_name, note, created_at) VALUES (?,?,?,?,?,?)')
          .run(info.lastInsertRowid, 'created', user.id, user.full_name, subject, `${requestDate} 09:00:00`);
        if (closed) {
          db.prepare('INSERT INTO request_events (request_id, type, actor_id, actor_name, note, created_at) VALUES (?,?,?,?,?,?)')
            .run(info.lastInsertRowid, 'closed', user.id, user.full_name,
                 late ? `متأخر — ${delayReason || ''}` : 'أُغلق في الوقت المحدد', `${closeDate} 14:00:00`);
        }
      }
    });
    insert();
    log(`${DEMO_REQUESTS.length} demo request(s) created`);
  }
}

db.prepare(`
  INSERT INTO audit_log (actor_username, actor_role, action, target_type, target_id, new_value)
  VALUES ('SEED','system','تهيئة البيانات','system','seed',?)
`).run(RESET ? 'إعادة تهيئة كاملة' : 'تهيئة البيانات المرجعية');

const counts = {
  departments: db.prepare('SELECT COUNT(*) n FROM departments').get().n,
  services:    db.prepare('SELECT COUNT(*) n FROM services').get().n,
  users:       db.prepare('SELECT COUNT(*) n FROM users').get().n,
  holidays:    db.prepare('SELECT COUNT(*) n FROM holidays').get().n,
  requests:    db.prepare('SELECT COUNT(*) n FROM requests').get().n,
};

console.log('');
log('done:', JSON.stringify(counts));
if (USERS.length) {
  log(`test accounts sign in with password: ${TEST_PASSWORD}`);
  log('  admin@test.local (مدير النظام)  power@test.local  supervisor@test.local  hisham@test.local');
}
