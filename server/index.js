// server/index.js
//
// نظام تسجيل الجودة — API + web server.
//
// One process serves both the API under /api and the site itself from public/,
// so there is one port to open, one origin, and therefore no CORS in the normal
// deployment. Same arrangement as docTracking.
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const fs         = require('fs');
require('dotenv').config();

// Requiring the db module is what creates or migrates the file on disk, so it
// happens before any route can run a query against a table that isn't there.
require('./db');

const authRoutes        = require('./routes/auth');
const bootstrapRoutes   = require('./routes/bootstrap');
const requestsRoutes    = require('./routes/requests');
const departmentsRoutes = require('./routes/departments');
const servicesRoutes    = require('./routes/services');
const holidaysRoutes    = require('./routes/holidays');
const usersRoutes       = require('./routes/users');
const auditRoutes       = require('./routes/audit');

const app  = express();
const PORT = process.env.PORT || 4100;

// Refusing to start is the right response to a missing signing secret. The
// alternative — a default — means every deployment that forgot to set one
// shares a secret that is printed in this file, and any of them can mint a
// valid token for any other.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('replace_with')) {
  console.error('[Server] FATAL: JWT_SECRET is not set in server/.env. Refusing to start.');
  console.error('         Generate one with:');
  console.error('         node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

app.disable('x-powered-by');

// Security headers. upgradeInsecureRequests must be nulled explicitly —
// helmet's default turns it on, which rewrites every asset request to https://
// and breaks the site outright on an internal deployment with no TLS.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      fontSrc:        ["'self'", 'data:'],
      imgSrc:         ["'self'", 'data:'],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      frameAncestors: ["'self'"],
      formAction:     ["'self'"],
      scriptSrcAttr:  ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));

// Only relevant for a split deployment where the page is served from somewhere
// else. Same-origin is the normal case and needs none of this.
app.use(cors({ origin: process.env.CLIENT_URL || true, credentials: true }));
app.use(bodyParser.json({ limit: '1mb' }));

app.use('/api/auth',        authRoutes);
app.use('/api/bootstrap',   bootstrapRoutes);
app.use('/api/requests',    requestsRoutes);
app.use('/api/departments', departmentsRoutes);
app.use('/api/services',    servicesRoutes);
app.use('/api/holidays',    holidaysRoutes);
app.use('/api/users',       usersRoutes);
app.use('/api/audit',       auditRoutes);

// Liveness, and enough configuration detail to answer "why can nobody sign in?"
// without opening a shell on the server. No secrets — only whether each thing is
// configured at all.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    ldap: process.env.LDAP_URL ? 'configured' : 'disabled',
    ldapBrowse: process.env.LDAP_BIND_DN ? 'configured' : 'disabled',
  });
});

// An unknown /api path is a 404 in JSON, not the HTML shell below. A front end
// that calls a misspelled endpoint should see an error it can report, not a
// page of HTML that fails to parse as JSON three frames later.
app.use('/api', (_req, res) => res.status(404).json({ success: false, message: 'Endpoint not found.' }));

// ── The site ─────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir));
  // Fall back to the app shell only for routes with no file extension. A
  // request for a missing /favicon.ico should 404, not quietly return HTML.
  app.get('*', (req, res, next) => {
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  console.log('[Server] serving site from', publicDir);
} else {
  console.warn('[Server] public/index.html not found — API only.');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] نظام تسجيل الجودة running on http://localhost:${PORT}`);
  console.log(`[Server] LDAP: ${process.env.LDAP_URL || '(disabled — local accounts only)'}`);
});
