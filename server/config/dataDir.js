// server/config/dataDir.js
//
// Where this deployment keeps its live data: the database (with the -wal and
// -shm files SQLite keeps beside it), the copies `npm run backup` makes, and the
// directory-link.csv the two directory-link scripts pass between them.
//
// DATA_DIR in server/.env names that folder. Unset, it is server/data inside the
// code folder, exactly as before. On SWAPP it is set to a folder outside every
// app's code, so a pull or a fresh clone can never touch the data, and one
// backup of that folder covers all the apps.
//
// DB_PATH still overrides the database file alone, wherever DATA_DIR points.
// Relative paths in either are taken from the server folder rather than from
// wherever the command happened to be started, so every script that reads them
// agrees on one file.
//
// config/directory-map.json does NOT move with DATA_DIR. Nothing in the app
// writes it (writeConfig in services/configService.js has no caller): it is
// deployment configuration an administrator edits by hand and git tracks, the
// same kind of file as this one. If a screen ever starts writing it, it becomes
// live data and belongs in DATA_DIR, seeded from the tracked copy.
//
// Reads process.env when first required and does not load .env itself, the same
// as db/index.js: the entry point loads it first. That is deliberate, because
// scripts/test-migration-prep.js points DB_PATH at a scratch file and must not
// pick up the server's DATA_DIR.
const fs   = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const DB_FILE    = 'iso-quality.db';

/** The paths a given environment resolves to. Pure, so the test can feed it any
 *  environment and any server folder without touching the real ones. */
function resolveDataPaths(env = process.env, serverDir = SERVER_DIR) {
  const legacyDir  = path.join(serverDir, 'data');
  const configured = String(env.DATA_DIR || '').trim();
  const dataDir    = configured ? path.resolve(serverDir, configured) : legacyDir;
  const dbOverride = String(env.DB_PATH || '').trim();
  return {
    dataDir,
    dbPath:         dbOverride ? path.resolve(serverDir, dbOverride) : path.join(dataDir, DB_FILE),
    legacyDir,
    legacyDbPath:   path.join(legacyDir, DB_FILE),
    usingDataDir:   Boolean(configured),
    dbPathOverride: Boolean(dbOverride),
  };
}

// Windows paths compare without case; E:\Apps and e:\apps are one folder.
function samePath(a, b) {
  const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function isInside(dir, file) {
  const rel = path.relative(dir, file);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}

// A WAL database's newest changes are in its -wal file, which can be hours
// newer than the .db, so both count towards "last changed".
function lastChanged(dbFile) {
  let latest = 0;
  for (const f of [dbFile, `${dbFile}-wal`]) {
    try { latest = Math.max(latest, fs.statSync(f).mtimeMs); } catch { /* absent */ }
  }
  return latest;
}

function stamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Whether it is safe to open the database, decided BEFORE opening it, because
 * opening a missing file creates it.
 *
 * With DATA_DIR unset nothing is refused: the server behaves exactly as it did
 * before DATA_DIR existed. With it set, the person who set it has said the data
 * has moved, so a missing database means the move has not happened (or went to
 * the wrong folder), and starting anyway would put the site on a new empty
 * database while the real one sits somewhere nobody backs up.
 *
 * Returns { refuse, warnings }: refuse is null or the lines explaining why,
 * each warning is an array of lines.
 */
function checkDataLocation(p = resolveDataPaths()) {
  const warnings = [];
  if (!p.usingDataDir) return { refuse: null, warnings };

  if (p.dbPathOverride && !isInside(p.dataDir, p.dbPath)) {
    warnings.push([
      `DB_PATH overrides DATA_DIR: the database in use is ${p.dbPath}, which is outside ${p.dataDir}.`,
      'A backup of DATA_DIR does not include it. Remove DB_PATH from server/.env unless that is intended.',
    ]);
  }

  const legacyIsLive = samePath(p.dbPath, p.legacyDbPath);
  const legacyDb     = !legacyIsLive && fs.existsSync(p.legacyDbPath);

  if (!fs.existsSync(p.dbPath)) {
    const lines = [
      `DATA_DIR is set, but there is no database at ${p.dbPath}${p.dbPathOverride ? ' (the file DB_PATH names)' : ''}.`,
      'Refusing to start, so that a new empty database is not created in its place.',
    ];
    if (legacyDb) lines.push(`The database is still in the old folder: ${p.legacyDbPath}`);
    if (p.dbPathOverride) {
      lines.push('Correct DB_PATH in server/.env, or remove it so the database is looked for in DATA_DIR.');
    } else {
      lines.push(
        `Stop the server, move ${DB_FILE} together with its -wal and -shm files into ${p.dataDir}, then start again.`,
        `Or remove DATA_DIR from server/.env to keep using ${p.legacyDir}.`,
      );
    }
    return { refuse: lines, warnings };
  }

  // The .db moved and its -wal stayed behind. The -wal holds every change not
  // yet copied into the .db, and SQLite only applies it when it sits next to
  // its own .db, so opening the moved file now would quietly lose those changes
  // and the next write would make them unrecoverable.
  const legacyWal = `${p.legacyDbPath}-wal`;
  if (!legacyIsLive && !legacyDb && sizeOf(legacyWal) > 0) {
    if (sizeOf(`${p.dbPath}-wal`) < 0) {
      return {
        refuse: [
          `${DB_FILE}-wal was left behind in ${p.legacyDir}.`,
          'It holds the newest changes to the database and only counts next to its own .db file.',
          `Stop the server, move ${DB_FILE}-wal and ${DB_FILE}-shm from ${p.legacyDir} into ${path.dirname(p.dbPath)}, then start again.`,
        ],
        warnings,
      };
    }
    warnings.push([
      `A leftover ${DB_FILE}-wal is in ${p.legacyDir}. It is not used: the one next to ${p.dbPath} is.`,
      'Move it out of the code folder once you are sure the moved database is complete.',
    ]);
  }

  if (legacyDb) {
    const lines = [
      `An old database is still at ${p.legacyDbPath}. It is NOT used while DATA_DIR is set.`,
      `In use: ${p.dbPath} (last changed ${stamp(lastChanged(p.dbPath))}), old one last changed ${stamp(lastChanged(p.legacyDbPath))}.`,
    ];
    if (lastChanged(p.legacyDbPath) > lastChanged(p.dbPath)) {
      lines.push('The old one changed MORE recently than the one in use. Check that the right file was moved before anyone signs in.');
    }
    lines.push('Once the moved database is confirmed complete, move the old files out of the code folder so they cannot be mistaken for the live one.');
    warnings.push(lines);
  }

  return { refuse: null, warnings };
}

const PATHS = resolveDataPaths();

module.exports = {
  SERVER_DIR,
  DB_FILE,
  DATA_DIR:        PATHS.dataDir,
  DB_PATH:         PATHS.dbPath,
  LEGACY_DATA_DIR: PATHS.legacyDir,
  DATA_DIR_SET:    PATHS.usingDataDir,
  resolveDataPaths,
  checkDataLocation,
};
