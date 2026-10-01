// Mnestic — "Copy for AI": the prompts, and the text they're sent with.
//
// Mnestic never talks to an AI. It puts a question and a prompt on your
// clipboard; you paste it into the assistant you already use. These are pure
// functions (no DOM), unit-tested in test/unit/ai.test.js.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE.
(function (root) {
  "use strict";

  const EXAM = { 1: "USMLE Step 1", 2: "USMLE Step 2 CK", 3: "USMLE Step 3" };
  const FOCUS = {
    1: "This is Step 1: focus on mechanisms, pathophysiology, pharmacology, microbiology and histology — the why behind each finding.",
    2: "This is Step 2 CK: focus on the most likely diagnosis, the next best step in diagnosis or management, and the clinical reasoning for this patient.",
    3: "This is Step 3: focus on management, the next best step, prognosis, prevention and screening — what to do for this patient, and in what order."
  };

  // How it went, in the student's own words -- from "How did that go?".
  const FEELING = {
    knew: "I knew it",
    narrowed: "I narrowed it down to two",
    guessed: "I guessed",
    noknow: "I didn't know it",
    misread: "I misread the question or missed a clue",
    reasoning: "I knew the facts but reasoned my way to the wrong answer",
    torn: "I was torn between two choices",
    time: "I ran out of time",
    noidea: "I had no idea"                // ratings saved before 1.5
  };
  const UNSURE = { narrowed: 1, guessed: 1, noidea: 1 };

  // Rules every prompt ends with: they keep the assistant on the question, on
  // the answer key, and short.
  function rules(ctx) {
    return [
      "Rules:",
      "- The correct answer given below is the official answer. Treat it as correct; don't argue with it.",
      "- Base your reasoning on the question and explanation below. Don't invent findings that aren't there. If you add outside knowledge, keep it standard and board-relevant.",
      "- If my answer says \"not detected\", tell me so and don't guess what I picked.",
      "- Be high-yield: short headings and bullet points, no filler, and don't just repeat the explanation back to me.",
      "- " + (FOCUS[ctx.step] || "Focus on the reasoning that leads to the answer.")
    ].join("\n");
  }

  function situation(parts, ctx) {
    const r = parts.result;
    const f = ctx.conf;
    if (r === "incorrect") return "wrong";
    if (r === "omitted") return "omitted";
    if (r === "correct") return f && UNSURE[f] ? "unsure" : "right";
    return "unknown";
  }

  // ---- the presets ----------------------------------------------------------
  // Few on purpose: each answers a different need, and each is a complete
  // brief, so the assistant doesn't have to guess what a student wants.
  const PRESETS = [
    {
      key: "full",
      label: "Full review",
      hint: "The reasoning, your mistake, every choice, what to remember",
      build(parts, ctx) {
        const sit = situation(parts, ctx);
        const mine = {
          wrong: "5. Why my answer was wrong — why it looked tempting, the exact clue that rules it out, and what you would expect to see if my answer were right. Name my error type (knowledge gap, misread a clue, reasoning error, or torn between two) and give me one short rule that would stop me repeating it.",
          unsure: "5. I got it right but I wasn't sure (" + (FEELING[ctx.conf] || "unsure") + "). Show me what should have made me certain, and the single clue that separates the correct answer from the choice I was hesitating over.",
          right: "5. I got it right. Confirm the reasoning in two lines, then name the distractor most students pick and why it's wrong.",
          omitted: "5. I didn't answer this one. Show me how to get to the answer quickly, and which clue to look for first.",
          unknown: "5. Name the most tempting wrong answer and why it's wrong."
        }[sit];
        return [
          "You are an expert USMLE tutor. Review this question I just did and teach me the reasoning, not just the answer.",
          "",
          "1. What it tests — one line: the concept or decision the question is built on.",
          "2. Key clues — the 3 to 6 findings that matter. For each, what it points to. Mark the decisive clue.",
          "3. How to solve it — the path from the stem to the answer, step by step, the way an expert would reason it.",
          "4. Why the correct answer is right — the mechanism or rule, and why it beats the closest distractor.",
          mine,
          "6. The other choices — one line each: when it would be the answer, and the clue against it here.",
          "7. Take-home — the one or two things to remember, one line each."
        ].join("\n");
      }
    },
    {
      key: "mistake",
      label: "Why I got it wrong",
      hint: "Why your answer was tempting, and how not to repeat it",
      build(parts, ctx) {
        const sit = situation(parts, ctx);
        const open = {
          wrong: "I got this question wrong. Analyse my mistake like a tutor who wants me never to make it again.",
          unsure: "I got this right, but " + (FEELING[ctx.conf] || "I wasn't sure") + ", so treat it as a mistake I got lucky on. Analyse it like a tutor who wants me to be certain next time.",
          right: "I got this right. Check that my reasoning would hold if the question were harder, and show me where students usually go wrong.",
          omitted: "I didn't answer this question. Show me where I would most likely have gone wrong, and how to avoid it.",
          unknown: "Analyse the most likely mistake on this question, like a tutor who wants me never to make it."
        }[sit];
        return [
          open,
          "",
          "1. Why my answer looked right — what in the stem, or in what I know, made it tempting.",
          "2. What rules it out — the specific clue(s) in the stem against it, and what I would expect to see if it were correct.",
          "3. Correct vs. mine — the one feature that decides between them, in one sentence.",
          "4. My error type — knowledge gap, misread or missed a clue, reasoning error, or torn between two — and why you think so." +
            (ctx.conf && FEELING[ctx.conf] ? " (My own read: " + FEELING[ctx.conf] + ".)" : ""),
          "5. The fix — one short, specific rule for next time, and what exactly to review.",
          "6. The same trap again — a two-line variant of this question that tests the same distinction, with its answer."
        ].join("\n");
      }
    },
    {
      key: "choices",
      label: "Compare the choices",
      hint: "Every option, what makes it right or wrong, and mine vs. correct",
      build(parts, ctx) {
        return [
          "Go through every answer choice so that I can tell them apart on the exam.",
          "",
          "For each choice, in order:",
          "- What it is, or what it would be the answer to.",
          "- Right or wrong for this patient, and the deciding clue.",
          "- If wrong: \"It would be correct if…\" — the change in the stem that would make it the answer.",
          "",
          "Then a short table comparing the correct answer with " +
            (situation(parts, ctx) === "wrong" ? "my answer" : "the most tempting distractor") +
            ": the 3 to 5 features that separate them. End with the single best discriminating feature."
        ].join("\n");
      }
    },
    {
      key: "hy",
      label: "High-yield points",
      hint: "The topic's high-yield points, arranged for review",
      build() {
        return [
          "Arrange the high-yield points of this question's topic, the way I would want them for a final review before the exam.",
          "",
          "- Start with the core concept in one line.",
          "- Group the points under short headings that fit this topic (for example: pathophysiology, presentation, diagnosis, labs or imaging, treatment, adverse effects, complications, associations). Use only the headings that matter here.",
          "- Order the points from most to least tested, and mark the three most tested with ★.",
          "- Include the look-alikes the exam likes to contrast with it, and how to tell them apart.",
          "- Note any classic trap or exception.",
          "Keep each point to one line."
        ].join("\n");
      }
    },
    {
      key: "quiz",
      label: "Quiz me",
      hint: "Five questions, one at a time, to check you really get it",
      build() {
        return [
          "Quiz me on this question's concept to check that I really understand it.",
          "",
          "- Ask me ONE question at a time, and wait for my answer before going on.",
          "- Five questions, getting harder: a recall question; a mechanism question; a \"what if the stem changed\" question; one that makes me tell it apart from its look-alike; then a short new USMLE-style vignette with answer choices.",
          "- After each answer: say whether I'm right, correct me briefly, and give the key point in one or two lines.",
          "- At the end, sum up what I know well and what I should review.",
          "Start with question 1 now. Don't reveal any answers in advance."
        ].join("\n");
      }
    }
  ];
  const CUSTOM = { key: "custom", label: "My own prompt", hint: "The prompt you wrote in the Mnestic popup" };

  function preset(key) { return PRESETS.find((p) => p.key === key) || (key === CUSTOM.key ? CUSTOM : null); }

  // Did you write a prompt of your own? Before 1.5 the popup's prompt box came
  // filled with a built-in text; that one doesn't count.
  function hasOwnPrompt(customPrompt, builtInDefault) {
    const own = String(customPrompt || "").trim();
    return !!own && own !== String(builtInDefault || "").trim();
  }
  // The preset one click uses. Someone who wrote their own prompt before 1.5
  // keeps getting it; everyone else gets the full review. "My own prompt"
  // with the prompt since emptied falls back to the full review.
  function defaultPreset(stored, customPrompt, builtInDefault) {
    const own = hasOwnPrompt(customPrompt, builtInDefault);
    if (stored === CUSTOM.key) return own ? CUSTOM.key : "full";
    if (stored && preset(stored)) return stored;
    return own ? CUSTOM.key : "full";
  }

  // ---- the question block ---------------------------------------------------
  function choiceLine(c, parts) {
    let line = c.letter + ". " + c.text;
    const tags = [];
    if (parts.mine && c.letter === parts.mine) tags.push("my answer");
    if (parts.correct && c.letter === parts.correct) tags.push("correct answer");
    if (tags.length) line += "   ← " + tags.join(", ");
    return line;
  }
  function choiceText(parts, letter) {
    const c = (parts.choices || []).find((x) => x.letter === letter);
    return c ? letter + ". " + c.text : letter;
  }
  function questionBlock(parts, ctx) {
    const out = [];
    const exam = EXAM[ctx.step] || "USMLE";
    out.push("=== QUESTION (" + exam + ") ===");
    if (parts.stem) out.push(parts.stem);
    if (parts.choices && parts.choices.length) {
      out.push("", "Answer choices:");
      parts.choices.forEach((c) => out.push(choiceLine(c, parts)));
    }
    if (!parts.stem && !(parts.choices && parts.choices.length) && parts.fallback) out.push(parts.fallback);
    out.push("", "=== MY ATTEMPT ===");
    out.push("My answer: " + (parts.mine ? choiceText(parts, parts.mine) : (parts.result === "omitted" ? "none (omitted)" : "not detected")));
    out.push("Correct answer: " + (parts.correct ? choiceText(parts, parts.correct) : "not detected"));
    out.push("Result: " + ({ correct: "correct", incorrect: "incorrect", omitted: "omitted" }[parts.result] || "not detected"));
    if (ctx.conf && FEELING[ctx.conf]) out.push("How it went: " + FEELING[ctx.conf]);
    if (parts.explanation) out.push("", "=== EXPLANATION (from the question bank) ===", parts.explanation);
    return out.join("\n");
  }

  // The whole clipboard text: the prompt, its rules, then the question.
  // ctx: { step: 1|2|3|null, conf: a FEELING key or null, custom: string }
  function compose(parts, key, ctx) {
    ctx = ctx || {};
    parts = parts || {};
    const p = preset(key) || PRESETS[0];
    let prompt;
    if (p.key === CUSTOM.key) prompt = String(ctx.custom || "").trim();
    else prompt = p.build(parts, ctx) + "\n\n" + rules(ctx);
    return (prompt ? prompt + "\n\n" : "") + questionBlock(parts, ctx);
  }

  // Page text minus a qbank player's furniture: the block's question-number
  // list ("1" … "40"), "Item 20 of 40", the toolbar labels, timers. Only for
  // when the question couldn't be read in parts.
  const FURNITURE = /^(\d{1,3}|item \d+ of \d+|question id:?\s*\d*|mark(ed)?|previous|next|full screen|shortcuts|marker|lab values|notes|calculator|settings|explanation:?|consult ai tutor|end (review|block)|medical library|notebook|flashcards|feedback|test id:?.*|(review|tutor|timed)\s*-.*|block time.*|\d{1,2}\s*min(s)?\s*\d{1,2}\s*sec(s)?|time spent|answered correctly|version|\d{4})$/i;
  function stripFurniture(text) {
    return String(text || "").split("\n").map((l) => l.trim())
      .filter((l) => l && !FURNITURE.test(l))
      .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const api = { PRESETS, CUSTOM, preset, defaultPreset, hasOwnPrompt, compose, stripFurniture };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).ai = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
