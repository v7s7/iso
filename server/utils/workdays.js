// server/utils/workdays.js
//
// The deadline engine. Every number the ISO system is actually measured on —
// the الموعد النهائي, أيام التأخير, الإنجاز في الوقت — comes out of this file.
//
// It lived in the browser, which meant the deadline was whatever the user's
// machine computed: a wrong clock, a stale tab, or the console produced a
// different answer, and nothing on the server could tell. Here there is one
// answer, and the API is the only thing that writes it.
//
// Two kinds of day arithmetic, and mixing them up is the classic bug in this
// domain:
//
//   working days  — skip Friday, Saturday and every public holiday.
//                   Service turnaround (مدة الخدمة) and أيام التأخير.
//   calendar days — count every day.
//                   A holiday's own length: عيد الفطر is four days whether or
//                   not a weekend falls inside it.
const { db } = require('../db');

// 0=Sunday … 6=Saturday. Bahrain's weekend is Friday + Saturday.
function weekendDays() {
  const raw = process.env.WEEKEND_DAYS;
  if (!raw) return [5, 6];
  const parsed = raw.split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return parsed.length ? parsed : [5, 6];
}

/** Today, as the 'YYYY-MM-DD' string everything else in the system compares against. */
function today() {
  const d = new Date();
  return fmt(d);
}

/** A Date for a 'YYYY-MM-DD' string, pinned to midday.
 *
 *  Midday, not midnight, on purpose: `new Date('2026-09-13')` is parsed as UTC,
 *  so anywhere east of Greenwich it lands on the previous evening and every
 *  date shifts by one. Midday local is far enough from both boundaries that no
 *  timezone or DST change can move the calendar day. */
function toDate(s) {
  return new Date(String(s) + 'T12:00:00');
}

/** A Date back to 'YYYY-MM-DD'. */
function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Reads the holiday ranges once, for a caller that is about to do a lot of
 *  date arithmetic. Pass the result into the functions below so a loop over 500
 *  requests does not run 500 queries. */
function loadHolidays() {
  return db.prepare('SELECT start_date, end_date FROM holidays').all();
}

function isHoliday(dateStr, holidays) {
  return holidays.some(h => dateStr >= h.start_date && dateStr <= h.end_date);
}

/** Is this a working day? Not a weekend, not inside a public holiday. */
function isWorkingDay(date, holidays) {
  const weekend = weekendDays();
  if (weekend.includes(date.getDay())) return false;
  return !isHoliday(fmt(date), holidays);
}

/**
 * The الموعد النهائي: `n` working days after `startDate`.
 *
 * Counts FORWARD from the day after the request — the request date itself is
 * day zero, not day one — and lands on the nth working day. A 3-day service
 * filed on a Wednesday is due the following Tuesday, because Friday and
 * Saturday do not count.
 */
function addWorkingDays(startDate, n, holidays = loadHolidays()) {
  const d = toDate(startDate);
  let counted = 0;
  while (counted < n) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d, holidays)) counted++;
  }
  return fmt(d);
}

/**
 * Working days strictly between two dates — used for أيام التأخير, where the
 * deadline day itself is not late and the closing day is.
 */
function workingDaysBetween(startDate, endDate, holidays = loadHolidays()) {
  const d = toDate(startDate);
  const end = toDate(endDate);
  let counted = 0;
  while (d < end) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d, holidays)) counted++;
  }
  return counted;
}

/**
 * Calendar days, for a holiday's own span. A 1-day holiday starts and ends on
 * the same date, so the offset is duration-1.
 */
function addCalendarDays(startDate, n) {
  const d = toDate(startDate);
  d.setDate(d.getDate() + Math.max(0, n - 1));
  return fmt(d);
}

/**
 * Is this request late, on the calendar?
 *
 * Closed  → it was closed after its deadline.
 * Open    → its deadline has already passed.
 *
 * Calendar, not working days, deliberately: a request whose deadline passed
 * yesterday IS late today, even when zero working days have elapsed because the
 * weekend is in between. That case shows "0" in the أيام التأخير column — late,
 * but not yet costing working time — and the prototype's own build notes call
 * that out as intended behaviour.
 */
function isLate(request) {
  if (request.status === 'Closed') {
    return Boolean(request.close_date && request.close_date > request.due_date);
  }
  return request.status === 'Open' && request.due_date < today();
}

/**
 * أيام التأخير as of right now. A closed request's delay is frozen at the value
 * stored when it was closed; an open one's keeps growing.
 */
function currentDelayDays(request, holidays = loadHolidays()) {
  if (request.status === 'Closed') return Number(request.delay_days || 0);
  const t = today();
  if (request.status === 'Open' && request.due_date < t) {
    return workingDaysBetween(request.due_date, t, holidays);
  }
  return 0;
}

/**
 * تستحق قريباً: open, not yet overdue, and due within the next two working
 * days. The window is measured in working days so a Thursday afternoon does not
 * light up every request due the following Tuesday.
 */
function isDueSoon(request, holidays = loadHolidays()) {
  if (request.status !== 'Open') return false;
  const t = today();
  const cutoff = addWorkingDays(t, 2, holidays);
  return request.due_date >= t && request.due_date <= cutoff;
}

/**
 * Recomputes الموعد النهائي for every OPEN request.
 *
 * Called after any change to the holiday calendar. Declaring a new public
 * holiday moves the deadline of everything still open — that is the whole point
 * of measuring in working days — while closed requests keep the deadline they
 * were actually judged against. Rewriting history there would change past
 * ISO results, so it does not happen.
 *
 * @returns {number} how many open requests had their deadline moved.
 */
function recalcOpenDueDates() {
  const holidays = loadHolidays();
  const open = db.prepare("SELECT id, request_date, duration, due_date FROM requests WHERE status = 'Open'").all();
  const update = db.prepare("UPDATE requests SET due_date = ?, updated_at = datetime('now','localtime') WHERE id = ?");

  let moved = 0;
  const run = db.transaction(() => {
    for (const r of open) {
      const due = addWorkingDays(r.request_date, r.duration, holidays);
      if (due !== r.due_date) {
        update.run(due, r.id);
        moved++;
      }
    }
  });
  run();

  if (moved) console.log(`[Workdays] holiday change moved ${moved} open deadline(s)`);
  return moved;
}

module.exports = {
  today, toDate, fmt, weekendDays,
  loadHolidays, isHoliday, isWorkingDay,
  addWorkingDays, workingDaysBetween, addCalendarDays,
  isLate, currentDelayDays, isDueSoon,
  recalcOpenDueDates,
};
