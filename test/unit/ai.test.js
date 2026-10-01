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
const OLD_DEFAULT = "I'm studying for the USMLE. Below is a question…";

test("the copied text: prompt, rules, then the question with my answer and the correct one", () => {
  const t = A.compose(parts, "full", { step: 1, conf: "torn" });
  assert.match(t, /^You are an expert USMLE tutor/);
  assert.match(t, /Rules:\n- The correct answer given below is the official answer/);
  assert.match(t, /This is Step 1: focus on mechanisms/);
  assert.match(t, /=== QUESTION \(USMLE Step 1\) ===\nA 56-year-old man/);
  assert.match(t, /C\. Neutrophil-rich fluid filling the bronchi, bronchioles, and alveoli {3}← my answer/);
  assert.match(t, /E\. Engorged capillaries .* {3}← correct answer/);
  assert.match(t, /My answer: C\. Neutrophil-rich/);
  assert.match(t, /Correct answer: E\. Engorged/);
  assert.match(t, /Result: incorrect/);
  assert.match(t, /How it went: I was torn between two choices/);
  assert.match(t, /=== EXPLANATION \(from the question bank\) ===\nThis patient/);
});

test("no question bank name, no link, no block navigation", () => {
  const t = A.compose(parts, "full", { step: 1 });
  assert.doesNotMatch(t, /coursology|uworld|medpark|https?:/i);
});

test("the full review adapts to how it went", () => {
  assert.match(A.compose(parts, "full", { step: 1 }), /Why my answer was wrong/);
  const right = Object.assign({}, parts, { mine: "E", result: "correct" });
  assert.match(A.compose(right, "full", { step: 1 }), /I got it right\. Confirm the reasoning/);
  assert.match(A.compose(right, "full", { step: 1, conf: "guessed" }), /I got it right but I wasn't sure \(I guessed\)/);
  const omitted = Object.assign({}, parts, { mine: null, result: "omitted" });
  const o = A.compose(omitted, "full", { step: 2 });
  assert.match(o, /I didn't answer this one/);
  assert.match(o, /My answer: none \(omitted\)/);
  assert.match(o, /This is Step 2 CK: focus on the most likely diagnosis, the next best step/);
});

test("a choice that couldn't be read is said, never guessed", () => {
  const unknown = Object.assign({}, parts, { mine: null, result: null });
  const t = A.compose(unknown, "mistake", { step: 3 });
  assert.match(t, /My answer: not detected/);
  assert.match(t, /Result: not detected/);
  assert.match(t, /If my answer says "not detected", tell me so and don't guess/);
  assert.match(t, /=== QUESTION \(USMLE Step 3\) ===/);
});

test("each preset is a different brief", () => {
  const seen = new Set();
  A.PRESETS.forEach((p) => {
    const t = A.compose(parts, p.key, { step: 1 });
    const first = t.split("\n")[0];
    assert.ok(!seen.has(first), p.key + " repeats another preset");
    seen.add(first);
  });
  assert.equal(A.PRESETS.length, 5);
  assert.match(A.compose(parts, "hy", { step: 1 }), /Arrange the high-yield points of this question's topic/);
  assert.match(A.compose(parts, "quiz", { step: 1 }), /Ask me ONE question at a time/);
  assert.match(A.compose(parts, "choices", { step: 1 }), /comparing the correct answer with my answer/);
});

test("my own prompt is used as written, with the question under it", () => {
  const t = A.compose(parts, "custom", { step: 1, custom: "Explain like I'm tired." });
  assert.match(t, /^Explain like I'm tired\.\n\n=== QUESTION/);
  assert.doesNotMatch(t, /Rules:/);
});

test("one-click default: your own prompt from before 1.5 is kept, the old built-in one isn't yours", () => {
  assert.equal(A.defaultPreset(null, "", OLD_DEFAULT), "full");
  assert.equal(A.defaultPreset(null, OLD_DEFAULT, OLD_DEFAULT), "full");
  assert.equal(A.defaultPreset(null, "Give me one high-yield sentence.", OLD_DEFAULT), "custom");
  assert.equal(A.defaultPreset("quiz", "Give me one sentence.", OLD_DEFAULT), "quiz");
  assert.equal(A.defaultPreset("custom", "", OLD_DEFAULT), "full", "own prompt emptied");
  assert.equal(A.defaultPreset("nonsense", "", OLD_DEFAULT), "full");
});

test("when the question couldn't be read in parts, the page text goes without the player around it", () => {
  const page = "1\n2\n3\n40\nItem 20 of 40\nQuestion Id: 1881\nMark\nPrevious\nNext\nA 56-year-old man…\nA. Fat globules\nE. Engorged capillaries\nTest ID: 1883996777\nBlock Time Elapsed: 01:26:32";
  const t = A.stripFurniture(page);
  assert.equal(t, "A 56-year-old man…\nA. Fat globules\nE. Engorged capillaries");
});
