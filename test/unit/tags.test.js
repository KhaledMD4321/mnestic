"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../extension/lib/tags.js");

test("resource tags become readable chapter paths", () => {
  const paths = T.tagPaths([
    "#AK_Step1_v12::#FirstAid::03_Respiratory::Obstructive_Lung_Disease",
    "#AK_Step1_v12::#FirstAid::##_Retired_Lessons::Old",
    "#AK_Step1_v12::#FirstAid::2019::03_Respiratory",
    "#AK_Step1_v12::#Sketchy::Pharm::Beta_Blockers::Extra",
    "#AK_Step1_v12::#Physeo::Cardio"
  ], "#FirstAid");
  assert.deepEqual(paths, [["Respiratory", "Obstructive Lung Disease"]]);
  assert.deepEqual(T.tagPaths(["#AK_Step1_v12::#Sketchy::Pharm::Beta_Blockers::Extra"], "#Sketchy"),
    [["Pharm", "Beta Blockers"]], "a trailing ::Extra is dropped");
  assert.deepEqual(T.tagPaths(null, "#FirstAid"), []);
});

test("edition segments are recognised and chapters are not", () => {
  for (const ed of ["FA2024", "2023", "FA_2025"]) assert.ok(T.isEditionSeg(ed), ed);
  for (const ch of ["03_Respiratory", "Cardiovascular", "B12_deficiency"]) assert.ok(!T.isEditionSeg(ch), ch);
});

const omalizumab = [
  { tags: ["#AK_Step1_v12::#FirstAid::FA2024::02_Immunology::Immunosuppressants",
           "#AK_Step1_v12::#FirstAid::FA2024::13_Respiratory::Asthma_drugs",
           "#AK_Step1_v12::#UWorld::Step::2128"] },
  { tags: ["#AK_Step1_v12::#FirstAid::FA2024::02_Immunology::Omalizumab",
           "#AK_Step1_v12::#FirstAid::FA2024::13_Respiratory::Omalizumab",
           "#AK_Step1_v12::#UWorld::Step::2128"] }
];

test("a tie no longer falls to alphabetical order when the qbank names the system", () => {
  const plain = T.chapterCandidates(omalizumab, 1);
  assert.equal(plain[0].name, "Immunology", "the old behaviour, with nothing else to go on");
  const withSystem = T.chapterCandidates(omalizumab, 1, { system: "Pulmonary & Critical Care" });
  assert.equal(withSystem[0].name, "Respiratory", "the question's own system wins");
  assert.equal(T.chapterCandidates(omalizumab, 1, { system: "Respiratory" })[0].name, "Respiratory");
});

test("what you chose before breaks a tie", () => {
  const c = T.chapterCandidates(omalizumab, 1, { preferred: { respiratory: 3 } });
  assert.equal(c[0].name, "Respiratory");
});

test("system names map onto AnKing chapter names", () => {
  assert.ok(T.matchesSystem("Renal", "Renal/Urinary System"));
  assert.ok(T.matchesSystem("Neurology and Special Senses", "Nervous System"));
  assert.ok(T.matchesSystem("Hematology and Oncology", "Hematology & Oncology"));
  assert.ok(!T.matchesSystem("Immunology", "Pulmonary & Critical Care"));
  assert.ok(!T.matchesSystem("Respiratory", ""));
});

test("Step 2 suggests rotations, with abbreviations spelled out", () => {
  const c = T.chapterCandidates([{ tags: [
    "#AK_Step2_v12::#Resources_by_rotation::IM::Pulm",
    "#AK_Step2_v12::#Resources_by_rotation::IM::Cards",
    "#AK_Step2_v12::#FirstAid::Pulmonary"] }], 2);
  assert.equal(c[0].name, "Internal Medicine");
});

test("an existing subdeck is reused exactly, or by its start -- never by a word in the middle", () => {
  const decks = ["Missed Qs", "Missed Qs::03_Respiratory", "Missed Qs::Psych Pharm", "Missed Qs::Cardiovascular",
                 "Missed Qs::Respiratory::Asthma", "Other::Pharm"];
  assert.equal(T.existingChapterDeck(decks, "Missed Qs", "Respiratory"), "Missed Qs::03_Respiratory");
  assert.equal(T.existingChapterDeck(decks, "Missed Qs", "Cardio"), "Missed Qs::Cardiovascular");
  assert.equal(T.existingChapterDeck(decks, "Missed Qs", "Pharm"), null, "not 'Psych Pharm'");
  assert.equal(T.existingChapterDeck(decks, "Missed Qs", "Asthma"), null, "direct children only");
  assert.equal(T.existingChapterDeck(decks, "Missed Qs", "GI"), null, "too short to guess");
  assert.equal(T.existingChapterDeck(null, "Missed Qs", "Respiratory"), null);
});
