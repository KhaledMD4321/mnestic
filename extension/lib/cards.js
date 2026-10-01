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

  const api = { nextClozeNum, protectClozeBody, wrapCloze };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).cards = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
