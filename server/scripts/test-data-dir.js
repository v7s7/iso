// server/scripts/test-data-dir.js
//
//   npm run test-data-dir
//
// Checks DATA_DIR: the default paths, the paths DATA_DIR and DB_PATH give, the
// refusal to start on a missing or empty database, what happens to a -wal or a
// whole database left behind in the old folder, a run that did not load
// server/.env, backups following the data, and config/directory-map.json
// staying where it is.
//
// Safe to run next to the live data. It never opens server/data or the database
// server/.env names: every server it starts is a copy of db/index.js and
// config/dataDir.js inside a temporary folder, run with DATA_DIR and DB_PATH
// cleared and from a folder with no .env, so nothing of the real configuration
// leaks in. The temporary folder is deleted at the end.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { resolveDataPaths, checkDataLocation, DB_FILE } = require('../config/dataDir');

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
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('DATA_DIR checks passed.\n');
