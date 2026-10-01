// Mnestic — which topics in a block are actually weak.
//
// Raw accuracy ranks a 0/1 topic below a 7/13 one, which says more about luck
// than about you. Two simple, explainable corrections:
//
//   smoothed = (correct + k * p) / (total + k)
//     where p is your accuracy on the whole block and k = 4: "count each topic
//     as if it also had four average questions". A big group barely moves; a
//     one-question group is pulled most of the way to your block average.
//
//   a group with fewer than 3 questions is marked "few" and ranked after every
//   group that has enough to judge.
//
// The raw "7/13" is always shown next to it, so the ranking can be checked.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE.
(function (root) {
  "use strict";

  const K = 4;
  const MIN_N = 3;

  // rows: [{qid, ...}], key: the column to group by,
  // missed(row): did you get it wrong (incl. omitted/guessed), guessed(row): optional
  function aggregate(rows, key, missed, guessed, opts) {
    opts = opts || {};
    const k = opts.k != null ? opts.k : K, minN = opts.minN != null ? opts.minN : MIN_N;
    const total = rows.length;
    const correctAll = rows.filter((r) => !missed(r)).length;
    const p = total ? correctAll / total : 0;
    const map = new Map();
    rows.forEach((r) => {
      const name = String(r[key] || "").trim() || "—";
      let g = map.get(name);
      if (!g) { g = { name, total: 0, wrong: 0, guessed: 0, wrongQids: [] }; map.set(name, g); }
      g.total++;
      if (missed(r)) { g.wrong++; g.wrongQids.push(r.qid); }
      if (guessed && guessed(r)) g.guessed++;
    });
    const out = Array.from(map.values());
    out.forEach((g) => {
      g.correct = g.total - g.wrong;
      g.acc = g.total ? g.correct / g.total : 0;
      g.smoothed = (g.correct + k * p) / (g.total + k);
      g.few = g.total < minN;
    });
    out.sort((a, b) => (a.few - b.few) || (a.smoothed - b.smoothed) || (b.total - a.total) ||
      a.name.localeCompare(b.name));
    return { groups: out, blockAccuracy: p, total, correct: correctAll };
  }

  // The groups to drill: the weakest that have misses and enough questions to
  // judge; only if there are none of those, the small ones.
  function weakest(groups, n) {
    const withMisses = groups.filter((g) => g.wrongQids.length);
    const solid = withMisses.filter((g) => !g.few);
    return (solid.length ? solid : withMisses).slice(0, n == null ? 3 : n);
  }

  const api = { K, MIN_N, aggregate, weakest };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).weak = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
