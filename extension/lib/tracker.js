// Mnestic — study tracker math.
//
// Two signals feed the tracker. The panel logs each question it watches you
// answer, with a timestamp. The qbank's own dashboard counter ("Used
// Questions") catches the rest -- a timed block you never reviewed leaves no
// trace in the panel, but the counter can't miss it.
//
// The counter only says HOW MANY, and only when you open the dashboard. 1.3
// booked every jump to the day the dashboard was opened, so a week of blocks
// read on a Wednesday landed on that Wednesday ("Today 122" on a day with no
// tests at all), and the week before it went blank. Now a jump is credited to
// a day only when the previous reading was the same day; otherwise it is kept
// UNDATED, with the range it happened in. It still counts toward totals and
// pace -- just never toward a particular day's bar or streak.
//
// Pace for the finish date comes from daily snapshots of that counter, per
// bank, so it measures the bank you're projecting and nothing else.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE.
(function (root) {
  "use strict";
  const D = (typeof module === "object" && module.exports) ? require("./dates.js") : root.Mnx.dates;

  const VERSION = 3;
  const SNAP_KEEP_DAYS = 90;
  const UNDATED_KEEP = 60;
  const PACE_WINDOW = 14;
  const MIN_PACE_DAYS = 3;
  const MAX_PROJECTION_DAYS = 3650;

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

  // Accepts anything that was ever stored (v2 or v3) and returns a v3 log.
  // Idempotent: normalizing a v3 log returns the same content.
  function normalizeLog(t) {
    t = isObj(t) ? t : {};
    const out = {
      v: VERSION,
      answered: isObj(t.answered) ? t.answered : {},
      totals: isObj(t.totals) ? t.totals : {},
      daily: {},
      undated: {},
      snaps: {},
      targets: {
        weekly: Math.max(0, +(t.targets && t.targets.weekly) || 0),
        daily: Math.max(0, +(t.targets && t.targets.daily) || 0)
      }
    };
    // v2 keyed days by local-midnight milliseconds; v3 by "YYYY-MM-DD".
    for (const bank in (isObj(t.daily) ? t.daily : {})) {
      const src = t.daily[bank];
      if (!isObj(src)) continue;
      const dst = out.daily[bank] = {};
      for (const k in src) {
        const day = D.normalizeKey(k), n = +src[k] || 0;
        if (day && n > 0) dst[day] = (dst[day] || 0) + n;
      }
    }
    for (const bank in (isObj(t.undated) ? t.undated : {})) {
      const list = Array.isArray(t.undated[bank]) ? t.undated[bank] : [];
      out.undated[bank] = list.filter((u) => u && +u.n > 0 && D.isDayKey(u.from) && D.isDayKey(u.to))
        .map((u) => ({ from: u.from, to: u.to, n: +u.n }));
    }
    for (const bank in (isObj(t.snaps) ? t.snaps : {})) {
      const src = t.snaps[bank];
      if (!isObj(src)) continue;
      const dst = out.snaps[bank] = {};
      for (const k in src) if (D.isDayKey(k) && isFinite(+src[k])) dst[k] = +src[k];
    }
    return out;
  }

  // Questions the panel logged for this bank in (fromTs, toTs].
  function liveBetween(log, bank, fromTs, toTs) {
    let n = 0;
    for (const k in log.answered) {
      const e = log.answered[k];
      if (!e || e.slug !== bank || !e.ts) continue;
      if (e.ts > fromTs && e.ts <= toTs) n++;
    }
    return n;
  }

  // The dashboard counter moved from prev.used to `used`. Credit the part the
  // panel didn't already log. Returns what it did, for tests and messages.
  function creditCounter(log, bank, prev, used, nowMs) {
    if (!prev || prev.used == null || used == null) return { kind: "baseline" };
    if (used < prev.used) return { kind: "reset" };             // bank reset or switch
    const extra = Math.max(0, used - prev.used - liveBetween(log, bank, prev.ts || 0, nowMs));
    if (!extra) return { kind: "none" };
    const today = D.dayKey(nowMs), from = D.dayKey(prev.ts || nowMs);
    if (from === today) {
      const b = log.daily[bank] || (log.daily[bank] = {});
      b[today] = (b[today] || 0) + extra;
      return { kind: "dated", day: today, n: extra };
    }
    const list = log.undated[bank] || (log.undated[bank] = []);
    list.push({ from, to: today, n: extra });
    if (list.length > UNDATED_KEEP) list.splice(0, list.length - UNDATED_KEEP);
    return { kind: "undated", from, to: today, n: extra };
  }

  // One reading of the counter per bank per day (the latest wins). A drop
  // means the bank was reset, and pace across a reset is meaningless, so the
  // series starts again.
  function recordSnapshot(log, bank, day, used) {
    if (used == null || !isFinite(+used)) return;
    let s = log.snaps[bank] || (log.snaps[bank] = {});
    const days = Object.keys(s).sort();
    const last = days.length ? s[days[days.length - 1]] : null;
    if (last != null && +used < last) s = log.snaps[bank] = {};
    s[day] = +used;
    const cut = D.addDays(day, -SNAP_KEEP_DAYS);
    for (const k of Object.keys(s)) if (k < cut) delete s[k];
  }

  // day -> questions, both signals, all banks (for Today / week / streak /
  // heatmap). Undated jumps are deliberately absent.
  function dayCounts(log, bank) {
    const out = {};
    for (const k in log.answered) {
      const e = log.answered[k];
      if (!e || !e.ts || (bank && e.slug !== bank)) continue;
      const d = D.dayKey(e.ts);
      out[d] = (out[d] || 0) + 1;
    }
    for (const b in log.daily) {
      if (bank && b !== bank) continue;
      for (const d in log.daily[b]) out[d] = (out[d] || 0) + log.daily[b][d];
    }
    return out;
  }
  function undatedTotal(log, bank) {
    let n = 0;
    for (const b in log.undated) {
      if (bank && b !== bank) continue;
      for (const u of log.undated[b]) n += u.n;
    }
    return n;
  }

  // Questions per day for one bank.
  //   counter  from the dashboard snapshots, over the last 14 days of them
  //   log      from dated activity, over min(14, days since you started)
  // Needs at least three days of history either way; before that it says so
  // rather than dividing a first day's burst by fourteen, or by one.
  function pace(log, bank, today) {
    const s = log.snaps[bank] || {};
    const days = Object.keys(s).sort();
    if (days.length >= 2) {
      const last = days[days.length - 1];
      const start = D.addDays(last, -PACE_WINDOW);
      let base = days[0];
      for (const d of days) if (d <= start) base = d;
      const span = D.daysBetween(base, last), done = s[last] - s[base];
      if (span >= MIN_PACE_DAYS && done > 0) {
        return { perDay: done / span, span, from: base, to: last, source: "counter",
                 staleDays: Math.max(0, D.daysBetween(last, today)) };
      }
    }
    const counts = dayCounts(log, bank);
    const active = Object.keys(counts).filter((d) => d <= today).sort();
    if (!active.length) return null;
    const span = Math.min(PACE_WINDOW, D.daysBetween(active[0], today) + 1);
    if (span < MIN_PACE_DAYS) return { insufficient: true, span };
    const from = D.addDays(today, -(span - 1));
    let done = 0;
    for (const d of active) if (d >= from) done += counts[d];
    return done > 0 ? { perDay: done / span, span, from, to: today, source: "log", staleDays: 0 } : null;
  }

  // When the remaining questions run out at that pace.
  function projection(remaining, p, today) {
    if (remaining == null || !isFinite(remaining)) return null;
    if (remaining <= 0) return { done: true };
    if (!p || !(p.perDay > 0)) return null;
    const daysLeft = Math.ceil(remaining / p.perDay);
    if (daysLeft > MAX_PROJECTION_DAYS) return { tooFar: true, daysLeft };
    return { daysLeft, finish: D.addDays(today, daysLeft) };
  }

  const api = { VERSION, normalizeLog, creditCounter, recordSnapshot, dayCounts, undatedTotal, pace, projection };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).tracker = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
