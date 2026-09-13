// server/scripts/test-flow.js
//
//   node scripts/test-flow.js          (the server must be running)
//   node scripts/test-flow.js --url http://10.27.17.20:4100
//
// Walks the paths a person actually takes, end to end, and asserts the rules
// hold at each one. Where test-security.js attacks the system, this one uses it:
//
//   · an account created, handed a temporary password, and forced to change it
//   · a self-service password change, and what it does to other open sessions
//   · an administrator changing someone's role while they are signed in
//   · the guards on filing a request — wrong department, future date, a
//     deactivated service
//   · whether Active Directory answers at all
//
// It works against ONE fixed test account (see TEST_EMAIL) which it reuses and
// leaves deactivated, so running it repeatedly does not fill the users table.
// Everything else it touches, it puts back.
require('dotenv').config();

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg > -1 && process.argv[urlArg + 1]) || `http://localhost:${process.env.PORT || 4100}`;

const TEST_EMAIL = 'flow.check@test.local';
const TEST_USER  = 'flow.check';

let fails = 0;
const p = (label, ok, extra) => {
  if (!ok) fails++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  [${extra}]` : ''}`);
};

const api = (path, token, opts = {}) =>
  fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const login = (identifier, password = 'Test123') =>
  api('/api/auth/login', null, { method: 'POST', body: JSON.stringify({ identifier, password }) })
    .then(r => r.body);

const today = () => new Date().toISOString().slice(0, 10);

(async () => {
  console.log(`\n نظام تسجيل الجودة — فحص التدفق\n\n target: ${BASE}\n`);

  try {
    const h = await api('/api/health');
    if (h.status !== 200) throw new Error();
  } catch {
    console.error(` The server is not running at ${BASE}.\n Start it with:  npm start\n`);
    process.exit(1);
  }

  const adm = await login('admin@test.local');
  if (!adm.token) {
    console.error(' Could not sign in as admin@test.local. Run: npm run seed -- --demo\n');
    process.exit(1);
  }
  const T = adm.token;

  const depts = (await api('/api/departments', T)).body.departments || [];
  const deptA = depts.find(d => d.prefix === 'IT');
  const deptB = depts.find(d => d.prefix === 'MNT');
  const services = (await api('/api/services', T)).body.services || [];
  const svcA = services.find(s => s.departmentId === deptA?.id && s.active);
  const svcB = services.find(s => s.departmentId === deptB?.id && s.active);

  // ── 1. A new account, and the temporary password it starts with ─────────
  console.log('1. new account → forced password change');
  let existing = (await api('/api/users', T)).body.users?.find(u => u.email === TEST_EMAIL);

  if (existing) {
    // Reuse the row from a previous run: put it back to a known state.
    await api(`/api/users/${existing.id}`, T, {
      method: 'PUT',
      body: JSON.stringify({ active: true, role: 'user', departmentId: deptB.id }),
    });
    await api(`/api/users/${existing.id}/reset-password`, T, {
      method: 'POST', body: JSON.stringify({ password: 'Temp123' }),
    });
    p('reusing the existing test account', true, `id ${existing.id}`);
  } else {
    const r = await api('/api/users', T, {
      method: 'POST',
      body: JSON.stringify({
        name: 'حساب فحص التدفق', email: TEST_EMAIL, username: TEST_USER,
        password: 'Temp123', departmentId: deptB.id, role: 'user',
        admin: false, active: true, forcePasswordChange: true,
      }),
    });
    p('created', r.status === 201, `HTTP ${r.status} ${r.body.message || ''}`);
    existing = r.body.user;
  }
  const uid = existing.id;

  const temp = await login(TEST_EMAIL, 'Temp123');
  p('signs in with the temporary password', !!temp.token);
  p('flagged as needing a change', temp.user?.forcePasswordChange === true);

  // The flag has to mean something beyond the screen that shows it.
  const blocked = await api('/api/requests', temp.token);
  p('every other screen is refused until it is changed', blocked.status === 403, `HTTP ${blocked.status}`);
  const shell = await api('/api/bootstrap', temp.token);
  p('the snapshot carries no data yet', (shell.body.requests || []).length === 0);

  // …and the change itself must be reachable, without the temporary password,
  // which the administrator chose and probably said out loud.
  const chg = await api('/api/auth/password', temp.token, {
    method: 'POST', body: JSON.stringify({ current: '', password: 'FlowPass1', confirmPassword: 'FlowPass1' }),
  });
  p('the change is allowed without re-typing the temporary one', chg.status === 200, `HTTP ${chg.status}`);
  p('the system opens up afterwards', (await api('/api/requests', temp.token)).status === 200);
  p('the temporary password stops working', !(await login(TEST_EMAIL, 'Temp123')).token);

  // ── 2. Self-service change ──────────────────────────────────────────────
  console.log('\n2. self-service password change');
  const me = await login(TEST_EMAIL, 'FlowPass1');
  const bad = (body) => api('/api/auth/password', me.token, { method: 'POST', body: JSON.stringify(body) });

  p('wrong current password refused',
    (await bad({ current: 'nope', password: 'FlowPass2', confirmPassword: 'FlowPass2' })).status === 401);
  p('too short refused',
    (await bad({ current: 'FlowPass1', password: 'ab', confirmPassword: 'ab' })).status === 400);
  p('mismatched confirmation refused',
    (await bad({ current: 'FlowPass1', password: 'FlowPass2', confirmPassword: 'Other9' })).status === 400);
  p('reusing the current password refused',
    (await bad({ current: 'FlowPass1', password: 'FlowPass1', confirmPassword: 'FlowPass1' })).status === 400);

  // A password changed because someone else may know it is pointless if their
  // existing sign-in keeps working.
  const otherDevice = await login(TEST_EMAIL, 'FlowPass1');
  p('valid change accepted',
    (await bad({ current: 'FlowPass1', password: 'FlowPass2', confirmPassword: 'FlowPass2' })).status === 200);
  p('it ended the other open session', (await api('/api/requests', otherDevice.token)).status === 401);
  p('but not the session that made the change', (await api('/api/requests', me.token)).status === 200);

  // ── 3. An administrator changing someone mid-session ────────────────────
  console.log('\n3. admin changes take effect immediately');
  const r3 = await api(`/api/users/${uid}`, T, {
    method: 'PUT', body: JSON.stringify({ role: 'supervisor', departmentId: deptB.id }),
  });
  p('role changed', r3.status === 200 && r3.body.user?.role === 'supervisor', `HTTP ${r3.status}`);
  const live = await api('/api/bootstrap', me.token);
  p('the signed-in session sees it on its next request, with no re-login',
    live.body.user?.role === 'supervisor', `role=${live.body.user?.role}`);

  await api(`/api/users/${uid}/reset-password`, T, { method: 'POST', body: JSON.stringify({ password: 'Temp123' }) });
  p('an admin password reset ends their sessions', (await api('/api/requests', me.token)).status === 401);

  await api(`/api/users/${uid}/toggle`, T, { method: 'POST' });
  p('a deactivated account cannot sign in', !(await login(TEST_EMAIL, 'Temp123')).token);

  // ── 4. Filing a request: the guards ─────────────────────────────────────
  console.log('\n4. filing a request');
  const staff = await login('hisham@test.local');      // in deptA
  const file = (body) => api('/api/requests', staff.token, { method: 'POST', body: JSON.stringify(body) });

  const ok = await file({ serviceId: svcA.id, requestDate: today(), subject: 'فحص التدفق — طلب سليم' });
  p('a valid request is accepted', ok.status === 201, `HTTP ${ok.status} ${ok.body.message || ''}`);
  p('the deadline was computed server-side', !!ok.body.request?.dueDate, ok.body.request?.dueDate);

  p("another department's service is refused",
    (await file({ serviceId: svcB.id, requestDate: today(), subject: 'قسم آخر' })).status === 403);
  p('a future request date is refused',
    (await file({ serviceId: svcA.id, requestDate: '2099-01-01', subject: 'مستقبلي' })).status === 400);
  p('a missing subject is refused',
    (await file({ serviceId: svcA.id, requestDate: today(), subject: '' })).status === 400);

  await api(`/api/services/${svcA.id}/toggle`, T, { method: 'POST' });
  p('a deactivated service is refused',
    (await file({ serviceId: svcA.id, requestDate: today(), subject: 'معطّلة' })).status === 400);
  await api(`/api/services/${svcA.id}/toggle`, T, { method: 'POST' });   // put it back

  // ── 5. Closing it ───────────────────────────────────────────────────────
  console.log('\n5. closing a request');
  const code = ok.body.request?.reqCode;
  const close = (body) => api(`/api/requests/${code}/close`, staff.token, { method: 'POST', body: JSON.stringify(body) });

  p('a close date before the request date is refused',
    (await close({ closeDate: '2020-01-01' })).status === 400);
  p('a close date in the future is refused',
    (await close({ closeDate: '2099-01-01' })).status === 400);

  const other = await login('power@test.local');
  p('someone else cannot close it',
    (await api(`/api/requests/${code}/close`, other.token, { method: 'POST', body: JSON.stringify({ closeDate: today() }) })).status === 403);

  const done = await close({ closeDate: today(), closureNotes: 'فحص آلي' });
  p('the person who filed it can', done.status === 200, `HTTP ${done.status}`);
  p('closed on time', done.body.request?.isOnTime === true && done.body.request?.delayDays === 0);
  p('closing it twice is refused', (await close({ closeDate: today() })).status === 409);

  // ── 6. Active Directory ─────────────────────────────────────────────────
  console.log('\n6. Active Directory');
  if (!process.env.LDAP_URL) {
    console.log('  — LDAP_URL not set; skipped');
  } else {
    // A deliberately wrong password. What matters is WHICH refusal comes back:
    // "invalid credentials" means the directory answered, which is the thing
    // worth knowing. A 503 would mean it never did.
    const ad = await api('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ identifier: 'a.alkubaesy', password: 'deliberately-wrong-' + Date.now() }),
    });
    p('the directory answered (401, not 503)', ad.status === 401,
      `HTTP ${ad.status} — ${ad.body.message || ''}`);
    if (ad.status === 503) {
      console.log('      the domain controller did not respond. Check LDAP_URL and the network.');
    }

    const dir = await api('/api/users/directory', T);
    if (dir.status === 503) console.log('  — directory browse disabled (no LDAP_BIND_DN); sign-in still works');
    else p('directory browse returned users', dir.status === 200 && Array.isArray(dir.body.users),
      `${dir.body.users?.length ?? 0} account(s)`);
  }

  console.log('');
  console.log(fails ? `${fails} check(s) FAILED.\n` : 'All flow checks passed.\n');
  process.exit(fails ? 1 : 0);
})();
