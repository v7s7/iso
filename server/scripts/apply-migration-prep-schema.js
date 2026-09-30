// Applies additive migration-preparation tables and columns. No historical
// records are staged or imported by this command.
// server/.env by its full path, so a run from another folder still finds DATA_DIR.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, DB_PATH } = require('../db');

const tables = db.prepare(`
  SELECT name FROM sqlite_master
   WHERE type='table' AND name LIKE 'migration_%'
   ORDER BY name
`).all().map(row => row.name);

console.log(`Migration preparation schema ready: ${DB_PATH}`);
console.log(`Migration tables: ${tables.join(', ')}`);
db.close();
