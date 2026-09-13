// server/routes/requests.js
//
// الطلبات — the records the whole ISO system exists to produce.
//
// Two writes: filing one, and closing it. Everything else is reading.
//
// What moved server-side, and why it matters: the deadline, the delay and the
// on-time verdict are now computed here from the holiday calendar in the
// database. In the prototype they came out of the browser, which meant a user's
// clock, a stale tab, or the developer console could each produce a different
// answer to "was this on time?" — the one number an ISO audit actually asks
// about.
const express = require('express');
const { db, nextReqCode } = require('../db');
const { verifyToken, blockUntilPasswordChanged } = require('../middleware/authMiddleware');
const { visibilityClause, canViewRequest, canCloseRequest } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const {
  today, addWorkingDays, workingDaysBetween, loadHolidays,
  isLate, currentDelayDays, isDueSoon,
} = require('../utils/workdays');

const router = express.Router();
router.use(verifyToken, blockUntilPasswordChanged);

// أسباب التأخير. Fixed list, because the delay analysis is a count per reason —
// free text would make it uncountable. 'أسباب أخرى' is the escape hatch, and it
// requires the author to write what actually happened.
const DELAY_REASONS = [
  'إحالة الطلب إلى جهة أخرى للاعتماد أو المراجعة',
  'غياب الموظف المسؤول أو تغيير المسؤول عن الطلب',
  'نقص المعلومات أو المستندات المطلوبة',
  'طلب استكمال بيانات إضافية من مقدم الطلب',
  'مشكلات تقنية أو أعطال في الأنظمة الإلكترونية',
  'الحاجة إلى وقت إضافي لاستكمال الطلب',
  'تأخير في الموافقات الداخلية أو الخارجية',
  'تحديث السياسات أو اللوائح المتعلقة بنوع الطلب',
  'أسباب أخرى',
];
const OTHER_REASON = 'أسباب أخرى';

/** The row shape the UI already speaks — camelCase, same field names as the
 *  prototype's request objects, plus the two values it used to compute itself. */
function toClient(r, holidays) {
  return {
    id:                 r.id,
    reqCode:            r.req_code,
    userId:             r.user_id,
    requesterName:      r.requester_name,
    officeEmail:        r.office_email || '',
    departmentId:       r.department_id,
    departmentSnapshot: r.department_snapshot,
    serviceId:          r.service_id,
    serviceCode:        r.service_code,
    serviceName:        r.service_name,
    duration:           r.duration,
    subject:            r.subject,
    notes:              r.notes || '',
    requestDate:        r.request_date,
    createdAt:          r.created_at,
    dueDate:            r.due_date,
    status:             r.status,
    closeDate:          r.close_date || '',
    closedAt:           r.closed_at || '',
    delayReason:        r.delay_reason || '',
    otherDelayReason:   r.other_delay_reason || '',
    closureNotes:       r.closure_notes || '',
    delayDays:          r.delay_days || 0,
    isOnTime:           r.is_on_time === null ? null : !!r.is_on_time,
    // Computed server-side so every screen agrees, and so an export and a
    // dashboard can never disagree about the same request.
    isLate:             isLate(r),
    currentDelayDays:   currentDelayDays(r, holidays),
    isDueSoon:          isDueSoon(r, holidays),
  };
}

const SELECT_SQL = 'SELECT r.* FROM requests r';

// ── GET /api/requests ────────────────────────────────────────
// Everything the caller is allowed to see. The dashboard filters on top of this
// in the browser — it is at most a few thousand rows for one organisation, and
// keeping the filtering in one place is what makes the table, the cards, the
// charts and the Excel export agree by construction.
router.get('/', (req, res) => {
  const { clause, params } = visibilityClause(req.user);
  const rows = db.prepare(`${SELECT_SQL} WHERE ${clause} ORDER BY r.created_at DESC, r.id DESC`).all(...params);
  const holidays = loadHolidays();
  res.json({ success: true, requests: rows.map(r => toClient(r, holidays)), today: today() });
});

// ── GET /api/requests/delay-reasons ──────────────────────────
// Served rather than duplicated in the client, so the list the UI offers and
// the list the server validates against cannot drift apart.
router.get('/delay-reasons', (_req, res) => {
  res.json({ success: true, reasons: DELAY_REASONS, otherReason: OTHER_REASON });
});

// ── GET /api/requests/:code ──────────────────────────────────
router.get('/:code', (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE req_code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ success: false, message: 'الطلب غير موجود.' });
  if (!canViewRequest(req.user, row)) {
    return res.status(403).json({ success: false, message: 'غير مصرح بعرض هذا الطلب.' });
  }

  const events = db.prepare(
    'SELECT type, actor_name, note, created_at FROM request_events WHERE request_id = ? ORDER BY id'
  ).all(row.id);

  res.json({
    success: true,
    request: toClient(row, loadHolidays()),
    events,
    canClose: canCloseRequest(req.user, row),
  });
});

// ── POST /api/requests ───────────────────────────────────────
// تسجيل طلب جديد.
router.post('/', (req, res) => {
  const serviceId   = Number(req.body?.serviceId);
  const requestDate = String(req.body?.requestDate || '').trim();
  const subject     = String(req.body?.subject || '').trim();
  const notes       = String(req.body?.notes || '').trim();

  if (!serviceId || !requestDate || !subject) {
    return res.status(400).json({ success: false, message: 'الخدمة والموضوع وتاريخ الطلب حقول مطلوبة.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) {
    return res.status(400).json({ success: false, message: 'صيغة تاريخ الطلب غير صحيحة.' });
  }
  // A request cannot be filed in the future. Backdating IS allowed — paperwork
  // arrives before it is entered — but a future date would start the clock
  // before the work exists and quietly inflate the on-time figures.
  if (requestDate > today()) {
    return res.status(400).json({ success: false, message: 'تاريخ الطلب لا يمكن أن يكون في المستقبل.' });
  }
  if (!req.user.department_id) {
    return res.status(400).json({ success: false, message: 'لم يتم تحديد قسم لحسابك. يرجى مراجعة مدير النظام.' });
  }

  const service = db.prepare(`
    SELECT s.*, d.name AS department_name, d.is_active AS dept_active
      FROM services s JOIN departments d ON d.id = s.department_id
     WHERE s.id = ?
  `).get(serviceId);

  if (!service) {
    return res.status(404).json({ success: false, message: 'الخدمة غير موجودة.' });
  }
  // A person files against their OWN department's catalogue. Checked here and
  // not only in the dropdown: the dropdown is a convenience, this is the rule.
  if (Number(service.department_id) !== Number(req.user.department_id)) {
    return res.status(403).json({ success: false, message: 'هذه الخدمة تتبع قسماً آخر.' });
  }
  if (!service.is_active || !service.dept_active) {
    return res.status(400).json({ success: false, message: 'هذه الخدمة غير مفعّلة حالياً.' });
  }

  const dueDate = addWorkingDays(requestDate, service.duration);

  // One transaction: the code is read and the row written with nothing able to
  // interleave, which is what makes two simultaneous submissions get two
  // different رقم الطلب rather than one collision.
  const create = db.transaction(() => {
    const reqCode = nextReqCode();
    const info = db.prepare(`
      INSERT INTO requests (
        req_code, user_id, requester_name, office_email,
        department_id, department_snapshot,
        service_id, service_code, service_name, duration,
        subject, notes, request_date, due_date, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Open')
    `).run(
      reqCode, req.user.id, req.user.name, req.user.email || '',
      req.user.department_id, req.user.department_name || service.department_name,
      service.id, service.code, service.name, service.duration,
      subject, notes, requestDate, dueDate
    );
    db.prepare(
      'INSERT INTO request_events (request_id, type, actor_id, actor_name, note) VALUES (?,?,?,?,?)'
    ).run(info.lastInsertRowid, 'created', req.user.id, req.user.name, subject);
    return { id: info.lastInsertRowid, reqCode };
  });

  const { id, reqCode } = create();

  logAudit(req.user, 'تسجيل طلب جديد', 'request', reqCode,
    { newValue: `${service.code} - ${service.name}، الموعد النهائي ${dueDate}`,
      details: { serviceId: service.id, requestDate, dueDate } }, req.ip);

  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  res.status(201).json({ success: true, request: toClient(row, loadHolidays()) });
});

// ── POST /api/requests/:code/close ───────────────────────────
// إغلاق الطلب. The measured event: the on-time percentage is computed from
// exactly this.
router.post('/:code/close', (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE req_code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ success: false, message: 'الطلب غير موجود.' });

  if (!canViewRequest(req.user, row)) {
    return res.status(403).json({ success: false, message: 'غير مصرح بعرض هذا الطلب.' });
  }
  if (row.status !== 'Open') {
    return res.status(409).json({ success: false, message: 'هذا الطلب مغلق بالفعل.' });
  }
  if (!canCloseRequest(req.user, row)) {
    return res.status(403).json({ success: false, message: 'في المرحلة الأولى، منشئ الطلب فقط هو من يغلقه.' });
  }

  const closeDate    = String(req.body?.closeDate || '').trim();
  const delayReason  = String(req.body?.delayReason || '').trim();
  const otherReason  = String(req.body?.otherDelayReason || '').trim();
  const closureNotes = String(req.body?.closureNotes || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) {
    return res.status(400).json({ success: false, message: 'تاريخ الإغلاق مطلوب.' });
  }
  // The window is [request date, today]. Before the request is impossible;
  // after today would let someone close a request into the future and dodge the
  // delay that has not finished accruing.
  if (closeDate < row.request_date || closeDate > today()) {
    return res.status(400).json({ success: false, message: 'تاريخ الإغلاق يجب أن يكون بين تاريخ الطلب واليوم.' });
  }

  const late = closeDate > row.due_date;

  // A late closure without a reason is the case the whole delay analysis is
  // built on, so it is refused rather than stored empty.
  if (late) {
    if (!delayReason) {
      return res.status(400).json({ success: false, message: 'سبب التأخير مطلوب لأن تاريخ الإغلاق بعد الموعد النهائي.' });
    }
    if (!DELAY_REASONS.includes(delayReason)) {
      return res.status(400).json({ success: false, message: 'سبب التأخير غير معروف.' });
    }
    if (delayReason === OTHER_REASON && !otherReason) {
      return res.status(400).json({ success: false, message: 'يرجى كتابة السبب الآخر للتأخير.' });
    }
  }

  const delayDays = late ? workingDaysBetween(row.due_date, closeDate) : 0;

  db.transaction(() => {
    db.prepare(`
      UPDATE requests
         SET status = 'Closed',
             close_date = ?, closed_at = datetime('now','localtime'),
             delay_reason = ?, other_delay_reason = ?, closure_notes = ?,
             delay_days = ?, is_on_time = ?,
             updated_at = datetime('now','localtime')
       WHERE id = ? AND status = 'Open'
    `).run(
      closeDate,
      late ? delayReason : '',
      late && delayReason === OTHER_REASON ? otherReason : '',
      closureNotes,
      delayDays,
      late ? 0 : 1,
      row.id
    );
    db.prepare(
      'INSERT INTO request_events (request_id, type, actor_id, actor_name, note) VALUES (?,?,?,?,?)'
    ).run(row.id, 'closed', req.user.id, req.user.name,
      late ? `متأخر ${delayDays} يوم عمل — ${delayReason}` : 'أُغلق في الوقت المحدد');
  })();

  logAudit(req.user, 'إغلاق طلب', 'request', row.req_code, {
    oldValue: `مفتوح، الموعد النهائي ${row.due_date}`,
    newValue: late ? `مغلق ${closeDate}، متأخر ${delayDays} يوم عمل` : `مغلق ${closeDate} في الوقت المحدد`,
    details: { closeDate, late, delayDays, delayReason: late ? delayReason : '' },
  }, req.ip);

  const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(row.id);
  res.json({ success: true, request: toClient(updated, loadHolidays()) });
});

module.exports = router;
module.exports.DELAY_REASONS = DELAY_REASONS;
