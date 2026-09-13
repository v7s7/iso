// server/routes/audit.js
//
// سجل التدقيق, read-only.
//
// There is no endpoint here that writes, edits or deletes — deliberately. An
// audit log a user can edit is not an audit log, and ISO expects the trail to
// be one nobody inside the system can rewrite. Entries are written only by
// utils/audit.js, from inside the operations being recorded.
const express = require('express');
const { db } = require('../db');
const { verifyToken, blockUntilPasswordChanged } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../utils/permissions');

const router = express.Router();
router.use(verifyToken, blockUntilPasswordChanged, requireAdmin);

// ── GET /api/audit ───────────────────────────────────────────
// Newest first. Paged, because this table only ever grows and a year of
// activity is not something to send to a browser in one response.
router.get('/', (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();
  const action = String(req.query.action || '').trim();

  const where = [];
  const params = [];
  if (search) {
    where.push('(actor_username LIKE ? OR action LIKE ? OR target_id LIKE ? OR old_value LIKE ? OR new_value LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }
  if (action) { where.push('action = ?'); params.push(action); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(...params).n;
  const rows  = db.prepare(`
    SELECT id, created_at, actor_username, actor_role, action, target_type, target_id,
           old_value, new_value, ip
      FROM audit_log ${whereSql}
     ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    success: true,
    total, limit, offset,
    entries: rows.map(r => ({
      id: r.id,
      timestamp: r.created_at,
      actor: r.actor_username,
      actorRole: r.actor_role || '',
      action: r.action,
      target: r.target_id || '',
      targetType: r.target_type || '',
      oldValue: r.old_value || '',
      newValue: r.new_value || '',
      ip: r.ip || '',
    })),
  });
});

// ── GET /api/audit/actions ───────────────────────────────────
// The distinct action names actually present, for the filter dropdown. Read
// from the data rather than hard-coded, so a new action type appears in the
// filter the first time it happens.
router.get('/actions', (_req, res) => {
  const rows = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all();
  res.json({ success: true, actions: rows.map(r => r.action) });
});

module.exports = router;
