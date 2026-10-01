"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../../extension/lib/weak.js");

// Test 35 on the live account, by Subject: 40 questions, 28 correct (70%).
function block() {
  const rows = [];
  const add = (subject, right, wrong) => {
    for (let i = 0; i < right; i++) rows.push({ qid: subject + "+" + i, subject, wrong: false });
    for (let i = 0; i < wrong; i++) rows.push({ qid: subject + "-" + i, subject, wrong: true });
  };
  add("Pathology", 7, 6); add("Pathophysiology", 9, 5); add("Physiology", 7, 1);
  add("Pharmacology", 3, 0); add("Anatomy", 2, 0);
  return rows;
}
const missed = (r) => r.wrong;

test("the real block ranks the same as before, with smoothed scores alongside", () => {
  const { groups, blockAccuracy } = W.aggregate(block(), "subject", missed);
  assert.equal(blockAccuracy, 0.7);
  assert.deepEqual(groups.map((g) => g.name), ["Pathology", "Pathophysiology", "Physiology", "Pharmacology", "Anatomy"]);
  const by = Object.fromEntries(groups.map((g) => [g.name, g]));
  assert.equal(Math.round(by.Pathology.smoothed * 100), 58);
  assert.equal(Math.round(by.Pathophysiology.smoothed * 100), 66);
  assert.equal(Math.round(by.Physiology.smoothed * 100), 82);
  assert.equal(by.Anatomy.few, true, "2 questions is too few to judge");
  assert.equal(by.Pathology.wrongQids.length, 6);
});

test("one unlucky question no longer outranks a genuinely weak topic", () => {
  const rows = block().concat([{ qid: "x", subject: "Genetics", wrong: true }]);
  const { groups } = W.aggregate(rows, "subject", missed);
  assert.equal(groups[0].name, "Pathology", "0/1 Genetics is not the weakest");
  const genetics = groups.find((g) => g.name === "Genetics");
  assert.equal(genetics.acc, 0);
  assert.equal(genetics.few, true);
  assert.deepEqual(W.weakest(groups).map((g) => g.name), ["Pathology", "Pathophysiology", "Physiology"]);
});

test("small groups are drilled only when nothing else has misses", () => {
  const rows = [{ qid: "1", s: "A", wrong: true }, { qid: "2", s: "B", wrong: false }, { qid: "3", s: "B", wrong: false },
                { qid: "4", s: "B", wrong: false }];
  const { groups } = W.aggregate(rows, "s", missed);
  assert.deepEqual(W.weakest(groups).map((g) => g.name), ["A"]);
});

test("guessed answers are counted as missed and reported separately", () => {
  const rows = [{ qid: "1", s: "A", wrong: false, g: true }, { qid: "2", s: "A", wrong: false },
                { qid: "3", s: "A", wrong: false }];
  const { groups } = W.aggregate(rows, "s", (r) => r.wrong || r.g, (r) => r.g);
  assert.equal(groups[0].wrong, 1);
  assert.equal(groups[0].guessed, 1);
});

test("an empty block is not a division by zero", () => {
  const out = W.aggregate([], "subject", missed);
  assert.deepEqual(out.groups, []);
  assert.equal(out.blockAccuracy, 0);
});
