"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../../extension/lib/ai.js");

// The live Step 1 question 1881: picked C, the answer is E.
const parts = {
  stem: "A 56-year-old man is brought to the emergency department due to burning substernal pain…",
  choices: [
    { letter: "A", text: "Fat globules and bone marrow cells in the pulmonary arterioles" },
    { letter: "C", text: "Neutrophil-rich fluid filling the bronchi, bronchioles, and alveoli" },
    { letter: "E", text: "Engorged capillaries and alveoli filled with acellular pink material" }
  ],
  mine: "C", correct: "E", result: "incorrect",
  explanation: "This patient has chest pain and ECG evidence of acute myocardial infarction…"
};
const OLD_DEFAULT = A.LEGACY_DEFAULT;
const KEYS = ["full", "mistake", "choices", "hy", "quiz"];
const with_ = (o) => Object.assign({}, parts, o);
const count = (t, re) => (t.match(re) || []).length;

// Every attempt the extension can report, as (parts, ctx).
const CASES = {
  wrong: [parts, { conf: "torn" }],
  unsure: [with_({ mine: "E", result: "correct" }), { conf: "guessed" }],
  right: [with_({ mine: "E", result: "correct" }), { conf: "knew" }],
  omitted: [with_({ mine: null, result: "omitted" }), {}],
  unknown: [with_({ mine: null, result: null }), {}]
};

test("the five presets, with their new labels and hints, and My own prompt", () => {
  assert.deepEqual(A.PRESETS.map((p) => p.key), KEYS);
  assert.deepEqual(A.PRESETS.map((p) => p.label), ["Full Review", "Fix My Mistake", "Compare the Choices", "High-Yield Review", "Quiz Me"]);
  A.PRESETS.forEach((p) => assert.ok(p.hint && p.hint.length <= 70, p.key));
  assert.equal(A.preset("custom").label, "My own prompt");
});

test("the copied text: brief, rules with one focus, then the question block last", () => {
  const t = A.compose(parts, "full", { step: 1, conf: "torn" });
  assert.match(t, /^You are an expert USMLE tutor/);
  assert.match(t, /\n\nRules:\n- The given correct answer is official/);
  assert.match(t, /- This is USMLE Step 1\. Focus on the underlying science/);
  assert.equal(count(t, /^Rules:$/gm), 1);
  assert.equal(count(t, /This is USMLE Step/g), 1);
  assert.ok(t.indexOf("Rules:") < t.indexOf("=== QUESTION (USMLE Step 1) ==="));
  assert.match(t, /C\. Neutrophil-rich fluid filling the bronchi, bronchioles, and alveoli {3}← my answer/);
  assert.match(t, /E\. Engorged capillaries .* {3}← correct answer/);
  assert.match(t, /My answer: C\. Neutrophil-rich/);
  assert.match(t, /Correct answer: E\. Engorged/);
  assert.match(t, /Result: incorrect/);
  assert.match(t, /How it went: I was torn between two choices/);
  assert.match(t, /=== EXPLANATION \(from the question bank\) ===\nThis patient[^\n]*$/);
});

test("each Step gets its own focus, and only that one", () => {
  const f = (step) => A.compose(parts, "hy", { step });
  assert.match(f(1), /This is USMLE Step 1\./);
  assert.match(f(2), /This is USMLE Step 2 CK\. Focus on clinical reasoning/);
  assert.match(f(3), /This is USMLE Step 3\. Focus on clinical decision-making/);
  [1, 2, 3].forEach((s) => assert.equal(count(f(s), /This is USMLE Step/g), 1));
  const none = f(null);
  assert.doesNotMatch(none, /This is USMLE Step/);
  assert.match(none, /- Focus on the reasoning that leads to the answer/);
  assert.match(none, /=== QUESTION \(USMLE\) ===/);
});

test("Full Review and Fix My Mistake pick one variant for each situation", () => {
  const FULL = { wrong: "6. WHY I GOT IT WRONG", unsure: "6. RESOLVE MY UNCERTAINTY", right: "6. STRENGTHEN MY UNDERSTANDING",
    omitted: "6. HOW I SHOULD APPROACH IT", unknown: "6. THE MAIN LEARNING TRAP" };
  const MIST = { wrong: "I answered this question incorrectly.", unsure: "I answered correctly, but I guessed.",
    right: "I answered correctly. Stress-test", omitted: "I left this question unanswered.", unknown: "My answer or result is unclear. Analyze" };
  Object.keys(CASES).forEach((sit) => {
    const [p, ctx] = CASES[sit];
    const full = A.compose(p, "full", Object.assign({ step: 2 }, ctx));
    const mist = A.compose(p, "mistake", Object.assign({ step: 2 }, ctx));
    assert.ok(full.includes(FULL[sit]), "full/" + sit);
    assert.ok(mist.includes(MIST[sit]), "mistake/" + sit);
    Object.keys(FULL).filter((k) => k !== sit).forEach((k) => assert.ok(!full.includes(FULL[k]), "full/" + sit + " also has " + k));
  });
});

test("an unsure right answer quotes the student's words, or says it neutrally", () => {
  const p = with_({ mine: "E", result: "correct" });
  assert.match(A.compose(p, "full", { conf: "narrowed" }), /I answered correctly, but I narrowed it down to two\./);
  assert.match(A.compose(p, "mistake", { conf: "noidea" }), /I answered correctly, but I had no idea\./);
  // a right answer with no rating is "right", not "unsure"
  assert.match(A.compose(p, "full", {}), /6\. STRENGTHEN MY UNDERSTANDING/);
});

test("an answer that couldn't be read is never analysed as the student's pick", () => {
  const unread = with_({ mine: null, result: "incorrect" });
  const full = A.compose(unread, "full", { step: 1 });
  assert.match(full, /6\. THE MAIN LEARNING TRAP/);
  assert.doesNotMatch(full, /WHY I GOT IT WRONG|Compare my answer/);
  assert.match(full, /My answer: not detected/);
  assert.match(full, /Result: incorrect/, "the recorded result is kept");
  assert.match(A.compose(unread, "mistake", {}), /My answer or result is unclear/);
  assert.match(A.compose(unread, "choices", {}), /with the most tempting distractor side by side/);
  const unknown = with_({ mine: null, result: null });
  const t = A.compose(unknown, "mistake", { step: 3 });
  assert.match(t, /My answer: not detected/);
  assert.match(t, /Result: not detected/);
  assert.match(t, /If my answer says "not detected", state that it was not detected/);
  assert.match(t, /=== QUESTION \(USMLE Step 3\) ===/);
});

test("Compare the Choices: 'my answer' only for a wrong pick that was read", () => {
  const target = (p, ctx) => A.compose(p, "choices", ctx).match(/Compare the official correct answer with (.+) side by side/)[1];
  assert.equal(target(...CASES.wrong), "my answer");
  ["unsure", "right", "omitted", "unknown"].forEach((sit) => assert.equal(target(...CASES[sit]), "the most tempting distractor", sit));
});

test("every built-in prompt, in every situation: plain text, nothing unresolved", () => {
  KEYS.forEach((k) => Object.keys(CASES).forEach((sit) => [1, 2, 3, null].forEach((step) => [false, true].forEach((basics) => {
    const [p, ctx] = CASES[sit];
    const t = A.compose(p, k, Object.assign({ step, basics }, ctx));
    const where = k + "/" + sit + "/" + step + "/" + basics;
    assert.doesNotMatch(t, /\{[A-Z_]+\}/, where);
    assert.doesNotMatch(t, /undefined|null|NaN|\[object/, where);
    assert.doesNotMatch(t, /<[a-z]+[ >]|```|"role"\s*:/i, where);
    assert.equal(count(t, /^Rules:$/gm), 1, where);
    assert.equal(count(t, /=== QUESTION/g), 1, where);
    assert.ok(/=== EXPLANATION[^]*$/.test(t) && t.endsWith(p.explanation), where + ": the question block is last");
  }))));
});

test("Explain from Basics: after the brief, before the rules -- only when on", () => {
  const on = A.compose(parts, "quiz", { step: 1, basics: true });
  assert.equal(count(on, /Explain from Basics is enabled/g), 1);
  assert.ok(on.indexOf("Start with question 1 now") < on.indexOf("Explain from Basics") &&
            on.indexOf("Explain from Basics") < on.indexOf("Rules:"));
  assert.doesNotMatch(A.compose(parts, "quiz", { step: 1 }), /Explain from Basics/);
  assert.doesNotMatch(A.compose(parts, "quiz", { step: 1, basics: false }), /Explain from Basics/);
});

test("my own prompt is used as written, with nothing added", () => {
  const t = A.compose(parts, "custom", { step: 1, custom: "Explain like I'm tired.", basics: true });
  assert.match(t, /^Explain like I'm tired\.\n\n=== QUESTION/);
  assert.doesNotMatch(t, /Rules:|Explain from Basics/);
  // the pre-1.5 built-in prompt left in storage is never sent as yours
  assert.match(A.compose(parts, "custom", { custom: OLD_DEFAULT }), /^=== QUESTION/);
});

test("each preset is a different brief; Quiz Me asks one question and waits", () => {
  const firsts = new Set(KEYS.map((k) => A.compose(parts, k, { step: 1 }).split("\n")[0]));
  assert.equal(firsts.size, 5);
  const q = A.compose(parts, "quiz", { step: 2 });
  assert.match(q, /Ask exactly ONE question at a time and wait for my answer/);
  assert.match(q, /Start with question 1 now and wait for my answer\./);
  assert.match(A.compose(parts, "mistake", {}), /Don't reveal the answer until I respond/);
  assert.match(A.compose(parts, "hy", {}), /Mark the three highest-priority learning points with ★/);
});

test("no question bank name and no link reach the clipboard; the medicine does", () => {
  const t = A.compose(with_({
    stem: "A 30-year-old woman (see https://example.com/img?id=3) has fever.  Labs follow.",
    explanation: "Aspirin inhibits COX-1 irreversibly (www.example.org/aspirin).\nAs discussed in UWorld question 12, platelets lack nuclei.\nCopyright © UWorld. All rights reserved.\n(c) Copyright notice about mechanisms of copyright-free drugs is kept because it is long and names no bank at all."
  }), "full", { step: 1 });
  assert.doesNotMatch(t, /uworld|coursology|medpark|https?:|www\./i);
  assert.match(t, /A 30-year-old woman \(see \) has fever\. Labs follow\./);
  assert.match(t, /Aspirin inhibits COX-1 irreversibly/);
  assert.match(t, /As discussed in the question bank question 12, platelets lack nuclei\./);
  assert.match(t, /\(c\) Copyright notice about mechanisms/);
  assert.doesNotMatch(t, /All rights reserved/);
  assert.equal(A.scrub("Na+ 135 mEq/L\n  - indented point"), "Na+ 135 mEq/L\n  - indented point");
});

test("one-click default: your own prompt from before 1.5 is kept, the old built-in one isn't yours", () => {
  assert.equal(A.defaultPreset(null, ""), "full");
  assert.equal(A.defaultPreset(null, OLD_DEFAULT), "full");
  assert.equal(A.defaultPreset(null, "Give me one high-yield sentence."), "custom");
  assert.equal(A.defaultPreset("quiz", "Give me one sentence."), "quiz");
  assert.equal(A.defaultPreset("custom", ""), "full", "own prompt emptied");
  assert.equal(A.defaultPreset("nonsense", ""), "full");
});

test("when the question couldn't be read in parts, the page text goes without the player around it", () => {
  const page = "1\n2\n3\n40\nItem 20 of 40\nQuestion Id: 1881\nMark\nPrevious\nNext\nA 56-year-old man…\nA. Fat globules\nE. Engorged capillaries\nTest ID: 1883996777\nBlock Time Elapsed: 01:26:32";
  const t = A.stripFurniture(page);
  assert.equal(t, "A 56-year-old man…\nA. Fat globules\nE. Engorged capillaries");
});
