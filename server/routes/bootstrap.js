// server/routes/bootstrap.js
//
// One call that returns everything the app needs to draw its first screen:
// the signed-in user, the requests they may see, and the reference data.
//
// One call rather than five because the front end renders synchronously from a
// single snapshot — the same shape it used to read out of localStorage. Five
// parallel calls would each land at a different moment and the first paint
// would be assembled from four of them.
//
// Every list here is already limited to what the caller may see; there is no
// second filtering step in the browser that could be skipped.
const express = require('express');
const { db } = require('../db');
const { verifyToken } = require('../middleware/authMiddleware');
const { visibilityClause, capabilities, effectiveRole, effectiveIsAdmin } = require('../utils/permissions');
const { today, loadHolidays, isLate, currentDelayDays, isDueSoon } = require('../utils/workdays');
const { DELAY_REASONS } = require('./requests');
const { HOLIDAY_TYPES } = require('./holidays');
const { ROLE_LABELS }   = require('./users');

const router = express.Router();

// ── GET /api/bootstrap ───────────────────────────────────────
router.get('/', verifyToken, (req, res) => {
  const holidays = loadHolidays();

  // A user who must change their password gets the shell and nothing else. The
  // client shows the password screen; sending the data as well would mean the
  // data was already delivered to a session that has not finished authenticating.
  if (req.user.force_password_change) {
    return res.json({
      success: true,
      today: today(),
      user: { id: req.user.id, name: req.user.name, email: req.user.email,
              role: req.user.role, admin: req.user.is_admin,
              departmentId: req.user.department_id, departmentName: req.user.department_name,
              forcePasswordChange: true },
      requests: [], departments: [], services: [], users: [], holidays: [],
      can: capabilities(req.user),
    });
  }

  const { clause, params } = visibilityClause(req.user);
  const requests = db.prepare(`
    SELECT r.* FROM requests r WHERE ${clause} ORDER BY r.created_at DESC, r.id DESC
  `).all(...params);

  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const services    = db.prepare(`
    SELECT s.*, d.name AS department_name
      FROM services s JOIN departments d ON d.id = s.department_id
     ORDER BY s.code
  `).all();

  // The employee filter's population — the same scope rule as the requests
  // above, so the dropdown can never offer someone whose requests are invisible.
  //
  // مدير النظام is the exception and gets EVERY account, deactivated ones
  // included: this list is also what the إدارة النظام table renders, and a
  // screen for re-enabling accounts that hides the disabled ones is a screen
  // that cannot do its job.
  let peopleSql, peopleParams = [];
  if (req.user.is_admin) {
    peopleSql = '';
  } else if (req.user.role === 'power') {
    peopleSql = 'WHERE u.is_active = 1';
  } else if (req.user.role === 'supervisor' && req.user.department_id) {
    peopleSql = 'WHERE u.is_active = 1 AND u.department_id = ?';
    peopleParams = [req.user.department_id];
  } else {
    peopleSql = 'WHERE u.id = ?';
    peopleParams = [req.user.id];
  }
  const people = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.email, u.department_id, u.role,
           u.is_admin, u.is_active, u.force_password_change, u.last_login_at,
           (u.password_hash IS NOT NULL) AS has_password,
           d.name AS department_name, d.prefix AS department_prefix
      FROM users u LEFT JOIN departments d ON d.id = u.department_id
      ${peopleSql} ORDER BY u.full_name
  `).all(...peopleParams);

  res.json({
    success: true,
    today: today(),
    user: {
      id: req.user.id, username: req.user.username, name: req.user.name, email: req.user.email,
      role: req.user.role, admin: req.user.is_admin,
      departmentId: req.user.department_id, departmentName: req.user.department_name,
      forcePasswordChange: false,
    },
    can: capabilities(req.user),
    requests: requests.map(r => ({
      id: r.id, reqCode: r.req_code, userId: r.user_id,
      requesterName: r.requester_name, officeEmail: r.office_email || '',
      departmentId: r.department_id, departmentSnapshot: r.department_snapshot,
      serviceId: r.service_id, serviceCode: r.service_code, serviceName: r.service_name,
      duration: r.duration, subject: r.subject, notes: r.notes || '',
      requestDate: r.request_date, createdAt: r.created_at, dueDate: r.due_date,
      status: r.status, closeDate: r.close_date || '', closedAt: r.closed_at || '',
      delayReason: r.delay_reason || '', otherDelayReason: r.other_delay_reason || '',
      closureNotes: r.closure_notes || '', delayDays: r.delay_days || 0,
      isOnTime: r.is_on_time === null ? null : !!r.is_on_time,
      isLate: isLate(r), currentDelayDays: currentDelayDays(r, holidays), isDueSoon: isDueSoon(r, holidays),
    })),
    departments: departments.map(d => ({
      id: d.id, name: d.name, prefix: d.prefix, active: !!d.is_active, ldapGroup: d.ldap_group || '',
    })),
    services: services.map(s => ({
      id: s.id, code: s.code, name: s.name, departmentId: s.department_id,
      departmentName: s.department_name, duration: s.duration, active: !!s.is_active,
    })),
    // The admin table needs more columns than the employee filter does, but the
    // extra ones are harmless to anyone else here: every person in this list is
    // already visible to the caller by name and department, and nothing
    // sensitive (no hash, no address book beyond their own scope) is added.
    users: people.map(u => ({
      id: u.id, name: u.full_name, email: u.email || '', username: u.username || '',
      departmentId: u.department_id, departmentName: u.department_name || '',
      role: effectiveRole(u), admin: effectiveIsAdmin(u), active: !!u.is_active,
      forcePasswordChange: !!u.force_password_change,
      isLdap: !u.has_password,
      lastLoginAt: u.last_login_at || '',
    })),
    holidays: db.prepare('SELECT * FROM holidays ORDER BY start_date DESC').all().map(h => ({
      id: h.id, type: h.type, name: h.name,
      startDate: h.start_date, duration: h.duration, endDate: h.end_date,
    })),
    // The fixed vocabularies, served rather than duplicated in the client, so
    // the list the UI offers and the list the server validates against cannot
    // drift apart.
    reference: {
      delayReasons: DELAY_REASONS,
      holidayTypes: HOLIDAY_TYPES,
      roleLabels:   ROLE_LABELS,
    },
  });
});

module.exports = router;
