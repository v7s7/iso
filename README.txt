نظام تسجيل الجودة — ISO Phase 1
================================

No longer a browser-only prototype. The data lives in a SQLite database on the
server, and people sign in with their Active Directory account — the same
directory, and the same integration, docTracking uses.


WHAT CHANGED
------------
Before                                  Now
--------------------------------------  --------------------------------------
localStorage, one copy per browser      one SQLite database, shared
passwords in plain text in the browser  bcrypt hashes, or Active Directory
anyone could edit the data in devtools  the server decides what is allowed
deadlines computed by the browser       computed by the server, one answer
audit log written by the browser        written server-side, inside each write
"reset demo data" button                a deliberate command on the server

The screens themselves did not change. The views, the filters, the charts and
the Excel export are the same code; only the layer underneath them is new.


RUNNING IT
----------
First time:

    cd server
    npm install
    copy .env.example .env        (then edit it — see CONFIGURATION)
    npm run seed -- --demo
    npm start

Then open  http://localhost:4100

After that, just:

    cd server
    npm start

One process serves both the site and the API, so there is one port to open and
one address to give people.


CONFIGURATION (server/.env)
---------------------------
Copy .env.example to .env and set at least these two:

  JWT_SECRET   Required — the server refuses to start without it, and refuses
               to start on the placeholder .env.example ships with.
                 npm run new-secret
               writes a fresh one into .env and prints nothing secret. Run it
               again any time the secret may have been seen; everyone signed in
               is signed out, which is the point.

  LDAP_URL     The domain controller. Leave it blank to run on local accounts
               only (useful on a laptop); sign-in then uses the seeded test
               users and nothing else.

  npm run check-env    checks the whole file and says what is wrong and how to
                       fix it. Run it before asking why nobody can sign in.


ACTIVE DIRECTORY
----------------
Signing in:
  A local account (password stored here) is tried first, then the directory.
  People type either their username (a.alkubaesy) or their email; the server
  tries the three spellings AD accepts — user@swd.bh, user@swd.local and
  SWD\user — so nobody has to know which one their forest wants.

  Somebody signing in for the first time gets an account created automatically
  from their AD group memberships. With no matching group they land on مستخدم
  with no department, which sees only their own requests — the right floor.

Role mapping — server/config/directory-map.json:
  roleGroupMap   AD group → مستخدم / مشرف قسم / Power User
  adminGroups    AD groups that grant مدير النظام
  deptGroupMap   AD group → department, used only on a first sign-in

  Keys are the group's CN in lowercase: a group
  "CN=ISO_Supervisors,OU=Groups,DC=swd,DC=local" is written "iso_supervisors".
  The file is read on every sign-in, so an edit applies to the next login
  without restarting anything.

  npm run ad-probe                 shows what AD actually returns, plus the
                                   most common groups, ready to paste into the
                                   file above
  npm run ad-probe -- a.alkubaesy  one specific account, every attribute

Browsing the directory (the import screen) additionally needs a read-only
service account in LDAP_BIND_DN / LDAP_BIND_PASSWORD. Sign-in works without it.

WHERE DEPARTMENTS COME FROM — and why not from AD
  They cannot come from Active Directory. `npm run ad-probe` against SWD's
  directory reports the `department` attribute populated on 0 of 300 accounts,
  and the groups that do exist (all staff, swd staff, ma&r, rental, orbit-users)
  are functional groups, not the قسم structure this system measures.

  So the departments come from docTracking, which already holds them for 119
  people, linked to AD accounts and confirmed by hand:

    npm run export-link -- --from "<path>\docTracking\server\data\doctracking.db"
        Reads docTracking READ-ONLY and writes server/data/directory-link.csv.
        Writes nothing else. Open the CSV, check it, correct it.
        Blank someone's iso_dept_prefix cell to leave them out.

    npm run import-link                                  dry run
    npm run import-link -- --apply --uncertain=exclude   write it

  The accounts it creates have NO password — password_hash stays NULL, which is
  what sends their sign-in to Active Directory. It is an upsert keyed on the
  username, so re-running only applies what the CSV has changed.

  Anyone not imported can still sign in; they simply arrive with no department
  and cannot file a request until someone gives them one in إدارة النظام.

What AD owns and what this system owns:
  AD owns who someone is — their name, their email, their password.
  This system owns what they may do — role, department, active or not.
  A sign-in refreshes the first set and never touches the second, so an
  administrator's decision is not overwritten by the directory every morning.


مدير النظام, AND NOT BEING LOCKED OUT
-------------------------------------
Three ways to hold it:
  1. the flag on the account, set in إدارة النظام
  2. SUPER_ADMIN_USERS in .env — always admin, whatever the database says.
     This is the failsafe, and no screen in the app can remove it.
  3. ADMIN_DEPT_PREFIX — everyone in that department. OFF by default; see the
     warning in .env.example before switching it on.


THE DATABASE
------------
  server/data/iso-quality.db

Created and migrated automatically on first start. To back it up while people
are using the system, do NOT copy the file — recent writes live in the -wal
file beside it and a plain copy will miss them. Use:

    sqlite3 data/iso-quality.db ".backup data/backup.db"

Tables: departments, services, users, holidays, requests, request_events,
sessions, audit_log, app_settings.


CHECK SCRIPTS
-------------
  npm run new-secret      generate a fresh JWT_SECRET into .env (signs everyone
                          out — the old tokens were signed with the old key)
  npm run check-env       is this machine configured correctly?
  npm run data-check      does the data contradict any rule it should obey?
                          (deadlines, delay arithmetic, on-time flags, orphans,
                          whether anyone can still reach إدارة النظام)
  npm run ad-probe        what does Active Directory actually return?
  npm run test-security   forges tokens against the running server and checks
                          they are refused. Server must be running.
  npm run test-flow       walks the paths a person actually takes — a new
                          account through its forced password change, an admin
                          edit landing mid-session, filing and closing a
                          request, and whether AD answers. Server must be
                          running.

check-env, data-check and ad-probe only read; they are safe against live data
at any time.

test-security and test-flow need the server running and are for a test or
staging database. test-security only signs in and is harmless. test-flow
WRITES: it keeps one account (flow.check@test.local, left deactivated) and
files one request each run. Do not point it at live records.


TEST ACCOUNTS
-------------
Password for all of them: Test123

  hisham@test.local      مستخدم       — own requests only
  supervisor@test.local  مشرف قسم     — his department
  power@test.local       Power User   — the whole organisation
  admin@test.local       مدير النظام  — plus إدارة النظام

These are local accounts and exist alongside AD sign-in. Delete them before
this goes anywhere real:

    npm run seed -- --reset          (reference data only, no test accounts —
                                      edit USERS in scripts/seed.js first)


RESETTING THE DEMO DATA
-----------------------
    npm run seed -- --reset --demo

Wipes every table and reseeds. The button that used to do this in the UI is
gone: it cleared one browser's storage, and the data is now shared.


PHASE 1 RULES STILL IN FORCE
----------------------------
  · Only the person who filed a request may close it.
  · A closing date after the deadline requires a reason from the fixed list;
    "أسباب أخرى" requires the reason to be written out.
  · The working week skips Friday, Saturday and every public holiday.
  · Declaring a holiday moves the deadline of everything still OPEN. Closed
    requests keep the deadline they were actually judged against.
  · Service codes and request numbers are generated, never typed.

Every one of these is enforced by the server, not just by the screen.
