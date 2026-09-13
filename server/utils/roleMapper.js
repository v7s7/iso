// server/utils/roleMapper.js
//
// Active Directory group memberships → this system's role, department and
// مدير النظام flag.
//
// The mapping is read from config/directory-map.json on every call (cached in
// memory by configService), so adding a group to the file takes effect on the
// next sign-in — no restart, no redeploy.
const { readConfig } = require('../services/configService');

/**
 * The CN out of a full distinguished name.
 * "CN=ISO_Supervisors,OU=Groups,DC=swd,DC=local" → "iso_supervisors"
 */
function extractCN(dn) {
  const m = String(dn).match(/^CN=([^,]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Least to most privileged. A person in several mapped groups gets the highest
// one — the alternative is that the answer depends on the order AD happens to
// return memberOf in, which is not an order anyone controls.
const ROLE_PRIORITY = ['user', 'supervisor', 'power'];

/** Plain group CN names, for the audit trail and the import screen. */
function groupNames(memberOf = []) {
  return memberOf.map(extractCN).filter(Boolean);
}

/**
 * The role these groups grant. Falls back to 'user' for anyone who
 * authenticated successfully but matches no mapped group — a real employee
 * with no special standing, which is the correct default.
 */
function mapGroupsToRole(memberOf = []) {
  const { roleGroupMap = {} } = readConfig();
  let highest = 'user';

  for (const cn of groupNames(memberOf)) {
    const mapped = roleGroupMap[cn];
    if (!mapped || !ROLE_PRIORITY.includes(mapped)) continue;
    if (ROLE_PRIORITY.indexOf(mapped) > ROLE_PRIORITY.indexOf(highest)) highest = mapped;
  }
  return highest;
}

/** Do these groups grant مدير النظام? */
function mapGroupsToAdmin(memberOf = []) {
  const { adminGroups = [] } = readConfig();
  if (!adminGroups.length) return false;
  const wanted = adminGroups.map(g => String(g).toLowerCase());
  return groupNames(memberOf).some(cn => wanted.includes(cn));
}

/**
 * The department id these groups point at, or null.
 *
 * Only a hint: routes/auth.js uses it for a first sign-in where nobody has
 * assigned a department yet. Once a row exists, the stored department wins —
 * an administrator's decision here is not overwritten by AD on the next login.
 */
function mapGroupsToDepartmentId(memberOf = []) {
  const { deptGroupMap = {} } = readConfig();
  for (const cn of groupNames(memberOf)) {
    if (deptGroupMap[cn] != null) return Number(deptGroupMap[cn]);
  }
  return null;
}

module.exports = { extractCN, groupNames, mapGroupsToRole, mapGroupsToAdmin, mapGroupsToDepartmentId };
