// Mnestic — building the text of a new card.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE.
(function (root) {
  "use strict";

  const ZWSP = "​";

  function nextClozeNum(s) {
    let n = 0, m;
    const re = /\{\{c(\d+)::/g;
    while ((m = re.exec(String(s || "")))) n = Math.max(n, +m[1]);
    return n + 1;
  }

  // Inside a cloze, "::" starts a hint and "}}" ends the deletion, so a
  // selection containing either ("Na+/K+::ATPase") came out as a broken card.
  // An invisible zero-width space between the two characters keeps the text
  // looking the same and stops Anki reading it as syntax.
  function protectClozeBody(text) {
    return String(text || "").split("::").join(":" + ZWSP + ":").split("}}").join("}" + ZWSP + "}");
  }

  // Wrap text[a, b) in the next cloze number. Nothing selected wraps it all.
  function wrapCloze(text, a, b) {
    text = String(text || "");
    if (a === b) { a = 0; b = text.length; }
    if (a === b) return { text, wrapped: false };
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const n = nextClozeNum(text);
    return {
      text: text.slice(0, lo) + "{{c" + n + "::" + protectClozeBody(text.slice(lo, hi)) + "}}" + text.slice(hi),
      wrapped: true,
      n
    };
  }

  // ---- reading a card back, for the flashcard test ----
  // {{c2::answer::hint}} -- number, answer, optional hint.
  const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

  // The cloze numbers a note's Text asks, in order, once each: one card each.
  function clozeOrdinals(text) {
    const seen = new Set();
    let m;
    CLOZE.lastIndex = 0;
    while ((m = CLOZE.exec(String(text || "")))) seen.add(+m[1]);
    return Array.from(seen).sort((a, b) => a - b);
  }

  // One side of cloze card n, as Anki shows it: on the front, cloze n is a
  // blank ("[…]", or its hint) and every other cloze is plain text; on the
  // back, cloze n is revealed. The blank and the answer are wrapped in our own
  // "cloze" span (the one class the card renderer keeps).
  function clozeSide(text, n, back) {
    CLOZE.lastIndex = 0;
    return String(text || "").replace(CLOZE, (all, num, answer, hint) => {
      if (+num !== n) return answer;
      if (back) return '<span class="cloze">' + answer + "</span>";
      return '<span class="cloze">[' + (hint && hint.trim() ? hint : "…") + "]</span>";
    });
  }

  // The answer of cloze n as plain words (for the end-of-test list).
  function clozeAnswer(text, n) {
    const out = [];
    let m;
    CLOZE.lastIndex = 0;
    while ((m = CLOZE.exec(String(text || "")))) if (+m[1] === n) out.push(m[2]);
    return out.join(" … ");
  }

  const api = { nextClozeNum, protectClozeBody, wrapCloze, clozeOrdinals, clozeSide, clozeAnswer };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).cards = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
