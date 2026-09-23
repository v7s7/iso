// server/middleware/authMiddleware.js
//
// The gate every authenticated route passes through.
//
// The rule it exists to enforce: a token proves WHO you are; it never says what
// you may do. Role, department and الحالة are re-read from the users table on
// every single request. Three things follow from that, and all three are the
// reason it is written this way rather than trusting the signed payload:
//
//   • a demotion applies on the next click, not in eight hours
//   • a deactivated account is refused immediately
//   • a token forged with the signing secret cannot name itself into a role,
//     because the role in the payload is overwritten before any route sees it
//
// Ported from docTracking, where each of those was closed as a real finding.
const jwt = require('jsonwebtoken');
const { DEFAULT_EXPIRY, parseExpirySeconds } = require('../utils/expiry');

// The row every authorisation decision is made from. department_prefix is
// joined in because utils/permissions.js can grant مدير النظام by department.
//
// has_password is derived rather than selecting password_hash itself: callers
// need to know whether this is a local or an Active Directory account, and
// nothing outside the sign-in check has any business holding the hash. A column
// that is never read cannot be leaked by a route that forgets to strip it.
const USER_SQL = `
  SELECT u.id, u.username, u.email, u.full_name, u.role, u.is_admin, u.is_active,
         u.department_id, u.force_password_change, u.title, u.last_login_at,
         u.ad_password_override,
         (u.password_hash IS NOT NULL) AS has_password,
         d.name AS department_name, d.prefix AS department_prefix
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
`;

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.query.token) {
    // Only for endpoints a browser reaches without headers (a file download
    // opened in a new tab). Regular calls use the header.
    token = req.query.token;
  } else {
    return res.status(401).json({ success: false, message: 'لم يتم تسجيل الدخول.' });
  }

  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    const { db } = require('../db');
    const { effectiveRole, effectiveIsAdmin } = require('../utils/permissions');

    // Every token this server issues carries a jti, and the matching row in
    // `sessions` is the ONLY thing that can revoke it. Treating the claim as
    // optional would mean a token forged with the signing secret could simply
    // omit it, skip this lookup, and be immune to a forced sign-out because
    // there would be no session row to delete. A token without a jti is not one
    // of ours.
    if (!claims.jti) {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة. يرجى تسجيل الدخول من جديد.' });
    }

    // The session is bound to WHOSE it is. Looking the jti up on its own would
    // let a holder of the signing key keep an honest session id while renaming
    // themselves in the payload.
    const sess = db.prepare('SELECT jti, user_id, username FROM sessions WHERE jti = ?').get(claims.jti);
    if (!sess || String(sess.username).toLowerCase() !== String(claims.username || '').toLowerCase()) {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة. يرجى تسجيل الدخول من جديد.' });
    }

    // Identity comes from the SESSION ROW, never from the token — not even the
    // id. This looked safe when the id came from the token and the username was
    // cross-checked against the session, but the two are independent fields: a
    // token carrying its own honest jti and username alongside SOMEONE ELSE'S
    // id passed the check above and was then served as that other person.
    // Confirmed as a working escalation to مدير النظام before this line changed.
    // The session row is written by this server at sign-in and is the only thing
    // here the client has never touched.
    const row = db.prepare(`${USER_SQL} WHERE u.id = ?`).get(sess.user_id);

    if (!row) {
      // Deleted while the session was still live.
      return res.status(401).json({ success: false, message: 'هذا الحساب لم يعد موجوداً.' });
    }
    if (!row.is_active) {
      return res.status(401).json({ success: false, message: 'تم تعطيل هذا الحساب.' });
    }

    req.user = {
      id:            row.id,
      username:      row.username,
      email:         row.email,
      name:          row.full_name,
      role:          effectiveRole(row),
      is_admin:      effectiveIsAdmin(row),
      department_id: row.department_id,
      department_name:   row.department_name || '',
      department_prefix: row.department_prefix || '',
      force_password_change: !!row.force_password_change,
      jti: claims.jti,
      exp: claims.exp,
    };

    // ── Sliding sessions ──────────────────────────────────────────────────
    // Someone using the system all day should never be thrown back to the login
    // screen mid-task. Past the halfway point of its life the token is quietly
    // reissued and the client swaps it in from the response header.
    //
    // The SAME jti is reused on purpose: the sessions row is what a forced
    // sign-out deletes, and minting a new id on every renewal would both break
    // that link and fill the table with rows for one person. A session nobody
    // uses still expires on its own, so a forgotten login on a shared machine
    // does not stay valid forever.
    try {
      if (claims.exp) {
        const now      = Math.floor(Date.now() / 1000);
        const lifetime = parseExpirySeconds(process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRY);
        if (claims.exp - now < lifetime / 2) {
          const { exp, iat, ...rest } = claims;
          const fresh = jwt.sign(rest, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRY,
          });
          db.prepare('UPDATE sessions SET expires_at = ? WHERE jti = ?')
            .run(new Date(Date.now() + lifetime * 1000).toISOString(), claims.jti);
          res.set('X-Renewed-Token', fresh);
          res.set('Access-Control-Expose-Headers', 'X-Renewed-Token');
        }
      }
    } catch (e) {
      // Renewal is a convenience. If it fails the request still succeeds and
      // the existing token keeps working until it genuinely expires.
      console.warn('[Auth] token renewal skipped:', e.message);
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'انتهت الجلسة. يرجى تسجيل الدخول من جديد.' });
    }
    return res.status(401).json({ success: false, message: 'رمز الدخول غير صالح.' });
  }
}

/**
 * Refuses every write while a temporary password is still in force.
 *
 * Without it, "إجبار تغيير كلمة المرور" is only a screen the browser shows —
 * anyone who skips the UI keeps working with a password an administrator typed
 * and probably spoke out loud. The two endpoints that must stay open are the
 * password change itself and signing out.
 */
function blockUntilPasswordChanged(req, res, next) {
  if (req.user?.force_password_change) {
    return res.status(403).json({
      success: false,
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'يجب تغيير كلمة المرور المؤقتة قبل متابعة استخدام النظام.',
    });
  }
  next();
}

module.exports = { verifyToken, blockUntilPasswordChanged, USER_SQL };
