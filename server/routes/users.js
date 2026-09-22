// server/routes/users.js
//
// المستخدمون — إدارة النظام.
//
// Two kinds of account live in one table, and the difference is one column:
//
//   password_hash NOT NULL → a local account. This system checks the password.
//   password_hash NULL     → an Active Directory account. The directory checks
//                            it; this row only says what the person may do here.
//
// That is the whole integration. AD owns identity, this table owns authority,
// and neither one overwrites the other.
const express = require('express');
const bcrypt  = require('bcryptjs');
const { db } = require('../db');
const { ldapEnabled } = require('../config/ldap');
const { browseAllUsers } = require('../services/ldapService');
const { verifyToken, blockUntilPasswordChanged, USER_SQL } = require('../middleware/authMiddleware');
const { mapGroupsToRole, mapGroupsToAdmin, mapGroupsToDepartmentId } = require('../utils/roleMapper');
const {
  ROLES, requireAdmin, refuseUserEdit, capabilities,
  effectiveRole, effectiveIsAdmin, isOverrideAdmin,
} = require('../utils/permissions');
const { logAudit, readableDiff } = require('../utils/audit');

const router = express.Router();
router.use(verifyToken, blockUntilPasswordChanged);

const ROLE_LABELS = { user: 'مستخدم', supervisor: 'مشرف قسم', power: 'Power User' };

function toClient(u) {
  return {
    id: u.id,
    username: u.username || '',
    email: u.email || '',
    name: u.full_name,
    departmentId: u.department_id,
    departmentName: u.department_name || '',
    role: effectiveRole(u),
    storedRole: u.role,
    admin: effectiveIsAdmin(u),
    active: !!u.is_active,
    forcePasswordChange: !!u.force_password_change,
    isLdap: !u.has_password,
    // A row whose admin rights come from .env or from the IT department rather
    // than from this screen. The UI marks it, because switching the checkbox
    // off would appear to work and change nothing.
    isProtected: isOverrideAdmin(u),
    title: u.title || '',
    lastLoginAt: u.last_login_at || '',
  };
}

// ── GET /api/users ───────────────────────────────────────────
//
// The full list is مدير النظام only. Everyone else gets the name-and-department
// subset the dashboard's employee filter needs — a supervisor filtering by
// employee must not be handed everyone's email, role and sign-in history.
router.get('/', (req, res) => {
  if (!req.user.is_admin) {
    let rows;
    if (req.user.role === 'power') {
      rows = db.prepare(`
        SELECT u.id, u.full_name, u.department_id, d.name AS department_name
          FROM users u LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.is_active = 1 ORDER BY u.full_name
      `).all();
    } else if (req.user.role === 'supervisor' && req.user.department_id) {
      rows = db.prepare(`
        SELECT u.id, u.full_name, u.department_id, d.name AS department_name
          FROM users u LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.is_active = 1 AND u.department_id = ? ORDER BY u.full_name
      `).all(req.user.department_id);
    } else {
      // A مستخدم filters only by himself, so that is all he is given.
      rows = db.prepare(`
        SELECT u.id, u.full_name, u.department_id, d.name AS department_name
          FROM users u LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.id = ?
      `).all(req.user.id);
    }
    return res.json({
      success: true,
      users: rows.map(r => ({ id: r.id, name: r.full_name, departmentId: r.department_id, departmentName: r.department_name || '' })),
      can: capabilities(req.user),
    });
  }

  const rows = db.prepare(`${USER_SQL} ORDER BY u.full_name`).all();

  res.json({
    success: true,
    users: rows.map(toClient),
    can: capabilities(req.user),
    roles: ROLES.map(r => ({ value: r, label: ROLE_LABELS[r] })),
  });
});

// ── POST /api/users ──────────────────────────────────────────
// A LOCAL account. AD accounts arrive through /import or on first sign-in.
router.post('/', requireAdmin, (req, res) => {
  const name     = String(req.body?.name || '').trim();
  const email    = String(req.body?.email || '').trim().toLowerCase();
  const username = String(req.body?.username || '').trim() || null;
  const password = String(req.body?.password || '');
  const departmentId = req.body?.departmentId ? Number(req.body.departmentId) : null;
  const role     = String(req.body?.role || 'user');
  const admin    = !!req.body?.admin;
  const active   = req.body?.active === undefined ? true : !!req.body.active;
  const force    = req.body?.forcePasswordChange === undefined ? true : !!req.body.forcePasswordChange;

  if (!name)  return res.status(400).json({ success: false, message: 'الاسم مطلوب.' });
  if (!email) return res.status(400).json({ success: false, message: 'البريد الرسمي مطلوب.' });
  if (!ROLES.includes(role)) return res.status(400).json({ success: false, message: 'دور غير معروف.' });
  if (!departmentId) return res.status(400).json({ success: false, message: 'القسم مطلوب.' });
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.' });
  }
  if (departmentId && !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId)) {
    return res.status(404).json({ success: false, message: 'القسم غير موجود.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ success: false, message: 'البريد الرسمي مستخدم في حساب آخر.' });
  }
  if (username && db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ success: false, message: 'اسم المستخدم مستخدم في حساب آخر.' });
  }

  const info = db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, department_id,
                       role, is_admin, is_active, force_password_change, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(username, email, bcrypt.hashSync(password, 10), name, departmentId,
         role, admin ? 1 : 0, active ? 1 : 0, force ? 1 : 0, req.user.username || req.user.email);

  logAudit(req.user, 'إنشاء مستخدم', 'user', email, {
    newValue: `القسم=${departmentId ? (db.prepare('SELECT name FROM departments WHERE id=?').get(departmentId)?.name || '-') : '-'}, الدور=${ROLE_LABELS[role]}, مدير نظام=${admin ? 'نعم' : 'لا'}`,
  }, req.ip);

  res.status(201).json({ success: true, user: toClient(db.prepare(`${USER_SQL} WHERE u.id = ?`).get(info.lastInsertRowid)) });
});

// ── PUT /api/users/:id ───────────────────────────────────────
router.put('/:id', requireAdmin, (req, res) => {
  const current = db.prepare(`${USER_SQL} WHERE u.id = ?`).get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'المستخدم غير موجود.' });

  const patch = {};
  if (req.body?.role     !== undefined) patch.role      = String(req.body.role);
  if (req.body?.admin    !== undefined) patch.is_admin  = !!req.body.admin;
  if (req.body?.active   !== undefined) patch.is_active = !!req.body.active;
  if (req.body?.departmentId !== undefined) patch.department_id = req.body.departmentId ? Number(req.body.departmentId) : null;

  // The rule lives in utils/permissions.js — one place, so the UI and the API
  // cannot disagree about who may do what.
  const refusal = refuseUserEdit(req.user, current, patch);
  if (refusal) return res.status(403).json({ success: false, message: refusal });

  const name  = req.body?.name  !== undefined ? String(req.body.name).trim()  : current.full_name;
  const email = req.body?.email !== undefined ? String(req.body.email).trim().toLowerCase() : (current.email || '');
  const role  = patch.role      !== undefined ? patch.role  : current.role;
  const admin = patch.is_admin  !== undefined ? patch.is_admin  : !!current.is_admin;
  const active= patch.is_active !== undefined ? patch.is_active : !!current.is_active;
  const deptId= patch.department_id !== undefined ? patch.department_id : current.department_id;
  const force = req.body?.forcePasswordChange !== undefined ? !!req.body.forcePasswordChange : !!current.force_password_change;

  if (!name) return res.status(400).json({ success: false, message: 'الاسم مطلوب.' });
  if (!deptId) return res.status(400).json({ success: false, message: 'القسم مطلوب.' });
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(email, current.id)) {
    return res.status(409).json({ success: false, message: 'البريد الرسمي مستخدم في حساب آخر.' });
  }
  if (deptId && !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(deptId)) {
    return res.status(404).json({ success: false, message: 'القسم غير موجود.' });
  }

  db.prepare(`
    UPDATE users SET full_name = ?, email = NULLIF(?,''), department_id = ?, role = ?,
                     is_admin = ?, is_active = ?, force_password_change = ?,
                     updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(name, email, deptId, role, admin ? 1 : 0, active ? 1 : 0, force ? 1 : 0, current.id);

  // Deactivating someone must end their live sessions. Without this the flag is
  // only checked at the door, and whoever is already inside stays inside until
  // their token expires — which is the whole window you were trying to close.
  if (!active && current.is_active) {
    const killed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.id).changes;
    if (killed) console.log(`[Users] deactivated ${current.username}: ended ${killed} session(s)`);
  }

  const deptName = id => (id ? (db.prepare('SELECT name FROM departments WHERE id=?').get(id)?.name || '-') : '-');
  const diff = readableDiff(
    { 'الاسم': current.full_name, 'البريد': current.email || '-', 'القسم': deptName(current.department_id),
      'الدور': ROLE_LABELS[current.role] || current.role, 'مدير نظام': current.is_admin ? 'نعم' : 'لا',
      'الحالة': current.is_active ? 'فعال' : 'غير فعال' },
    { 'الاسم': name, 'البريد': email || '-', 'القسم': deptName(deptId),
      'الدور': ROLE_LABELS[role] || role, 'مدير نظام': admin ? 'نعم' : 'لا',
      'الحالة': active ? 'فعال' : 'غير فعال' }
  );
  if (diff.changed.length) {
    logAudit(req.user, 'تعديل مستخدم', 'user', current.username || current.email,
      { oldValue: diff.oldValue, newValue: diff.newValue, details: { changed: diff.changed } }, req.ip);
  }

  res.json({ success: true, user: toClient(db.prepare(`${USER_SQL} WHERE u.id = ?`).get(current.id)) });
});

// ── POST /api/users/:id/toggle ───────────────────────────────
router.post('/:id/toggle', requireAdmin, (req, res) => {
  const current = db.prepare(`${USER_SQL} WHERE u.id = ?`).get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'المستخدم غير موجود.' });

  const next = current.is_active ? 0 : 1;
  if (next && !current.department_id) {
    return res.status(400).json({ success: false, message: 'يجب تعيين قسم قبل تفعيل المستخدم.' });
  }
  const refusal = refuseUserEdit(req.user, current, { is_active: !!next });
  if (refusal) return res.status(403).json({ success: false, message: refusal });

  db.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(next, current.id);

  if (!next) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.id);

  logAudit(req.user, next ? 'تفعيل مستخدم' : 'تعطيل مستخدم', 'user', current.username || current.email, {
    oldValue: current.is_active ? 'فعال' : 'غير فعال',
    newValue: next ? 'فعال' : 'غير فعال',
  }, req.ip);

  res.json({ success: true, user: toClient(db.prepare(`${USER_SQL} WHERE u.id = ?`).get(current.id)) });
});

// ── POST /api/users/:id/reset-password ───────────────────────
// Sets a temporary password and forces a change at next sign-in.
router.post('/:id/reset-password', requireAdmin, (req, res) => {
  const current = db.prepare(`${USER_SQL} WHERE u.id = ?`).get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'المستخدم غير موجود.' });

  if (!current.has_password) {
    return res.status(400).json({
      success: false,
      message: 'هذا حساب Active Directory؛ تُعاد كلمة المرور من الدليل وليس من هنا.',
    });
  }

  const password = String(req.body?.password || '');
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.' });
  }

  db.prepare(`
    UPDATE users SET password_hash = ?, force_password_change = 1,
                     updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(bcrypt.hashSync(password, 10), current.id);

  // The old password is gone, so the sessions it opened must go with it.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.id);

  logAudit(req.user, 'إعادة تعيين كلمة المرور', 'user', current.username || current.email,
    { newValue: 'كلمة مرور مؤقتة + إجبار التغيير عند الدخول' }, req.ip);

  res.json({ success: true, message: 'تمت إعادة كلمة المرور وسيُطلب من المستخدم تغييرها عند الدخول.' });
});

// ── GET /api/users/directory ─────────────────────────────────
// Browse Active Directory. Read-only, and it writes nothing — the administrator
// picks who to import from the result.
router.get('/directory', requireAdmin, async (req, res) => {
  if (!ldapEnabled()) {
    return res.json({ success: true, users: [], note: 'لم يتم إعداد الاتصال بـ Active Directory.' });
  }
  try {
    const adUsers = await browseAllUsers();
    // Mark who already has a row here, so the screen can show "مضاف" instead of
    // offering to import the same person twice.
    const known = new Set(
      db.prepare('SELECT username FROM users WHERE username IS NOT NULL').all()
        .map(r => String(r.username).toLowerCase())
    );
    res.json({
      success: true,
      users: adUsers.map(u => ({
        username: u.username, name: u.name, email: u.email,
        department: u.department, title: u.title,
        alreadyLinked: known.has(String(u.username).toLowerCase()),
        suggestedRole: mapGroupsToRole(u.memberOf),
        suggestedAdmin: mapGroupsToAdmin(u.memberOf),
        suggestedDepartmentId: mapGroupsToDepartmentId(u.memberOf),
      })),
    });
  } catch (e) {
    const code = e.code || 'LDAP_ERROR';
    console.warn('[LDAP browse]', code, e.message);
    if (code === 'NOT_CONFIGURED') {
      return res.status(503).json({ success: false, code, message: e.message });
    }
    if (code === 49 || /Invalid Credentials|invalidCredentials/.test(e.message || '')) {
      return res.status(502).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'بيانات حساب الخدمة لـ Active Directory غير صحيحة.' });
    }
    return res.status(502).json({ success: false, code, message: `تعذّر الاتصال بـ Active Directory: ${e.message}` });
  }
});

// ── POST /api/users/import ───────────────────────────────────
// Creates (or updates) the local row for an AD account. No password is stored —
// password_hash stays NULL, which is what routes the sign-in to the directory.
router.post('/import', requireAdmin, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const name     = String(req.body?.name || '').trim();
  const email    = String(req.body?.email || '').trim().toLowerCase();
  const departmentId = req.body?.departmentId ? Number(req.body.departmentId) : null;
  const role  = String(req.body?.role || 'user');
  const admin = !!req.body?.admin;

  if (!username || !name) {
    return res.status(400).json({ success: false, message: 'اسم المستخدم والاسم مطلوبان.' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ success: false, message: 'دور غير معروف.' });
  if (!departmentId) return res.status(400).json({ success: false, message: 'القسم مطلوب.' });
  if (departmentId && !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId)) {
    return res.status(404).json({ success: false, message: 'القسم غير موجود.' });
  }

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (existing) {
    if (existing.password_hash) {
      return res.status(409).json({
        success: false,
        message: 'هذا الاسم يخص حساباً محلياً بكلمة مرور. احذف التعارض أو استخدم اسماً آخر.',
      });
    }
    db.prepare(`
      UPDATE users SET full_name = ?, email = NULLIF(?,''), department_id = ?, role = ?,
                       is_admin = ?, is_active = 1, updated_at = datetime('now','localtime')
       WHERE id = ?
    `).run(name, email, departmentId, role, admin ? 1 : 0, existing.id);

    logAudit(req.user, 'تحديث ربط حساب Active Directory', 'user', username, {
      oldValue: `الدور=${ROLE_LABELS[existing.role] || existing.role}`,
      newValue: `الدور=${ROLE_LABELS[role]}، مدير نظام=${admin ? 'نعم' : 'لا'}`,
    }, req.ip);

    return res.json({ success: true, user: toClient(db.prepare(`${USER_SQL} WHERE u.id = ?`).get(existing.id)) });
  }

  if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ success: false, message: 'البريد الرسمي مستخدم في حساب آخر.' });
  }

  const info = db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, department_id,
                       role, is_admin, is_active, created_by)
    VALUES (?, NULLIF(?,''), NULL, ?, ?, ?, ?, 1, ?)
  `).run(username, email, name, departmentId, role, admin ? 1 : 0, req.user.username || req.user.email);

  logAudit(req.user, 'استيراد مستخدم من Active Directory', 'user', username, {
    newValue: `الدور=${ROLE_LABELS[role]}، مدير نظام=${admin ? 'نعم' : 'لا'}`,
  }, req.ip);

  res.status(201).json({ success: true, user: toClient(db.prepare(`${USER_SQL} WHERE u.id = ?`).get(info.lastInsertRowid)) });
});

module.exports = router;
module.exports.ROLE_LABELS = ROLE_LABELS;
