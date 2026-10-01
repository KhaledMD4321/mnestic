"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../extension/lib/tracker.js");
const D = require("../../extension/lib/dates.js");

const at = (y, m, d, h) => new Date(y, m - 1, d, h == null ? 12 : h).getTime();

test("a v2 log migrates its day keys and keeps everything else", () => {
  const sep29 = new Date(2026, 8, 29).getTime();
  const v2 = {
    answered: { "usmle1 2128": { ts: at(2026, 9, 29), slug: "usmle1", qid: "2128", correct: false } },
    totals: { usmle1: { total: 3654, used: 1512, unused: 2142, ts: at(2026, 9, 30) } },
    daily: { usmle1: { [String(sep29)]: 15 } },
    targets: { weekly: 200, daily: 40 }
  };
  const v3 = T.normalizeLog(v2);
  assert.equal(v3.v, 3);
  assert.deepEqual(v3.daily, { usmle1: { "2026-09-29": 15 } });
  assert.equal(v3.answered["usmle1 2128"].qid, "2128");
  assert.deepEqual(v3.targets, { weekly: 200, daily: 40 });
  assert.deepEqual(T.normalizeLog(v3), v3, "normalizing twice changes nothing");
});

test("garbage in storage comes back as an empty log, not a crash", () => {
  for (const junk of [null, 7, "x", [], { answered: 5, daily: { a: "b" }, snaps: { b: [1] } }]) {
    const t = T.normalizeLog(junk);
    assert.deepEqual(Object.keys(t.answered), []);
    assert.equal(t.v, 3);
  }
});

// The live case from the audit: tests 36-40 were done 23-29 Sep and the
// dashboard was next opened on 30 Sep. 1.3 put all 122 on 30 Sep.
test("a week of blocks read off the dashboard later is NOT booked to today", () => {
  const log = T.normalizeLog({});
  const prev = { used: 1390, ts: at(2026, 9, 23, 9) };
  const r = T.creditCounter(log, "usmle1", prev, 1512, at(2026, 9, 30, 20));
  assert.equal(r.kind, "undated");
  assert.deepEqual(log.undated.usmle1, [{ from: "2026-09-23", to: "2026-09-30", n: 122 }]);
  assert.equal(T.dayCounts(log)["2026-09-30"], undefined, "today gets none of it");
  assert.equal(T.undatedTotal(log), 122);
});

test("a jump within the same day IS today's", () => {
  const log = T.normalizeLog({});
  const r = T.creditCounter(log, "usmle1", { used: 100, ts: at(2026, 9, 30, 8) }, 140, at(2026, 9, 30, 21));
  assert.deepEqual(r, { kind: "dated", day: "2026-09-30", n: 40 });
  assert.equal(T.dayCounts(log)["2026-09-30"], 40);
});

test("questions the panel already logged are not counted twice", () => {
  const log = T.normalizeLog({ answered: {
    "usmle1 1": { ts: at(2026, 9, 30, 10), slug: "usmle1", qid: "1" },
    "usmle1 2": { ts: at(2026, 9, 30, 11), slug: "usmle1", qid: "2" },
    "other 3": { ts: at(2026, 9, 30, 11), slug: "other", qid: "3" }
  } });
  const r = T.creditCounter(log, "usmle1", { used: 100, ts: at(2026, 9, 30, 8) }, 110, at(2026, 9, 30, 21));
  assert.equal(r.n, 8, "10 counted by the bank, 2 already logged here, the other bank's ignored");
});

test("a bank reset re-baselines instead of going negative", () => {
  const log = T.normalizeLog({});
  assert.equal(T.creditCounter(log, "usmle1", { used: 900, ts: at(2026, 9, 1) }, 0, at(2026, 9, 2)).kind, "reset");
  assert.deepEqual(log.daily, {});
  T.recordSnapshot(log, "usmle1", "2026-09-01", 900);
  T.recordSnapshot(log, "usmle1", "2026-09-02", 0);
  assert.deepEqual(log.snaps.usmle1, { "2026-09-02": 0 }, "the series restarts");
});

test("pace comes from the bank's own counter, over the last 14 days of it", () => {
  const log = T.normalizeLog({});
  // 20 a day for 30 days, then 40 a day for the last 14
  let used = 0;
  for (let i = 0; i <= 44; i++) {
    const day = D.addDays("2026-08-17", i);
    used += i <= 30 ? 20 : 40;
    T.recordSnapshot(log, "usmle1", day, used);
  }
  const p = T.pace(log, "usmle1", "2026-09-30");
  assert.equal(p.source, "counter");
  assert.equal(p.span, 14);
  assert.equal(Math.round(p.perDay), 40, "recent pace, not the all-time average");
});

test("a new user's first days don't get divided by fourteen", () => {
  const log = T.normalizeLog({ answered: {} });
  for (let d = 0; d < 3; d++) {
    for (let q = 0; q < 30; q++) {
      log.answered["usmle1 " + d + "-" + q] = { ts: at(2026, 9, 28 + d), slug: "usmle1", qid: String(q) };
    }
  }
  const p = T.pace(log, "usmle1", "2026-09-30");
  assert.equal(p.source, "log");
  assert.equal(p.span, 3);
  assert.equal(p.perDay, 30, "1.3 said 90/14 = 6.4 a day, 4.7x too slow");
});

test("too little history says so instead of guessing", () => {
  const log = T.normalizeLog({ answered: { "usmle1 1": { ts: at(2026, 9, 30), slug: "usmle1", qid: "1" } } });
  assert.deepEqual(T.pace(log, "usmle1", "2026-09-30"), { insufficient: true, span: 1 });
  assert.equal(T.pace(T.normalizeLog({}), "usmle1", "2026-09-30"), null);
});

test("days with no questions count toward the pace", () => {
  const log = T.normalizeLog({ answered: {} });
  for (let q = 0; q < 70; q++) log.answered["usmle1 a" + q] = { ts: at(2026, 9, 17), slug: "usmle1", qid: "a" + q };
  const p = T.pace(log, "usmle1", "2026-09-30");          // one busy day, then 13 empty ones
  assert.equal(p.span, 14);
  assert.equal(p.perDay, 5);
});

test("the finish date handles done, absurd and normal cases", () => {
  assert.deepEqual(T.projection(0, { perDay: 10 }, "2026-10-01"), { done: true });
  assert.equal(T.projection(100, null, "2026-10-01"), null);
  assert.equal(T.projection(null, { perDay: 10 }, "2026-10-01"), null);
  assert.equal(T.projection(3000, { perDay: 0.5 }, "2026-10-01").tooFar, true);
  assert.deepEqual(T.projection(3014, { perDay: 8.71 }, "2026-10-01"), { daysLeft: 347, finish: D.addDays("2026-10-01", 347) });
});
