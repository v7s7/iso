// server/scripts/test-data-dir.js
//
//   npm run test-data-dir
//
// Checks DATA_DIR: the default paths, the paths DATA_DIR and DB_PATH give, the
// refusal to start on a missing or empty database, what happens to a -wal or a
// whole database left behind in the old folder, a run that did not load
// server/.env, backups following the data, a data folder this process may not
// read (never taken for a missing database), a database or folder it may read
// but not write (refused before "SQLite ready"), and config/directory-map.json
// staying where it is.
//
// Safe to run next to the live data. It never opens server/data or the database
// server/.env names: every server it starts is a copy of db/index.js and
// config/dataDir.js inside a temporary folder, run with DATA_DIR and DB_PATH
// cleared and from a folder with no .env, so nothing of the real configuration
// leaks in. The temporary folder is deleted at the end.
//
// On Windows some cases deny this account rights on a folder inside the
// temporary folder with icacls, as IT's permissions do on SWAPP, and take the
// denial off again straight after, before anything else runs (and once more
// before the temporary folder is deleted, whatever failed).
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { resolveDataPaths, checkDataLocation, cannotWrite, DB_FILE } = require('../config/dataDir');

const SERVER = path.join(__dirname, '..');
const tmp    = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-data-dir-'));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) {
    failures++;
    if (detail) String(detail).trim().split(/\r?\n/).forEach(l => console.log(`      ${l}`));
  }
}

// db/index.js is copied on its own below, so it must not need other files from
// this repo, or the copy would fail for a reason that has nothing to do with
// DATA_DIR.
const localRequires = fs.readFileSync(path.join(SERVER, 'db', 'index.js'), 'utf8')
  .match(/require\(\s*['"]\.{1,2}\/[^'"]+['"]\s*\)/g) || [];
if (localRequires.length !== 1 || !localRequires[0].includes('config/dataDir')) {
  console.error('\n  db/index.js now requires more than config/dataDir.js:');
  localRequires.forEach(r => console.error(`    ${r}`));
  console.error('  Copy those files into the temporary server below as well.\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// A throwaway copy of the server's data code, with its own server/data beside
// it standing in for the old in-code folder.
const fake       = path.join(tmp, 'app', 'server');
const fakeLegacy = path.join(fake, 'data');
const fakeDb     = path.join(fake, 'db', 'index.js');
const fakeEnv    = path.join(fake, '.env');
const backupJs   = path.join(fake, 'scripts', 'backup-db.js');
for (const rel of ['db/index.js', 'config/dataDir.js', 'scripts/backup-db.js']) {
  fs.mkdirSync(path.dirname(path.join(fake, rel)), { recursive: true });
  fs.copyFileSync(path.join(SERVER, rel), path.join(fake, rel));
}

const cleanEnv = { ...process.env };
delete cleanEnv.DATA_DIR;
delete cleanEnv.DB_PATH;

/** Runs a node program from a folder with no .env, and returns its result. */
function run(args, env = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: tmp,
    env: { ...cleanEnv, NODE_PATH: path.join(SERVER, 'node_modules'), ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Starts the fake server's database and runs `then` against it. */
function startDb(env, then = '') {
  return run(['-e', `const { db, DB_PATH } = require(${JSON.stringify(fakeDb)}); ${then}`], env);
}

// What `npm run backup`, the copy taken before each Veeam run or a DB viewer
// does to a database: a read-only open, which leaves an empty -wal and a -shm
// beside it. The copy itself goes to scratch.
let copies = 0;
function readOnlyOpen(env) {
  return run([backupJs, path.join(tmp, 'scratch', `copy-${++copies}.db`)], env);
}

const addDept = n => `
  const d = db.prepare("INSERT INTO departments (name, prefix) VALUES ('Test ${n}', 'T${n}')").run().lastInsertRowid;
  db.prepare("INSERT INTO users (username, email, full_name, department_id) VALUES ('t${n}', 't${n}@example.invalid', 'Test', ?)").run(d);`;
// process.exit leaves the -wal file in place with its changes not yet copied
// into the .db, which is what closing the server's window does too.
const writeAndDrop = n => `${addDept(n)} process.exit(0);`;
// db.close() is a clean close: SQLite copies the -wal into the .db and deletes
// it, as `npm run check-env` does when it ends normally.
const writeAndClose = n => `${addDept(n)} db.close();`;
const countDepts = `console.log('departments=' + db.prepare('SELECT COUNT(*) n FROM departments').get().n); db.close();`;

const exists   = f => fs.existsSync(f);
const sizeOf   = f => { try { return fs.statSync(f).size; } catch { return -1; } };
const moveFile = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); };
const setFiles = base => ['', '-wal', '-shm'].map(s => `${base}${s}`);
const moveSet  = (fromBase, toBase) => setFiles(fromBase).forEach((f, i) => { if (exists(f)) moveFile(f, setFiles(toBase)[i]); });
function countIn(file) {
  const d = new Database(file, { fileMustExist: true });
  const hasTable = !!d.prepare("SELECT 1 FROM sqlite_master WHERE name='departments'").get();
  const n = hasTable ? d.prepare('SELECT COUNT(*) n FROM departments').get().n : 0;
  d.close();
  return n;
}

/** Every .js file of the server outside node_modules, data and dot folders. */
function serverFiles(dir = SERVER, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) serverFiles(f, out);
    else if (e.name.endsWith('.js') && f !== __filename) out.push(f);
  }
  return out;
}

const legacyDb = path.join(fakeLegacy, DB_FILE);
const dataDir  = path.join(tmp, 'data', 'iso');
const newDb    = path.join(dataDir, DB_FILE);
const staleWal = path.join(tmp, 'stale', `${DB_FILE}-wal`);

// Every refusal the checks below make the server print, to prove at the end
// that none holds an em or en dash (the owner reads those as machine-written).
const printed = [];
const DASH = /[\u2013\u2014]/;

// fs.statSync answering EPERM (or another code) for the folder and everything
// in it while fn runs, as Windows answers for a folder whose permissions give
// this account nothing: E:\Apps\data gives Users and Authenticated Users no
// rights, so a window whose account has no grant of its own cannot look in it.
function denied(dir, fn, code = 'EPERM') {
  const real = fs.statSync;
  const inside = p => { const rel = path.relative(dir, path.resolve(String(p))); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  fs.statSync = function (p, ...rest) {
    if (inside(p)) { const e = new Error(`${code}: operation not permitted, stat '${p}'`); e.code = code; throw e; }
    return real.call(this, p, ...rest);
  };
  try { return fn(); } finally { fs.statSync = real; }
}
const said = c => (c.refuse ? c.refuse.join('\n') : '');

// The real thing, for a child: this account denied rights on a folder of the
// temporary folder with icacls, and the denial taken off again. Every folder
// denied is remembered, so the end can take off any denial a failure left
// behind before it deletes the temporary folder.
const ACCOUNT = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${os.userInfo().username}`;
const deniedDirs = new Set();
const icacls = (...args) => spawnSync('icacls', args, { encoding: 'utf8' });
function deny(dir, rights) {
  deniedDirs.add(dir);
  return icacls(dir, '/deny', `${ACCOUNT}:${rights}`).status === 0;
}
function undeny(dir) {
  const ok = icacls(dir, '/remove:d', ACCOUNT).status === 0;
  if (ok) deniedDirs.delete(dir);
  return ok;
}
const denyAll      = dir => deny(dir, '(OI)(CI)F');   // may not even look in it
const denyNewFiles = dir => deny(dir, '(WD,AD)');     // the folder itself takes no new file

try {
  // ── Paths ──
  console.log('\npaths');
  {
    const p = resolveDataPaths({}, fake);
    check('unset: data folder is server/data', p.dataDir === fakeLegacy && !p.usingDataDir);
    check('unset: database is server/data/iso-quality.db', p.dbPath === legacyDb);

    const q = resolveDataPaths({ DATA_DIR: dataDir }, fake);
    check('DATA_DIR: data folder and database follow it',
      q.usingDataDir && q.dataDir === dataDir && q.dbPath === newDb);

    const r = resolveDataPaths({ DATA_DIR: '../../data/iso' }, fake);
    check('a relative DATA_DIR is taken from the server folder', r.dataDir === dataDir);

    const s = resolveDataPaths({ DATA_DIR: '   ' }, fake);
    check('a blank DATA_DIR counts as unset', !s.usingDataDir && s.dataDir === fakeLegacy);

    const other = path.join(tmp, 'elsewhere', 'x.db');
    const t = resolveDataPaths({ DATA_DIR: dataDir, DB_PATH: other }, fake);
    check('DB_PATH overrides the database file, not the data folder',
      t.dbPath === other && t.dataDir === dataDir && t.dbPathOverride);

    const u = resolveDataPaths({ DB_PATH: './data/x.db' }, fake);
    check('a relative DB_PATH is taken from the server folder', u.dbPath === path.join(fakeLegacy, 'x.db'));
  }

  // ── Without DATA_DIR: as before ──
  console.log('\nwithout DATA_DIR');
  {
    const r = startDb({}, 'db.close();');
    check('a first start creates server/data and a new database there', r.code === 0 && exists(legacyDb), r.out);
    check('and says so', /Creating a new empty one/.test(r.out), r.out);

    const r2 = startDb({}, writeAndDrop(1));
    check('the next start uses it', r2.code === 0 && !/Creating/.test(r2.out), r2.out);
    check('the newest changes are still in the -wal file', sizeOf(`${legacyDb}-wal`) > 0);

    // Kept for later: this -wal as it was before the move, with its own time.
    const st = fs.statSync(`${legacyDb}-wal`);
    fs.mkdirSync(path.dirname(staleWal), { recursive: true });
    fs.copyFileSync(`${legacyDb}-wal`, staleWal);
    fs.utimesSync(staleWal, st.atime, st.mtime);
  }

  // ── DATA_DIR set, database not moved yet ──
  console.log('\nDATA_DIR set, database not moved');
  {
    const r = startDb({ DATA_DIR: dataDir });
    check('refuses to start', r.code === 1 && /FATAL/.test(r.out), r.out);
    check('names the folder it looked in and the old database', r.out.includes(newDb) && r.out.includes(legacyDb), r.out);
    check('creates neither the folder nor a database', !exists(dataDir));

    fs.mkdirSync(dataDir, { recursive: true });
    const r2 = startDb({ DATA_DIR: dataDir });
    check('refuses with an empty DATA_DIR folder too, and leaves it empty',
      r2.code === 1 && fs.readdirSync(dataDir).length === 0, r2.out);
  }

  // ── The .db moved, its -wal left behind ──
  console.log('\n.db moved without its -wal');
  {
    moveFile(legacyDb, newDb);
    const r = startDb({ DATA_DIR: dataDir }, countDepts);
    check('refuses to start', r.code === 1 && /-wal was left behind/.test(r.out), r.out);
    check('opens nothing, so the -wal can still be moved', !exists(`${newDb}-wal`));

    // What the refusal protects: the .db alone does not hold the change yet.
    // Read from a copy, so this check cannot put a -wal beside the moved file.
    const aloneFile = path.join(tmp, 'alone', DB_FILE);
    fs.mkdirSync(path.dirname(aloneFile), { recursive: true });
    fs.copyFileSync(newDb, aloneFile);
    check('(the .db on its own is missing the newest change)', countIn(aloneFile) === 0);

    readOnlyOpen({ DATA_DIR: dataDir });
    check('(a read-only open, as npm run backup makes, leaves an empty -wal beside it)', sizeOf(`${newDb}-wal`) === 0);
    const r2 = startDb({ DATA_DIR: dataDir }, countDepts);
    check('still refuses after that: an empty -wal holds no changes',
      r2.code === 1 && /-wal was left behind/.test(r2.out), r2.out);
  }

  // ── Moved properly ──
  console.log('\nmoved with its -wal and -shm');
  {
    // Over the empty ones the read-only open left, as the refusal says.
    moveFile(`${legacyDb}-wal`, `${newDb}-wal`);
    if (exists(`${legacyDb}-shm`)) moveFile(`${legacyDb}-shm`, `${newDb}-shm`);
    const r = startDb({ DATA_DIR: dataDir }, countDepts);
    check('starts on the database in DATA_DIR', r.code === 0 && r.out.includes(`SQLite ready: ${newDb}`), r.out);
    check('with every change, including the ones that were in the -wal', /departments=1\b/.test(r.out), r.out);
    check('with no warning, as nothing was left behind', !/WARNING/.test(r.out), r.out);
    check('and nothing new in the old folder', fs.readdirSync(fakeLegacy).length === 0);
  }

  // ── A stale -wal in the code folder, after a clean close ──
  console.log('\nold -wal left in the code folder, older than the database');
  {
    const r0 = startDb({ DATA_DIR: dataDir }, writeAndClose(2));
    check('(a change after the move, closed cleanly, leaves no -wal beside the database)',
      r0.code === 0 && !exists(`${newDb}-wal`), r0.out);

    // A copy of the -wal from before the move, still in the old folder.
    const st = fs.statSync(staleWal);
    fs.copyFileSync(staleWal, `${legacyDb}-wal`);
    fs.utimesSync(`${legacyDb}-wal`, st.atime, st.mtime);
    const r = startDb({ DATA_DIR: dataDir }, countDepts);
    check('starts, with every change', r.code === 0 && /departments=2\b/.test(r.out), r.out);
    check('and warns NOT to move that -wal next to the database', /Do NOT move it next to the database in use/.test(r.out), r.out);

    // What moving it would do, shown on a copy.
    const replay = path.join(tmp, 'replay', DB_FILE);
    fs.mkdirSync(path.dirname(replay), { recursive: true });
    fs.copyFileSync(newDb, replay);
    fs.copyFileSync(staleWal, `${replay}-wal`);
    check('(moving it there would undo the change made after the move)', countIn(replay) === 1);
    fs.rmSync(`${legacyDb}-wal`);
  }

  // ── An old copy left in the code folder ──
  console.log('\nold database left in the code folder');
  {
    fs.copyFileSync(newDb, legacyDb);
    const old = new Date(Date.now() - 86400000);
    fs.utimesSync(legacyDb, old, old);
    const r = startDb({ DATA_DIR: dataDir }, countDepts);
    check('starts, on the database in DATA_DIR', r.code === 0 && /departments=2\b/.test(r.out), r.out);
    check('warns that the old one is not used', /WARNING: An old database is still in/.test(r.out) && r.out.includes(fakeLegacy), r.out);
    check('naming its -wal and -shm, so they go with it', r.out.includes(`${DB_FILE}-wal and ${DB_FILE}-shm`), r.out);

    const later = new Date(Date.now() + 86400000);
    fs.utimesSync(legacyDb, later, later);
    const r2 = startDb({ DATA_DIR: dataDir });
    check('refuses when the old one changed more recently', r2.code === 1 && /is older than the one still in/.test(r2.out), r2.out);
    fs.rmSync(legacyDb);
  }

  // ── Only the .db copied, the originals kept ──
  console.log('\n.db copied without its -wal, the originals kept');
  {
    // Back to the old folder, with one more change there, still in its -wal.
    moveSet(newDb, legacyDb);
    const r0 = startDb({}, writeAndDrop(3));
    check('(the change is in the old folder\'s -wal)', r0.code === 0 && sizeOf(`${legacyDb}-wal`) > 0, r0.out);

    // A copy keeps the file's time on Windows; set here so any system does.
    fs.copyFileSync(legacyDb, newDb);
    const st = fs.statSync(legacyDb);
    fs.utimesSync(newDb, st.atime, st.mtime);
    // And something reads the copy, leaving a -wal there with a newer time.
    readOnlyOpen({ DATA_DIR: dataDir });

    const r = startDb({ DATA_DIR: dataDir }, countDepts);
    check('refuses: the copy is older than the old database with its -wal',
      r.code === 1 && /is older than the one still in/.test(r.out), r.out);
    check('and says to move the .db, -wal and -shm together', r.out.includes(`${DB_FILE}-wal and ${DB_FILE}-shm from`), r.out);

    // As the refusal says: the files in DATA_DIR out of the way, the three moved in.
    const aside = path.join(tmp, 'aside');
    setFiles(newDb).forEach(f => { if (exists(f)) moveFile(f, path.join(aside, path.basename(f))); });
    moveSet(legacyDb, newDb);
    const r2 = startDb({ DATA_DIR: dataDir }, countDepts);
    check('after which it starts with every change and no warning',
      r2.code === 0 && /departments=3\b/.test(r2.out) && !/WARNING/.test(r2.out), r2.out);
  }

  // ── DB_PATH beside DATA_DIR ──
  console.log('\nDB_PATH with DATA_DIR');
  {
    const outside = path.join(tmp, 'elsewhere', DB_FILE);
    const r = startDb({ DATA_DIR: dataDir, DB_PATH: outside });
    check('a DB_PATH naming a missing file is refused, not created',
      r.code === 1 && /the file DB_PATH names/.test(r.out) && !exists(outside), r.out);

    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.copyFileSync(newDb, outside);
    const r2 = startDb({ DATA_DIR: dataDir, DB_PATH: outside });
    check('a DB_PATH outside DATA_DIR is used, with a warning that the backup misses it',
      r2.code === 0 && r2.out.includes(`SQLite ready: ${outside}`) && /outside/.test(r2.out), r2.out);
  }

  // ── An empty database file ──
  console.log('\nempty database file in DATA_DIR');
  {
    const emptyDir = path.join(tmp, 'data', 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, DB_FILE), '');
    const r = startDb({ DATA_DIR: emptyDir });
    check('a 0-byte database is refused like a missing one', r.code === 1 && /is empty \(0 bytes\)/.test(r.out), r.out);
    check('and left as it was', sizeOf(path.join(emptyDir, DB_FILE)) === 0 && fs.readdirSync(emptyDir).length === 1);
  }

  // ── The same folder named another way ──
  if (process.platform === 'win32') {
    console.log('\nletter case');
    const probe = path.join(tmp, 'case', 'server');
    fs.mkdirSync(path.join(probe, 'data'), { recursive: true });
    fs.writeFileSync(path.join(probe, 'data', DB_FILE), 'not empty');
    const c = checkDataLocation(resolveDataPaths({ DATA_DIR: path.join(probe, 'DATA') }, probe));
    check('DATA_DIR naming server/data in other letter case is not an "old database"',
      !c.refuse && c.warnings.length === 0, JSON.stringify(c));
  }

  // ── server/.env not loaded ──
  console.log('\na run that did not load server/.env');
  {
    // The fake db/index.js loads no .env, like a node -e or a script that forgot.
    fs.writeFileSync(fakeEnv, `PORT=4100\r\nDATA_DIR=${dataDir}\r\n`);
    const r = startDb({});
    check('refuses rather than use server/data', r.code === 1 && /did not load it/.test(r.out), r.out);
    check('and creates no database there', !exists(legacyDb));

    const own = path.join(tmp, 'scratch', 'own.db');
    const r2 = startDb({ DB_PATH: own }, 'db.close();');
    check('a DB_PATH naming its own file still runs, as test-migration-prep needs', r2.code === 0 && exists(own), r2.out);

    fs.writeFileSync(fakeEnv, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`DATA_DIR=${dataDir}\r\n`, 'utf16le')]));
    const r3 = startDb({});
    check('a server/.env saved as UTF-16 is named as the cause', r3.code === 1 && /Save it again as UTF-8/.test(r3.out), r3.out);

    // Every entry point loads it by its full path; one that took it from the
    // current folder would miss DATA_DIR whenever it is started from elsewhere.
    const fromCwd = serverFiles()
      .filter(f => /require\(\s*['"]dotenv['"]\s*\)\s*\.config\(\s*\)/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SERVER, f));
    check('nothing loads .env from the current folder instead of server/.env', fromCwd.length === 0, fromCwd.join('\n'));
  }

  // ── Backups follow the data ──
  console.log('\nnpm run backup');
  {
    // DATA_DIR only in server/.env, and started from another folder: the
    // script has to find server/.env by its own path.
    fs.writeFileSync(fakeEnv, `DATA_DIR=${dataDir}\r\n`);
    const r = run([backupJs]);
    const backups = path.join(dataDir, 'backups');
    // Only the .db counts: the read-only integrity check leaves an empty -wal
    // and -shm beside the copy, as it always has.
    const made = exists(backups) ? fs.readdirSync(backups).filter(f => f.endsWith('.db')) : [];
    check('writes its verified copy under DATA_DIR/backups, reading DATA_DIR from server/.env',
      r.code === 0 && /integrity ok/.test(r.out) && made.length === 1 && made[0].startsWith('iso-quality-'),
      `${r.out}\nfiles: ${made.join(', ')}`);
    check('and nothing into the old folder', !exists(path.join(fakeLegacy, 'backups')));

    const r2 = run([backupJs], { DATA_DIR: path.join(tmp, 'nowhere') });
    check('refuses when DATA_DIR has no database, and creates nothing',
      r2.code === 1 && /Database not found/.test(r2.out) && !exists(path.join(tmp, 'nowhere')), r2.out);
    fs.rmSync(fakeEnv);
  }

  // ── DATA_DIR lost from server/.env after the move ──
  // The 09-30 rehearsal of the SWAPP move: with the line removed after the move,
  // the server made a new empty database in server/data and started on it, and
  // putting the line back then refused and said to swap that empty database in.
  console.log('\nDATA_DIR missing from server/.env after the move');
  {
    const planned    = path.join(tmp, 'data', 'app');   // <apps>/data/<app folder> for <apps>/app/server
    const plannedDb  = path.join(planned, DB_FILE);
    const movedAside = path.join(fake, 'data.moved-20260930');
    const copySet = (fromBase, toBase) => setFiles(fromBase).forEach((f, i) => {
      if (!exists(f)) return;
      fs.mkdirSync(path.dirname(toBase), { recursive: true });
      fs.copyFileSync(f, setFiles(toBase)[i]);
      const st = fs.statSync(f);
      fs.utimesSync(setFiles(toBase)[i], st.atime, st.mtime);
    });
    check('(the planned folder is <apps>/data/<app folder>)', resolveDataPaths({}, fake).plannedDir === planned);

    // The move as the backup tool's move-data makes it: the database in the
    // planned folder, server/data renamed to data.moved-<date>.
    fs.renameSync(fakeLegacy, movedAside);
    copySet(newDb, plannedDb);
    const r = startDb({}, countDepts);
    check('refuses rather than make a new empty database in server/data',
      r.code === 1 && /DATA_DIR is not set in server\/.env, but the database is at/.test(r.out), r.out);
    check('names the line to add', r.out.includes(`DATA_DIR=${planned}`), r.out);
    check('and creates nothing there', !exists(fakeLegacy));

    const r2 = startDb({ DATA_DIR: planned }, countDepts);
    check('with the line back it starts on the moved database, with no warning',
      r2.code === 0 && /departments=3\b/.test(r2.out) && !/WARNING/.test(r2.out), r2.out);

    // Moved somewhere other than the planned folder: only data.moved-<date> says so.
    const other = path.join(tmp, 'data', 'app-other');
    fs.renameSync(planned, other);
    const r3 = startDb({}, countDepts);
    check('refuses too when only data.moved-<date> shows the data was moved',
      r3.code === 1 && /data\.moved-20260930 is beside it/.test(r3.out), r3.out);
    check('and creates nothing there either', !exists(fakeLegacy));
    fs.renameSync(other, planned);

    // A copy put back into server/data while the moved one stays: DATA_DIR
    // unset means server/data, as before, but not without saying so.
    copySet(plannedDb, legacyDb);
    const r4 = startDb({}, countDepts);
    check('with a database in both places it starts on server/data, and warns',
      r4.code === 0 && /departments=3\b/.test(r4.out) && /there is another one at/.test(r4.out), r4.out);
    fs.rmSync(fakeLegacy, { recursive: true, force: true });

    // A new empty database in server/data, newer than the one in use, as a start
    // without the line made before this check. DB_PATH makes it here, because
    // nothing else will any more.
    const r5 = startDb({ DB_PATH: legacyDb }, 'db.close();');
    check('(a new empty database in server/data)', r5.code === 0 && exists(legacyDb), r5.out);
    const older = new Date(Date.now() - 3600000);
    setFiles(plannedDb).forEach(f => { if (exists(f)) fs.utimesSync(f, older, older); });
    const r6 = startDb({ DATA_DIR: planned }, countDepts);
    check('is not taken for newer data: it starts on the database in DATA_DIR',
      r6.code === 0 && /departments=3\b/.test(r6.out), r6.out);
    check('and warns not to move it there, rather than saying to swap it in',
      /with less in it/.test(r6.out) && /Do NOT move it into/.test(r6.out) && !/Refusing/.test(r6.out), r6.out);
    fs.rmSync(fakeLegacy, { recursive: true, force: true });
    fs.rmSync(movedAside, { recursive: true, force: true });
  }

  // ── A data folder this process may not read ──
  // The 30 Sep rehearsal: a window whose account may not open E:\Apps\data\iso,
  // right after a move that printed PASS, was told there was no database there
  // and offered to remove DATA_DIR. The data was there all along.
  console.log('\na data folder this process may not read');
  {
    const apps    = path.join(tmp, 'eperm');
    const server  = path.join(apps, 'iso', 'server');
    const home    = path.join(apps, 'data', 'iso');           // the planned folder, and DATA_DIR after the move
    const oldData = path.join(server, 'data');
    const inHome  = path.join(home, DB_FILE);
    const inOld   = path.join(oldData, DB_FILE);
    fs.mkdirSync(oldData, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(inHome, 'not empty');
    const set   = resolveDataPaths({ DATA_DIR: home }, server);
    const unset = resolveDataPaths({}, server);

    const c1 = denied(home, () => checkDataLocation(set));
    printed.push(said(c1));
    check('DATA_DIR set, the database there but the folder answers EPERM: refused as unreadable',
      c1.refuse && c1.refuse[0] === `DATA_DIR is set, but this process may not read ${home}.`, said(c1));
    check('naming the file it could not read, the error and the account',
      said(c1).includes(`Could not read ${inHome} (EPERM), running as ${ACCOUNT}.`), said(c1));
    check('saying not to remove DATA_DIR, and not that the database is missing',
      /Do NOT remove DATA_DIR/.test(said(c1)) && !/there is no database/.test(said(c1)) && !/Or remove DATA_DIR/.test(said(c1)), said(c1));
    check('and to give that account Modify on the folder, or use the right kind of window',
      said(c1).includes(`or have ${ACCOUNT} given Modify on ${home}`), said(c1));
    const c2 = denied(home, () => checkDataLocation(set), 'EACCES');
    check('EACCES the same', c2.refuse && c2.refuse[0] === c1.refuse[0] && /EACCES/.test(said(c2)), said(c2));

    fs.rmSync(inHome);
    const c3 = checkDataLocation(set);
    check('a database that really is missing is still reported as missing',
      c3.refuse && /there is no database at/.test(c3.refuse[0]), said(c3));

    fs.writeFileSync(inOld, 'not empty');
    const c4 = denied(home, () => checkDataLocation(unset));
    check('DATA_DIR unset before the move, the planned folder unreadable: a normal start, no warning',
      !c4.refuse && c4.warnings.length === 0, JSON.stringify(c4));

    const c5 = denied(oldData, () => checkDataLocation(unset));
    printed.push(said(c5));
    check('DATA_DIR unset, server/data unreadable: refused, not a new database beside the real one',
      c5.refuse && c5.refuse[0] === `This process may not read ${inOld} (EPERM).` && said(c5).includes(ACCOUNT), said(c5));

    fs.renameSync(oldData, path.join(server, 'data.moved-20260930'));
    fs.writeFileSync(inHome, 'not empty');
    const c6 = denied(home, () => checkDataLocation(unset));
    printed.push(said(c6));
    check('DATA_DIR removed after the move, the data folder unreadable: refused over data.moved-<date>',
      c6.refuse && /data\.moved-20260930 is beside it/.test(c6.refuse[0]), said(c6));
    check('and saying it could not look in the data folder',
      said(c6).includes(`This process may not read ${home} (EPERM), running as ${ACCOUNT}`), said(c6));

    fs.rmSync(path.join(server, 'data.moved-20260930'), { recursive: true, force: true });
    const c7 = denied(home, () => checkDataLocation(unset));
    printed.push(said(c7));
    check('no database and no data.moved-<date> in the code folder, the data folder unreadable: refused, not a new database',
      c7.refuse && c7.refuse[0].includes(`and this process may not read ${home}`) && said(c7).includes(`DATA_DIR=${home}`), said(c7));

    const bare = resolveDataPaths({}, path.join(tmp, 'eperm-bare', 'iso', 'server'));
    const c8 = checkDataLocation(bare);
    check('no database and no data folder at all: still a normal first start', !c8.refuse, said(c8));
  }

  // ── The same, for real: icacls ──
  if (process.platform === 'win32') {
    console.log('\na real data folder this account may not read (icacls)');
    const planned    = path.join(tmp, 'data', 'app');       // holds the moved database from above
    const plannedDb  = path.join(planned, DB_FILE);
    const movedAside = path.join(fake, 'data.moved-20260930');
    check('(the moved database is in the data folder, and server/data holds none)', sizeOf(plannedDb) > 0 && !exists(legacyDb));
    check(`premise: icacls denied ${ACCOUNT} every right on the data folder`, denyAll(planned));
    let r1, r2, r3;
    try {
      check('(this process may not even look at the database now)', sizeOf(plannedDb) === -1);
      r1 = startDb({ DATA_DIR: planned }, countDepts);
      fs.mkdirSync(movedAside, { recursive: true });
      r2 = startDb({}, countDepts);
      fs.rmSync(movedAside, { recursive: true, force: true });
      r3 = startDb({}, countDepts);
    } finally {
      check('  (and took the denial off again)', undeny(planned));
    }
    printed.push(r1.out, r2.out, r3.out);
    check('DATA_DIR set: refused, saying it may not read the folder',
      r1.code === 1 && r1.out.includes(`[DB] FATAL: DATA_DIR is set, but this process may not read ${planned}.`)
        && /EPERM/.test(r1.out) && r1.out.includes(ACCOUNT), r1.out);
    check('  not that the database is missing, and not to remove DATA_DIR',
      !/there is no database/.test(r1.out) && !/Or remove DATA_DIR/.test(r1.out) && /Do NOT remove DATA_DIR/.test(r1.out), r1.out);
    check('DATA_DIR removed anyway: refused too, over data.moved-<date>, saying it could not look in the data folder',
      r2.code === 1 && /data\.moved-20260930 is beside it/.test(r2.out) && r2.out.includes(`may not read ${planned} (EPERM)`), r2.out);
    check('DATA_DIR removed and no data.moved-<date> either: refused, not a new database',
      r3.code === 1 && /and this process may not read/.test(r3.out), r3.out);
    check('  (nothing made in server/data)', !exists(fakeLegacy));
    const r4 = startDb({ DATA_DIR: planned }, countDepts);
    check('once it may read the folder: starts on the moved database',
      r4.code === 0 && r4.out.includes(`SQLite ready: ${plannedDb}`) && /departments=3\b/.test(r4.out), r4.out);
  }

  // ── A database or folder it may read but not write ──
  // SQLite opens a database it may not write read-only without a word, so the
  // server used to print "SQLite ready", answer /api/health and fail the first
  // sign-in with SQLITE_READONLY (the 09-30 rehearsal, for وصل). Now it refuses
  // before "SQLite ready", before the schema and its migrations.
  console.log('\na database or folder it may read but not write');
  {
    const moved = path.join(tmp, 'data', 'app', DB_FILE);    // departments=3
    const home  = path.join(tmp, 'data', 'rw');
    const file  = path.join(home, DB_FILE);
    fs.mkdirSync(home, { recursive: true });
    fs.copyFileSync(moved, file);
    const noProbe = dir => fs.readdirSync(dir).every(n => !n.startsWith('.write-check-'));

    // In process: a database and folder it may write report nothing, and the
    // check itself writes nothing.
    {
      const d = new Database(file, { fileMustExist: true });
      d.pragma('wal_autocheckpoint = 0');
      d.prepare('SELECT COUNT(*) n FROM departments').get();          // opens the -wal
      const before = sizeOf(`${file}-wal`);
      const found = cannotWrite(d, resolveDataPaths({ DATA_DIR: home }, fake));
      const after = sizeOf(`${file}-wal`);
      d.close();
      check('a database and folder it may write: nothing reported', found.length === 0, JSON.stringify(found));
      check('  and nothing written: the -wal did not grow', before >= 0 && after === before, `${before} -> ${after}`);
      check('  and no check file left behind', noProbe(home));
    }

    // The read-only attribute on the file: SQLite opens it read-only.
    fs.chmodSync(file, 0o444);
    let r;
    try { r = startDb({ DATA_DIR: home }, countDepts); } finally { fs.chmodSync(file, 0o666); }
    printed.push(r.out);
    check('a database it may read but not write: refused',
      r.code === 1 && r.out.includes(`[DB] FATAL: This process cannot write where the data is kept: ${home}.`), r.out);
    check('  naming the database and SQLITE_READONLY', r.out.includes(`Could not write ${file}: SQLITE_READONLY`), r.out);
    check('  and the account', r.out.includes(`Running as ${ACCOUNT}.`), r.out);
    check('  saying not to remove DATA_DIR', /Do NOT remove DATA_DIR from server\/\.env/.test(r.out), r.out);
    check('  before "SQLite ready", so nothing ran on it', !/SQLite ready/.test(r.out) && !/departments=/.test(r.out), r.out);

    // One with a migration to apply: the refusal comes before the schema.
    const stale = path.join(tmp, 'data', 'rw-stale', DB_FILE);
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.copyFileSync(moved, stale);
    const hasIndex = f => {
      const d = new Database(f, { readonly: true, fileMustExist: true });
      try { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sessions_user_id'").get(); } finally { d.close(); }
    };
    { const d = new Database(stale); d.exec('DROP INDEX idx_sessions_user_id'); d.close(); }
    fs.chmodSync(stale, 0o444);
    let rs;
    try { rs = startDb({ DATA_DIR: path.dirname(stale) }, countDepts); } finally { fs.chmodSync(stale, 0o666); }
    printed.push(rs.out);
    check('the same with a migration to apply: the same refusal, not a raw SQLITE_READONLY',
      rs.code === 1 && /\[DB\] FATAL: This process cannot write where the data is kept/.test(rs.out) && !/SqliteError/.test(rs.out), rs.out);
    check('  and the migration was not applied', !hasIndex(stale));

    // DATA_DIR unset (DB_PATH here): the same refusal, without a word about DATA_DIR.
    fs.chmodSync(file, 0o444);
    let ru;
    try { ru = startDb({ DB_PATH: file }, countDepts); } finally { fs.chmodSync(file, 0o666); }
    printed.push(ru.out);
    check('DATA_DIR unset: refused the same way, without mentioning DATA_DIR',
      ru.code === 1 && /This process cannot write where the data is kept/.test(ru.out) && !/DATA_DIR/.test(ru.out), ru.out);

    if (process.platform === 'win32') {
      // A folder that takes no new file: SQLite could not make its -wal or
      // -shm there after the next clean close. The -wal and -shm are there now
      // (a start left them), so the database alone would pass.
      const drop = startDb({ DATA_DIR: home }, writeAndDrop(9));
      check('(a change left in the -wal, with the -shm beside it)', drop.code === 0 && sizeOf(`${file}-wal`) > 0, drop.out);
      check(`premise: icacls denied ${ACCOUNT} making files in the data folder`, denyNewFiles(home));
      let rf;
      try { rf = startDb({ DATA_DIR: home }, countDepts); } finally {
        check('  (and took the denial off again)', undeny(home));
      }
      printed.push(rf.out);
      check('a data folder that takes no new file: refused, naming the folder',
        rf.code === 1 && rf.out.includes(`Could not write ${home}: EPERM`) && !/SQLite ready/.test(rf.out), rf.out);
      check('  and no check file left behind', noProbe(home));

      // The read-only attribute on a folder, which Windows ignores for folders.
      const on = spawnSync('attrib', ['+R', home]).status === 0;
      let ra;
      try { ra = startDb({ DATA_DIR: home }, countDepts); } finally { spawnSync('attrib', ['-R', home]); }
      check('the read-only attribute on the data folder: starts as before',
        on && ra.code === 0 && ra.out.includes(`SQLite ready: ${file}`) && /departments=4\b/.test(ra.out) && !/FATAL/.test(ra.out), ra.out);
    }

    // Another connection holding the write lock, as the running server does
    // while check-env runs: that is not "cannot write". The check waits at most
    // the busy timeout (5 s), then starts.
    const holder = new Database(file, { fileMustExist: true });
    holder.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    let rb;
    try { rb = startDb({ DATA_DIR: home }, countDepts); } finally { holder.exec('ROLLBACK'); holder.close(); }
    const secs = (Date.now() - t0) / 1000;
    check('the write lock held by another connection: starts, SQLITE_BUSY is not "cannot write"',
      rb.code === 0 && rb.out.includes(`SQLite ready: ${file}`) && !/FATAL/.test(rb.out), rb.out);
    check(`  after waiting about the busy timeout, no longer (${secs.toFixed(1)} s)`, secs >= 4.5 && secs < 20);

    const rn = startDb({ DATA_DIR: home }, countDepts);
    check('and a normal start afterwards: SQLite ready, no warning, no check file left',
      rn.code === 0 && rn.out.includes(`SQLite ready: ${file}`) && !/WARNING|FATAL/.test(rn.out) && noProbe(home), rn.out);
  }

  console.log('\nwhat the refusals print');
  check('no em or en dash in any of them', printed.length > 0 && !DASH.test(printed.join('\n')),
    printed.filter(t => DASH.test(t)).join('\n'));

  // ── config/directory-map.json ──
  console.log('\nconfig/directory-map.json');
  {
    const svc = path.join(SERVER, 'services', 'configService.js');
    const r = run(['-e', `const c = require(${JSON.stringify(svc)}); console.log(JSON.stringify({ p: c.CONFIG_PATH, m: c.readConfig().roleGroupMap }));`],
      { DATA_DIR: dataDir });
    let got = {};
    try { got = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch { /* reported below */ }
    check('stays in server/config with DATA_DIR set',
      got.p === path.join(SERVER, 'config', 'directory-map.json'), r.out);
    check('and is still read from there', got.m && typeof got.m === 'object', r.out);

    // It stays because the app never writes it. If that changes, this fails and
    // the file has to move to DATA_DIR, seeded from the tracked copy.
    const writers = serverFiles()
      .filter(f => f !== svc && /\bwriteConfig\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SERVER, f));
    check('nothing in the app writes it at run time', writers.length === 0, writers.join('\n'));
  }
} finally {
  // Any denial a failure left behind comes off first, or the folder could not
  // be deleted (and the account would keep a deny entry on it).
  for (const dir of [...deniedDirs]) {
    if (!undeny(dir)) console.log(`  ! could not take the icacls denial off ${dir}: run icacls "${dir}" /remove:d ${ACCOUNT}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('DATA_DIR checks passed.\n');
