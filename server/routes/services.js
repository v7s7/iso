// server/routes/services.js
//
// الخدمات — the catalogue. Each service carries its promised turnaround in
// working days, which is where every الموعد النهائي in the system comes from.
const express = require('express');
const { db, nextServiceCode } = require('../db');
const { verifyToken, blockUntilPasswordChanged } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../utils/permissions');
const { logAudit, readableDiff } = require('../utils/audit');

const router = express.Router();
router.use(verifyToken, blockUntilPasswordChanged);

function toClient(s) {
  return {
    id: s.id, code: s.code, name: s.name,
    departmentId: s.department_id, departmentName: s.department_name || '',
    duration: s.duration, active: !!s.is_active,
    requestCount: s.request_count ?? undefined,
  };
}

const SELECT_SQL = `
  SELECT s.*, d.name AS department_name,
         (SELECT COUNT(*) FROM requests r WHERE r.service_id = s.id) AS request_count
    FROM services s JOIN departments d ON d.id = s.department_id
`;

// ── GET /api/services ────────────────────────────────────────
// ?mine=1 narrows to the caller's own department and active services only —
// what the new-request form needs, so it does not have to filter client-side
// and risk offering a service the server will refuse.
router.get('/', (req, res) => {
  let rows;
  if (req.query.mine === '1') {
    if (!req.user.department_id) return res.json({ success: true, services: [] });
    rows = db.prepare(`${SELECT_SQL} WHERE s.department_id = ? AND s.is_active = 1 AND d.is_active = 1 ORDER BY s.code`)
      .all(req.user.department_id);
  } else {
    rows = db.prepare(`${SELECT_SQL} ORDER BY s.code`).all();
  }
  res.json({ success: true, services: rows.map(toClient) });
});

// ── POST /api/services ───────────────────────────────────────
router.post('/', requireAdmin, (req, res) => {
  const departmentId = Number(req.body?.departmentId);
  const name         = String(req.body?.name || '').trim();
  const duration     = Number(req.body?.duration);
  const active       = req.body?.active === undefined ? true : !!req.body.active;

  if (!departmentId || !name) {
    return res.status(400).json({ success: false, message: 'القسم واسم الخدمة مطلوبان.' });
  }
  if (!Number.isInteger(duration) || duration < 1) {
    return res.status(400).json({ success: false, message: 'مدة الخدمة يجب أن تكون يوم عمل واحداً على الأقل.' });
  }
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(departmentId);
  if (!dept) return res.status(404).json({ success: false, message: 'القسم غير موجود.' });

  const dup = db.prepare('SELECT 1 FROM services WHERE department_id = ? AND name = ? COLLATE NOCASE').get(departmentId, name);
  if (dup) return res.status(409).json({ success: false, message: 'يوجد خدمة بنفس الاسم داخل هذا القسم.' });

  // The code is generated, never typed. It has to be unique and has to carry
  // the department's prefix, and both of those stop being true the moment a
  // person is allowed to enter it by hand.
  const create = db.transaction(() => {
    const code = nextServiceCode(departmentId);
    const info = db.prepare(
      'INSERT INTO services (code, name, department_id, duration, is_active) VALUES (?,?,?,?,?)'
    ).run(code, name, departmentId, duration, active ? 1 : 0);
    return { id: info.lastInsertRowid, code };
  });
  const { id, code } = create();

  logAudit(req.user, 'إنشاء خدمة', 'service', code,
    { newValue: `${name}، ${dept.name}، ${duration} يوم عمل` }, req.ip);

  res.status(201).json({ success: true, service: toClient(db.prepare(`${SELECT_SQL} WHERE s.id = ?`).get(id)) });
});

// ── PUT /api/services/:id ────────────────────────────────────
router.put('/:id', requireAdmin, (req, res) => {
  const current = db.prepare(`${SELECT_SQL} WHERE s.id = ?`).get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'الخدمة غير موجودة.' });

  const name     = req.body?.name     !== undefined ? String(req.body.name).trim() : current.name;
  const duration = req.body?.duration !== undefined ? Number(req.body.duration)    : current.duration;
  const active   = req.body?.active   !== undefined ? !!req.body.active            : !!current.is_active;

  if (!name) return res.status(400).json({ success: false, message: 'اسم الخدمة مطلوب.' });
  if (!Number.isInteger(duration) || duration < 1) {
    return res.status(400).json({ success: false, message: 'مدة الخدمة يجب أن تكون يوم عمل واحداً على الأقل.' });
  }

  const dup = db.prepare('SELECT 1 FROM services WHERE department_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(current.department_id, name, current.id);
  if (dup) return res.status(409).json({ success: false, message: 'يوجد خدمة بنفس الاسم داخل هذا القسم.' });

  // Neither the code nor the department moves. Both are copied onto every
  // request filed against this service, and changing them here would leave the
  // catalogue saying one thing and the records another.
  db.prepare(`
    UPDATE services SET name = ?, duration = ?, is_active = ?,
                        updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(name, duration, active ? 1 : 0, current.id);

  const diff = readableDiff(
    { 'الاسم': current.name, 'المدة': `${current.duration} يوم عمل`, 'الحالة': current.is_active ? 'فعال' : 'غير فعال' },
    { 'الاسم': name,         'المدة': `${duration} يوم عمل`,          'الحالة': active ? 'فعال' : 'غير فعال' }
  );
  if (diff.changed.length) {
    logAudit(req.user, 'تعديل خدمة', 'service', current.code,
      { oldValue: diff.oldValue, newValue: diff.newValue }, req.ip);
  }

  // Note for whoever changes a duration: OPEN requests keep the duration they
  // were filed under, because that is the promise that was made at the time.
  // The new duration applies to requests filed from now on.
  res.json({
    success: true,
    service: toClient(db.prepare(`${SELECT_SQL} WHERE s.id = ?`).get(current.id)),
    note: duration !== current.duration
      ? 'المدة الجديدة تُطبَّق على الطلبات الجديدة فقط؛ الطلبات المفتوحة تحتفظ بالمدة التي سُجِّلت بها.'
      : undefined,
  });
});

// ── POST /api/services/:id/toggle ────────────────────────────
router.post('/:id/toggle', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'الخدمة غير موجودة.' });

  const next = current.is_active ? 0 : 1;
  db.prepare("UPDATE services SET is_active = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(next, current.id);

  logAudit(req.user, next ? 'تفعيل خدمة' : 'تعطيل خدمة', 'service', current.code, {
    oldValue: current.is_active ? 'فعال' : 'غير فعال',
    newValue: next ? 'فعال' : 'غير فعال',
  }, req.ip);

  res.json({ success: true, service: toClient(db.prepare(`${SELECT_SQL} WHERE s.id = ?`).get(current.id)) });
});

module.exports = router;
