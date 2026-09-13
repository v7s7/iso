// server/services/ldapService.js
//
// Everything this system knows about Active Directory lives here. Two jobs:
//
//   authenticateUser()  — sign one person in, and read back the profile and the
//                         groups the role mapping needs.
//   browseAllUsers()    — list the directory with a read-only service account,
//                         so مدير النظام can import staff instead of typing them.
//
// Both are ports of the docTracking implementations against the same forest, so
// a quirk already solved there (the missing `mail` attribute, the three bind
// spellings AD accepts) stays solved here.
const { getLdapConfig, createLdapClient } = require('../config/ldap');

// Bind with a given DN + password. Resolves with the bound client.
// The 'error' listener matters: ldapjs emits TCP failures (ECONNREFUSED,
// ETIMEDOUT) as events that never reach the bind callback, so without it a
// dead directory hangs the request until the HTTP client gives up.
function bindClient(client, dn, password) {
  return new Promise((resolve, reject) => {
    function fail(err) {
      client.unbind(() => {});
      reject(err);
    }
    client.once('error', fail);
    client.bind(dn, password, (err) => {
      client.removeListener('error', fail);
      if (err) return fail(err);
      resolve(client);
    });
  });
}

// One user entry after a successful bind: profile fields + memberOf for the
// group-to-role mapping in utils/roleMapper.js.
function searchUser(client, baseDN, filter) {
  return new Promise((resolve, reject) => {
    const opts = {
      scope: 'sub',
      filter,
      attributes: ['cn', 'displayName', 'mail', 'userPrincipalName', 'proxyAddresses',
                   'department', 'title', 'memberOf', 'sAMAccountName'],
    };
    client.search(baseDN, opts, (err, res) => {
      if (err) return reject(err);

      let entry = null;
      res.on('searchEntry', (e) => { entry = e.object; });
      res.on('error',       (e) => reject(e));
      res.on('end', () => {
        client.unbind(() => {});
        if (!entry) return reject(Object.assign(new Error('USER_NOT_FOUND'), { code: 'USER_NOT_FOUND' }));
        resolve(entry);
      });
    });
  });
}

// ldapjs hands back a bare string when an attribute has exactly one value.
function normalizeMemberOf(raw) {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// Turns raw ldapjs failures into codes the route layer maps to status codes.
// "wrong password" and "the domain controller is down" must not look alike to
// the person signing in.
function classifyLdapError(err) {
  const msg = err?.message || '';
  if (err?.code === 49 || msg.includes('Invalid Credentials') || msg.includes('invalidCredentials')) {
    return 'INVALID_CREDENTIALS';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND')    || msg.includes('connect')) {
    return 'LDAP_UNREACHABLE';
  }
  return 'LDAP_ERROR';
}

/**
 * Where a usable address actually lives, in order of trustworthiness.
 *
 * `mail` is the canonical attribute and is blank across almost all of SWD's
 * directory — normal when mailboxes are provisioned through Exchange Online:
 * the address then lives in proxyAddresses, and the name people sign in with is
 * the userPrincipalName.
 */
function resolveEmail(o) {
  if (o.mail) return String(o.mail).trim();

  // proxyAddresses looks like ["SMTP:primary@swd.bh", "smtp:alias@swd.bh"] —
  // an UPPERCASE SMTP marks the primary.
  const proxies = [].concat(o.proxyAddresses || []).map(String);
  const primary = proxies.find(p => p.startsWith('SMTP:')) || proxies.find(p => /^smtp:/i.test(p));
  if (primary) return primary.slice(5).trim();

  // The sign-in name — a real address in most tenants, but NOT when the forest
  // uses an internal-only domain, so a .local UPN is refused rather than filling
  // the البريد الرسمي column with undeliverable addresses.
  const upn = String(o.userPrincipalName || '').trim();
  if (upn.includes('@') && !/\.local$/i.test(upn.split('@')[1] || '')) return upn;

  return '';
}

/**
 * The spellings Active Directory will accept for one identifier.
 *
 * A bare sAMAccountName is usually NOT a valid bind DN on its own — AD wants a
 * UPN, a DOMAIN\user, or a full distinguished name. Anything already carrying an
 * @ or a backslash is passed through untouched; a full DN (CN=…,DC=…) contains a
 * comma and no @, so it is left alone too.
 *
 * Shared by both binds on purpose. It used to live only inside
 * authenticateUser(), which meant the login screen forgave a bare username while
 * LDAP_BIND_DN silently did not — the same value worked in one place and failed
 * in the other, with nothing on screen to say why.
 */
function bindCandidates(identifier, cfg) {
  const id = String(identifier).trim();
  if (id.includes('@') || id.includes('\\') || /^[A-Za-z]{2,}=/.test(id)) return [id];
  return [
    `${id}@${cfg.defaultUPN}`,
    `${id}@${cfg.altUPN}`,
    `${cfg.netbios}\\${id}`,
    id,
  ];
}

/**
 * Binds the read-only service account, trying each spelling.
 *
 * THE one place a service-account bind happens. It exists because the same
 * inconsistency appeared three times: the login screen forgave a bare username,
 * browseAllUsers() did not, and scripts/ad-probe.js had a third copy that also
 * did not — so LDAP_BIND_DN could work in the app and fail in the diagnostic
 * written to explain why the app was failing.
 *
 * Errors are classified rather than passed through raw: "the password is wrong"
 * and "the domain controller is unreachable" arrive from ldapjs looking similar
 * and lead to completely different places.
 *
 * @returns {Promise<object>} the bound ldapjs client — the caller unbinds it
 */
async function bindServiceAccount(cfg, bindDN, bindPwd) {
  let lastError = null;
  for (const candidate of bindCandidates(bindDN, cfg)) {
    try {
      const client = await bindClient(createLdapClient(cfg.url), candidate, bindPwd);
      if (candidate !== String(bindDN).trim()) {
        console.log(`[LDAP] service account bound as "${candidate}"`);
      }
      return client;
    } catch (err) {
      lastError = err;
    }
  }

  const code = classifyLdapError(lastError);
  const err = new Error(`Could not bind the LDAP service account "${bindDN}": ${lastError?.message || 'unknown error'}`);
  // AD buries the actual reason in a sub-code. 52e is by far the most common and
  // the most misleading — it means the ACCOUNT WAS FOUND and only the password
  // was rejected, which usually means the password never arrived intact. An
  // unquoted # in .env truncates it, and that is exactly what it looks like.
  if (/data 52e/.test(lastError?.message || '')) {
    err.hint = 'AD reports 52e — the account exists, the password was rejected. '
             + 'If the password contains a "#", quote it in .env: KEY="pa55word###".';
  } else if (/data 525/.test(lastError?.message || '')) {
    err.hint = 'AD reports 525 — no such account. Check LDAP_BIND_DN.';
  } else if (/data 533/.test(lastError?.message || '')) {
    err.hint = 'AD reports 533 — the account is disabled.';
  } else if (/data 532|data 773/.test(lastError?.message || '')) {
    err.hint = 'AD reports an expired password on the service account.';
  } else if (/data 775/.test(lastError?.message || '')) {
    err.hint = 'AD reports 775 — the account is locked out.';
  }
  throw Object.assign(err, { code });
}

/**
 * Authenticates one person against Active Directory.
 *
 *  1. Build the bind spellings AD accepts for a bare username.
 *  2. Try each in turn — first success wins.
 *  3. Read the full profile + memberOf back.
 *
 * @returns {Promise<{username,name,email,department,title,memberOf[]}>}
 * @throws  Error with .code = INVALID_CREDENTIALS | LDAP_UNREACHABLE | USER_NOT_FOUND | LDAP_ERROR
 */
async function authenticateUser(username, password) {
  const cfg = getLdapConfig();
  const candidates = bindCandidates(username, cfg);

  let lastError = null;

  for (const bindDN of candidates) {
    try {
      const client = createLdapClient(cfg.url);
      await bindClient(client, bindDN, password);

      // sAMAccountName is the short username whichever bind spelling worked.
      const samAccount = username.split('@')[0].split('\\').pop();
      const filter = `(|(userPrincipalName=${bindDN})(sAMAccountName=${samAccount}))`;

      const entry = await searchUser(client, cfg.baseDN, filter);

      return {
        username:   entry.sAMAccountName || samAccount,
        name:       entry.displayName    || entry.cn || username,
        email:      resolveEmail(entry)  || bindDN,
        department: entry.department     || '',
        title:      entry.title          || '',
        memberOf:   normalizeMemberOf(entry.memberOf),
      };
    } catch (err) {
      lastError = err;
      console.warn(`[LDAP] bind/search failed for "${bindDN}": ${err.message}`);
    }
  }

  const code = classifyLdapError(lastError);
  throw Object.assign(new Error(lastError ? lastError.message : 'Authentication failed'), { code });
}

/**
 * Lists every enabled user account, using the read-only service account.
 * Computer accounts and disabled users are filtered out.
 */
async function browseAllUsers() {
  const bindDN  = process.env.LDAP_BIND_DN;
  const bindPwd = process.env.LDAP_BIND_PASSWORD;

  if (!bindDN || !bindPwd) {
    throw Object.assign(
      new Error('LDAP service account not configured (set LDAP_BIND_DN and LDAP_BIND_PASSWORD).'),
      { code: 'NOT_CONFIGURED' }
    );
  }

  const cfg    = getLdapConfig();
  const client = await bindServiceAccount(cfg, bindDN, bindPwd);

  return new Promise((resolve, reject) => {
    const users = [];
    const opts  = {
      scope:      'sub',
      filter:     '(&(objectClass=user)(!(objectClass=computer))(sAMAccountName=*))',
      attributes: ['sAMAccountName', 'displayName', 'cn', 'mail', 'userPrincipalName',
                   'proxyAddresses', 'department', 'title', 'memberOf', 'userAccountControl'],
      sizeLimit:  2000,
    };

    function fail(e) { client.unbind(() => {}); reject(e); }
    client.once('error', fail);

    client.search(cfg.baseDN, opts, (err, res) => {
      if (err) { client.removeListener('error', fail); return fail(err); }

      res.on('searchEntry', (entry) => {
        const o   = entry.object;
        const uac = parseInt(o.userAccountControl || '0', 10);
        if ((uac & 2) !== 0) return; // ACCOUNTDISABLE
        users.push({
          username:   o.sAMAccountName || '',
          name:       o.displayName    || o.cn || '',
          email:      resolveEmail(o),
          department: o.department     || '',
          title:      o.title          || '',
          memberOf:   normalizeMemberOf(o.memberOf),
        });
      });

      res.on('error', (e) => { client.removeListener('error', fail); fail(e); });

      res.on('end', () => {
        client.removeListener('error', fail);
        client.unbind(() => {});
        resolve(users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar')));
      });
    });
  });
}

module.exports = { authenticateUser, browseAllUsers, classifyLdapError, resolveEmail, bindCandidates, bindServiceAccount };
