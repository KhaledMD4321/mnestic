// Mnestic — matching a question to AnKing notes, and ordering what matched.
//
// Read off a real v12 deck, #UWorld tags come in three shapes:
//     #AK_Step1_v12::#UWorld::Step::2108      the UWorld question id
//     #AK_Step1_v12::#UWorld::COMLEX::25217   a COMLEX id — a DIFFERENT exam
//     #AK_Step3_v12::#UWorld::122790          older/bare form, no namespace
// The precise query takes the first and last and never the COMLEX one (those
// ids genuinely collide with Step ids). Anki's tag: search compares whole tag
// components, so 21 never matches 2108.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE.
(function (root) {
  "use strict";

  const ANKING_VER = "v*";   // any AnKing version

  // A question id reaches us from the page and goes into Anki searches (and,
  // through them, into writes). Digits only, no leading zeros -- AnKing never
  // writes "02128" -- and a sane length, whatever an adapter returned.
  function safeQid(qid) {
    const digits = String(qid == null ? "" : qid).replace(/[^0-9]/g, "").replace(/^0+/, "");
    if (!digits || digits.length > 12) throw new Error("bad question id");
    return digits;
  }
  function safeQidOrNull(qid) {
    try { return safeQid(qid); } catch (e) { return null; }
  }
  function stepTag(sv) {
    const n = +sv;
    if (!(n >= 1 && n <= 3)) throw new Error("bad step");
    return "tag:#AK_Step" + n + "_" + ANKING_VER + "::#UWorld::";
  }
  // The question's AnKing notes, plus any note Mnestic itself linked to it
  // (a card you made from it, or a copy you saved).
  function qidQuery(qid, sv) {
    const id = safeQid(qid), base = stepTag(sv);
    return "(" + base + "Step::" + id + " OR " + base + id + " OR tag:Mnestic::QID::" + id + ")";
  }
  // The old wildcard. It can pull in other namespaces (COMLEX), so it is only
  // ever run when you ask for a broader search, and the panel says so.
  function qidQueryLoose(qid, sv) {
    return stepTag(sv) + "*::" + safeQid(qid);
  }
  function qidTag(qid) {
    return "Mnestic::QID::" + safeQid(qid);
  }

  const UW_RE = /^#AK_Step(\d)_v[^:]*::#UWorld::(?:Step::)?(\d+)$/i;
  // Distinct UWorld question ids AnKing tagged on a note (any step).
  function uworldIds(tags) {
    const out = new Set();
    for (const t of tags || []) {
      const m = UW_RE.exec(String(t));
      if (m) out.add(m[2]);
    }
    return out;
  }

  // AnKing's own yield marking, e.g. #AK_Step1_v12::^Other::#Low/HighYield::1-HighYield
  const YIELD_NAMES = {
    highyield: "HighYield", relativelyhighyield: "RelativelyHighYield",
    "highyield-temporary": "HighYield-temporary", loweryield: "LowerYield", lowyield: "LowYield"
  };
  function yieldOf(tags) {
    for (const t of tags || []) {
      const low = String(t).toLowerCase();
      if (low.indexOf("low/highyield") < 0 && low.indexOf("^highyield") < 0) continue;
      const leaf = low.split("::").pop().replace(/^\d+-/, "").trim();
      if (YIELD_NAMES[leaf]) return YIELD_NAMES[leaf];
    }
    return null;
  }
  const YIELD_ORDER = { HighYield: 0, RelativelyHighYield: 1, "HighYield-temporary": 2, null: 3, LowerYield: 4, LowYield: 5 };

  // Which matched note is most about THIS question.
  //   1. specificity: a note AnKing tagged with 2 question ids is about them;
  //      one tagged with 60 is a general fact that happens to come up a lot.
  //   2. yield: AnKing's own high-yield marking.
  //   3. note id, so the order is stable from one visit to the next.
  // A note Mnestic linked itself (no #UWorld tag) counts as fully specific.
  function rankInfo(note) {
    const ids = uworldIds(note && note.tags).size || 1;
    const y = yieldOf(note && note.tags);
    return { ids, yield: y, yieldOrder: YIELD_ORDER[y] != null ? YIELD_ORDER[y] : 3 };
  }
  function rankNotes(notes) {
    return (notes || [])
      .map((n, i) => ({ n, i, r: rankInfo(n) }))
      .sort((a, b) => (a.r.ids - b.r.ids) || (a.r.yieldOrder - b.r.yieldOrder) ||
        ((+a.n.noteId || 0) - (+b.n.noteId || 0)) || (a.i - b.i))
      .map((x) => x.n);
  }

  const api = { ANKING_VER, safeQid, safeQidOrNull, qidQuery, qidQueryLoose, qidTag, uworldIds, yieldOf, rankInfo, rankNotes };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).match = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
