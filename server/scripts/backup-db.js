// Create a consistent SQLite backup while the application may be running.
// better-sqlite3 uses SQLite's online backup API, so committed WAL data is
// included and the source database is never modified.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const serverDir = path.resolve(__dirname, '..');
const source = path.resolve(serverDir, process.env.DB_PATH || 'data/iso-quality.db');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const requested = process.argv[2];
const destination = requested
  ? path.resolve(process.cwd(), requested)
  : path.join(serverDir, 'data', 'backups', `iso-quality-${stamp}.db`);

if (!fs.existsSync(source)) {
  console.error(`Database not found: ${source}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });

(async () => {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }

  const check = new Database(destination, { readonly: true, fileMustExist: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  const counts = {
    departments: check.prepare('SELECT COUNT(*) AS n FROM departments').get().n,
    users: check.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    requests: check.prepare('SELECT COUNT(*) AS n FROM requests').get().n,
  };
  check.close();

  if (integrity !== 'ok') {
    console.error(`Backup integrity check failed: ${integrity}`);
    process.exit(1);
  }

  console.log(`Backup ready: ${destination}`);
  console.log(`${counts.departments} departments, ${counts.users} users, ${counts.requests} requests; integrity ok`);
})().catch(error => {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
});
