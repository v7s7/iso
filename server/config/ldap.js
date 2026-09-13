// server/config/ldap.js
//
// Connection details for the directory, and a client factory. Ported verbatim
// in shape from docTracking so both systems talk to the same AD the same way —
// if one of them can sign in, so can the other.
const ldap = require('ldapjs');
require('dotenv').config();

function getLdapConfig() {
  const url = process.env.LDAP_URL;
  if (!url) throw new Error('LDAP_URL is not defined in environment variables.');

  return {
    url,
    baseDN:     process.env.LDAP_BASE_DN     || 'DC=example,DC=local',
    defaultUPN: process.env.LDAP_DEFAULT_UPN || 'example.com',
    altUPN:     process.env.LDAP_ALT_UPN     || 'example.local',
    netbios:    process.env.LDAP_NETBIOS     || 'EXAMPLE',
  };
}

/** True when the directory is configured at all. Sign-in falls back to local
 *  accounts when it is not, so the site still runs on a laptop with no AD. */
function ldapEnabled() {
  return !!process.env.LDAP_URL;
}

// Factory: a fresh ldapjs client per request (no shared state, so one slow bind
// cannot wedge another). TLS is used automatically for ldaps://
function createLdapClient(url) {
  const isSecure = url.startsWith('ldaps://');
  return ldap.createClient({
    url,
    timeout:        8000,
    connectTimeout: 8000,
    reconnect:      false,
    ...(isSecure
      ? { tlsOptions: { rejectUnauthorized: process.env.NODE_ENV === 'production' } }
      : {}),
  });
}

module.exports = { getLdapConfig, createLdapClient, ldapEnabled };
