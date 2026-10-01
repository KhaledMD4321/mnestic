// Mnestic — calendar days.
//
// The tracker used to key each day by local-midnight milliseconds and step
// between days by adding 86,400,000. On the two days a year a clock changes
// the day is 23 or 25 hours long, so the step landed an hour off the next
// key: a 10-day streak across Egypt's 29 Oct 2026 change read as 5 days, and
// half the heatmap went blank. A day is a calendar date, so key it as one:
// "YYYY-MM-DD" in local time, and step with the calendar, not with a count of
// milliseconds.
//
// Pure functions, no browser APIs: loaded as a classic script by the content
// script and the popup (window.Mnx.dates), and by Node for the unit tests.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE.
(function (root) {
  "use strict";

  const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const pad = (n) => (n < 10 ? "0" : "") + n;

  function keyOfDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  // The local calendar day a moment falls on.
  function dayKey(ms) {
    return keyOfDate(new Date(ms == null ? Date.now() : ms));
  }
  function isDayKey(k) {
    return typeof k === "string" && KEY_RE.test(k);
  }
  // Local midnight of that day, as a Date.
  function parseDay(key) {
    const m = KEY_RE.exec(String(key));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function addDays(key, n) {
    const d = parseDay(key);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return keyOfDate(d);
  }
  // Whole days from a to b (b - a). Counted on the calendar, so a clock change
  // in between can never make it 0.96 or 1.04.
  function daysBetween(a, b) {
    const x = KEY_RE.exec(String(a)), y = KEY_RE.exec(String(b));
    if (!x || !y) return NaN;
    return Math.round((Date.UTC(+y[1], +y[2] - 1, +y[3]) - Date.UTC(+x[1], +x[2] - 1, +x[3])) / 86400000);
  }
  // The Monday of that day's week.
  function weekStart(key) {
    const d = parseDay(key);
    if (!d) return null;
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return keyOfDate(d);
  }
  // Keys written before 1.4 were local-midnight milliseconds ("1790546400000").
  // Their local date is the day they meant, so read them back through Date.
  function normalizeKey(k) {
    if (isDayKey(k)) return k;
    if (/^\d{9,}$/.test(String(k))) return dayKey(+k);
    return null;
  }

  // Consecutive days with a count > 0, ending today -- or yesterday, so a
  // streak isn't "broken" at breakfast before you've done today's questions.
  function currentStreak(counts, today) {
    let d = today, n = 0;
    if (!(counts[d] > 0)) d = addDays(d, -1);
    while (counts[d] > 0) { n++; d = addDays(d, -1); }
    return n;
  }
  function bestStreak(counts) {
    const days = Object.keys(counts).filter((k) => isDayKey(k) && counts[k] > 0).sort();
    let best = 0, run = 0, prev = null;
    for (const d of days) {
      run = prev != null && daysBetween(prev, d) === 1 ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    }
    return best;
  }

  const api = { dayKey, isDayKey, parseDay, addDays, daysBetween, weekStart, normalizeKey, currentStreak, bestStreak };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).dates = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
