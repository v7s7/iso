// server/scripts/test-data-dir.js
//
//   npm run test-data-dir
//
// Checks DATA_DIR: the default paths, the paths DATA_DIR and DB_PATH give, the
// refusal to start on a missing database, the warnings about data left in the
// old folder, backups following the data, and config/directory-map.json staying
// where it is.
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
for (const rel of ['db/index.js', 'config/dataDir.js', 'scripts/backup-db.js']) {
  fs.mkdirSync(path.dirname(path.join(fake, rel)), { recursive: true });
  fs.copyFileSync(path.join(SERVER, rel), path.join(fake, rel));
}

const cleanEnv = { ...process.env };
delete cleanEnv.DATA_DIR;
delete cleanEnv.DB_PATH;

/** Runs a node program the way a server start would, and returns its result. */
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

// process.exit leaves the -wal file in place with its changes not yet copied
// into the .db, which is what closing the server's window does too.
const writeAndDrop = `
  const d = db.prepare("INSERT INTO departments (name, prefix) VALUES ('Test', 'TST')").run().lastInsertRowid;
  db.prepare("INSERT INTO users (username, email, full_name, department_id) VALUES ('t1', 't1@example.invalid', 'Test', ?)").run(d);
  process.exit(0);`;
const countDepts = `console.log('departments=' + db.prepare('SELECT COUNT(*) n FROM departments').get().n); db.close();`;

const exists = f => fs.existsSync(f);
const moveFile = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); };
const setFiles = base => ['', '-wal', '-shm'].map(s => `${base}${s}`);

try {
  // ── Paths ──
  console.log('\npaths');
  {
    const p = resolveDataPaths({}, fake);
    check('unset: data folder is server/data', p.dataDir === fakeLegacy && !p.usingDataDir);
    check('unset: database is server/data/iso-quality.db', p.dbPath === path.join(fakeLegacy, DB_FILE));

    const target = path.join(tmp, 'data', 'iso');
    const q = resolveDataPaths({ DATA_DIR: target }, fake);
    check('DATA_DIR: data folder and database follow it',
      q.usingDataDir && q.dataDir === target && q.dbPath === path.join(target, DB_FILE));

    const r = resolveDataPaths({ DATA_DIR: '../../data/iso' }, fake);
    check('a relative DATA_DIR is taken from the server folder', r.dataDir === path.join(tmp, 'data', 'iso'));

    const s = resolveDataPaths({ DATA_DIR: '   ' }, fake);
    check('a blank DATA_DIR counts as unset', !s.usingDataDir && s.dataDir === fakeLegacy);

    const other = path.join(tmp, 'elsewhere', 'x.db');
    const t = resolveDataPaths({ DATA_DIR: target, DB_PATH: other }, fake);
    check('DB_PATH overrides the database file, not the data folder',
      t.dbPath === other && t.dataDir === target && t.dbPathOverride);

    const u = resolveDataPaths({ DB_PATH: './data/x.db' }, fake);
    check('a relative DB_PATH is taken from the server folder', u.dbPath === path.join(fakeLegacy, 'x.db'));
  }

  // ── Without DATA_DIR: as before ──
  console.log('\nwithout DATA_DIR');
  {
    const r = startDb({}, writeAndDrop);
    check('a first start creates server/data and a new database there',
      r.code === 0 && exists(path.join(fakeLegacy, DB_FILE)), r.out);
    check('and says so', /Creating a new empty one/.test(r.out), r.out);
    const wal = path.join(fakeLegacy, `${DB_FILE}-wal`);
    check('the newest changes are still in the -wal file', exists(wal) && fs.statSync(wal).size > 0);
  }
  const legacyDb = path.join(fakeLegacy, DB_FILE);

  // ── DATA_DIR set, database not moved yet ──
  console.log('\nDATA_DIR set, database not moved');
  const dataDir = path.join(tmp, 'data', 'iso');
  const newDb   = path.join(dataDir, DB_FILE);
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
    const alone = new Database(aloneFile, { fileMustExist: true });
    const hasTable = !!alone.prepare("SELECT 1 FROM sqlite_master WHERE name='departments'").get();
    const n = hasTable ? alone.prepare('SELECT COUNT(*) n FROM departments').get().n : 0;
    alone.close();
    check('(the .db on its own is missing the newest change)', n === 0);
  }

  // ── Moved properly ──
  console.log('\nmoved with its -wal and -shm');
  {
    moveFile(`${legacyDb}-wal`, `${newDb}-wal`);
    if (exists(`${legacyDb}-shm`)) moveFile(`${legacyDb}-shm`, `${newDb}-shm`);
    const r = startDb({ DATA_DIR: dataDir }, countDepts);
    check('starts on the database in DATA_DIR', r.code === 0 && r.out.includes(`SQLite ready: ${newDb}`), r.out);
    check('with every change, including the ones that were in the -wal', /departments=1\b/.test(r.out), r.out);
    check('with no warning, as nothing was left behind', !/WARNING/.test(r.out), r.out);
    check('and nothing new in the old folder', fs.readdirSync(fakeLegacy).length === 0);
  }

  // ── An old copy left in the code folder ──
  console.log('\nold database left in the code folder');
  {
    fs.copyFileSync(newDb, legacyDb);
    const old = new Date(Date.now() - 86400000);
    fs.utimesSync(legacyDb, old, old);
    const r = startDb({ DATA_DIR: dataDir }, countDepts);
    check('starts, on the database in DATA_DIR', r.code === 0 && /departments=1\b/.test(r.out), r.out);
    check('warns that the old one is not used', /WARNING: An old database is still at/.test(r.out) && r.out.includes(legacyDb), r.out);
    check('without claiming the old one is newer', !/MORE recently/.test(r.out), r.out);

    const later = new Date(Date.now() + 86400000);
    fs.utimesSync(legacyDb, later, later);
    const r2 = startDb({ DATA_DIR: dataDir });
    check('says so when the old one changed more recently', r2.code === 0 && /MORE recently/.test(r2.out), r2.out);
    fs.rmSync(legacyDb);
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

  // ── The same folder named another way ──
  if (process.platform === 'win32') {
    console.log('\nletter case');
    const probe = path.join(tmp, 'case', 'server');
    fs.mkdirSync(path.join(probe, 'data'), { recursive: true });
    fs.writeFileSync(path.join(probe, 'data', DB_FILE), '');
    const c = checkDataLocation(resolveDataPaths({ DATA_DIR: path.join(probe, 'DATA') }, probe));
    check('DATA_DIR naming server/data in other letter case is not an "old database"',
      !c.refuse && c.warnings.length === 0, JSON.stringify(c));
  }

  // ── Backups follow the data ──
  console.log('\nnpm run backup');
  {
    const r = run([path.join(fake, 'scripts', 'backup-db.js')], { DATA_DIR: dataDir });
    const backups = path.join(dataDir, 'backups');
    // Only the .db counts: the read-only integrity check leaves an empty -wal
    // and -shm beside the copy, as it always has.
    const made = exists(backups) ? fs.readdirSync(backups).filter(f => f.endsWith('.db')) : [];
    check('writes its verified copy under DATA_DIR/backups',
      r.code === 0 && /integrity ok/.test(r.out) && made.length === 1 && made[0].startsWith('iso-quality-'),
      `${r.out}\nfiles: ${made.join(', ')}`);
    check('and nothing into the old folder', !exists(path.join(fakeLegacy, 'backups')));

    const r2 = run([path.join(fake, 'scripts', 'backup-db.js')], { DATA_DIR: path.join(tmp, 'nowhere') });
    check('refuses when DATA_DIR has no database, and creates nothing',
      r2.code === 1 && /Database not found/.test(r2.out) && !exists(path.join(tmp, 'nowhere')), r2.out);
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
    const writers = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name.endsWith('.js') && f !== svc && f !== __filename
          && /\bwriteConfig\s*\(/.test(fs.readFileSync(f, 'utf8'))) writers.push(path.relative(SERVER, f));
      }
    })(SERVER);
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
