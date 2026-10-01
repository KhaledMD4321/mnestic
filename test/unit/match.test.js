"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../../extension/lib/match.js");

test("question ids are digits, without leading zeros, and bounded", () => {
  assert.equal(M.safeQid("2128"), "2128");
  assert.equal(M.safeQid(" Question Id: 02128 "), "2128");
  assert.equal(M.safeQid(2128), "2128");
  for (const bad of ["", "abc", "0", "000", "1234567890123", null, undefined]) {
    assert.throws(() => M.safeQid(bad), "should refuse " + JSON.stringify(bad));
  }
  assert.equal(M.safeQidOrNull("x"), null);
});

test("the query matches the precise tag shapes and Mnestic's own link, never a wildcard", () => {
  const q = M.qidQuery("2128", 1);
  assert.equal(q, "(tag:#AK_Step1_v*::#UWorld::Step::2128 OR tag:#AK_Step1_v*::#UWorld::2128 OR tag:Mnestic::QID::2128)");
  assert.ok(!/::\*::/.test(q), "no ::*:: wildcard (it matches COMLEX ids)");
  assert.throws(() => M.qidQuery("2128", 4), "steps are 1-3");
  assert.equal(M.qidQuery("21 OR deck:*", 1), M.qidQuery("21", 1), "injection collapses to the digits");
  assert.equal(M.qidQueryLoose("2128", 2), "tag:#AK_Step2_v*::#UWorld::*::2128");
});

test("UWorld ids on a note are read from every step, COMLEX excluded", () => {
  const ids = M.uworldIds([
    "#AK_Step1_v12::#UWorld::Step::2108", "#AK_Step2_v12::#UWorld::Step::2108",
    "#AK_Step1_v12::#UWorld::COMLEX::25217", "#AK_Step3_v12::#UWorld::122790", "marked"
  ]);
  assert.deepEqual(Array.from(ids).sort(), ["122790", "2108"]);
});

test("AnKing yield is read from its own tag", () => {
  assert.equal(M.yieldOf(["#AK_Step1_v12::^Other::#Low/HighYield::1-HighYield"]), "HighYield");
  assert.equal(M.yieldOf(["#AK_Step1_v12::^Other::#Low/HighYield::4-LowYield"]), "LowYield");
  assert.equal(M.yieldOf(["#AK_Step1_v12::#FirstAid::HighYield_stuff"]), null, "a chapter name is not a marker");
});

test("the note most about this question comes first", () => {
  const many = Array.from({ length: 40 }, (_, i) => "#AK_Step1_v12::#UWorld::Step::" + (1000 + i));
  const notes = [
    { noteId: 5, tags: many },                                                      // a general fact
    { noteId: 9, tags: ["#AK_Step1_v12::#UWorld::Step::2128", "#AK_Step1_v12::#UWorld::Step::7",
                        "#AK_Step1_v12::^Other::#Low/HighYield::4-LowYield"] },
    { noteId: 8, tags: ["#AK_Step1_v12::#UWorld::Step::2128", "#AK_Step1_v12::#UWorld::Step::7",
                        "#AK_Step1_v12::^Other::#Low/HighYield::1-HighYield"] },
    { noteId: 3, tags: ["#AK_Step1_v12::#UWorld::Step::2128", "#AK_Step1_v12::#UWorld::Step::7"] }
  ];
  assert.deepEqual(M.rankNotes(notes).map((n) => n.noteId), [8, 3, 9, 5]);
  assert.deepEqual(M.rankNotes([{ noteId: 2, tags: [] }, { noteId: 1, tags: [] }]).map((n) => n.noteId), [1, 2],
    "ties fall back to note id, so the order is stable");
  assert.deepEqual(M.rankNotes(null), []);
});
