// server/utils/expiry.js
//
// JWT_EXPIRES_IN is a jsonwebtoken duration string ("8h", "45m", "7d"). The
// sliding-session logic needs the same value as a number, and jsonwebtoken does
// not expose its parser.
const DEFAULT_EXPIRY = '8h';

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/** "8h" → 28800. Falls back to the default for anything unparseable, so a typo
 *  in .env produces a normal session rather than one that expires instantly. */
function parseExpirySeconds(value) {
  const raw = String(value || DEFAULT_EXPIRY).trim();
  const m = raw.match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return parseExpirySeconds(DEFAULT_EXPIRY);
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  return n * (UNITS[unit] || 1);
}

function parseExpiryMs(value) {
  return parseExpirySeconds(value) * 1000;
}

module.exports = { DEFAULT_EXPIRY, parseExpirySeconds, parseExpiryMs };
