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
// as db/index.js: the entry point loads it first, by its full path. That is
// deliberate, because scripts/test-migration-prep.js points DB_PATH at a scratch
// file and must not pick up the server's DATA_DIR. server/.env is read here only
// to notice a run that did not load it (see checkDataLocation).
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
    serverDir,
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

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return -1; }
}

// A WAL database's newest changes are in its -wal file, which can be hours
// newer than the .db, so both count towards "last changed". An empty -wal does
// not: it holds no changes, and every read-only open (npm run backup, the copy
// taken before each Veeam run, a DB viewer) leaves one with a fresh time.
function lastChanged(dbFile) {
  let latest = mtimeOf(dbFile);
  if (sizeOf(`${dbFile}-wal`) > 0) latest = Math.max(latest, mtimeOf(`${dbFile}-wal`));
  return latest;
}

function stamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// What server/.env itself says DATA_DIR is, whatever this process loaded.
function envFileDataDir(serverDir) {
  let buf;
  try { buf = fs.readFileSync(path.join(serverDir, '.env')); } catch { return { value: '', utf16: false }; }
  // Notepad's "Unicode" is UTF-16, which dotenv reads as no settings at all.
  const utf16 = buf[0] === 0xFF && buf[1] === 0xFE;
  let value = '';
  try {
    value = String(require('dotenv').parse(utf16 ? buf.toString('utf16le') : buf.toString('utf8')).DATA_DIR || '').trim();
  } catch { /* unreadable: nothing to compare against */ }
  return { value, utf16 };
}

/**
 * Whether it is safe to open the database, decided BEFORE opening it, because
 * opening a missing file creates it.
 *
 * With DATA_DIR unset nothing is refused, so the server behaves exactly as it
 * did before DATA_DIR existed, unless server/.env sets DATA_DIR and this run
 * simply did not load it. With it set, the person who set it has said the data
 * has moved, so a missing database means the move has not happened (or went to
 * the wrong folder), and starting anyway would put the site on a new empty
 * database while the real one sits somewhere nobody backs up.
 *
 * Returns { refuse, warnings }: refuse is null or the lines explaining why,
 * each warning is an array of lines.
 */
function checkDataLocation(p = resolveDataPaths()) {
  const warnings = [];

  if (!p.usingDataDir) {
    // Every entry point loads server/.env by its full path. Something that does
    // not (a node -e, a new script, a .env saved in the wrong encoding) would
    // otherwise open the old database left in server/data, or create a new
    // empty one there, while the live one sits in DATA_DIR. DB_PATH names its
    // own file, as scripts/test-migration-prep.js does, so it is exempt.
    if (!p.dbPathOverride) {
      const env = envFileDataDir(p.serverDir);
      if (env.value) {
        return {
          refuse: [
            `server/.env sets DATA_DIR to ${env.value}, but this run did not load it, so it would use ${p.legacyDbPath}.`,
            'Refusing to start, so that no database is opened or created in the old folder.',
            env.utf16
              ? 'server/.env is saved as Unicode (UTF-16), which is read as no settings at all. Save it again as UTF-8.'
              : 'Load server/.env by its full path before requiring db/index.js, as server/index.js and the scripts in server/scripts do.',
          ],
          warnings,
        };
      }
    }
    return { refuse: null, warnings };
  }

  if (p.dbPathOverride && !isInside(p.dataDir, p.dbPath)) {
    warnings.push([
      `DB_PATH overrides DATA_DIR: the database in use is ${p.dbPath}, which is outside ${p.dataDir}.`,
      'A backup of DATA_DIR does not include it. Remove DB_PATH from server/.env unless that is intended.',
    ]);
  }

  const liveDir      = path.dirname(p.dbPath);
  const liveName     = path.basename(p.dbPath);
  const legacyIsLive = samePath(p.dbPath, p.legacyDbPath);
  const legacyDb     = !legacyIsLive && fs.existsSync(p.legacyDbPath);
  const oldSet       = `${DB_FILE}, ${DB_FILE}-wal and ${DB_FILE}-shm`;

  // 0 bytes is what a failed copy, or a tool that opened a missing file, leaves.
  // SQLite takes it for an empty database and would build a new schema in it,
  // so it counts as missing.
  const liveSize = sizeOf(p.dbPath);
  if (liveSize <= 0) {
    const named = p.dbPathOverride ? ' (the file DB_PATH names)' : '';
    const lines = liveSize === 0
      ? [
        `DATA_DIR is set, but the database at ${p.dbPath}${named} is empty (0 bytes).`,
        'Refusing to start, so that the site does not run on it as a new empty database.',
      ]
      : [
        `DATA_DIR is set, but there is no database at ${p.dbPath}${named}.`,
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

  // The old .db is gone from server/data but a -wal is still there. What sits
  // beside the database in use says nothing about it: any read-only open leaves
  // an empty -wal there, and a clean close deletes a full one. When the -wal
  // was written does. A moved .db keeps its modified time, and only a
  // checkpoint changes it, so a -wal written at or after that time holds
  // changes the .db does not have, and SQLite applies them only when the -wal
  // sits next to its own .db. A -wal older than the .db's last write is left
  // over from before: its changes are in the .db already or were overwritten
  // since, and putting it next to the .db would replay old pages over newer
  // ones.
  const legacyWal = `${p.legacyDbPath}-wal`;
  if (!legacyIsLive && !legacyDb && sizeOf(legacyWal) > 0) {
    const pending = mtimeOf(legacyWal) >= mtimeOf(p.dbPath);
    if (pending && sizeOf(`${p.dbPath}-wal`) <= 0) {
      return {
        refuse: [
          `${DB_FILE}-wal was left behind in ${p.legacyDir}, and it was written after ${p.dbPath} last changed.`,
          'It holds the newest changes to the database and only counts next to its own .db file.',
          `Stop the server, move ${legacyWal} to ${p.dbPath}-wal and ${p.legacyDbPath}-shm to ${p.dbPath}-shm, replacing any already there (they hold no changes), then start again.`,
        ],
        warnings,
      };
    }
    warnings.push(pending
      ? [
        `A leftover ${DB_FILE}-wal is in ${p.legacyDir}. It is not used: the one next to ${p.dbPath} is.`,
        'Do NOT move it next to the database in use, which would replace that one.',
        'Keep it, out of the code folder, until you are sure the database in use is complete.',
      ]
      : [
        `An old ${DB_FILE}-wal is still in ${p.legacyDir}. It is older than the last change to ${p.dbPath}, so it is left over from before the move and is not used.`,
        'Do NOT move it next to the database in use: SQLite would apply its old contents over newer changes.',
        `Move it, with the ${DB_FILE}-shm beside it, out of the code folder.`,
      ]);
  }

  // A whole old database is still in server/data. Newer than the one in use
  // means the one in use is a copy taken before the last changes (the .db
  // copied without its -wal, say), and running on it would lose them for good
  // once it is written to.
  if (legacyDb) {
    const inUse = lastChanged(p.dbPath);
    const old   = lastChanged(p.legacyDbPath);
    if (old > inUse) {
      const renamed = liveName === DB_FILE ? '' : ` (renamed ${liveName}, ${liveName}-wal and ${liveName}-shm)`;
      return {
        refuse: [
          `The database in use, ${p.dbPath}, is older than the one still in ${p.legacyDir}: last changed ${stamp(inUse)}, against ${stamp(old)} there.`,
          'Refusing to start, so that the site does not run on a copy that is missing the newest changes.',
          `Stop the server. Move ${liveName}, ${liveName}-wal and ${liveName}-shm out of ${liveDir}, then move ${oldSet} from ${p.legacyDir} into ${liveDir} together${renamed}.`,
          'The three belong together: the -wal holds the newest changes and only counts next to its own .db file.',
        ],
        warnings,
      };
    }
    warnings.push([
      `An old database is still in ${p.legacyDir} (${oldSet}). It is NOT used while DATA_DIR is set.`,
      `In use: ${p.dbPath}, last changed ${stamp(inUse)}. The old one last changed ${stamp(old)}.`,
      `Once the database in use is confirmed complete, move ${oldSet} out of the code folder together, so they cannot be mistaken for the live one.`,
    ]);
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
