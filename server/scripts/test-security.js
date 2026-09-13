// server/scripts/test-security.js
//
//   node scripts/test-security.js          (the server must be running)
//   node scripts/test-security.js --url http://10.27.17.20:4100
//
// Tries to break into the running server, from the position of someone who has
// stolen the JWT signing secret — the worst realistic case, and the one where
// "the token is signed, so it is fine" stops being true.
//
// Every check here asserts a REFUSAL. They exist because each one was, at some
// point, a way in:
//
//   · a token naming someone else's id while carrying its own honest session
//     served that other person's account — this is how مدير النظام was reached
//     from a مشرف قسم account
//   · a token with no jti skipped the session lookup entirely, which also made
//     it immune to a forced sign-out
//   · role and admin claimed in the payload were believed
//
// Read-only apart from signing in as the seeded test accounts.
require('dotenv').config();
const jwt = require('jsonwebtoken');

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg > -1 && process.argv[urlArg + 1]) || `http://localhost:${process.env.PORT || 4100}`;
const SECRET = process.env.JWT_SECRET;

let failures = 0;
const pass = (m)      => console.log(`  ✓ ${m}`);
const fail = (m, got) => { failures++; console.log(`  ✗ ${m}`); console.log(`      got: ${got}`); };

async function api(path, token, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function login(identifier, password = 'Test123') {
  const { body } = await api('/api/auth/login', null, {
    method: 'POST', body: JSON.stringify({ identifier, password }),
  });
  return body;
}

/** Asserts that a forged token is NOT served as someone it should not be. */
async function mustNotBecome(label, token, forbidden) {
  const { body } = await api('/api/bootstrap', token);
  if (!body.success) return pass(`${label} → refused (${body.message})`);

  const got = `${body.user.name} role=${body.user.role} admin=${body.user.admin}`;
  const escalated =
    (forbidden.admin !== undefined && body.user.admin === forbidden.admin) ||
    (forbidden.role  !== undefined && body.user.role  === forbidden.role)  ||
    (forbidden.name  !== undefined && body.user.name  === forbidden.name);

  if (escalated) return fail(`${label} → ESCALATED`, got);
  // Accepted, but downgraded to the account the session actually belongs to.
  // That is the correct outcome for a real session carrying invented claims.
  pass(`${label} → accepted but served as its real account (${got})`);
}

(async () => {
  console.log(`\n نظام تسجيل الجودة — فحص الأمان\n\n target: ${BASE}\n`);

  if (!SECRET) { console.error('JWT_SECRET is not set — cannot run.'); process.exit(1); }

  try {
    const health = await api('/api/health');
    if (health.status !== 200) throw new Error('not ok');
  } catch {
    console.error(` The server is not running at ${BASE}.`);
    console.error(' Start it with:  npm start\n');
    process.exit(1);
  }

  // ── Sign-in ──
  console.log('sign-in');
  const sup = await login('supervisor@test.local');
  const adm = await login('admin@test.local');
  if (!sup.token || !adm.token) {
    console.error(' Could not sign in as the seeded test accounts. Run: npm run seed\n');
    process.exit(1);
  }
  pass(`signed in as supervisor (role=${sup.user.role}, admin=${sup.user.admin})`);
  pass(`signed in as admin (role=${adm.user.role}, admin=${adm.user.admin})`);

  const bad = await login('supervisor@test.local', 'not-the-password');
  bad.success ? fail('a wrong password is refused', 'accepted') : pass('a wrong password is refused');

  // ── Forged tokens ──
  console.log('\nforged tokens (signed with the REAL secret)');
  const { exp, iat, ...claims } = jwt.decode(sup.token);
  const sign = (payload) => jwt.sign(payload, SECRET, { expiresIn: '8h' });

  await mustNotBecome("id swapped to the admin's id",
    sign({ ...claims, id: adm.user.id }), { admin: true });

  await mustNotBecome('renamed self to admin',
    sign({ ...claims, username: 'admin', name: 'مدير النظام' }), { admin: true });

  await mustNotBecome('no jti at all (skips the session lookup)',
    sign({ id: claims.id, username: claims.username }), { role: 'supervisor' });

  await mustNotBecome('role and admin claimed in the payload',
    sign({ ...claims, role: 'power', admin: true, is_admin: true }), { admin: true });

  await mustNotBecome('unknown jti',
    sign({ ...claims, jti: '00000000-0000-0000-0000-000000000000' }), { role: 'supervisor' });

  // A token signed with the WRONG secret must never be accepted — this is the
  // baseline the others are only interesting relative to.
  {
    const wrong = jwt.sign({ ...claims }, 'not-the-real-secret', { expiresIn: '8h' });
    const { body } = await api('/api/bootstrap', wrong);
    body.success ? fail('a token signed with the wrong secret is refused', 'accepted')
                 : pass('a token signed with the wrong secret is refused');
  }

  // ── Authorisation ──
  console.log('\nauthorisation');
  const checks = [
    ['GET',  '/api/audit',           'سجل التدقيق'],
    ['GET',  '/api/users/directory', 'Active Directory browse'],
  ];
  for (const [method, path, label] of checks) {
    const { status } = await api(path, sup.token, { method });
    status === 403 ? pass(`مشرف قسم is refused ${label}`)
                   : fail(`مشرف قسم is refused ${label}`, `HTTP ${status}`);
  }
  {
    const { status } = await api('/api/departments', sup.token, {
      method: 'POST', body: JSON.stringify({ name: 'اختبار', prefix: 'ZZZ' }),
    });
    status === 403 ? pass('مشرف قسم cannot create a department')
                   : fail('مشرف قسم cannot create a department', `HTTP ${status}`);
  }
  {
    // Self-promotion. مدير النظام editing his own role is the one edit an
    // administrator must not be able to make.
    const { status, body } = await api(`/api/users/${adm.user.id}`, adm.token, {
      method: 'PUT', body: JSON.stringify({ role: 'user' }),
    });
    status === 403 ? pass(`مدير النظام cannot change his own role (${body.message})`)
                   : fail('مدير النظام cannot change his own role', `HTTP ${status}`);
  }
  {
    const { status, body } = await api(`/api/users/${adm.user.id}`, adm.token, {
      method: 'PUT', body: JSON.stringify({ active: false }),
    });
    status === 403 ? pass(`مدير النظام cannot deactivate himself (${body.message})`)
                   : fail('مدير النظام cannot deactivate himself', `HTTP ${status}`);
  }

  // ── Visibility ──
  console.log('\nvisibility');
  const user = await login('hisham@test.local');
  const mine = await api('/api/bootstrap', user.token);
  const others = mine.body.requests.filter(r => r.userId !== user.user.id);
  others.length === 0 ? pass(`مستخدم sees only his own requests (${mine.body.requests.length})`)
                      : fail('مستخدم sees only his own requests', `${others.length} belonging to others`);

  const supBoot = await api('/api/bootstrap', sup.token);
  const outside = supBoot.body.requests.filter(r => r.departmentId !== sup.user.departmentId);
  outside.length === 0 ? pass(`مشرف قسم sees only his department (${supBoot.body.requests.length})`)
                       : fail('مشرف قسم sees only his department', `${outside.length} from other departments`);

  // A request the user is not entitled to must 404/403 when asked for directly,
  // not merely be absent from the list.
  const foreign = supBoot.body.requests.find(r => r.userId !== user.user.id);
  if (foreign) {
    const { status } = await api(`/api/requests/${foreign.reqCode}`, user.token);
    status === 403 ? pass("مستخدم cannot open another person's request directly")
                   : fail("مستخدم cannot open another person's request directly", `HTTP ${status}`);
  }

  // ── Session revocation ──
  console.log('\nsession revocation');
  const temp = await login('hisham@test.local');
  await api('/api/auth/logout', temp.token, { method: 'POST' });
  const after = await api('/api/bootstrap', temp.token);
  after.status === 401 ? pass('a token stops working after signing out')
                       : fail('a token stops working after signing out', `HTTP ${after.status}`);

  console.log('');
  if (failures) {
    console.log(`${failures} check(s) FAILED.\n`);
    process.exit(1);
  }
  console.log('All security checks passed.\n');
})();
