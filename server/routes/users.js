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
    // An AD person signing in with a local password مدير النظام set here. The
    // screen shows it, because "محلي" on its own would read as a local account
    // and lose the fact that the directory is being bypassed for this row.
    adPasswordOverride: !!u.ad_password_override,
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
//
// مدير النظام sets the password for ANY account. This is the only way a
// password changes in this system now — self-service was removed, so the one
// screen that can do it is this one, and the one person who can reach it is an
// administrator.
//
// On an Active Directory account it does something worth being explicit about:
// writing password_hash where there was NULL moves the account onto the local
// sign-in path, because POST /api/auth/login checks a local hash BEFORE it asks
// the directory. From that point the password typed here is the password that
// opens this system, and the directory's own password no longer does.
//
// What it does NOT do is change anything in Active Directory. The link to the
// directory is read-only — it authenticates and it browses, and there is no
// write path in ldapService. The person's Windows and email password is
// untouched and keeps working everywhere else. The override is local to this
// application, which is the whole of what it can honestly claim.
router.post('/:id/reset-password', requireAdmin, (req, res) => {
  const current = db.prepare(`${USER_SQL} WHERE u.id = ?`).get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'المستخدم غير موجود.' });

  const password = String(req.body?.password || '');
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.' });
  }

  // Read before the write: afterwards every account looks local, and the audit
  // entry would lose the one fact that makes it worth reading later.
  const wasLdap = !current.has_password;

  // Sticky: once set it stays set, because the row is still an AD person's row
  // whether this is the first override or the third reset of the local password
  // that replaced the directory's.
  const override = wasLdap || current.ad_password_override ? 1 : 0;

  db.prepare(`
    UPDATE users SET password_hash = ?, force_password_change = 1,
                     ad_password_override = ?,
                     updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(bcrypt.hashSync(password, 10), override, current.id);

  // The old password is gone, so the sessions it opened must go with it. For an
  // account that was signing in through the directory a moment ago this is what
  // stops the directory password continuing to hold an open session here.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.id);

  // An AD override is a different event from an ordinary reset — it changes
  // which system decides this person's password — so it is recorded as one.
  logAudit(req.user,
    wasLdap ? 'تعيين كلمة مرور محلية لحساب Active Directory' : 'إعادة تعيين كلمة المرور',
    'user', current.username || current.email,
    {
      oldValue: wasLdap ? 'الدخول عبر Active Directory' : 'كلمة مرور محلية',
      newValue: wasLdap
        ? 'كلمة مرور محلية تتجاوز كلمة مرور الدليل في هذا النظام + إجبار التغيير عند الدخول'
        : 'كلمة مرور مؤقتة + إجبار التغيير عند الدخول',
    }, req.ip);

  res.json({
    success: true,
    wasLdap,
    message: wasLdap
      ? 'تم تعيين كلمة مرور محلية لهذا الحساب. أصبحت هي كلمة المرور المستخدمة للدخول إلى هذا النظام بدلاً من كلمة مرور Active Directory، وسيُطلب تغييرها عند الدخول. (كلمة مرور الحساب في الدليل لم تتغير.)'
      : 'تمت إعادة كلمة المرور وسيُطلب من المستخدم تغييرها عند الدخول.',
  });
});

// ── POST /api/users/:id/revert-to-directory ──────────────────
//
// Undoes the override above: the local password is deleted and the account goes
// back to signing in through Active Directory. The counterpart has to exist,
// because otherwise an override applied to the wrong row in a table of 124
// people could only be undone by editing the database by hand.
//
// Clearing password_hash is the whole mechanism — a NULL hash is what sends
// sign-in to the directory — which is also why the refusals below matter more
// than they look. Each one is a way to leave someone with no password at all in
// either system:
//
//   • a row that was never AD-linked. ad_password_override is set only by the
//     reset route, and only on a row whose hash was NULL — so the flag is the
//     record of "this person came from the directory". Without it, this is a
//     genuine local account and deleting its hash locks it out permanently.
//   • no directory configured. Sending an account to AD when there is no AD to
//     go to is the same outcome by a different route.
//   • the failsafe account named in SUPER_ADMIN_USERS, whose local password is
//     the way back in when the directory itself is unreachable.
//
// A username is required for the same reason: the directory path in
// routes/auth.js matches on username, and a row without one could not sign in.
router.post('/:id/revert-to-directory', requireAdmin, (req, res) => {
  const current = db.prepare(`${USER_SQL} WHERE u.id = ?`).get(req.params.id);
  if (!current) return res.status(404).json({ success: false, message: 'المستخدم غير موجود.' });

  if (!current.ad_password_override) {
    return res.status(400).json({
      success: false,
      message: 'هذا الحساب ليس حساب Active Directory تم تجاوز كلمة مروره. لا يمكن تحويله إلى الدخول عبر الدليل.',
    });
  }
  if (!ldapEnabled()) {
    return res.status(400).json({
      success: false,
      message: 'لم يتم إعداد الاتصال بـ Active Directory. إلغاء كلمة المرور المحلية الآن يمنع هذا الحساب من الدخول نهائياً.',
    });
  }
  // The failsafe account keeps its local password. ldapEnabled() above says the
  // directory is CONFIGURED, not that it is answering — and a local password on
  // the one account that cannot be demoted from a screen is exactly what keeps
  // the system usable on the morning the directory is down. Same reasoning as
  // the protections in utils/permissions.js: this account is managed in the
  // server's own settings, not from a table of rows.
  if (isOverrideAdmin(current)) {
    return res.status(400).json({
      success: false,
      message: 'هذا الحساب محمي في إعدادات الخادم، وكلمة مروره المحلية هي وسيلة الدخول الاحتياطية عند تعذّر الاتصال بالدليل.',
    });
  }
  if (!current.username) {
    return res.status(400).json({
      success: false,
      message: 'لا يوجد اسم مستخدم لهذا الحساب، والدخول عبر Active Directory يتم باسم المستخدم.',
    });
  }

  // force_password_change is cleared with the hash: it refers to a temporary
  // local password that no longer exists, and leaving it set would block every
  // endpoint behind a change screen the account can no longer use.
  db.prepare(`
    UPDATE users SET password_hash = NULL, ad_password_override = 0,
                     force_password_change = 0,
                     updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(current.id);

  // Sessions opened with the local password go with it, exactly as on a reset.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.id);

  logAudit(req.user, 'إعادة الحساب إلى الدخول عبر Active Directory', 'user',
    current.username || current.email,
    {
      oldValue: 'كلمة مرور محلية تتجاوز كلمة مرور الدليل',
      newValue: 'الدخول عبر Active Directory',
    }, req.ip);

  res.json({
    success: true,
    message: 'تم إلغاء كلمة المرور المحلية. يسجّل هذا الحساب الدخول الآن بكلمة مروره في Active Directory.',
    user: toClient(db.prepare(`${USER_SQL} WHERE u.id = ?`).get(current.id)),
  });
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
    // A hash used to be proof that this username belonged to a separate local
    // account, and refusing was right. Since مدير النظام can give an AD account
    // a local password, a hash on an overridden row means the opposite — it IS
    // this AD person — so the refusal is limited to the case it was written for.
    // The override is left in place: re-importing fixes the role and department
    // from the directory, and is not a decision about which password signs in.
    if (existing.password_hash && !existing.ad_password_override) {
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
