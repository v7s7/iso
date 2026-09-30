// server/services/configService.js
//
// Single source of truth for how Active Directory maps onto this system:
// which AD group grants which role, which grants مدير النظام, and which AD
// group belongs to which department.
//
// A file rather than a table, matching docTracking: this is deployment
// configuration an administrator edits alongside .env, not user data. Cached in
// memory and refreshed on write, so an edit applies to the next login without a
// restart.
const fs   = require('fs');
const path = require('path');

// Stays in config/ when DATA_DIR moves the data out of the code folder: nothing
// in the app calls writeConfig, so the file is configuration that git tracks,
// not data. A screen that writes it would make it data, and it would then have
// to move to DATA_DIR (see config/dataDir.js).
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'directory-map.json');

const DEFAULT_CONFIG = {
  roleGroupMap:  {},
  adminGroups:   [],
  deptGroupMap:  {},
};

let cache = null;

function readConfig() {
  if (!cache) {
    try {
      cache = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    } catch {
      cache = { ...DEFAULT_CONFIG };
    }
  }
  return cache;
}

function writeConfig(data) {
  const toWrite = { ...readConfig(), ...data };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), 'utf8');
  cache = toWrite; // keep the cache consistent with disk
  return toWrite;
}

/** Drops the cache. Only the scripts need this, after editing the file directly. */
function reloadConfig() {
  cache = null;
  return readConfig();
}

module.exports = { readConfig, writeConfig, reloadConfig, CONFIG_PATH };
