// Calendar days across clock changes. Run under two time zones whose clocks
// change on different dates, because the bug this replaces only showed up on
// those days: a 10-day streak across Egypt's 29 Oct 2026 change read as 5.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../../extension/lib/dates.js");

function withTz(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}
// Noon on a local calendar date, as the panel would timestamp an answer.
const noon = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

for (const [tz, changeDay] of [["Africa/Cairo", [2026, 10, 29]], ["America/New_York", [2026, 11, 1]]]) {
  test(tz + ": ten straight days across the clock change are a 10-day streak", () => {
    withTz(tz, () => {
      const counts = {};
      const start = new Date(changeDay[0], changeDay[1] - 1, changeDay[2] - 4);
      for (let i = 0; i < 10; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        counts[D.dayKey(noon(d.getFullYear(), d.getMonth() + 1, d.getDate()))] = 20;
      }
      const days = Object.keys(counts).sort();
      assert.equal(days.length, 10, "ten distinct calendar days");
      const last = days[days.length - 1];
      assert.equal(D.currentStreak(counts, last), 10);
      assert.equal(D.bestStreak(counts), 10);
      assert.equal(D.daysBetween(days[0], last), 9);
      // every day is reachable by stepping one calendar day at a time
      let k = days[0];
      for (let i = 0; i < 10; i++) { assert.equal(counts[k], 20, "day " + k); k = D.addDays(k, 1); }
    });
  });

  test(tz + ": stepping a day lands on the next date on both sides of the change", () => {
    withTz(tz, () => {
      const key = D.dayKey(noon(...changeDay));
      const before = D.addDays(key, -1), after = D.addDays(key, 1);
      assert.equal(D.daysBetween(before, key), 1);
      assert.equal(D.daysBetween(key, after), 1);
      assert.notEqual(before, key);
      assert.notEqual(after, key);
    });
  });

  test(tz + ": a v1.3 key (local-midnight milliseconds) reads back as its own date", () => {
    withTz(tz, () => {
      const midnight = new Date(changeDay[0], changeDay[1] - 1, changeDay[2]).getTime();
      assert.equal(D.normalizeKey(String(midnight)), D.dayKey(noon(...changeDay)));
    });
  });
}

test("a streak survives a day that hasn't started yet, and breaks on a missed one", () => {
  const counts = { "2026-09-28": 5, "2026-09-29": 5, "2026-09-30": 0 };
  assert.equal(D.currentStreak(counts, "2026-09-30"), 2, "today not done yet keeps yesterday's streak");
  assert.equal(D.currentStreak(counts, "2026-10-01"), 0, "a whole missed day breaks it");
});

test("week starts on Monday", () => {
  assert.equal(D.weekStart("2026-10-01"), "2026-09-28");   // Thursday -> Monday
  assert.equal(D.weekStart("2026-09-28"), "2026-09-28");
  assert.equal(D.weekStart("2026-10-04"), "2026-09-28");   // Sunday
});

test("junk keys are refused, not misread", () => {
  assert.equal(D.normalizeKey("tomorrow"), null);
  assert.equal(D.normalizeKey(""), null);
  assert.equal(D.isDayKey("2026-9-1"), false);
  assert.ok(Number.isNaN(D.daysBetween("x", "2026-01-01")));
});
