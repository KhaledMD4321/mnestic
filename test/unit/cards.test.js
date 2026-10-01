"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../../extension/lib/cards.js");

test("cloze numbers continue from the highest one used", () => {
  assert.equal(C.nextClozeNum(""), 1);
  assert.equal(C.nextClozeNum("{{c1::a}} {{c3::b}}"), 4);
});

test("wrapping a selection makes the next cloze", () => {
  const r = C.wrapCloze("The cochlea hears", 4, 11);
  assert.equal(r.text, "The {{c1::cochlea}} hears");
  const r2 = C.wrapCloze(r.text, 20, 25);
  assert.equal(r2.text, "The {{c1::cochlea}} {{c2::hears}}");
});

test("nothing selected wraps the whole text; empty text does nothing", () => {
  assert.equal(C.wrapCloze("All of it", 3, 3).text, "{{c1::All of it}}");
  assert.equal(C.wrapCloze("", 0, 0).wrapped, false);
});

test("text that looks like cloze syntax can't break the card", () => {
  const r = C.wrapCloze("Na+/K+::ATPase and }} braces", 0, 28);
  assert.ok(!/::ATPase/.test(r.text), "'::' inside the cloze would start a hint");
  assert.equal((r.text.match(/\}\}/g) || []).length, 1, "only the cloze's own closing braces remain");
  assert.equal(r.text.replace(/​/g, ""), "{{c1::Na+/K+::ATPase and }} braces}}", "it still reads the same");
});
