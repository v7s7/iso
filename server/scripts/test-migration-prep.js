// Verifies migration schema and numbering against a disposable SQLite file.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-migration-prep-'));
const tempDb = path.join(tempDir, 'test.db');
process.env.DB_PATH = tempDb;

let db;
let nextReqCode;
try {
  ({ db, nextReqCode } = require('../db'));

  const requiredTables = [
    'migration_batches', 'migration_request_stage', 'migration_closure_stage',
    'migration_user_map', 'migration_department_map', 'migration_service_map',
    'request_sequences',
  ];
  for (const name of requiredTables) {
    const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!found) throw new Error(`missing table ${name}`);
  }

  const yy = String(new Date().getFullYear()).slice(-2);
  const deptId = db.prepare("INSERT INTO departments (name,prefix) VALUES ('Test','TST')").run().lastInsertRowid;
  const serviceId = db.prepare("INSERT INTO services (code,name,department_id,duration) VALUES ('TST-001','Test',?,1)").run(deptId).lastInsertRowid;
  const userId = db.prepare("INSERT INTO users (username,email,full_name,department_id) VALUES ('test','test@example.invalid','Test',?)").run(deptId).lastInsertRowid;

  const insertRequest = db.prepare(`
    INSERT INTO requests (
      req_code,user_id,requester_name,office_email,department_id,department_snapshot,
      service_id,service_code,service_name,duration,subject,request_date,due_date,is_migrated
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const values = code => [code,userId,'Test','test@example.invalid',deptId,'Test',serviceId,'TST-001','Test',1,'Test','2026-01-01','2026-01-04'];

  insertRequest.run(...values(`${yy}000005`), 0);
  insertRequest.run(...values(`${yy}000006`), 1);
  insertRequest.run(...values(`${yy}999773`), 1);

  const generated = db.transaction(() => nextReqCode())();
  if (generated !== `${yy}000007`) {
    throw new Error(`expected ${yy}000007, received ${generated}`);
  }
  if (generated.length !== 8) throw new Error(`generated code is not eight digits: ${generated}`);

  console.log('Migration preparation schema and request numbering passed.');
} finally {
  if (db) db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
