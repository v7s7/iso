// server/utils/audit.js
//
// سجل التدقيق. Every write that matters passes through here.
//
// The signature carries old_value/new_value as a readable Arabic pair, because
// that is what the audit screen shows and what a reviewer reads. `details` holds
// the same change as JSON for anyone who needs the exact fields later. A
// reviewer needs the sentence; an investigation needs the values.
//
// Logging never throws. An audit failure must not be able to roll back the
// business operation it was recording — losing one log line is bad, losing the
// user's work because of a log line is worse. Failures go to the console where
// the check scripts can see them.
const { db } = require('../db');

function logAudit(actor, action, targetType, targetId, { oldValue, newValue, details } = {}, ip) {
  try {
    db.prepare(`
      INSERT INTO audit_log
        (actor_username, actor_role, action, target_type, target_id, old_value, new_value, details, ip)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      actor?.username || actor?.email || 'SYSTEM',
      actor?.role     || '',
      action,
      targetType || '',
      targetId != null ? String(targetId) : '',
      oldValue != null ? String(oldValue) : '',
      newValue != null ? String(newValue) : '',
      details ? JSON.stringify(details) : null,
      ip || ''
    );
  } catch (e) {
    console.warn('[Audit] log failed:', e.message);
  }
}

/**
 * A readable "before → after" pair over the fields that actually changed.
 *
 * The prototype logged whole objects as raw JSON, which made the audit screen
 * unreadable — its own test checklist calls that out. Unchanged fields are
 * dropped entirely: an entry saying only "القسم: قسم الصيانة ← قسم المساجد" is
 * the one a reviewer can act on.
 *
 * @param {object} before  labelled snapshot, e.g. { 'القسم': 'قسم الصيانة' }
 * @param {object} after   the same labels, after the change
 */
function readableDiff(before, after) {
  const changed = Object.keys(after).filter(k => String(before[k] ?? '') !== String(after[k] ?? ''));
  return {
    changed,
    oldValue: changed.map(k => `${k}: ${before[k] ?? '-'}`).join(' | '),
    newValue: changed.map(k => `${k}: ${after[k]  ?? '-'}`).join(' | '),
  };
}

module.exports = { logAudit, readableDiff };
