// server/routes/holidays.js
//
// العطلات الرسمية — and therefore, indirectly, every deadline in the system.
//
// Declaring a holiday moves the الموعد النهائي of every OPEN request, because
// the turnaround was promised in working days and a holiday is not one. Closed
// requests keep the deadline they were actually judged against; rewriting that
// would change past ISO results after the fact. recalcOpenDueDates() enforces
// exactly that split, and runs after every write here.
const express = require('express');
const { db } = require('../db');
const { verifyToken, blockUntilPasswordChanged } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../utils/permissions');
const { logAudit, readableDiff } = require('../utils/audit');
const { addCalendarDays, recalcOpenDueDates } = require('../utils/workdays');

const router = express.Router();
router.use(verifyToken, blockUntilPasswordChanged);

// The named public holidays. 'أخرى' is the escape hatch and requires a name.
const HOLIDAY_TYPES = [
  'رأس السنة الميلادية', 'عيد الفطر', 'عيد الأضحى', 'رأس السنة الهجرية',
  'عاشوراء', 'المولد النبوي الشريف', 'العيد الوطني', 'أخرى',
];
const OTHER_TYPE = 'أخرى';

function toClient(h) {
  return {
    id: h.id, type: h.type, name: h.name,
    startDate: h.start_date, duration: h.duration, endDate: h.end_date,
  };
}

// ── GET /api/holidays ────────────────────────────────────────
// Readable by everyone: the client needs the calendar to show why a deadline
// falls where it does.
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM holidays ORDER BY start_date DESC').all();
  res.json({ success: true, holidays: rows.map(toClient), types: HOLIDAY_TYPES, otherType: OTHER_TYPE });
});

function validate(body) {
  const type      = String(body?.type || '').trim();
  const startDate = String(body?.startDate || '').trim();
  const duration  = Number(body?.duration);
  // For a named holiday the type IS the name; only 'أخرى' needs one typed.
  const name      = type === OTHER_TYPE ? String(body?.name || '').trim() : type;

  if (!HOLIDAY_TYPES.includes(type)) return { error: 'نوع العطلة غير معروف.' };
  if (!name) return { error: 'اسم العطلة مطلوب.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return { error: 'تاريخ بداية العطلة مطلوب.' };
  if (!Number.isInteger(duration) || duration < 1) return { error: 'مدة العطلة يجب أن تكون يوماً واحداً على الأقل.' };

  // Calendar days, not working days: عيد الفطر is four days whether or not a
  // weekend falls inside it.
  return { type, name, startDate, duration, endDate: addCalendarDays(startDate, duration) };
}

// ── POST /api/holidays ───────────────────────────────────────
router.post('/', requireAdmin, (req, res) => {
  const v = validate(req.body);
  if (v.error) return res.status(400).json({ success: false, message: v.error });

  // Overlapping holidays are not wrong — an extended عيد can be declared on top
  // of an existing day — and the deadline engine treats any covered date as
  // non-working regardless of how many ranges cover it. So this is not refused.
  const info = db.prepare(
    'INSERT INTO holidays (type, name, start_date, duration, end_date) VALUES (?,?,?,?,?)'
  ).run(v.type, v.name, v.startDate, v.duration, v.endDate);

  const moved = recalcOpenDueDates();

  logAudit(req.user, 'إضافة عطلة رسمية', 'holiday', info.lastInsertRowid, {
    newValue: `${v.name}: ${v.startDate} إلى ${v.endDate}`,
    details: { movedDeadlines: moved },
  }, req.ip);

  res.status(201).json({
    success: true,
    holiday: toClient(db.prepare('SELECT * FROM holidays WHERE id=?').get(info.lastInsertRowid)),
    movedDeadlines: moved,
  });
});

// ── PUT /api/holidays/:id ────────────────────────────────────
router.put('/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM holidays WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'العطلة غير موجودة.' });

  const v = validate(req.body);
  if (v.error) return res.status(400).json({ success: false, message: v.error });

  db.prepare(`
    UPDATE holidays SET type = ?, name = ?, start_date = ?, duration = ?, end_date = ?,
                        updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(v.type, v.name, v.startDate, v.duration, v.endDate, current.id);

  const moved = recalcOpenDueDates();

  const diff = readableDiff(
    { 'الاسم': current.name, 'من': current.start_date, 'إلى': current.end_date },
    { 'الاسم': v.name,       'من': v.startDate,        'إلى': v.endDate }
  );
  if (diff.changed.length) {
    logAudit(req.user, 'تعديل عطلة رسمية', 'holiday', current.id, {
      oldValue: diff.oldValue, newValue: diff.newValue, details: { movedDeadlines: moved },
    }, req.ip);
  }

  res.json({
    success: true,
    holiday: toClient(db.prepare('SELECT * FROM holidays WHERE id=?').get(current.id)),
    movedDeadlines: moved,
  });
});

// ── DELETE /api/holidays/:id ─────────────────────────────────
// A holiday, unlike a department, genuinely can be removed: it was declared in
// error, or moved. Open deadlines are recomputed straight afterwards, so
// removing a wrongly-entered holiday pulls them back rather than leaving the
// error baked into dates nobody will re-check.
router.delete('/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM holidays WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'العطلة غير موجودة.' });

  db.prepare('DELETE FROM holidays WHERE id = ?').run(current.id);
  const moved = recalcOpenDueDates();

  logAudit(req.user, 'حذف عطلة رسمية', 'holiday', current.id, {
    oldValue: `${current.name}: ${current.start_date} إلى ${current.end_date}`,
    newValue: 'محذوفة',
    details: { movedDeadlines: moved },
  }, req.ip);

  res.json({ success: true, movedDeadlines: moved });
});

module.exports = router;
module.exports.HOLIDAY_TYPES = HOLIDAY_TYPES;
