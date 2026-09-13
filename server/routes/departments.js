// server/routes/departments.js
//
// الأقسام. Read by everyone (the dashboard filters and the new-request form
// need the list); written only by مدير النظام.
const express = require('express');
const { db } = require('../db');
const { verifyToken, blockUntilPasswordChanged } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../utils/permissions');
const { logAudit, readableDiff } = require('../utils/audit');

const router = express.Router();
router.use(verifyToken, blockUntilPasswordChanged);

function toClient(d) {
  return {
    id: d.id, name: d.name, prefix: d.prefix,
    ldapGroup: d.ldap_group || '', active: !!d.is_active,
    serviceCount: d.service_count ?? undefined,
    userCount:    d.user_count ?? undefined,
  };
}

// ── GET /api/departments ─────────────────────────────────────
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*,
           (SELECT COUNT(*) FROM services s WHERE s.department_id = d.id) AS service_count,
           (SELECT COUNT(*) FROM users    u WHERE u.department_id = d.id) AS user_count
      FROM departments d
     ORDER BY d.name
  `).all();
  res.json({ success: true, departments: rows.map(toClient) });
});

// ── POST /api/departments ────────────────────────────────────
router.post('/', requireAdmin, (req, res) => {
  const name   = String(req.body?.name || '').trim();
  // Stripped to A-Z0-9 because the prefix becomes part of a service code, and a
  // code with a space or an Arabic letter in it is not something people can
  // read out over the phone.
  const prefix = String(req.body?.prefix || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const active = req.body?.active === undefined ? true : !!req.body.active;
  const ldapGroup = String(req.body?.ldapGroup || '').trim();

  if (!name)   return res.status(400).json({ success: false, message: 'اسم القسم مطلوب.' });
  if (!prefix) return res.status(400).json({ success: false, message: 'بادئة كود الخدمات مطلوبة (أحرف إنجليزية وأرقام).' });

  if (db.prepare('SELECT 1 FROM departments WHERE prefix = ?').get(prefix)) {
    return res.status(409).json({ success: false, message: 'بادئة الكود مستخدمة لقسم آخر.' });
  }
  if (db.prepare('SELECT 1 FROM departments WHERE name = ?').get(name)) {
    return res.status(409).json({ success: false, message: 'يوجد قسم بنفس الاسم.' });
  }

  const info = db.prepare(
    'INSERT INTO departments (name, prefix, ldap_group, is_active) VALUES (?,?,?,?)'
  ).run(name, prefix, ldapGroup || null, active ? 1 : 0);

  logAudit(req.user, 'إنشاء قسم', 'department', info.lastInsertRowid,
    { newValue: `${name} (بادئة ${prefix})` }, req.ip);

  res.status(201).json({ success: true, department: toClient(db.prepare('SELECT * FROM departments WHERE id=?').get(info.lastInsertRowid)) });
});

// ── PUT /api/departments/:id ─────────────────────────────────
router.put('/:id', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'القسم غير موجود.' });

  const name   = req.body?.name   !== undefined ? String(req.body.name).trim()   : current.name;
  const active = req.body?.active !== undefined ? !!req.body.active              : !!current.is_active;
  const ldapGroup = req.body?.ldapGroup !== undefined ? String(req.body.ldapGroup).trim() : (current.ldap_group || '');

  if (!name) return res.status(400).json({ success: false, message: 'اسم القسم مطلوب.' });

  const clash = db.prepare('SELECT 1 FROM departments WHERE name = ? AND id <> ?').get(name, current.id);
  if (clash) return res.status(409).json({ success: false, message: 'يوجد قسم بنفس الاسم.' });

  // The prefix is deliberately NOT editable. Existing service codes were minted
  // from it and are printed on real paperwork; changing it would either orphan
  // those codes or force a renumbering that breaks every reference to them.
  db.prepare(`
    UPDATE departments SET name = ?, ldap_group = ?, is_active = ?,
                           updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(name, ldapGroup || null, active ? 1 : 0, current.id);

  const diff = readableDiff(
    { 'الاسم': current.name, 'الحالة': current.is_active ? 'فعال' : 'غير فعال', 'مجموعة AD': current.ldap_group || '-' },
    { 'الاسم': name,         'الحالة': active ? 'فعال' : 'غير فعال',            'مجموعة AD': ldapGroup || '-' }
  );
  if (diff.changed.length) {
    logAudit(req.user, 'تعديل قسم', 'department', current.id,
      { oldValue: diff.oldValue, newValue: diff.newValue }, req.ip);
  }

  res.json({ success: true, department: toClient(db.prepare('SELECT * FROM departments WHERE id=?').get(current.id)) });
});

// ── POST /api/departments/:id/toggle ─────────────────────────
// Deactivate, never delete. A department with history behind it cannot be
// removed without taking its requests' meaning with it, so "تعطيل" hides it
// from the new-request form and leaves every past record readable.
router.post('/:id/toggle', requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'القسم غير موجود.' });

  const next = current.is_active ? 0 : 1;
  db.prepare("UPDATE departments SET is_active = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(next, current.id);

  logAudit(req.user, next ? 'تفعيل قسم' : 'تعطيل قسم', 'department', current.id, {
    oldValue: current.is_active ? 'فعال' : 'غير فعال',
    newValue: next ? 'فعال' : 'غير فعال',
  }, req.ip);

  res.json({ success: true, department: toClient(db.prepare('SELECT * FROM departments WHERE id=?').get(current.id)) });
});

module.exports = router;
