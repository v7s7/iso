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

  const candidates = [];
  if (username.includes('@') || username.includes('\\')) {
    candidates.push(username);
  } else {
    candidates.push(
      `${username}@${cfg.defaultUPN}`,
      `${username}@${cfg.altUPN}`,
      `${cfg.netbios}\\${username}`,
    );
  }
  if (!candidates.includes(username)) candidates.push(username);

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
  const client = createLdapClient(cfg.url);

  await bindClient(client, bindDN, bindPwd);

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

module.exports = { authenticateUser, browseAllUsers, classifyLdapError, resolveEmail };
