// server/scripts/new-secret.js
//
//   npm run new-secret
//
// Generates a fresh JWT_SECRET and writes it into server/.env in place.
//
// A script rather than a one-liner in a note, because the one-liner is how this
// goes wrong: it is long, it is easy to paste into the wrong window, and when it
// silently does nothing the server simply refuses to start with a message about
// a placeholder — which does not obviously point back at the paste.
//
// It prints nothing secret. A secret echoed to a terminal lives on in the
// scrollback and in the shell's history file, which is where the last one ended
// up.
//
// Every existing sign-in stops working, by design: the old tokens were signed
// with the old key. That is the entire point of rotating it, and everyone simply
// signs in again.
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '..', '.env');

if (!fs.existsSync(ENV_PATH)) {
  console.error('\n  server/.env does not exist.');
  console.error('  Create it first:  copy .env.example .env\n');
  process.exit(1);
}

const secret = crypto.randomBytes(64).toString('hex');   // 128 hex characters
const before = fs.readFileSync(ENV_PATH, 'utf8');

// Rewrite the line if it is there, append it if it is not. Matched per-line so
// a JWT_SECRET mentioned inside a comment is left alone.
let after;
let action;
if (/^JWT_SECRET=.*$/m.test(before)) {
  after  = before.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);
  action = 'replaced';
} else {
  after  = before.replace(/\s*$/, '\n') + `\nJWT_SECRET=${secret}\n`;
  action = 'added';
}

// Keep a copy of the previous file. Rotating a secret is not something to
// discover you did to the wrong .env with no way back.
const backup = `${ENV_PATH}.bak`;
fs.writeFileSync(backup, before, 'utf8');
fs.writeFileSync(ENV_PATH, after, 'utf8');

// Read it back through the parser that will actually load it, rather than
// trusting that the write did what it looked like it did.
const parsed = require('dotenv').parse(fs.readFileSync(ENV_PATH));
const ok = parsed.JWT_SECRET === secret;

console.log('');
if (!ok) {
  fs.writeFileSync(ENV_PATH, before, 'utf8');
  console.error(`  Wrote the secret but read back something different — .env restored from ${backup}`);
  console.error('  Set JWT_SECRET by hand.\n');
  process.exit(1);
}

console.log(`  JWT_SECRET ${action} in server/.env  (${secret.length} characters)`);
console.log(`  previous file kept at ${path.basename(backup)}`);
console.log('');
console.log('  Everyone signed in right now will be signed out — the old tokens');
console.log('  were signed with the old key. Restart the server to apply it.');
console.log('');
