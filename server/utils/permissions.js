// server/utils/permissions.js
//
// Who can see what, and who can change what. One file, because a rule that is
// written in two places eventually disagrees with itself.
//
// Three roles, from the prototype, unchanged:
//
//   user        مستخدم      — own requests only. Files them, closes his own.
//   supervisor  مشرف قسم    — everything in his own department.
//   power       Power User  — the whole organisation, read-wide.
//
// …and one flag beside them:
//
//   is_admin    مدير النظام — the إدارة النظام screens: users, departments,
//                            services, holidays, audit.
//
// Role and admin are deliberately separate. A Power User reads organisation-wide
// figures without being able to touch an account; an administrator from IT
// manages accounts without being handed everyone's request data by default.
//
// Everything here is enforced server-side. The UI hides what a user cannot do,
// but hiding is a courtesy — this file is the rule.

const ROLES = ['user', 'supervisor', 'power'];

// Usernames or emails that are ALWAYS مدير النظام, whatever the row says. The
// lockout failsafe: no screen in the app can remove it, which is the point.
function overrideAdmins() {
  return (process.env.SUPER_ADMIN_USERS || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

function isOverrideAdmin(row) {
  const u = String(row?.username || '').toLowerCase();
  const e = String(row?.email    || '').toLowerCase();
  if (!u && !e) return false;
  return overrideAdmins().some(x => (u && x === u) || (e && x === e));
}

/**
 * Everyone in the IT department is مدير النظام. IT is a team, and a permission
 * only one person holds is a permission that stops working the week he is on
 * leave — the same reasoning docTracking uses for its IT_DEPT_ID rule.
 *
 * Matched on the department's service-code prefix rather than its id, so the
 * rule survives the department being renamed or reseeded.
 */
function adminDeptPrefix() {
  return String(process.env.ADMIN_DEPT_PREFIX || '').trim().toUpperCase();
}

function isAdminDepartment(row) {
  const prefix = adminDeptPrefix();
  if (!prefix) return false;
  return String(row?.department_prefix || '').toUpperCase() === prefix;
}

/**
 * Whether a stored row is مدير النظام at runtime. THE single definition — the
 * login route and the per-request refresh both call this, so a person cannot
 * end up with one answer in their token and another in the middleware.
 *
 * Three ways to hold it:
 *   1. the stored is_admin flag
 *   2. SUPER_ADMIN_USERS names them — the failsafe
 *   3. they are in the IT department — IT is a team, not one person
 *
 * The row must carry `department_prefix` for (3) to apply; every query that
 * loads a user for authorisation joins it in.
 */
function effectiveIsAdmin(row) {
  if (!row) return false;
  return Boolean(row.is_admin) || isOverrideAdmin(row) || isAdminDepartment(row);
}

/** The role a row actually carries.
 *
 * Administration and request visibility are separate permissions. A person
 * named in SUPER_ADMIN_USERS can manage the system, but still keeps the
 * stored user/supervisor/power scope selected on the Users screen. This is
 * especially important for an IT supervisor: granting the administrator
 * failsafe must not silently expand his request access to the whole
 * organisation.
 */
function effectiveRole(row) {
  if (!row) return 'user';
  return ROLES.includes(row.role) ? row.role : 'user';
}

// ── Request visibility ───────────────────────────────────────
//
// Returned as a SQL fragment + parameters rather than filtering in JS, so the
// restriction is part of the query that reads the rows. Filtering after the
// fact is how an endpoint ends up counting records it is not allowed to show —
// the count is computed before the filter runs.

/**
 * The WHERE clause limiting `requests` to what this user may see.
 * @returns {{clause: string, params: any[]}}
 */
function visibilityClause(user) {
  if (user?.role === 'power') return { clause: '1=1', params: [] };
  if (user?.role === 'supervisor') {
    // A supervisor with no department sees nothing rather than everything.
    // Failing open here would hand the whole organisation to a half-configured
    // account.
    if (!user.department_id) return { clause: '1=0', params: [] };
    return { clause: 'r.department_id = ?', params: [user.department_id] };
  }
  return { clause: 'r.user_id = ?', params: [user?.id ?? -1] };
}

/** May this user open this particular request? */
function canViewRequest(user, request) {
  if (!user || !request) return false;
  if (user.role === 'power') return true;
  if (user.role === 'supervisor') return Number(request.department_id) === Number(user.department_id);
  return Number(request.user_id) === Number(user.id);
}

/**
 * May this user close it?
 *
 * Phase 1 rule, carried over deliberately: only the person who filed a request
 * closes it. A supervisor can see it and chase it; he cannot mark someone
 * else's work done, because إغلاق is the measured event — it is what the
 * on-time percentage is computed from.
 */
function canCloseRequest(user, request) {
  if (!user || !request) return false;
  if (request.status !== 'Open') return false;
  return Number(request.user_id) === Number(user.id);
}

// ── Express guards ───────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ success: false, message: 'غير مصرح. هذه الصفحة لمدير النظام.' });
  }
  next();
}

/** For the organisation-wide reporting endpoints. */
function requirePower(req, res, next) {
  if (req.user?.role !== 'power' && !req.user?.is_admin) {
    return res.status(403).json({ success: false, message: 'غير مصرح.' });
  }
  next();
}

/**
 * May `actor` modify this user row? null when allowed, otherwise the reason —
 * the caller turns that into a 403 the user can act on.
 */
function refuseUserEdit(actor, target, patch = {}) {
  if (!actor?.is_admin) return 'غير مصرح بتعديل حسابات المستخدمين.';

  // You do not sign your own promotion. The ordinary separation-of-duties rule:
  // an administrator may fix his own name and email, but not hand himself a
  // different role, and not switch himself off.
  if (actor?.id && target?.id && Number(actor.id) === Number(target.id)) {
    if (patch.role !== undefined && patch.role !== target.role) {
      return 'لا يمكنك تغيير دورك بنفسك.';
    }
    if (patch.is_admin !== undefined && !patch.is_admin) {
      return 'لا يمكنك إزالة صلاحية مدير النظام عن حسابك.';
    }
    if (patch.is_active !== undefined && !patch.is_active) {
      return 'لا يمكنك تعطيل حسابك.';
    }
  }

  // The failsafe account cannot be disabled or demoted from a screen — a
  // deactivated account is refused at the door regardless of the override, so
  // that one click would lock the only person who can undo it out of the app.
  if (isOverrideAdmin(target)) {
    if (patch.is_active !== undefined && !patch.is_active) {
      return 'هذا الحساب محمي في إعدادات الخادم ولا يمكن تعطيله من هنا.';
    }
    if (patch.is_admin !== undefined && !patch.is_admin) {
      return 'هذا الحساب محمي في إعدادات الخادم.';
    }
  }

  if (patch.role !== undefined && !ROLES.includes(patch.role)) {
    return 'دور غير معروف.';
  }
  return null;
}

/** What the caller may do, so the UI can shape itself around it. */
function capabilities(user) {
  return {
    manageUsers:       !!user?.is_admin,
    manageDepartments: !!user?.is_admin,
    manageServices:    !!user?.is_admin,
    manageHolidays:    !!user?.is_admin,
    viewAudit:         !!user?.is_admin,
    browseDirectory:   !!user?.is_admin,
    scope:             user?.role === 'power' ? 'organisation'
                     : user?.role === 'supervisor' ? 'department'
                     : 'self',
    assignableRoles:   ROLES,
  };
}

module.exports = {
  ROLES,
  overrideAdmins, isOverrideAdmin, isAdminDepartment, adminDeptPrefix,
  effectiveIsAdmin, effectiveRole,
  visibilityClause, canViewRequest, canCloseRequest,
  requireAdmin, requirePower, refuseUserEdit, capabilities,
};
