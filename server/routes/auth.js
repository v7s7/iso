// server/routes/auth.js
//
// Sign-in, sign-out, and "who am I".
//
// The flow, same as docTracking's:
//
//   1. A local account with a password_hash — the seeded test users, and any
//      account for someone with no AD presence. Checked first so the site still
//      works on a laptop with no directory.
//   2. Otherwise Active Directory. AD says who you are and which groups you are
//      in; the users table says what you may do here. If no row exists for you,
//      one is created on first sign-in from the group mapping, so an employee
//      does not have to be typed in before they can use the system.
//
// Either way the result is the same: a JWT plus a row in `sessions`. The token
// carries identity; the session row is what makes it revocable.
const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { randomUUID } = require('crypto');

const { db } = require('../db');
const { ldapEnabled } = require('../config/ldap');
const { authenticateUser } = require('../services/ldapService');
const { mapGroupsToRole, mapGroupsToAdmin, mapGroupsToDepartmentId, groupNames } = require('../utils/roleMapper');
const { verifyToken, USER_SQL } = require('../middleware/authMiddleware');
const { effectiveRole, effectiveIsAdmin, capabilities } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { DEFAULT_EXPIRY, parseExpiryMs } = require('../utils/expiry');

const router = express.Router();
const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRY;

/** The user shape the client works with — the same field names the UI already
 *  uses, so the front end does not have to translate. Never includes the hash. */
function publicUser(row) {
  return {
    id:            row.id,
    username:      row.username || '',
    email:         row.email || '',
    name:          row.full_name,
    role:          effectiveRole(row),
    admin:         effectiveIsAdmin(row),
    departmentId:  row.department_id,
    departmentName: row.department_name || '',
    active:        !!row.is_active,
    forcePasswordChange: !!row.force_password_change,
    isLdap:        !row.has_password,
  };
}

function loadUser(where, param) {
  return db.prepare(`${USER_SQL} ${where}`).get(param);
}

/** Issues the session row + token. One place, so both sign-in paths agree. */
function issueSession(row, req) {
  const user = publicUser(row);
  const jti  = randomUUID();
  const expiresAt = new Date(Date.now() + parseExpiryMs(JWT_EXPIRES_IN)).toISOString();

  // INSERT OR REPLACE, not INSERT: a jti is a fresh UUID every time, so this
  // only ever inserts — the OR REPLACE is belt and braces against a UUID
  // collision writing a second row for the same id.
  // user_id is the binding authMiddleware actually loads the account from;
  // username is kept beside it for the "who is signed in" screen and for the
  // cross-check on the token's own claim.
  db.prepare(`
    INSERT OR REPLACE INTO sessions (jti, user_id, username, full_name, role, ip, user_agent, expires_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(jti, row.id, row.username, row.full_name, user.role, req.ip, req.headers['user-agent'] || '', expiresAt);

  // The payload is identity only. Role and department are NOT trusted from it —
  // authMiddleware re-reads both from the row on every request — but they are
  // included so a client can render the first screen without a second call.
  const token = jwt.sign(
    { id: row.id, username: row.username, email: row.email || '', name: row.full_name, jti },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  db.prepare("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?").run(row.id);

  return { token, user };
}

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  const rawIdentifier = String(req.body?.identifier || req.body?.username || req.body?.email || '').trim();
  const password      = req.body?.password || '';

  if (!rawIdentifier || !password) {
    return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم وكلمة المرور.' });
  }

  // ── 1. Local account ──────────────────────────────────────
  // Matched on either spelling, because the prototype signed in with an email
  // and AD accounts sign in with a username; people will type whichever they
  // know.
  const local = db.prepare(`
    ${USER_SQL}
     WHERE (u.username = ? OR u.email = ?) AND u.password_hash IS NOT NULL
  `).get(rawIdentifier, rawIdentifier);

  if (local) {
    const full = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(local.id);
    if (!bcrypt.compareSync(password, full.password_hash || '')) {
      logAudit({ username: rawIdentifier }, 'محاولة دخول فاشلة', 'user', rawIdentifier,
        { newValue: 'كلمة مرور غير صحيحة' }, req.ip);
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة.' });
    }
    // Checked after the password, not before: answering "this account is
    // disabled" to an unauthenticated caller tells them the account exists.
    if (!local.is_active) {
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة أو الحساب غير فعال.' });
    }

    const { token, user } = issueSession(local, req);
    logAudit(user, 'تسجيل دخول', 'user', user.username || user.email, { newValue: 'حساب محلي' }, req.ip);
    console.log(`[Auth] local login OK: ${user.username || user.email} → role=${user.role} admin=${user.admin}`);
    return res.json({ success: true, token, user, can: capabilities(user) });
  }

  // ── 2. Active Directory ───────────────────────────────────
  if (!ldapEnabled()) {
    return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة.' });
  }

  try {
    const ad = await authenticateUser(rawIdentifier, password);

    let row = loadUser('WHERE u.username = ?', ad.username);

    if (row) {
      if (!row.is_active) {
        return res.status(401).json({ success: false, message: 'تم تعطيل هذا الحساب.' });
      }
      // Keep the AD-owned fields in step with the directory. Role, department
      // and الحالة are NOT touched: those are decisions someone made in إدارة
      // النظام, and overwriting them from AD on every login would undo that
      // administrator's work every morning.
      db.prepare(`
        UPDATE users SET full_name = ?, email = COALESCE(NULLIF(?,''), email),
                         title = ?, ad_department = ?, updated_at = datetime('now','localtime')
         WHERE id = ?
      `).run(ad.name, ad.email, ad.title || '', ad.department || '', row.id);
      row = loadUser('WHERE u.id = ?', row.id);
    } else {
      // First sign-in. A row is created from the group mapping so an employee
      // can use the system the day they are hired, without waiting for someone
      // to type them in. With no matching group they land on 'user' with no
      // department — which sees only their own requests, and is the right floor.
      const role    = mapGroupsToRole(ad.memberOf);
      const isAdmin = mapGroupsToAdmin(ad.memberOf) ? 1 : 0;
      const deptId  = mapGroupsToDepartmentId(ad.memberOf);

      const info = db.prepare(`
        INSERT INTO users (username, email, password_hash, full_name, department_id,
                           role, is_admin, is_active, title, ad_department, created_by)
        VALUES (?, NULLIF(?,''), NULL, ?, ?, ?, ?, 1, ?, ?, 'ACTIVE_DIRECTORY')
      `).run(ad.username, ad.email, ad.name, deptId, role, isAdmin, ad.title || '', ad.department || '');

      row = loadUser('WHERE u.id = ?', info.lastInsertRowid);
      logAudit({ username: 'SYSTEM', role: 'system' }, 'إنشاء حساب من Active Directory', 'user', ad.username,
        { newValue: `الدور=${role}، مدير نظام=${isAdmin ? 'نعم' : 'لا'}`, details: { groups: groupNames(ad.memberOf) } },
        req.ip);
      console.log(`[Auth] provisioned AD account: ${ad.username} → role=${role}`);
    }

    const { token, user } = issueSession(row, req);
    logAudit(user, 'تسجيل دخول', 'user', user.username, { newValue: 'Active Directory' }, req.ip);
    console.log(`[Auth] AD login OK: ${user.username} → role=${user.role} admin=${user.admin}`);
    return res.json({ success: true, token, user, can: capabilities(user) });

  } catch (err) {
    const code = err.code || 'LDAP_ERROR';
    console.warn(`[Auth] login FAILED for "${rawIdentifier}": [${code}] ${err.message}`);

    if (code === 'INVALID_CREDENTIALS' || code === 'USER_NOT_FOUND') {
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة.' });
    }
    if (code === 'LDAP_UNREACHABLE') {
      return res.status(503).json({ success: false, message: 'تعذّر الاتصال بخدمة تسجيل الدخول. حاول لاحقاً.' });
    }
    return res.status(500).json({ success: false, message: 'خطأ في التحقق من الهوية.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
// Read from the row, not the token — the role may have changed since sign-in.
router.get('/me', verifyToken, (req, res) => {
  const row = loadUser('WHERE u.id = ?', req.user.id);
  if (!row) return res.status(401).json({ success: false, message: 'هذا الحساب لم يعد موجوداً.' });
  const user = publicUser(row);
  res.json({ success: true, user, can: capabilities(user) });
});

// ── POST /api/auth/logout ────────────────────────────────────
// Deleting the session row is what actually ends it. The token stays
// syntactically valid until it expires, and is refused from here on because
// authMiddleware cannot find its jti.
router.post('/logout', verifyToken, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE jti = ?').run(req.user.jti);
  logAudit(req.user, 'تسجيل خروج', 'user', req.user.username || req.user.email, {}, req.ip);
  res.json({ success: true });
});

// ── POST /api/auth/password ──────────────────────────────────
// Self-service change. Reachable while force_password_change is set — it is the
// one thing such an account must be able to do.
router.post('/password', verifyToken, (req, res) => {
  const { current, password, confirmPassword } = req.body || {};

  const row = db.prepare('SELECT id, username, email, password_hash, force_password_change FROM users WHERE id = ?')
    .get(req.user.id);

  if (!row?.password_hash) {
    // An AD account's password lives in Active Directory. Changing it here would
    // create a second, divergent password for the same person — so it is
    // refused, with the place that can actually change it.
    return res.status(400).json({
      success: false,
      message: 'كلمة مرور هذا الحساب تُدار في Active Directory ولا يمكن تغييرها من هنا.',
    });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'كلمتا المرور غير متطابقتين.' });
  }

  // The current password is required — EXCEPT when an administrator has just
  // reset it, where the "current" one is the temporary the administrator chose
  // and asking for it again proves nothing.
  if (!row.force_password_change) {
    if (!current || !bcrypt.compareSync(current, row.password_hash)) {
      return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة.' });
    }
  }
  if (bcrypt.compareSync(password, row.password_hash)) {
    return res.status(400).json({ success: false, message: 'كلمة المرور الجديدة مطابقة للحالية.' });
  }

  db.prepare(`
    UPDATE users SET password_hash = ?, force_password_change = 0,
                     updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(bcrypt.hashSync(String(password), 10), row.id);

  // Every OTHER session for this person is ended. Changing a password because
  // you think someone else has it is pointless if their existing sign-in keeps
  // working — this is the request that makes it stop.
  const killed = db.prepare('DELETE FROM sessions WHERE user_id = ? AND jti <> ?')
    .run(row.id, req.user.jti).changes;

  logAudit(req.user, row.force_password_change ? 'تغيير كلمة المرور الإجباري' : 'تغيير كلمة المرور',
    'user', row.username || row.email,
    { oldValue: row.force_password_change ? 'كلمة مرور مؤقتة' : '', newValue: 'تم التغيير' }, req.ip);

  res.json({ success: true, message: 'تم تغيير كلمة المرور.', otherSessionsEnded: killed });
});

module.exports = router;
module.exports.publicUser = publicUser;
