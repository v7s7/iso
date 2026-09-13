// server/scripts/ad-probe.js
//
//   npm run ad-probe               — a few sample accounts + attribute coverage
//   npm run ad-probe -- a.alkubaesy  — one specific account, every attribute
//
// Read-only diagnostic. Prints exactly what Active Directory returns, so a
// question like "which group is this person actually in?" or "where does the
// email address live?" is answered by looking rather than by guessing.
//
// Writes nothing, changes nothing.
require('dotenv').config();
const { getLdapConfig, createLdapClient } = require('../config/ldap');

const WANT = process.argv[2] || null;

const ATTRS = [
  'sAMAccountName', 'displayName', 'cn',
  'mail', 'userPrincipalName', 'proxyAddresses',
  'department', 'title', 'memberOf', 'userAccountControl',
];

function bind(client, dn, pwd) {
  return new Promise((resolve, reject) => {
    const fail = e => { client.unbind(() => {}); reject(e); };
    client.once('error', fail);
    client.bind(dn, pwd, err => { client.removeListener('error', fail); err ? fail(err) : resolve(); });
  });
}

const cn = dn => (String(dn).match(/^CN=([^,]+)/i) || [])[1] || String(dn);

(async () => {
  if (!process.env.LDAP_URL) {
    console.error('[probe] LDAP_URL is not set in server/.env');
    process.exit(1);
  }
  const bindDN  = process.env.LDAP_BIND_DN;
  const bindPwd = process.env.LDAP_BIND_PASSWORD;
  if (!bindDN || !bindPwd) {
    console.error('[probe] LDAP_BIND_DN / LDAP_BIND_PASSWORD are not set in server/.env');
    console.error('        A read-only account is enough.');
    process.exit(1);
  }

  const cfg    = getLdapConfig();
  const client = createLdapClient(cfg.url);
  await bind(client, bindDN, bindPwd);
  console.log(`[probe] bound as ${bindDN}`);
  console.log(`[probe] baseDN ${cfg.baseDN}\n`);

  const filter = WANT
    ? `(&(objectClass=user)(sAMAccountName=${WANT}))`
    : '(&(objectClass=user)(!(objectClass=computer))(sAMAccountName=*))';

  const found = [];
  let scanned = 0;
  let disabled = 0;
  const coverage = Object.fromEntries(['mail', 'userPrincipalName', 'proxyAddresses', 'department', 'title'].map(k => [k, 0]));
  const groupCounts = new Map();

  await new Promise((resolve, reject) => {
    client.search(cfg.baseDN, { scope: 'sub', filter, attributes: ATTRS, sizeLimit: 2000 }, (err, res) => {
      if (err) return reject(err);
      res.on('searchEntry', e => {
        const o = e.object || {};
        scanned++;
        if ((parseInt(o.userAccountControl || '0', 10) & 2) !== 0) disabled++;
        for (const k of Object.keys(coverage)) if (o[k]) coverage[k]++;
        for (const dn of [].concat(o.memberOf || [])) {
          const name = cn(dn);
          groupCounts.set(name, (groupCounts.get(name) || 0) + 1);
        }
        if (WANT || found.length < 3) found.push(o);
      });
      res.on('error', reject);
      res.on('end', () => { client.unbind(() => {}); resolve(); });
    });
  });

  for (const o of found) {
    console.log('─'.repeat(64));
    for (const k of ATTRS) {
      if (k === 'memberOf') continue;
      if (o[k] != null) console.log(`  ${k.padEnd(20)} ${Array.isArray(o[k]) ? o[k].join(', ') : o[k]}`);
    }
    const groups = [].concat(o.memberOf || []).map(cn);
    console.log(`  ${'groups'.padEnd(20)} ${groups.length ? groups.join(', ') : '(none)'}`);
    // The lowercase CN is exactly the key config/directory-map.json expects, so
    // it can be copied straight across without working out the spelling.
    if (groups.length) {
      console.log(`  ${'map keys'.padEnd(20)} ${groups.map(g => g.toLowerCase()).join(', ')}`);
    }
  }

  console.log('─'.repeat(64));
  console.log(`\nscanned ${scanned} account(s) (${disabled} disabled)\n`);
  console.log('attribute coverage:');
  for (const [k, n] of Object.entries(coverage)) {
    const pct = scanned ? Math.round((n / scanned) * 100) : 0;
    console.log(`  ${k.padEnd(20)} ${String(n).padStart(4)} / ${scanned}  (${pct}%)`);
  }

  if (!WANT && groupCounts.size) {
    console.log('\nmost common groups — candidates for config/directory-map.json:');
    [...groupCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([g, n]) => console.log(`  ${String(n).padStart(4)}  ${g.toLowerCase()}`));
  }
  console.log('');
})().catch(e => {
  console.error('[probe] failed:', e.message);
  process.exit(1);
});
