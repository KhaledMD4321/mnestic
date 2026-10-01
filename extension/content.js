// Mnestic — content script.
//
// Runs on a supported question bank (Coursology, UWorld) and links each
// question to your AnKing cards by
// building a local Anki tag search (#AK_Step<n>_v*::#UWorld::*::<qid>) and
// sending it to the Mnestic Bridge add-on (via background.js).
//
// Layout of this file:
//   • SITE adapters — every site-specific DOM selector lives in one object per
//     qbank (COURSO, UWORLD); SITE is the one matching this tab's host.
//   • FEATURE 1  — results-page buttons (Missed / All / Marked / High-Yield).
//   • FEATURE 2  — review-page resource panel + F/S/P/E/A image overlay.
//   • FEATURE 2b — review-page note-taking (Copy Q, Preview, Save to Missed Qs).
//   • FEATURE 3  — study logging (per-question; the tracker UI is in the popup).
//   • Expected Score (beta) — preparedness estimate from card maturity.
//   • main loop — a 1s interval that injects/updates the UI as the SPA changes.
//
// All injected DOM uses ids/classes prefixed "mnx-" so it's easy to exclude.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE. No warranty, to the extent
// permitted by law.
(() => {
  "use strict";
  const BTN_HOST_ID = "mnx-buttons";
  const PANEL_ID = "mnx-resources";
  const OVERLAY_ID = "mnx-overlay";
  const SUMMARY_ID = "mnx-summary";
  // Pure logic, loaded before this file (see manifest) and unit-tested on its
  // own: calendar days, tracker math, matching/ranking, tag parsing, weak
  // areas, cloze text.
  const { dates: Dt, tracker: Trk, match: Mt, tags: Tg, weak: Wk, cards: Cd } = globalThis.Mnx;
  const { safeQid, safeQidOrNull, qidQuery, qidQueryLoose } = Mt;

  // ---------- talk to Anki via the background worker (the Mnestic Bridge) ----------
  // Rejects with an Error that also carries `code` (see background.js), so a
  // caller can tell "Anki is closed" from "not paired" from "timed out". It
  // stringifies to the bare message, as the plain strings it replaced did.
  function bridgeError(message, code) {
    const e = new Error(String(message || "unknown error"));
    e.code = code || "anki";
    e.toString = () => e.message;
    return e;
  }
  function bridge(op, args) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "bridge", op, args: args || {} }, resp => {
          // The extension was reloaded or updated under this tab: its old
          // content script can no longer reach the worker.
          if (chrome.runtime.lastError) return reject(bridgeError(chrome.runtime.lastError.message, "reload"));
          if (!resp || !resp.ok) return reject(bridgeError(resp && resp.error, resp && resp.code));
          resolve(resp.data);
        });
      } catch (e) {
        reject(bridgeError(String(e), "reload"));
      }
    });
  }
  // What to tell someone when a call to Anki fails. Never a stack trace.
  function bridgeFailure(e) {
    const code = e && e.code;
    if (code === "offline") return "Anki isn't running, or the Mnestic Bridge add-on isn't installed.";
    if (code === "auth") return "Mnestic isn't paired with this Anki. Open the Mnestic popup and paste the pairing code.";
    if (code === "timeout") return "Anki didn't answer in time. It may be busy (syncing, or a dialog is open).";
    if (code === "old-addon") return "Update the Mnestic Bridge add-on in Anki (Tools → Add-ons → Check for Updates).";
    if (code === "reload") return "Mnestic was updated. Reload this page to reconnect.";
    if (code === "refused") return "Anki refused that request (" + ((e && e.message) || "") + ").";
    return "Anki reported an error: " + ((e && e.message) || e);
  }
  // Step (1/2/3) for the AnKing tag. Prefer the step baked into the Coursology
  // URL (/qbanks/usmle2/...) so it follows you across Step 1/2/3 automatically;
  // fall back to the popup's Step selector when the URL doesn't say.
  function detectStepFromUrl() {
    let n = null;
    try { n = SITE.stepFromUrl(); } catch (e) {}
    if (!n) {
      const path = location.pathname + " " + location.href;
      const m = path.match(/step[\s_-]*(\d)/i)        // ...step2... / step-3
             || path.match(/usmle[\s_-]*(\d)/i);      // usmle 1
      if (m) n = parseInt(m[1], 10);
    }
    return (n >= 1 && n <= 3) ? n : null;
  }
  // The step a question actually matched on is part of its session (Q.sv,
  // below). The popup's Step selector and the URL are only guesses — what
  // matters is which step's tags the deck really has for this id, and every
  // follow-up call (open in Anki, card status, unsuspend) must use the same one.
  let stepBySlug = {};
  chrome.storage.local.get({ mnxStepBySlug: {} }, c => { stepBySlug = c.mnxStepBySlug || {}; });
  // Find the notes for a question, trying the likeliest step first and falling
  // back to the others. Before this, a Step 2 student whose URL didn't say so
  // got "No AnKing resources found" on every single question, with no clue why.
  //
  // Only the PRECISE tag shapes are tried here. UWorld question ids don't repeat
  // across Steps (checked against a full AnKing deck), so finding one under
  // Step 2 is the same question. The old "::*::" wildcard is different: it also
  // matches COMLEX ids, which DO collide -- so it only runs when you ask for a
  // broader search (broad = true), and the panel then says the match is approximate.
  async function resolveNotes(qid, broad) {
    const slug = currentQbankSlug();
    let detected = 1;
    try { detected = await getSv(); } catch (e) {}
    const order = [];
    const add = v => { v = +v; if (v >= 1 && v <= 3 && order.indexOf(v) < 0) order.push(v); };
    add(detected); add(stepBySlug[slug]); add(1); add(2); add(3);
    const remember = sv => {
      if (sv !== detected && stepBySlug[slug] !== sv) {
        stepBySlug[slug] = sv;                         // remember for this qbank
        chrome.storage.local.set({ mnxStepBySlug: stepBySlug });
      }
    };
    const builders = broad ? [qidQuery, qidQueryLoose] : [qidQuery];
    for (const build of builders) {
      for (const sv of order) {
        const query = build(qid, sv);
        let nids;
        try { nids = await bridge("searchNotes", { query }); }
        catch (e) { return { nids: [], sv: detected, error: e, tried: order }; }
        if (nids && nids.length) {
          remember(sv);
          return { nids, sv, query, error: null, tried: order, detected,
                   otherStep: sv !== detected, loose: build === qidQueryLoose };
        }
      }
    }
    return { nids: [], sv: detected, query: qidQuery(qid, detected), error: null, tried: order, detected, broad: !!broad };
  }
  function getSv() {
    const urlStep = detectStepFromUrl();
    if (urlStep) return Promise.resolve(urlStep);
    return new Promise(r => chrome.storage.local.get({ sv: 1 }, c => r(c.sv)));
  }

  // ============================================================
  // COURSOLOGY ADAPTER — all site-specific DOM selectors live here, so porting
  // to another qbank (or surviving a Coursology redesign) only touches this one
  // object. Coursology reuses UWorld's question IDs, so the AnKing tag query is
  // all the matching logic there is — any source of that question ID works.
  // Verified against the live DOM on 2026-06-14/15: the results-table parser,
  // the Question List modal parser, the review-page QID read, the spoiler-safe
  // gate (#question-explanation), and the panel anchor.
  // ============================================================
  const DEBUG = false; // set true to log what the results parser finds
  function dlog() { if (DEBUG) { try { console.log("[mnestic]", ...arguments); } catch (e) {} } }

  // Parse a results/score table into [{qid, wrong, marked}]. Site-agnostic on
  // purpose — every qbank we've seen either renders a real <table> with an "ID"
  // header column, or a list of rows starting with a status icon + the number —
  // so a new adapter can usually just reuse this.
  //
  // Only ever called on a page the adapter says IS a results page (see the
  // main loop). It used to run everywhere, and its row fallback read any
  // <li> or row that began with a number as a question id: an explanation's
  // "5-alpha reductase…" bullet, or the scores ("55%") in Coursology's list of
  // previous tests, which a click could then send to Anki as question ids.
  // The fallback now takes table-like rows only, and only ones carrying a
  // right/wrong mark.
  function genericResultRows() {
    const rows = [];
    const seen = new Set();
    const push = (qid, wrong, marked) => {
      if (!qid || seen.has(qid)) return;
      seen.add(qid); rows.push({ qid, wrong, marked });
    };
    const loc = findIdColumn();
    if (loc) {
      loc.bodyRows.forEach(tr => {
        const cell = tr.children[loc.index];
        if (!cell) return;
        const m = (cell.textContent || "").match(/\d+/);
        if (!m) return;
        push(m[0], rowIsWrong(tr, cell), rowIsMarked(tr));
      });
    }
    if (rows.length) { dlog("resultRows via table", rows.length); return rows; }
    document.querySelectorAll('[role="row"], tr, mat-row').forEach(tr => {
      if (tr.closest("[id^='mnx-']")) return;
      const m = ((tr.textContent || "").trim()).match(/^[✓✔✗✕×x]?\s*(\d{1,6})(?![\d%.,])\b/);
      if (m && rowHasOutcome(tr)) push(m[1], rowIsWrong(tr, tr), rowIsMarked(tr));
    });
    dlog("resultRows via fallback", rows.length);
    return rows;
  }

  const COURSO = {
    // ---- REVIEW PAGE (per question) ----
    // The player header renders "Question Id: 2"; findQid() reads it. Confirmed
    // present in document.body on the live review page. Listed scopes are tried
    // first (narrower = cheaper); body is the reliable fallback.
    headerSel: [".question-header", "header", "body"],
    // Only reveal resources once the answer/explanation is visible, so we never
    // spoil an unanswered question. Confirmed: the right-hand explanation column
    // is <div id="question-explanation">, which only has height once shown
    // (the footer's "REVIEW" text is CSS-uppercased, so we don't rely on it).
    isReviewing() {
      const ex = document.querySelector("#question-explanation");
      return !!(ex && ex.offsetHeight > 1);
    },
    // Anchor the resource panel inside the explanation column (confirmed id);
    // null -> it floats bottom-right.
    panelAnchor() {
      return document.querySelector("#question-explanation, #questionInformation");
    },
    // The central content column holding the question stem, the answer choices,
    // and the explanation - used by "Copy full Q". Best-effort: a real <main> if
    // the SPA exposes one, else climb from #question-explanation to the ancestor
    // that also picks up the stem/choices without ballooning to the whole shell.
    contentRoot() {
      const explicit = document.querySelector("main, [role='main']");
      if (explicit) return explicit;
      const ex = document.querySelector("#question-explanation");
      if (!ex) return null;
      const exLen = (ex.innerText || "").length || 1;
      let node = ex.parentElement, chosen = ex;
      for (let i = 0; i < 10 && node && node !== document.body; i++) {
        const len = (node.innerText || "").length;
        if (len > exLen * 8) break;       // too big (app shell) - keep previous
        chosen = node;
        if (len > exLen * 1.4) break;      // now includes the stem + choices
        node = node.parentElement;
      }
      return chosen;
    },

    // ---- RESULTS PAGE (the score table) ----
    // Container for the "Anki: Missed / All / Marked" buttons. Coursology has no
    // obvious inline anchor, so this returns null and a floating bar is used.
    toolbar() {
      return document.querySelector(".test-performance-top-div, .results-actions, .test-results-header");
    },
    // Confirmed on the live DOM: a real <table> with an "ID" header column; the
    // row's status icon is svg.fa-xmark.text-red-500 (wrong) /
    // svg.fa-check.text-lime-500 (right). Marked questions aren't flagged in the
    // results table (only in the player), so "Anki: Marked" stays empty here.
    // genericResultRows handles both shapes.
    resultRows() { return genericResultRows(); },

    // ---- identity / URL shape ----
    id: "coursology",
    label: "Coursology",
    hostRe: /(^|\.)coursology-qbank\.com$/i,
    // "Question Id: 2" in the player header.
    qidRe: [/Question\s*Id\s*[:#]?\s*(\d+)/i],
    explanationRoot() { return document.querySelector("#question-explanation"); },
    stepFromUrl() {
      const m = (location.pathname + " " + location.href).match(/\/qbanks\/[^/]*?(\d)/i);
      return m ? +m[1] : null;
    },
    // Per-qbank key for the tracker's dashboard totals.
    blockSlug() { const m = location.pathname.match(/\/qbanks\/([^/]+)/i); return m ? m[1].toLowerCase() : "default"; },
    // Coursology also hosts banks that are NOT UWorld's questions -- NBME
    // forms, self-assessments, other publishers -- on the same site. AnKing only
    // tags UWorld ids, so a number from one of those banks could only ever
    // match an unrelated card. Those banks are skipped and the panel says why.
    questionSource() {
      const slug = this.blockSlug();
      if (/nbme|uwsa|self[-_]?assess|mehlman|amboss|kaplan|truelearn|mrcp|plab|free[-_]?120|comlex|shelf/i.test(slug)) return "other";
      return slug === "default" ? "unknown" : "uworld";
    },
    inTest() { return /\/qbanks\//i.test(location.pathname); },
    // Figures behind a pill in the explanation ("transient tachypnea of the
    // newborn"): the site fetches each with its own logged-in request when the
    // pill is pressed. Mnestic presses the site's own button when you ask for
    // the figure, takes the image it shows, and closes the site's viewer again
    // -- it never reads or reuses the site's login.
    exhibits() {
      const ex = document.querySelector("#question-explanation");
      if (!ex) return [];
      return Array.from(ex.querySelectorAll("button[id^='exhibit-']"))
        .map(b => ({ label: (b.innerText || "").replace(/\s+/g, " ").trim(), open: () => openSiteExhibit(b) }))
        .filter(x => x.label);
    },
    isResultsPage() { return /\/results\b/i.test(location.pathname); },
    isDashboard() { return /welcome|dashboard|performance|home/i.test(location.pathname); },
    expandsResults: true,            // its results table paginates at 10
    usesGenericQuestionList: true    // its "Question List" modal carries the legend
  };

  // Press a qbank's own figure button and return the image it opens (see
  // COURSO.exhibits). Waits up to 6 s for an image from the qbank's own host
  // that wasn't on the page before; then closes the viewer the site opened.
  const QBANK_IMG = /^https:\/\/([a-z0-9-]+\.)*coursology-qbank\.com\//i;
  async function openSiteExhibit(btn) {
    const srcOf = im => im.currentSrc || im.src || "";
    const before = new Set(Array.from(document.querySelectorAll("img")).map(srcOf));
    const label = (btn.innerText || "").trim().toLowerCase();
    btn.click();
    let img = null;
    for (let i = 0; i < 60 && !img; i++) {
      await new Promise(r => setTimeout(r, 100));
      img = Array.from(document.querySelectorAll("img")).find(im =>
        QBANK_IMG.test(srcOf(im)) && !before.has(srcOf(im)) && !im.closest("[id^='mnx-']"));
    }
    // Already open before we pressed it: the viewer titled with this figure.
    if (!img) {
      img = Array.from(document.querySelectorAll("img")).find(im => {
        if (!QBANK_IMG.test(srcOf(im)) || im.closest("[id^='mnx-']") || !im.getClientRects().length) return false;
        const win = fixedAncestor(im);
        return !!win && (win.innerText || "").trim().toLowerCase().indexOf(label) === 0;
      }) || null;
    }
    if (!img) throw new Error("the figure didn't open");
    const src = srcOf(img);
    const win = fixedAncestor(img);
    const close = win && Array.from(win.querySelectorAll("button")).find(b => /(^|\s)bg-red-\d/.test(String(b.className)));
    if (close) close.click();
    return src;
  }
  function fixedAncestor(el) {
    for (let n = el, k = 0; n && k < 14; n = n.parentElement, k++) {
      if (getComputedStyle(n).position === "fixed") return n;
    }
    return null;
  }

  // ============================================================
  // UWORLD ADAPTER
  // ------------------------------------------------------------
  // UWorld is the deck's own source, so the tag query is identical — only the
  // DOM differs. Its markup uses generated class names that change between
  // releases, so nothing here keys off a class: we find things by *shape*
  // (a visible "Explanation" region, a "Question Id"-style label, a table with
  // an ID column). That is slower than a fixed selector but survives redesigns.
  //
  // The selectors in UW below are facts about UWorld's own pages, cross-checked
  // across several public tools that read those same pages (notably
  // github.com/omn0mn0m/UWorldToAnking, GPLv3). No code from any of them is
  // used here — this adapter is our own, and every selector has a heuristic
  // fallback so a UWorld redesign degrades instead of breaking.
  //
  // Still UNVERIFIED against a live account. The popup's "Check this page"
  // button reports what was actually found, for exactly this reason.
  // ============================================================
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  // The smallest visible element that looks like the explanation region: it
  // holds an "Explanation" heading and a decent amount of text. Cached per tick
  // because it walks the DOM.
  let explCache = { t: 0, el: null };
  function findExplanationRegion() {
    const now = Date.now();
    if (now - explCache.t < 700) return explCache.el;
    let best = null;
    const byAttr = document.querySelector("[id*='explanation' i], [class*='explanation' i], [data-testid*='explanation' i]");
    if (byAttr && visible(byAttr)) best = byAttr;
    if (!best) {
      // Find a heading that reads "Explanation", then take its container.
      const heads = document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'],strong,b,span,div");
      for (const h of heads) {
        if (h.children.length) continue;
        if (!/^\s*explanation\s*$/i.test(h.textContent || "")) continue;
        let node = h.parentElement;
        for (let i = 0; i < 6 && node && node !== document.body; i++) {
          if ((node.innerText || "").length > 400) { best = node; break; }
          node = node.parentElement;
        }
        if (best) break;
      }
    }
    if (best && !visible(best)) best = null;
    explCache = { t: now, el: best };
    return best;
  }

  // UWorld's player is an Angular + Angular Material app (mat-dialog,
  // ng-star-inserted, <common-content>). These are the stable hooks in it:
  const UW = {
    qid: "span.question-id, .question-id",         // text: "Question Id: 12345"
    explanation: "#explanation-container, #first-explanation",
    right: ".right-content, div.question-content.right-content",
    content: "common-content, .common-content",
    header: ".nbme-header, [class*='nbme-header']",
    stats: ".stats-bar[role='alert'], .stats-bar",  // appears once answered
    qbName: ".qb-name",                             // e.g. "USMLE STEP1"
    listDialog: ".question-list-dialog"             // mat-dialog of all QIDs
  };

  const UWORLD = {
    id: "uworld",
    label: "UWorld",
    hostRe: /(^|\.)uworld\.com$/i,
    qidRe: [
      /Question\s*Id\s*[:#]?\s*(\d+)/i,
      /\bQ\s*Id\s*[:#]?\s*(\d+)/i,
      /\bItem\s*Id\s*[:#]?\s*(\d+)/i
    ],
    headerSel: [UW.qid, UW.header, "header", "[class*='header' i]", "body"],

    // The id lives in its own element, so read it directly and just keep the
    // digits — the label around them ("Question Id: ") has varied. Falls back
    // to the shared header+regex scan when the element isn't there.
    findQid() {
      const el = document.querySelector(UW.qid);
      if (!el) return null;
      const digits = (el.textContent || "").replace(/[^\d]/g, "");
      return digits.length >= 2 && digits.length <= 8 ? digits : null;
    },

    explanationRoot() {
      const el = document.querySelector(UW.explanation) || document.querySelector(UW.right);
      if (el && visible(el)) return el;
      return findExplanationRegion();          // heuristic, if UWorld renames things
    },
    // Reviewing = the explanation is actually on screen. True in tutor mode once
    // you answer and in end-of-block review; false on an unanswered question —
    // which is exactly the spoiler gate, so this stays conservative.
    isReviewing() { return !!this.explanationRoot(); },
    panelAnchor() { return this.explanationRoot(); },
    contentRoot() {
      const own = document.querySelector(UW.content);
      if (own && visible(own)) return own;
      const explicit = document.querySelector("main, [role='main']");
      if (explicit && visible(explicit)) return explicit;
      const ex = this.explanationRoot();
      if (!ex) return null;
      const exLen = (ex.innerText || "").length || 1;
      let node = ex.parentElement, chosen = ex;
      for (let i = 0; i < 10 && node && node !== document.body; i++) {
        const len = (node.innerText || "").length;
        if (len > exLen * 8) break;
        chosen = node;
        if (len > exLen * 1.4) break;
        node = node.parentElement;
      }
      return chosen;
    },
    // The player header is a flex row we'd have to fight for space in, so the
    // results buttons use the floating bar.
    toolbar() { return null; },
    // UWorld's ID cells read like "Block 3 - 12345", so the last number in the
    // cell is the id — genericResultRows takes the first. Parse the table here
    // and only fall back to the generic scan.
    resultRows() {
      const loc = findIdColumn();
      if (loc) {
        const rows = []; const seen = new Set();
        loc.bodyRows.forEach(tr => {
          const cell = tr.children[loc.index];
          if (!cell) return;
          const nums = (cell.textContent || "").match(/\d+/g);
          if (!nums) return;
          const qid = nums[nums.length - 1];
          if (seen.has(qid)) return;
          seen.add(qid);
          rows.push({ qid, wrong: rowIsWrong(tr, cell), marked: rowIsMarked(tr) });
        });
        if (rows.length) return rows;
      }
      return genericResultRows();
    },
    // The "question list" dialog lists every id of the block, comma-separated.
    // Status isn't carried there, so these feed "Anki: All" only.
    questionListRows() {
      const dlg = document.querySelector(UW.listDialog);
      if (!dlg) return null;
      const text = dlg.textContent || "";
      const ids = text.match(/\b\d{3,8}\b/g);
      if (!ids || ids.length < 2) return null;
      const seen = new Set(); const rows = [];
      ids.forEach(qid => { if (!seen.has(qid)) { seen.add(qid); rows.push({ qid, wrong: false, correct: false, omitted: false, marked: false }); } });
      return rows;
    },

    stepFromUrl() {
      const m = (location.pathname + " " + location.search).match(/step[\s_-]*(\d)/i);
      if (m) return +m[1];
      // The qbank label reads like "USMLE STEP1" / "USMLE Step 2 CK".
      const qb = document.querySelector(UW.qbName);
      if (qb) { const s = (qb.textContent || "").match(/step\s*(\d)/i); if (s) return +s[1]; }
      for (const el of document.querySelectorAll("header, nav, [class*='header' i], [class*='course' i]")) {
        const t = (el.textContent || "").slice(0, 300);
        const s = t.match(/step\s*(\d)/i);
        if (s) return +s[1];
      }
      return null;
    },
    blockSlug() { return "uworld"; },
    questionSource() { return "uworld"; },
    // UWorld's test player is its own view; be permissive rather than guess a path.
    inTest() { return true; },
    // A results URL, or a table with an "ID" column -- never "some row starts
    // with a number", which a question's own explanation can satisfy.
    isResultsPage() {
      if (/result|review|performance/i.test(location.pathname + location.search)) return true;
      return !!findIdColumn();
    },
    isDashboard() { return /courseapp|dashboard|performance|home|welcome/i.test(location.pathname); },
    expandsResults: false,           // .cbt-nav-btn items are numbered — never click one
    usesGenericQuestionList: false   // it has its own dialog, parsed above
  };

  // ============================================================
  // MEDPARK ADAPTER  (medpark.io)
  // ------------------------------------------------------------
  // MedPark reuses UWorld's question ids and labels them "UW Id: 19633", so the
  // tag query is unchanged. Unlike UWorld it ships readable, semantic class
  // names, so this adapter is exact rather than heuristic.
  //
  // Verified against the live site on 2026-09-14, including the spoiler gate:
  //   unanswered -> section.explanation-area            (height 0)
  //   answered   -> section.explanation-area.visible    (height 418)
  //   and question-area gains .has-explanation only once answered.
  //
  // MedPark has no end-of-block table of question ids (its Test Summary is
  // totals only), so resultRows() is empty by design and the results-page
  // buttons simply don't appear there. Per-question features are the point here.
  // ============================================================
  const MP = {
    page: "div.test-page",
    header: "header.exam-header",
    expl: "section.explanation-area.visible",
    explAny: "section.explanation-area",
    content: "main.exam-content",
    marked: "input.header-mark-checkbox"
  };

  const MEDPARK = {
    id: "medpark",
    label: "MedPark",
    hostRe: /(^|\.)medpark\.io$/i,
    qidRe: [/UW\s*Id\s*[:#]?\s*(\d+)/i, /Question\s*Id\s*[:#]?\s*(\d+)/i],
    headerSel: [MP.header, MP.page, "body"],

    // The explanation pane exists in the DOM before you answer — it just has no
    // .visible and no height. Require BOTH, so neither alone can leak an answer.
    explanationRoot() {
      const el = document.querySelector(MP.expl);
      return el && visible(el) ? el : null;
    },
    isReviewing() { return !!this.explanationRoot(); },
    panelAnchor() { return this.explanationRoot(); },
    contentRoot() {
      const el = document.querySelector(MP.content);
      return el && visible(el) ? el : this.explanationRoot();
    },
    toolbar() { return null; },
    // No per-question id table anywhere in MedPark's results.
    resultRows() { return []; },
    // ?step=1 rides along in the dashboard and player URLs.
    stepFromUrl() {
      const m = location.search.match(/[?&]step=(\d)/i);
      return m ? +m[1] : null;
    },
    // Separate tracker totals per bank (UW / AMB / MLman all live here).
    blockSlug() {
      const m = location.search.match(/[?&]qBankId=(\d+)/i);
      return m ? "medpark-" + m[1] : "medpark";
    },
    // MedPark labels UWorld questions "UW Id". Its other banks (AMBOSS,
    // Mehlman) don't use that label, and their numbers aren't UWorld ids.
    questionSource() {
      const h = document.querySelector(MP.header);
      const t = (h && h.textContent) || "";
      if (/UW\s*Id/i.test(t)) return "uworld";
      return /\b(?:AMB|AMBOSS|Mehlman|MLman)\b/i.test(t) ? "other" : "unknown";
    },
    inTest() { return !!document.querySelector(MP.page); },
    isResultsPage() { return /\/results\b/i.test(location.pathname); },
    isDashboard() { return /dashboard|welcome|performance|app/i.test(location.pathname); },
    canAttachImages: false,          // figures live on a third-party storage host
    expandsResults: false,           // .exam-sidebar .nav-btn items are numbered
    usesGenericQuestionList: false   // its stats pages use the same words; no id list exists
  };

  // ============================================================
  // ADAPTER REGISTRY
  // ------------------------------------------------------------
  // Adding another question bank = add one object here and one host to the
  // manifest (and to background.js's image allowlist). Nothing outside the
  // adapter knows which site it's on. The contract, all of it:
  //
  //   id, label, hostRe          identity + the name shown in copied text
  //   qidRe: [RegExp]            capture group 1 = the question id
  //   headerSel: [selector]      where to look for that id, cheapest first
  //   isReviewing()              true only once the answer is revealed
  //                              (this is the spoiler gate — get it right)
  //   explanationRoot()          the explanation element, or null
  //   panelAnchor()              where the resource panel mounts (null = float)
  //   contentRoot()              stem + choices + explanation, for "Copy for AI"
  //   toolbar()                  results-page button host (null = float)
  //   resultRows()               [{qid, wrong, marked}] — genericResultRows()
  //                              already handles both common table shapes
  //   stepFromUrl()              1/2/3, or null to fall back to the popup
  //   blockSlug()                key for the tracker's per-qbank totals
  //   questionSource()           "uworld" | "other" | "unknown" -- only
  //                              UWorld ids can match AnKing's tags; "other"
  //                              banks are not searched at all
  //   inTest(), isResultsPage()  which view we're on. isResultsPage() gates
  //                              resultRows(): rows are never read elsewhere
  //   isDashboard()              where the qbank prints its Used/Total totals
  //   expandsResults             opt in to clicking a 10/25/50/100 page-size
  //                              control — ONLY where no other numbered button
  //                              exists, or it will click a question number
  //   usesGenericQuestionList    opt in to the "scan any block mentioning
  //                              correct/incorrect/marked/omitted for ids" pass
  //   canAttachImages            set false when the qbank's figures are served
  //                              from a host we won't add to the allowlist
  //   exhibits()                 optional: figures behind buttons in the
  //                              explanation, [{label, open() -> image URL}]
  //
  // docs/adding-a-qbank.md walks through it.
  // ============================================================
  const SITES = [COURSO, UWORLD, MEDPARK];
  const SITE = (() => {
    const host = location.hostname;
    for (const s of SITES) if (s.hostRe.test(host)) return s;
    return COURSO;
  })();
  dlog("adapter:", SITE.id);

  // status helpers shared by the results parser
  const WRONG_CLASS_RE = /incorrect|wrong|text-danger|text-red/i;
  function rowIsWrong(row, cell) {
    if (row && row.querySelector(".fa-times, .fa-xmark, .fa-circle-xmark, i.text-danger, [class*='incorrect']")) return true;
    if (/^\s*[✗✕×]/.test(((cell || row).textContent || ""))) return true;
    return WRONG_CLASS_RE.test((row && row.className) || "");
  }
  // A results row says how the question went: a check or a cross.
  function rowHasOutcome(row) {
    if (rowIsWrong(row, row)) return true;
    if (row.querySelector(".fa-check, .fa-circle-check, [class*='correct'], .text-success")) return true;
    return /^\s*[✓✔]/.test(row.textContent || "");
  }
  function rowIsMarked(row) {
    // flag (Coursology) / star (UWorld) / bookmark — whichever the site uses
    return !!(row && row.querySelector(".fa-bookmark, .fas.fa-bookmark, .fa-flag, .fa-star, [class*='marked'], [class*='flag']"));
  }
  // Find a <table> whose header has a cell reading exactly "ID"; return that
  // column index plus the body rows.
  function findIdColumn() {
    for (const table of document.querySelectorAll("table")) {
      const heads = table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td");
      let index = -1;
      heads.forEach((h, i) => { if (index < 0 && /^\s*id\s*$/i.test(h.textContent || "")) index = i; });
      if (index < 0) continue;
      const body = Array.from(table.querySelectorAll("tbody tr"));
      return { index, bodyRows: body.length ? body : Array.from(table.querySelectorAll("tr")).slice(1) };
    }
    return null;
  }
  // Floating host for the results buttons when no native toolbar is found.
  function ensureFloatingToolbar() {
    let bar = document.getElementById("mnx-float-toolbar");
    if (bar) { placeFloatingToolbar(bar); return bar; }
    bar = document.createElement("div");
    bar.id = "mnx-float-toolbar";
    // No transition until it has been placed once: a new bar would otherwise
    // animate in from the default offset every time it is rebuilt.
    bar.style.cssText = "position:fixed;top:74px;right:16px;z-index:2147483646;display:flex;gap:8px;" +
      "background:var(--mnx-surface);padding:6px;border-radius:var(--mnx-r-sm);border:1px solid var(--mnx-border);" +
      "box-shadow:var(--mnx-shadow-sm)";
    document.body.appendChild(bar);
    placeFloatingToolbar(bar);
    return bar;
  }
  // Parked at a fixed top-right offset, the bar landed straight on top of
  // Coursology's own search box. Drop below anything it would cover.
  //
  // Measure where the bar WOULD sit rather than actually moving it there. The
  // first version wrote top=74px and then read the rect back, once a second,
  // from the main loop. That read forces a style flush, so the browser commits
  // 74px as the current value -- and the next write animates down from there
  // through the bar's own `transition: top`. The result was a visible bounce
  // every tick. The bar's left/right and height do not depend on its top, so
  // the candidate rectangle can be worked out arithmetically instead.
  const BAR_TOP = 74;
  // Is this control pinned to the viewport, or does it scroll away with the page?
  function isPinned(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") return true;
    }
    return false;
  }
  // The bar settles. Its first placement clears whatever is on screen then --
  // which is how it stopped landing on Coursology's search box -- and after that
  // it will only ever yield FURTHER DOWN, for something pinned over it.
  //
  // It used to re-dodge every control every second. A control in normal flow
  // scrolls, so its viewport position changed on every tick, the target moved
  // with it, and the bar's `transition: top` rendered the chase as a slow bounce
  // up and down. Only moving downward makes that impossible: there is no value
  // for the bar to oscillate between.
  function placeFloatingToolbar(bar) {
    const r = bar.getBoundingClientRect();
    // The bar is created empty and its buttons are added later in the loop. An
    // empty one is still ~14px each way -- padding and border -- so a width test
    // does NOT catch it, and measuring then gives a band only 14px tall that
    // misses everything the full-height bar would cover. Wait for the buttons.
    if (r.width < 10 || !bar.firstChild) return;
    const first = !bar.dataset.mnxPlaced;
    bar.dataset.mnxPlaced = "1";
    const top = BAR_TOP, bottom = BAR_TOP + r.height;
    let lowest = 0;
    for (const el of document.querySelectorAll("input,button,select,textarea,a[role=button]")) {
      if (el.closest("[id^='mnx-']")) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 8 || b.height < 8) continue;
      // Horizontal from the bar's real rect (its left/right never change);
      // vertical against where the bar WOULD sit, so this never has to move the
      // bar in order to measure it.
      const hits = b.left < r.right && b.right > r.left && b.top < bottom && b.bottom > top;
      if (!hits || b.bottom <= lowest) continue;
      if (!first && !isPinned(el)) continue;
      lowest = b.bottom;
    }
    let want = Math.round(lowest > 0 ? lowest + 10 : BAR_TOP);
    const settled = parseInt(bar.dataset.mnxTop || "", 10);
    if (!isNaN(settled) && want < settled) want = settled;      // never creep back up
    bar.dataset.mnxTop = String(want);
    // Write only on a real change: an unchanged value must not restart the
    // transition, or a once-a-second caller turns it into a jitter of its own.
    if (bar.style.top !== want + "px") bar.style.top = want + "px";
    // Animate only from here on, once it has a home to move from.
    if (first) requestAnimationFrame(() => { bar.style.transition = "top .2s ease"; });
  }

  // ---------- styles (tuned to blend with the qbank UI) ----------
  const style = document.createElement("style");
  style.textContent = `
    /* ---- Mnestic design system — one source of truth; dark flips via :root.mnx-dark ---- */
    :root{
      --mnx-accent:#6d40e0; --mnx-accent-600:#5a2fc4; --mnx-accent-700:#48249e; --mnx-accent-soft:#f1ecfc;
      --mnx-accent-ring:rgba(109,64,224,.30);
      --mnx-good:#1f9d57; --mnx-good-600:#178048; --mnx-warn:#d5891c; --mnx-bad:#dc4b45;
      --mnx-violet:#0ca5a0;
      /* The two accent BUTTONS carry their own pair, because a token that works
         as a bar or a label does not necessarily work under text. White on the
         plain warn/violet measured 2.83 and 3.04 here, and 2.10 and 1.86 in
         dark -- all under the 4.5 that body-size text needs. Light darkens the
         background; dark keeps the light background and darkens the text. */
      --mnx-hy-bg:#a46914; --mnx-on-hy:#ffffff;
      --mnx-brk-bg:#078480; --mnx-on-brk:#ffffff;
      /* good/warn/bad are tuned as FILLS. As text on our own surfaces they
         measured 3.49 / 2.83 / 4.09, so percentages and labels get their own. */
      --mnx-good-txt:#188448; --mnx-warn-txt:#a46914; --mnx-bad-txt:#ca453f;
      --mnx-save-bg:#188448; --mnx-on-save:#ffffff;
      --mnx-surface:#ffffff; --mnx-surface-2:#f4f6fb; --mnx-elev:#ffffff;
      --mnx-border:#e6e9f2; --mnx-text:#1c2333; --mnx-muted:#656d85; --mnx-ink:#232a45;
      --mnx-r:16px; --mnx-r-sm:11px; --mnx-r-xs:8px; --mnx-r-pill:999px;
      --mnx-shadow:0 20px 48px -16px rgba(38,45,90,.34), 0 6px 16px -8px rgba(38,45,90,.18);
      --mnx-shadow-sm:0 2px 8px rgba(38,45,90,.12);
      --mnx-shadow-btn:0 5px 14px -4px rgba(109,64,224,.45);
      --mnx-font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,Arial,sans-serif;
    }
    :root.mnx-dark{
      --mnx-accent:#a48bff; --mnx-accent-600:#957aff; --mnx-accent-700:#8266f0; --mnx-accent-soft:#2a2450;
      --mnx-accent-ring:rgba(164,139,255,.34);
      --mnx-good:#3fbf78; --mnx-good-600:#35a95c; --mnx-warn:#e2a94a; --mnx-bad:#f0665e;
      --mnx-violet:#2dd4bf;
      --mnx-hy-bg:#e2a94a; --mnx-on-hy:#2a1c05;
      --mnx-brk-bg:#2dd4bf; --mnx-on-brk:#04302c;
      /* on a dark ground these already clear 4.5 as text, so they stay */
      --mnx-good-txt:#3fbf78; --mnx-warn-txt:#e2a94a; --mnx-bad-txt:#f0665e;
      --mnx-save-bg:#3fbf78; --mnx-on-save:#04240f;
      --mnx-surface:#161a26; --mnx-surface-2:#1e2436; --mnx-elev:#212842;
      --mnx-border:#333c56; --mnx-text:#e8ecf6; --mnx-muted:#98a2bd; --mnx-ink:#f0f3fb;
      --mnx-shadow:0 24px 60px -18px rgba(0,0,0,.62), 0 8px 20px -10px rgba(0,0,0,.5);
      --mnx-shadow-sm:0 2px 8px rgba(0,0,0,.42);
      --mnx-shadow-btn:0 6px 16px -4px rgba(0,0,0,.5);
    }
    @keyframes mnx-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes mnx-pop{from{opacity:0;transform:scale(.965) translateY(6px)}to{opacity:1;transform:none}}
    @keyframes mnx-toast-in{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}

    #${BTN_HOST_ID}{display:inline-flex;gap:8px;margin-left:8px;vertical-align:middle}
    .mnx-btn{background:linear-gradient(180deg,var(--mnx-accent),var(--mnx-accent-600));color:#fff;border:none;border-radius:var(--mnx-r-sm);padding:8px 16px;font:600 13.5px/1.2 var(--mnx-font);letter-spacing:-.01em;cursor:pointer;box-shadow:var(--mnx-shadow-btn),inset 0 1px 0 rgba(255,255,255,.18);transition:transform .16s cubic-bezier(.2,.7,.3,1),box-shadow .16s,filter .16s}
    .mnx-btn:hover{filter:brightness(1.04);transform:translateY(-1px)}
    .mnx-btn:active{transform:translateY(0) scale(.985)}
    .mnx-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring),var(--mnx-shadow-btn)}
    .mnx-hy{background:var(--mnx-hy-bg);color:var(--mnx-on-hy);box-shadow:0 5px 14px -4px rgba(213,137,28,.5),inset 0 1px 0 rgba(255,255,255,.2)}
    .mnx-brkbtn{background:var(--mnx-brk-bg);color:var(--mnx-on-brk);box-shadow:0 5px 14px -4px rgba(12,165,160,.5),inset 0 1px 0 rgba(255,255,255,.2)}
    .mnx-qid-open{display:inline-flex;align-items:center;margin-left:8px;vertical-align:middle;background:linear-gradient(180deg,var(--mnx-accent),var(--mnx-accent-600));color:#fff;border:none;border-radius:var(--mnx-r-sm);padding:3px 11px;font:700 12px var(--mnx-font);cursor:pointer;line-height:1.5;white-space:nowrap;box-shadow:var(--mnx-shadow-btn);transition:transform .16s,filter .16s}
    .mnx-qid-open:hover{filter:brightness(1.06);transform:translateY(-1px)}
    .mnx-qid-open:active{transform:translateY(0) scale(.97)}
    .mnx-qid-open.mnx-qid-float{position:fixed;top:8px;left:210px;z-index:2147483646}
    .mnx-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:rgba(23,27,40,.97);color:#fff;padding:11px 18px;border-radius:var(--mnx-r-pill);font-size:13.5px;font-weight:500;z-index:2147483647;box-shadow:var(--mnx-shadow);border:1px solid rgba(255,255,255,.08);max-width:80vw;text-align:center;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:mnx-toast-in .3s cubic-bezier(.2,.8,.3,1)}

    /* confirm dialog */
    #mnx-confirm{position:fixed;inset:0;background:rgba(10,14,30,.5);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:var(--mnx-font)}
    #mnx-confirm .mnx-cf-box{background:var(--mnx-surface);color:var(--mnx-text);width:min(380px,90vw);border-radius:var(--mnx-r);padding:20px 20px 16px;box-shadow:var(--mnx-shadow);border:1px solid var(--mnx-border);animation:mnx-pop .22s cubic-bezier(.2,.8,.3,1) both}
    #mnx-confirm .mnx-cf-title{font-size:15.5px;font-weight:700;letter-spacing:-.01em;color:var(--mnx-ink);margin-bottom:8px}
    #mnx-confirm .mnx-cf-body{font-size:13px;color:var(--mnx-muted);line-height:1.55;margin-bottom:18px}
    #mnx-confirm .mnx-cf-btns{display:flex;justify-content:flex-end;gap:8px}
    #mnx-confirm .mnx-cf-btn{border:none;border-radius:var(--mnx-r-sm);padding:9px 17px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:transform .16s,filter .16s}
    #mnx-confirm .mnx-cf-btn:active{transform:scale(.985)}
    #mnx-confirm .mnx-cf-cancel{background:var(--mnx-surface-2);color:var(--mnx-text)}
    #mnx-confirm .mnx-cf-cancel:hover{filter:brightness(.97)}
    #mnx-confirm .mnx-cf-ok{background:linear-gradient(180deg,var(--mnx-accent),var(--mnx-accent-600));color:#fff;box-shadow:var(--mnx-shadow-btn)}
    #mnx-confirm .mnx-cf-ok:hover{background:var(--mnx-accent-600)}

    /* resource card */
    #${PANEL_ID}{margin:14px 0;font-family:var(--mnx-font);color:var(--mnx-text);background:var(--mnx-surface);border:1px solid var(--mnx-border);border-radius:var(--mnx-r);display:block;position:relative;z-index:1;overflow:hidden;box-shadow:var(--mnx-shadow-sm);animation:mnx-rise .32s cubic-bezier(.2,.7,.3,1) both}
    #${PANEL_ID}.mnx-float{position:fixed;right:16px;bottom:16px;width:400px;max-height:60vh;overflow:auto;z-index:2147483646;box-shadow:var(--mnx-shadow)}
    #${PANEL_ID} table{border-collapse:collapse;width:100%;font-size:14px;background:transparent}
    #${PANEL_ID} td{border:none;border-bottom:1px solid var(--mnx-border);padding:10px 13px;vertical-align:top;line-height:1.45}
    #${PANEL_ID} tr:last-child td{border-bottom:none}
    #${PANEL_ID} tbody tr{transition:background .12s}
    #${PANEL_ID} tbody tr:hover td{background:var(--mnx-surface-2)}
    #${PANEL_ID} a{color:var(--mnx-accent);text-decoration:none;display:block;margin:3px 0;transition:color .12s}
    #${PANEL_ID} a:hover{color:var(--mnx-accent-600);text-decoration:underline}
    #${PANEL_ID} .mnx-group{margin:0 0 9px}
    #${PANEL_ID} .mnx-group:last-child{margin-bottom:0}
    #${PANEL_ID} .mnx-parent{font-size:12px;color:var(--mnx-muted);margin-bottom:2px}
    #${PANEL_ID} .mnx-leaf-row{padding:1px 0 1px 10px}
    #${PANEL_ID} .mnx-leaf{font-weight:600;color:var(--mnx-text)}
    #${PANEL_ID} .mnx-weight{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:700;
      color:var(--mnx-muted);background:var(--mnx-surface-2);border:1px solid var(--mnx-border);
      border-radius:var(--mnx-r-pill);padding:0 6px;font-variant-numeric:tabular-nums;vertical-align:1px}
    #${PANEL_ID} .mnx-watch{display:inline-block;color:var(--mnx-accent);text-decoration:none;font-size:12px;margin-left:8px;white-space:nowrap;font-weight:600}
    #${PANEL_ID} .mnx-watch:hover{text-decoration:underline}
    #${PANEL_ID} .mnx-msg{font-size:13px;color:var(--mnx-text);padding:12px 13px;line-height:1.5}
    #${PANEL_ID} .mnx-msg-why{font-size:12px;color:var(--mnx-muted);margin-top:3px}
    #${PANEL_ID} .mnx-msg-q{display:block;margin:7px 0 2px;padding:6px 8px;font-size:11.5px;
      font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--mnx-ink);
      background:var(--mnx-surface-2);border:1px solid var(--mnx-border);border-radius:var(--mnx-r-xs);
      user-select:all;overflow-wrap:anywhere}
    #${PANEL_ID} .mnx-note{font-size:12px;color:var(--mnx-muted);padding:9px 13px;border-top:1px solid var(--mnx-border);background:var(--mnx-surface-2)}
    #${PANEL_ID} .mnx-msg-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:9px}
    #${PANEL_ID} .mnx-msg-actions .mnx-msg-why{margin-top:0}
    #${PANEL_ID} .mnx-match-note{font-size:12px;color:var(--mnx-muted);padding:8px 13px;border-bottom:1px solid var(--mnx-border);background:var(--mnx-surface-2)}
    #${PANEL_ID} .mnx-match-note.mnx-approx{color:var(--mnx-warn-txt);font-weight:600;background:color-mix(in srgb,var(--mnx-warn) 10%,var(--mnx-surface))}

    /* ---- collapsible resource rows ----------------------------------------
       A whole AnKing card can carry 100+ tagged chapters. Showing them all at
       once buried the qbank's own explanation, so each resource is a closed
       disclosure: a one-line summary with enough scent to decide, and the full
       list one click away. What you open is remembered. */
    #${PANEL_ID} .mnx-r{border-bottom:1px solid var(--mnx-border)}
    #${PANEL_ID} .mnx-r:last-of-type{border-bottom:none}
    #${PANEL_ID} .mnx-r-head{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;
      background:none;border:none;border-left:3px solid var(--mnx-accent);padding:9px 13px;margin:0;
      font:inherit;font-size:13.5px;text-align:left;cursor:pointer;color:var(--mnx-text);
      transition:background .14s ease}
    #${PANEL_ID} .mnx-r-head:hover{background:var(--mnx-surface-2)}
    #${PANEL_ID} .mnx-r-head:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--mnx-accent-ring)}
    #${PANEL_ID} .mnx-r-chev{flex:none;width:9px;height:9px;border-right:2px solid var(--mnx-muted);
      border-bottom:2px solid var(--mnx-muted);transform:rotate(-45deg);transition:transform .2s cubic-bezier(.2,.7,.3,1);margin-left:1px}
    #${PANEL_ID} .mnx-r.open .mnx-r-chev{transform:rotate(45deg)}
    #${PANEL_ID} .mnx-r-name{font-weight:700;letter-spacing:-.01em;color:var(--mnx-ink);white-space:nowrap}
    #${PANEL_ID} .mnx-r-count{font-variant-numeric:tabular-nums;font-size:11.5px;font-weight:600;color:var(--mnx-muted);
      background:var(--mnx-surface-2);border:1px solid var(--mnx-border);border-radius:var(--mnx-r-pill);padding:1px 7px;flex:none}
    #${PANEL_ID} .mnx-r-peek{color:var(--mnx-muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;
      white-space:nowrap;flex:1 1 auto;min-width:0}
    #${PANEL_ID} .mnx-r.open .mnx-r-peek{opacity:0}
    #${PANEL_ID} .mnx-r-body{padding:2px 13px 12px 26px;animation:mnx-rise .2s cubic-bezier(.2,.7,.3,1) both}
    #${PANEL_ID} .mnx-r-key{flex:none;font-size:10.5px;font-weight:700;color:var(--mnx-accent);
      background:var(--mnx-accent-soft);border-radius:var(--mnx-r-xs);padding:1px 5px;letter-spacing:.02em;
      border:none;font-family:inherit;line-height:inherit;cursor:pointer;transition:filter .14s,transform .12s}
    #${PANEL_ID} .mnx-r-key:hover{filter:brightness(.94)}
    #${PANEL_ID} .mnx-r-key.mnx-r-key-empty{opacity:.4;cursor:default}
    #${PANEL_ID} .mnx-r-fieldcard{padding:8px 0;border-top:1px dashed var(--mnx-border);font-size:13.5px;line-height:1.55}
    #${PANEL_ID} .mnx-r-fieldcard:first-child{border-top:none}
    #${PANEL_ID} .mnx-r-fieldcard-h{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--mnx-muted);margin-bottom:4px}
    #${PANEL_ID} .mnx-r-fieldcard-body img{max-width:100%;height:auto;display:block;margin:6px 0;border-radius:var(--mnx-r-xs)}
    #${PANEL_ID} .mnx-r-fieldcard-body a{display:inline}
    #${PANEL_ID} .mnx-r-key:active{transform:scale(.94)}
    #${PANEL_ID} .mnx-r-key:focus-visible{outline:2px solid var(--mnx-accent-ring);outline-offset:1px}

    /* ---- how confident were you, really ---- */
    #${PANEL_ID} .mnx-recall{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 13px;
      border-bottom:1px solid var(--mnx-border);font-size:12.5px}
    #${PANEL_ID} .mnx-recall-lbl{color:var(--mnx-muted);margin-right:2px}
    #${PANEL_ID} .mnx-recall-btn{font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:3px 10px;
      border-radius:var(--mnx-r-pill);border:1px solid var(--mnx-border);background:var(--mnx-surface);
      color:var(--mnx-text);transition:background .14s,border-color .14s,transform .12s}
    #${PANEL_ID} .mnx-recall-btn:hover{background:var(--mnx-surface-2)}
    #${PANEL_ID} .mnx-recall-btn:active{transform:scale(.97)}
    #${PANEL_ID} .mnx-recall-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #${PANEL_ID} .mnx-recall-knew.on{background:rgba(31,157,87,.14);border-color:var(--mnx-good);color:var(--mnx-good)}
    #${PANEL_ID} .mnx-recall-guessed.on{background:rgba(213,137,28,.16);border-color:var(--mnx-warn);color:var(--mnx-warn)}
    #${PANEL_ID} .mnx-recall-noidea.on{background:rgba(220,75,69,.14);border-color:var(--mnx-bad);color:var(--mnx-bad)}

    /* ---- how ready you are for this question ---- */
    #${PANEL_ID} .mnx-cards{display:flex;align-items:center;gap:10px;padding:8px 13px;
      border-bottom:1px solid var(--mnx-border);background:var(--mnx-surface-2);font-size:12.5px}
    #${PANEL_ID} .mnx-cards-bar{display:flex;flex:none;width:96px;height:6px;border-radius:999px;overflow:hidden;background:var(--mnx-border)}
    #${PANEL_ID} .mnx-cards-bar i{display:block;height:100%}
    #${PANEL_ID} .mnx-seg-mature{background:var(--mnx-good)}
    #${PANEL_ID} .mnx-seg-young{background:var(--mnx-accent)}
    #${PANEL_ID} .mnx-seg-learning{background:var(--mnx-warn)}
    #${PANEL_ID} .mnx-seg-new{background:var(--mnx-muted);opacity:.45}
    #${PANEL_ID} .mnx-seg-suspended{background:var(--mnx-bad);opacity:.6}
    #${PANEL_ID} .mnx-cards-txt{color:var(--mnx-muted);font-variant-numeric:tabular-nums;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${PANEL_ID} .mnx-cards-txt b{color:var(--mnx-ink);font-weight:700}
    #${PANEL_ID} .mnx-unsus{margin-left:auto;flex:none;font:inherit;font-size:12px;font-weight:600;cursor:pointer;
      border:1px solid var(--mnx-border);background:var(--mnx-surface);color:var(--mnx-accent);
      border-radius:var(--mnx-r-xs);padding:3px 10px;transition:background .14s,transform .14s}
    #${PANEL_ID} .mnx-unsus:hover{background:var(--mnx-accent-soft)}
    #${PANEL_ID} .mnx-unsus:active{transform:scale(.97)}
    #${PANEL_ID} .mnx-unsus:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #${PANEL_ID} .mnx-unsus[disabled]{opacity:.55;cursor:default}
    @media (prefers-reduced-motion:reduce){
      #${PANEL_ID} .mnx-r-chev,#${PANEL_ID} .mnx-r-head{transition:none}
      #${PANEL_ID} .mnx-r-body{animation:none}
    }

    /* fullscreen image overlay */
    #${OVERLAY_ID}{display:none;position:fixed;inset:0;background:rgba(10,14,30,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:2147483646;align-items:flex-start;justify-content:center;padding:4vh 0}
    #${OVERLAY_ID} .mnx-dialog{background:var(--mnx-surface);color:var(--mnx-text);width:90vw;max-height:92vh;overflow:auto;border-radius:var(--mnx-r);padding:16px 18px 20px;box-shadow:var(--mnx-shadow);border:1px solid var(--mnx-border);font-family:var(--mnx-font);animation:mnx-pop .22s cubic-bezier(.2,.8,.3,1) both}
    #${OVERLAY_ID} .mnx-ovl-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--mnx-border);padding-bottom:10px;margin-bottom:14px}
    #${OVERLAY_ID} .mnx-ovl-head b{font-size:16px;font-weight:700;letter-spacing:-.01em;color:var(--mnx-ink)}
    #${OVERLAY_ID} .mnx-ovl-hint{font-size:12px;color:var(--mnx-muted);margin-left:8px}
    #${OVERLAY_ID} .mnx-x{border:none;background:transparent;font-size:26px;line-height:1;cursor:pointer;color:var(--mnx-muted);padding:0 6px;border-radius:var(--mnx-r-xs);transition:background .12s,color .12s}
    #${OVERLAY_ID} .mnx-x:hover{color:var(--mnx-text);background:var(--mnx-surface-2)}
    #${OVERLAY_ID} .mnx-ovl-img{display:block;width:100%;height:auto;margin:0 0 12px;border-radius:var(--mnx-r-xs)}
    #${OVERLAY_ID} .mnx-ovl-missing{font-size:12.5px;color:var(--mnx-warn-txt);margin:0 0 10px}
    #${OVERLAY_ID} .mnx-ovl-field{max-height:76vh;overflow:auto;font-size:15px;line-height:1.6}
    #${OVERLAY_ID} .mnx-ovl-fieldcard{padding:12px 2px;border-top:1px solid var(--mnx-border)}
    #${OVERLAY_ID} .mnx-ovl-fieldcard:first-child{border-top:none;padding-top:2px}
    #${OVERLAY_ID} .mnx-ovl-fieldcard-h{font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--mnx-muted);margin-bottom:6px}
    #${OVERLAY_ID} .mnx-ovl-fieldcard img{max-width:100%;height:auto;display:block;margin:8px 0;border-radius:var(--mnx-r-xs)}
    #${OVERLAY_ID} .mnx-ovl-fieldcard a{color:var(--mnx-accent)}
    /* multi-page overlay: pager in the header, filmstrip underneath */
    #${OVERLAY_ID} .mnx-ovl-nav{display:flex;align-items:center;gap:10px;margin-left:auto;margin-right:12px}
    #${OVERLAY_ID} .mnx-ovl-count{font-size:12.5px;font-weight:600;color:var(--mnx-muted);font-variant-numeric:tabular-nums;min-width:44px;text-align:center}
    #${OVERLAY_ID} .mnx-ovl-arrow{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--mnx-border);
      background:var(--mnx-surface);color:var(--mnx-accent);border-radius:var(--mnx-r-xs);padding:4px 10px;cursor:pointer;
      transition:background .14s,transform .14s}
    #${OVERLAY_ID} .mnx-ovl-arrow:hover{background:var(--mnx-accent-soft)}
    #${OVERLAY_ID} .mnx-ovl-arrow:active{transform:scale(.97)}
    #${OVERLAY_ID} .mnx-ovl-arrow:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #${OVERLAY_ID} .mnx-ovl-stage{max-height:70vh;overflow:auto;border-radius:var(--mnx-r-xs)}
    #${OVERLAY_ID} .mnx-ovl-thumbs{display:flex;gap:8px;overflow-x:auto;padding:12px 2px 2px;border-top:1px solid var(--mnx-border);margin-top:4px}
    #${OVERLAY_ID} .mnx-ovl-thumb{flex:none;width:74px;height:54px;padding:0;overflow:hidden;cursor:pointer;
      border:2px solid var(--mnx-border);border-radius:var(--mnx-r-xs);background:var(--mnx-surface-2);
      transition:border-color .14s,transform .14s}
    #${OVERLAY_ID} .mnx-ovl-thumb img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
    #${OVERLAY_ID} .mnx-ovl-thumb:hover{transform:translateY(-1px)}
    #${OVERLAY_ID} .mnx-ovl-thumb.on{border-color:var(--mnx-accent)}
    #${OVERLAY_ID} .mnx-ovl-thumb:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}

    .mnx-es{background:#2a9d8f}
    #${PANEL_ID} .mnx-expected{font-size:12.5px;padding:9px 12px;border-radius:var(--mnx-r-sm);margin:11px;border-left:3px solid var(--mnx-muted);background:var(--mnx-surface-2);color:var(--mnx-text)}
    #${PANEL_ID} .mnx-expected.good{border-left-color:var(--mnx-good);background:color-mix(in srgb,var(--mnx-good) 10%,var(--mnx-surface))}
    #${PANEL_ID} .mnx-expected.warn{border-left-color:var(--mnx-warn);background:color-mix(in srgb,var(--mnx-warn) 12%,var(--mnx-surface))}

    /* readiness summary */
    #${SUMMARY_ID}{display:none;position:fixed;inset:0;background:rgba(10,14,30,.5);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);z-index:2147483646;align-items:flex-start;justify-content:center;padding:6vh 0;font-family:var(--mnx-font)}
    #${SUMMARY_ID} .mnx-sum-dialog{background:var(--mnx-surface);color:var(--mnx-text);width:min(560px,92vw);max-height:86vh;overflow:auto;border-radius:var(--mnx-r);padding:18px 20px 22px;box-shadow:var(--mnx-shadow);border:1px solid var(--mnx-border);animation:mnx-pop .22s cubic-bezier(.2,.8,.3,1) both}
    #${SUMMARY_ID} .mnx-sum-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--mnx-border);padding-bottom:10px;margin-bottom:14px}
    #${SUMMARY_ID} .mnx-sum-head span{font-weight:700;font-size:16px;letter-spacing:-.01em;color:var(--mnx-ink)}
    #${SUMMARY_ID} .mnx-sum-row{display:flex;gap:10px;margin-bottom:10px}
    #${SUMMARY_ID} .mnx-metric{flex:1;background:var(--mnx-surface-2);border-radius:var(--mnx-r-sm);padding:11px 12px;text-align:center}
    #${SUMMARY_ID} .mnx-metric-v{font-size:22px;font-weight:700;color:var(--mnx-ink);font-variant-numeric:tabular-nums}
    #${SUMMARY_ID} .mnx-metric-l{font-size:12px;color:var(--mnx-muted);margin-top:2px}
    #${SUMMARY_ID} .mnx-sum-note{font-size:12.5px;color:var(--mnx-muted);margin-bottom:12px;line-height:1.55}
    #${SUMMARY_ID} .mnx-sum-lbl{font-size:13px;font-weight:600;color:var(--mnx-text);margin:6px 0}
    #${SUMMARY_ID} .mnx-sum-item{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--mnx-border);font-size:13px}
    #${SUMMARY_ID} a{color:var(--mnx-accent);text-decoration:none;font-size:12px;white-space:nowrap;font-weight:600}
    #${SUMMARY_ID} a:hover{text-decoration:underline}
    #${SUMMARY_ID} .mnx-sum-score{text-align:center;margin:2px 0 14px}
    #${SUMMARY_ID} .mnx-score-v{font-size:34px;font-weight:800;color:var(--mnx-ink);line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
    #${SUMMARY_ID} .mnx-score-l{display:block;font-size:12px;color:var(--mnx-muted);margin-top:3px}
    #${SUMMARY_ID} .mnx-cov{margin:0 0 14px}
    #${SUMMARY_ID} .mnx-cov-bar{height:8px;border-radius:var(--mnx-r-pill);background:var(--mnx-surface-2);overflow:hidden}
    #${SUMMARY_ID} .mnx-cov-fill{height:100%;background:var(--mnx-accent);border-radius:var(--mnx-r-pill);min-width:2px}
    #${SUMMARY_ID} .mnx-cov-lbl{font-size:12px;color:var(--mnx-muted);margin-top:5px}
    #${SUMMARY_ID} .mnx-conf{display:inline-block;font-size:12px;font-weight:700;padding:4px 12px;border-radius:var(--mnx-r-pill);margin:0 0 11px}
    #${SUMMARY_ID} .mnx-conf-high{background:color-mix(in srgb,var(--mnx-good) 16%,var(--mnx-surface));color:var(--mnx-good-600)}
    #${SUMMARY_ID} .mnx-conf-medium{background:var(--mnx-accent-soft);color:var(--mnx-accent-700)}
    #${SUMMARY_ID} .mnx-conf-low{background:color-mix(in srgb,var(--mnx-warn) 18%,var(--mnx-surface));color:var(--mnx-warn)}
    #${SUMMARY_ID} .mnx-conf-insufficient{background:var(--mnx-surface-2);color:var(--mnx-muted)}
    #${SUMMARY_ID} .mnx-x{border:none;background:transparent;font-size:26px;line-height:1;cursor:pointer;color:var(--mnx-muted);padding:0 4px;border-radius:var(--mnx-r-xs);transition:background .12s,color .12s}
    #${SUMMARY_ID} .mnx-x:hover{color:var(--mnx-text);background:var(--mnx-surface-2)}

    /* review-panel header actions */
    #${PANEL_ID} .mnx-phead{display:flex;gap:6px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--mnx-border);background:linear-gradient(180deg,var(--mnx-accent-soft),var(--mnx-surface-2))}
    #${PANEL_ID} .mnx-pbtn{border:none;border-radius:var(--mnx-r-xs);padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--mnx-font);background:var(--mnx-elev);color:var(--mnx-ink);box-shadow:var(--mnx-shadow-sm);transition:transform .16s,filter .16s}
    #${PANEL_ID} .mnx-pbtn:hover{filter:brightness(.97);transform:translateY(-1px)}
    #${PANEL_ID} .mnx-pbtn:active{transform:translateY(0) scale(.98)}
    #${PANEL_ID} .mnx-pbtn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #${PANEL_ID} .mnx-pbtn.mnx-save{background:var(--mnx-save-bg);color:var(--mnx-on-save);box-shadow:0 4px 12px -4px rgba(31,157,87,.5)}
    #${PANEL_ID} .mnx-pbtn.mnx-save:hover{filter:brightness(1.05)}

    /* modal system (preview / save / make card / breakdown) */
    #mnx-md-overlay{position:fixed;inset:0;background:rgba(10,14,30,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:6vh 0;font-family:var(--mnx-font)}
    #mnx-md-overlay .mnx-md{background:var(--mnx-surface);color:var(--mnx-text);width:min(560px,92vw);max-height:84vh;overflow:hidden;display:flex;flex-direction:column;border-radius:var(--mnx-r);box-shadow:var(--mnx-shadow);border:1px solid var(--mnx-border);animation:mnx-pop .24s cubic-bezier(.2,.8,.3,1) both}
    /* header and footer stay put; only the body scrolls, so the main button is
       never below the fold of a laptop screen */
    #mnx-md-overlay .mnx-md-head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-md-head b{font-size:15px;font-weight:700;letter-spacing:-.01em;color:var(--mnx-ink)}
    #mnx-md-overlay .mnx-md-x{border:none;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--mnx-muted);width:28px;height:28px;border-radius:var(--mnx-r-xs);transition:background .12s,color .12s}
    #mnx-md-overlay .mnx-md-x:hover{color:var(--mnx-text);background:var(--mnx-surface-2)}
    #mnx-md-overlay .mnx-md-body{padding:16px 18px;overflow:auto;flex:1 1 auto;min-height:0}
    #mnx-md-overlay .mnx-md-foot{flex:none;display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--mnx-border);background:var(--mnx-surface)}
    #mnx-md-overlay .mnx-saved{margin-top:4px}
    #mnx-md-overlay .mnx-saved-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--mnx-border);font-size:12.5px}
    #mnx-md-overlay .mnx-saved-x{flex:none;border:none;background:none;color:var(--mnx-bad-txt);font:600 12px var(--mnx-font);cursor:pointer;padding:2px 4px;border-radius:var(--mnx-r-xs)}
    #mnx-md-overlay .mnx-saved-x:hover{text-decoration:underline}
    #mnx-md-overlay .mnx-saved-x:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #mnx-md-overlay .mnx-pick-hint{font-style:normal;color:var(--mnx-muted);font-size:11.5px}
    #mnx-md-overlay .mnx-dup{color:var(--mnx-warn-txt);font-weight:600}
    #mnx-md-overlay .mnx-md-btn{border:none;border-radius:var(--mnx-r-sm);padding:9px 17px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--mnx-font);transition:transform .16s,filter .16s,background .16s}
    #mnx-md-overlay .mnx-md-btn:active{transform:scale(.985)}
    #mnx-md-overlay .mnx-md-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #mnx-md-overlay .mnx-md-ok{background:linear-gradient(180deg,var(--mnx-accent),var(--mnx-accent-600));color:#fff;box-shadow:var(--mnx-shadow-btn)}
    #mnx-md-overlay .mnx-md-ok:hover{background:var(--mnx-accent-600)}
    #mnx-md-overlay .mnx-md-ok:disabled{opacity:.55;cursor:default;box-shadow:none}
    #mnx-md-overlay .mnx-md-cancel{background:var(--mnx-surface-2);color:var(--mnx-text)}
    #mnx-md-overlay .mnx-md-cancel:hover{filter:brightness(.97)}
    /* undo sits left of Cancel: readable, never louder than the save button */
    #mnx-md-overlay .mnx-md-undo{background:transparent;color:var(--mnx-bad);
      box-shadow:inset 0 0 0 1px var(--mnx-border);margin-right:auto}
    #mnx-md-overlay .mnx-md-undo:hover{background:var(--mnx-surface-2)}
    #mnx-md-overlay .mnx-md-undo:disabled{opacity:.55;cursor:default}
    #mnx-md-overlay .mnx-chapchips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0}
    #mnx-md-overlay .mnx-chapchip{display:inline-flex;align-items:baseline;gap:6px;font:inherit;font-size:12.5px;
      font-weight:600;cursor:pointer;padding:5px 11px;border-radius:var(--mnx-r-pill);
      border:1px solid var(--mnx-border);background:var(--mnx-surface);color:var(--mnx-text);
      transition:background .14s,border-color .14s,transform .12s}
    #mnx-md-overlay .mnx-chapchip i{font-style:normal;font-size:10.5px;font-weight:600;color:var(--mnx-muted)}
    #mnx-md-overlay .mnx-chapchip:hover{background:var(--mnx-surface-2)}
    #mnx-md-overlay .mnx-chapchip:active{transform:scale(.97)}
    #mnx-md-overlay .mnx-chapchip:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #mnx-md-overlay .mnx-chapchip.on{background:var(--mnx-accent-soft);border-color:var(--mnx-accent);color:var(--mnx-accent)}
    #mnx-md-overlay .mnx-chapchip.on i{color:var(--mnx-accent)}
    #mnx-md-overlay .mnx-chapcustom{margin-top:7px}
    #mnx-md-overlay .mnx-md-dest{margin:8px 0 2px;font-size:12.5px;color:var(--mnx-muted)}
    #mnx-md-overlay .mnx-md-dest b{color:var(--mnx-ink);font-weight:700;overflow-wrap:anywhere}
    #mnx-md-overlay .mnx-md-lbl{display:block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--mnx-muted);margin:14px 0 6px}
    #mnx-md-overlay .mnx-md-body select,#mnx-md-overlay .mnx-md-body textarea,#mnx-md-overlay .mnx-md-body input[type=text]{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);font-size:13px;font-family:var(--mnx-font);color:var(--mnx-text);background:var(--mnx-surface-2);outline:none;transition:border-color .14s,box-shadow .14s}
    #mnx-md-overlay .mnx-md-body select:focus,#mnx-md-overlay .mnx-md-body textarea:focus,#mnx-md-overlay .mnx-md-body input[type=text]:focus{border-color:var(--mnx-accent);box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #mnx-md-overlay .mnx-md-body textarea{min-height:84px;resize:vertical;line-height:1.5}
    #mnx-md-overlay .mnx-pick{border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);max-height:min(320px,42vh);overflow:auto;background:var(--mnx-surface-2)}
    #mnx-md-overlay .mnx-pick input[type=radio]{margin-top:3px;flex:none}
    #mnx-md-overlay .mnx-glance{display:flex;flex-direction:column;gap:3px;min-width:0}
    #mnx-md-overlay .mnx-glance-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;line-height:1.45;color:var(--mnx-text)}
    #mnx-md-overlay .mnx-glance-ans{color:var(--mnx-accent);font-weight:700}
    #mnx-md-overlay .mnx-glance-sub{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:11.5px;line-height:1.4;color:var(--mnx-muted)}
    #mnx-md-overlay .mnx-glance-sub b{font-weight:700;color:var(--mnx-text);opacity:.75;text-transform:uppercase;font-size:10px;letter-spacing:.04em}
    #mnx-md-overlay .mnx-glance-meta{font-size:11px;color:var(--mnx-muted)}
    #mnx-md-overlay .mnx-pick label{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-bottom:1px solid var(--mnx-border);font-size:12.5px;cursor:pointer;transition:background .12s}
    #mnx-md-overlay .mnx-pick label:hover{background:var(--mnx-surface)}
    #mnx-md-overlay .mnx-pick label:last-child{border-bottom:none}
    #mnx-md-overlay .mnx-md-prev{font-size:13.5px;line-height:1.55}
    #mnx-md-overlay .mnx-md-prev img{max-width:100%;height:auto;display:block;margin:8px 0;border-radius:var(--mnx-r-xs)}
    #mnx-md-overlay .mnx-md-prev .cloze{color:var(--mnx-accent);font-weight:700}
    #mnx-md-overlay .mnx-fullcard{margin:10px 0 2px;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);background:var(--mnx-surface-2)}
    #mnx-md-overlay .mnx-fullcard > summary{cursor:pointer;padding:8px 11px;font-size:12.5px;font-weight:600;color:var(--mnx-accent)}
    #mnx-md-overlay .mnx-fullcard-body{padding:0 11px 10px;max-height:46vh;overflow:auto}
    #mnx-md-overlay .mnx-field{border-top:1px solid var(--mnx-border);padding:6px 0}
    #mnx-md-overlay .mnx-field:first-child{border-top:none}
    #mnx-md-overlay .mnx-field > summary{cursor:pointer;font-size:12.5px;display:flex;gap:8px;align-items:baseline;padding:3px 0;list-style-position:inside}
    #mnx-md-overlay .mnx-field > summary b{color:var(--mnx-ink);flex:none}
    #mnx-md-overlay .mnx-field-hint{color:var(--mnx-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    #mnx-md-overlay .mnx-field[open] > summary .mnx-field-hint{display:none}
    #mnx-md-overlay .mnx-field-body{padding:4px 0 2px}
    #mnx-md-overlay .mnx-remote-img{display:inline-block;font-size:11.5px;color:var(--mnx-muted);border:1px dashed var(--mnx-border);border-radius:var(--mnx-r-xs);padding:2px 7px;margin:4px 0}
    #mnx-md-overlay .mnx-prev-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
    #mnx-md-overlay .mnx-prev-count{font-size:12.5px;font-weight:700;color:var(--mnx-ink);font-variant-numeric:tabular-nums}
    #mnx-md-overlay .mnx-imgfield{display:flex;align-items:center;gap:8px;min-height:38px;box-sizing:border-box;padding:5px 6px 5px 11px;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);background:var(--mnx-surface-2);cursor:pointer;outline:none;transition:border-color .14s,box-shadow .14s,background .14s}
    #mnx-md-overlay .mnx-imgfield:hover{border-color:var(--mnx-accent)}
    #mnx-md-overlay .mnx-imgfield:focus-visible{border-color:var(--mnx-accent);box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #mnx-md-overlay .mnx-imgfield.mnx-img-over{border-color:var(--mnx-accent);border-style:dashed;background:var(--mnx-accent-soft)}
    #mnx-md-overlay .mnx-imgfield.has-imgs{padding-left:6px}
    #mnx-md-overlay .mnx-imgfield-ph{flex:1 1 auto;min-width:0;font-size:12.5px;color:var(--mnx-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #mnx-md-overlay .mnx-imgfield-add{flex:none;width:26px;height:26px;box-sizing:border-box;border-radius:var(--mnx-r-xs);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;line-height:1;color:var(--mnx-accent);background:var(--mnx-surface);border:1px solid var(--mnx-border);transition:background .14s,transform .14s}
    #mnx-md-overlay .mnx-imgfield:hover .mnx-imgfield-add{background:var(--mnx-accent-soft)}
    #mnx-md-overlay .mnx-imgfield:active .mnx-imgfield-add{transform:scale(.94)}
    #mnx-md-overlay .mnx-img-thumbs{display:flex;flex-wrap:wrap;gap:6px}
    #mnx-md-overlay .mnx-img-thumbs:empty{display:none}
    #mnx-md-overlay .mnx-img-thumb{position:relative;flex:none;width:44px;height:44px;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-xs);overflow:hidden;background:var(--mnx-surface);cursor:default}
    #mnx-md-overlay .mnx-img-from{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:7px}
    #mnx-md-overlay .mnx-img-thumb img{width:100%;height:100%;object-fit:cover;display:block}
    #mnx-md-overlay .mnx-img-x{position:absolute;top:1px;right:1px;width:16px;height:16px;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:13px;line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
    #mnx-md-overlay .mnx-img-x:hover{background:rgba(0,0,0,.85)}
    #mnx-md-overlay .mnx-qthumb{position:relative;flex:none;width:36px;height:36px;padding:0;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-xs);overflow:hidden;background:var(--mnx-surface);cursor:pointer;transition:transform .14s,border-color .14s}
    #mnx-md-overlay .mnx-qthumb:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #mnx-md-overlay .mnx-qthumb:hover{transform:translateY(-2px);border-color:var(--mnx-accent)}
    #mnx-md-overlay .mnx-qthumb img{width:100%;height:100%;object-fit:cover;display:block}
    #mnx-md-overlay .mnx-qthumb::after{content:"＋";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.34);color:#fff;font-size:14px;font-weight:700;opacity:0;transition:opacity .14s}
    #mnx-md-overlay .mnx-qthumb:hover::after{opacity:1}
    #mnx-md-overlay .mnx-figchips{display:flex;flex-wrap:wrap;gap:6px}
    #mnx-md-overlay .mnx-figchip{font:600 12px var(--mnx-font);cursor:pointer;padding:0 10px;height:30px;box-sizing:border-box;border-radius:var(--mnx-r-pill);border:1px solid var(--mnx-border);background:var(--mnx-surface);color:var(--mnx-accent);transition:background .14s}
    #mnx-md-overlay .mnx-figchip::before{content:"＋ "}
    #mnx-md-overlay .mnx-figchip:hover{background:var(--mnx-accent-soft)}
    #mnx-md-overlay .mnx-figchip.loading{opacity:.6;cursor:progress}
    #mnx-md-overlay .mnx-figchip.loading::before{content:"… "}
    #mnx-md-overlay .mnx-figchip.added{border-color:var(--mnx-good);color:var(--mnx-good-txt)}
    #mnx-md-overlay .mnx-figchip.added::before{content:"✓ "}
    #mnx-md-overlay .mnx-figchip:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mnx-accent-ring)}
    #mnx-md-overlay .mnx-qthumb.loading::after{content:"…";opacity:1}
    #mnx-md-overlay .mnx-qthumb.added::after{content:"✓";opacity:1;background:rgba(31,157,87,.66)}
    #mnx-md-overlay .mnx-seg{display:inline-flex;background:var(--mnx-surface-2);border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);padding:3px;gap:2px}
    #mnx-md-overlay .mnx-seg button{border:none;background:transparent;font:600 13px var(--mnx-font);color:var(--mnx-muted);padding:6px 18px;border-radius:var(--mnx-r-xs);cursor:pointer;transition:color .12s}
    #mnx-md-overlay .mnx-seg button.on{background:var(--mnx-surface);color:var(--mnx-ink);box-shadow:var(--mnx-shadow-sm)}
    #mnx-md-overlay .mnx-inline{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
    #mnx-md-overlay .mnx-inline .mnx-md-btn{padding:6px 13px;font-size:12.5px}
    #mnx-md-overlay .mnx-md-hint{font-size:11.5px;color:var(--mnx-muted)}
    #mnx-md-overlay .mnx-md-check{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px;color:var(--mnx-text);cursor:pointer}
    /* block breakdown (weak areas) */
    #mnx-md-overlay .mnx-brk-sub{font-size:12.5px;color:var(--mnx-muted);margin:-4px 0 14px}
    #mnx-md-overlay .mnx-brk-row{display:grid;grid-template-columns:1fr auto;gap:5px 12px;align-items:center;padding:11px 0;border-top:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-brk-row:first-of-type{border-top:none}
    #mnx-md-overlay .mnx-brk-name{font-size:13px;font-weight:600;color:var(--mnx-text)}
    #mnx-md-overlay .mnx-brk-few{display:inline-block;margin-left:8px;font-size:10.5px;font-weight:600;color:var(--mnx-muted);background:var(--mnx-surface-2);border:1px solid var(--mnx-border);border-radius:var(--mnx-r-pill);padding:0 7px;vertical-align:1px}
    #mnx-md-overlay .mnx-brk-pct{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
    #mnx-md-overlay .mnx-brk-bar{grid-column:1/2;height:8px;border-radius:var(--mnx-r-pill);background:var(--mnx-surface-2);overflow:hidden}
    #mnx-md-overlay .mnx-brk-fill{height:100%;border-radius:var(--mnx-r-pill);transition:width .5s cubic-bezier(.2,.7,.3,1)}
    #mnx-md-overlay .mnx-brk-meta{grid-column:2/3;display:flex;align-items:center;gap:12px;justify-self:end}
    #mnx-md-overlay .mnx-brk-count{font-size:11.5px;color:var(--mnx-muted);font-variant-numeric:tabular-nums}
    #mnx-md-overlay .mnx-brk-open{font-size:12px;font-weight:600;color:var(--mnx-accent);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap}
    #mnx-md-overlay .mnx-brk-open:hover{text-decoration:underline}
    #mnx-md-overlay .mnx-kb{display:flex;flex-direction:column}
    #mnx-md-overlay .mnx-kb-row{display:grid;grid-template-columns:158px 1fr;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-kb-row:first-child{border-top:none}
    #mnx-md-overlay .mnx-kb-keys{display:flex;gap:4px;flex-wrap:wrap}
    #mnx-md-overlay .mnx-kb kbd{font:700 11px var(--mnx-font);background:var(--mnx-surface-2);border:1px solid var(--mnx-border);border-bottom-width:2px;border-radius:var(--mnx-r-xs);padding:2px 7px;color:var(--mnx-ink);min-width:14px;text-align:center}
    #mnx-md-overlay .mnx-kb-desc{font-size:12.5px;color:var(--mnx-text)}
    #mnx-selchip{position:fixed;z-index:2147483647;display:none;align-items:center;gap:6px;background:linear-gradient(180deg,var(--mnx-accent),var(--mnx-accent-600));color:#fff;border:none;border-radius:var(--mnx-r-sm);padding:9px 14px;font:700 12.5px var(--mnx-font);cursor:pointer;box-shadow:var(--mnx-shadow-btn);transition:transform .16s,filter .16s;animation:mnx-rise .2s ease both}
    #mnx-selchip:hover{background:var(--mnx-accent-600);transform:translateY(-1px)}
  `;
  document.documentElement.appendChild(style);

  // ---------- dark mode + expected score ----------
  let darkMode = false;
  let esOn = false;
  let easyOn = false;
  let hyOn = false;
  const DEFAULT_AI_PROMPT = "I'm studying for the USMLE. Below is a question with its answer choices and explanation. Explain the correct answer and why each other option is wrong, then give me the single highest-yield fact to remember. Be concise.";
  let aiPrompt = DEFAULT_AI_PROMPT;   // prepended to "Copy for AI"
  let kbShortcuts = true;             // review-page action hotkeys
  // "auto" (the default) reads the qbank's own theme, then the OS. A stored
  // true/false is an explicit override and always wins — a white slab on a dark
  // qbank was the single most jarring thing about the old build.
  let darkPref = "auto";
  function siteIsDark() {
    const root = document.documentElement;
    if (root.classList.contains("dark") || document.body?.classList.contains("dark")) return true;
    const attr = (root.getAttribute("data-theme") || root.getAttribute("data-mode") || "").toLowerCase();
    if (attr.indexOf("dark") >= 0) return true;
    if (attr.indexOf("light") >= 0) return false;
    if ((getComputedStyle(root).colorScheme || "").indexOf("dark") >= 0) return true;
    // Fall back to the page's actual background luminance.
    const bg = getComputedStyle(document.body || root).backgroundColor || "";
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (m && (m[4] === undefined || +m[4] > 0.3)) {
      const lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      return lum < 0.4;
    }
    try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; }
  }
  function resolveDark() {
    if (darkPref === true || darkPref === false) return darkPref;
    try { return siteIsDark(); } catch (e) { return false; }
  }
  function applyTheme() {
    darkMode = resolveDark();
    document.documentElement.classList.toggle("mnx-dark", darkMode);   // flips design tokens
    const p = document.getElementById(PANEL_ID); if (p) p.classList.toggle("mnx-dark", darkMode);
    const o = document.getElementById(OVERLAY_ID); if (o) o.classList.toggle("mnx-dark", darkMode);
  }
  // Follow the qbank if it has its own light/dark switch.
  try {
    new MutationObserver(() => { if (darkPref === "auto") applyTheme(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-mode", "style"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (darkPref === "auto") applyTheme(); });
  } catch (e) {}
  chrome.storage.local.get({ dark: "auto", expectedScore: false, easy: false, highYield: false, aiPrompt: DEFAULT_AI_PROMPT, kbShortcuts: true }, c => { darkPref = (c.dark === true || c.dark === false) ? c.dark : "auto"; esOn = !!c.expectedScore; easyOn = !!c.easy; hyOn = !!c.highYield; aiPrompt = c.aiPrompt == null ? DEFAULT_AI_PROMPT : c.aiPrompt; kbShortcuts = c.kbShortcuts !== false; applyTheme(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("dark" in changes) {
      const v = changes.dark.newValue;
      darkPref = (v === true || v === false) ? v : "auto";
      applyTheme();
    }
    if (changes.expectedScore) { esOn = !!changes.expectedScore.newValue; }
    if (changes.easy) { easyOn = !!changes.easy.newValue; }
    if (changes.highYield) { hyOn = !!changes.highYield.newValue; }
    if ("aiPrompt" in changes) { aiPrompt = changes.aiPrompt.newValue == null ? "" : changes.aiPrompt.newValue; }
    if (changes.kbShortcuts) { kbShortcuts = changes.kbShortcuts.newValue !== false; }
    if (changes.mnxMissedMode) { missedMode = changes.mnxMissedMode.newValue || "move"; }
    if (changes.akMissedDeck) { plannedMissedDeck = changes.akMissedDeck.newValue || ""; }
  });

  // ---- which resources you actually use -----------------------------------
  // openResources: what to re-open on the next question (your working set).
  // resourceUses:  how often you've opened each, which decides the order.
  // How "Save to Missed Qs" keeps a question: "move" | "tag" | "copy".
  // Chosen in the popup; "move" until you say otherwise.
  let missedMode = "move";
  let plannedMissedDeck = "";              // base deck name chosen in the popup
  let openResources = new Set();
  let resourceUses = {};
  chrome.storage.local.get({ mnxOpenResources: [], mnxResourceUses: {}, mnxMissedMode: "move", akMissedDeck: "" }, c => {
    openResources = new Set(c.mnxOpenResources || []);
    resourceUses = c.mnxResourceUses || {};
    missedMode = c.mnxMissedMode || "move";
    plannedMissedDeck = c.akMissedDeck || "";
  });
  function rememberResource(label, opened) {
    if (opened) {
      openResources.add(label);
      resourceUses[label] = (resourceUses[label] || 0) + 1;
    } else {
      openResources.delete(label);
    }
    chrome.storage.local.set({
      mnxOpenResources: Array.from(openResources),
      mnxResourceUses: resourceUses
    });
  }

  function toast(text) {
    const t = document.createElement("div");
    t.className = "mnx-toast";
    t.textContent = text;
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  // ============================================================
  // FEATURE 1 - buttons on the test RESULTS page
  // ============================================================
  // The "Question List" modal lists every QID with colour (green=correct,
  // red=incorrect, blue=omitted) and a flag icon on marked ones - it's both
  // complete (no 10-row pagination) and the only place marked status shows. So
  // prefer it when open; fall back to the paginated results table otherwise.
  function questionListRoot() {
    let best = null;
    for (const el of document.querySelectorAll("div, section, [role=dialog]")) {
      const t = el.textContent || "";
      if (t.length > 8000) continue;
      if (/correct/i.test(t) && /incorrect/i.test(t) && /marked/i.test(t) && /omitted/i.test(t)) {
        if (!best || t.length < best.textContent.length) best = el;
      }
    }
    return best;
  }
  // Status is carried by Coursology's Tailwind text-colour class on each QID span
  // (verified on the live modal); fall back to the computed colour just in case.
  function elColorStatus(el) {
    const cls = (el.className && el.className.baseVal != null) ? el.className.baseVal : (el.className || "");
    if (/text-red/i.test(cls)) return "wrong";
    if (/text-lime|text-green/i.test(cls)) return "correct";
    if (/text-sky|text-blue/i.test(cls)) return "omitted";
    let c; try { c = getComputedStyle(el).color; } catch (e) { return ""; }
    const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return "";
    const r = +m[1], g = +m[2], b = +m[3];
    if (r > 130 && r > g + 40 && r > b + 40) return "wrong";
    if (g > 110 && g > r + 25 && g > b + 5) return "correct";
    if (b > 130 && b > r + 30 && b > g + 20) return "omitted";
    return "";
  }
  // Marked QIDs carry an inline flag icon INSIDE the span (e.g. <svg data-icon="flag">).
  function elHasFlag(el) {
    return !!(el.querySelector && el.querySelector("svg, [data-icon='flag'], [class*='fa-flag'], [class*='flag']"));
  }
  function ownNumber(el) {                       // the element's own text, if it's just a QID
    let s = "";
    el.childNodes.forEach(n => { if (n.nodeType === 3) s += n.nodeValue; });
    const m = s.trim().match(/^(\d{1,7})\s*,?\s*$/);
    return m ? m[1] : null;
  }
  function parseQuestionList() {
    // An adapter whose list dialog has its own shape parses it itself.
    if (SITE.questionListRows) {
      try { const own = SITE.questionListRows(); if (own && own.length) return own; } catch (e) {}
    }
    // The generic scan below hunts for any block mentioning correct/incorrect/
    // marked/omitted and reads every bare number in it as a question id. That's
    // right for Coursology's legend-bearing modal and wrong for a stats page
    // that happens to use the same words, so it's opt-in.
    if (!SITE.usesGenericQuestionList) return null;
    const root = questionListRoot();
    if (!root) return null;
    const rows = []; const seen = new Set();
    root.querySelectorAll("*").forEach(el => {
      const qid = ownNumber(el);
      if (!qid || seen.has(qid)) return;
      seen.add(qid);
      const st = elColorStatus(el);
      rows.push({ qid, wrong: st === "wrong", correct: st === "correct", omitted: st === "omitted", marked: elHasFlag(el) });
    });
    return rows.length ? rows : null;
  }
  // The Question List popup is a Radix element with NO role=dialog that closes
  // the instant you click a button outside it - so at click-time it's gone. We
  // cache its contents while it's on screen (captureQuestionList, each tick) and
  // read the cache at click-time. Keyed by path so it never leaks across tests.
  let qlistCache = null;   // { path, rows }
  function captureQuestionList() {
    if (SITE.questionListRows) {                           // adapter has its own dialog
      try {
        const own = SITE.questionListRows();
        if (own && own.length) { qlistCache = { path: location.pathname, rows: own }; return; }
      } catch (e) {}
    }
    let present = false;                                   // cheap gate: a radix popover showing the legend
    for (const el of document.querySelectorAll("[id^='radix-']")) {
      if (/Omitted/i.test(el.textContent || "")) { present = true; break; }
    }
    if (!present) return;
    const rows = parseQuestionList();
    if (rows && rows.length) qlistCache = { path: location.pathname, rows };
  }
  function questionListData() {
    const live = parseQuestionList();
    if (live && live.length) { qlistCache = { path: location.pathname, rows: live }; return live; }
    return qlistCached();
  }
  // What captureQuestionList already read, without scanning the page again.
  function qlistCached() {
    return (qlistCache && qlistCache.path === location.pathname) ? qlistCache.rows : null;
  }
  function resultData() { return questionListData() || SITE.resultRows(); }
  function collectAll() { return resultData().map(r => r.qid); }
  // An omitted question is not a question you know. The results TABLE can't
  // tell omitted from correct (no icon either way), but the Question List can —
  // so when that data is available, omitted counts as missed.
  function collectMissed() { return resultData().filter(r => r.wrong || r.omitted).map(r => r.qid); }

  // ---- block breakdown: read the results table's Subject/System/Topic columns ----
  function findResultColumns() {
    for (const table of document.querySelectorAll("table")) {
      const heads = Array.from(table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td"));
      const idx = {};
      heads.forEach((h, i) => {
        const t = (h.textContent || "").trim().toLowerCase();
        if (t === "id" && idx.id == null) idx.id = i;
        else if (/^subject/.test(t) && idx.subject == null) idx.subject = i;
        else if (/^system/.test(t) && idx.system == null) idx.system = i;
        else if (/^topic/.test(t) && idx.topic == null) idx.topic = i;
      });
      if (idx.id == null) continue;
      const body = Array.from(table.querySelectorAll("tbody tr"));
      const rows = body.length ? body : Array.from(table.querySelectorAll("tr")).slice(1);
      return { idx, rows };
    }
    return null;
  }
  // The results table's rows with their Subject/System/Topic. The table can't
  // tell an OMITTED question from a correct one (neither has a cross), so
  // when the Question List has been opened its status is merged in -- and
  // `omittedKnown` says whether that happened, so the breakdown can say so.
  function blockRows() {
    const loc = findResultColumns();
    if (!loc) return [];
    const cell = (tr, i) => { const c = i != null ? tr.children[i] : null; return c ? (c.textContent || "").trim() : ""; };
    const list = qlistCached();
    const status = new Map((list || []).map(r => [r.qid, r]));
    const out = []; const seen = new Set();
    loc.rows.forEach(tr => {
      const idCell = tr.children[loc.idx.id]; if (!idCell) return;
      const m = (idCell.textContent || "").match(/\d+/); if (!m || seen.has(m[0])) return; seen.add(m[0]);
      const st = status.get(m[0]);
      out.push({ qid: m[0], wrong: rowIsWrong(tr, idCell) || !!(st && st.wrong), omitted: !!(st && st.omitted),
                 subject: cell(tr, loc.idx.subject), system: cell(tr, loc.idx.system), topic: cell(tr, loc.idx.topic) });
    });
    out.omittedKnown = !!list;
    return out;
  }
  // What the qbank says each question was about, kept with the question in the
  // tracker, so "Save to Missed Qs" can later suggest the chapter matching the
  // question's own system.
  function rememberQuestionMeta(rows) {
    const slug = currentQbankSlug();
    let changed = false;
    rows.forEach(r => {
      if (!r.system && !r.subject) return;
      const key = slug + " " + r.qid;
      const e = trackerLog.answered[key] || (trackerLog.answered[key] = { ts: null, slug, qid: r.qid, src: "results" });
      if (e.sys !== r.system || e.subj !== r.subject) { e.sys = r.system || ""; e.subj = r.subject || ""; changed = true; }
    });
    if (changed) saveLog();
  }
  // One definition of "missed", used by the breakdown, the buttons and the
  // accuracy figures alike: anything you didn't get right.
  function isMissed(r) { return !!(r.wrong || r.omitted || wasGuessed(r.qid)); }
  // A right answer you weren't sure of is not a question you know, so the
  // breakdown, the accuracy figures and "Anki: Missed" all count it as weak.
  function wasGuessed(qid) {
    const e = trackerLog.answered[currentQbankSlug() + " " + qid];
    return !!(e && (e.conf === "guessed" || e.conf === "noidea"));
  }
  // Weakest first, by smoothed accuracy, with groups too small to judge ranked
  // last (lib/weak.js explains the arithmetic).
  function aggregateBy(rows, key) {
    return Wk.aggregate(rows, key, isMissed, r => wasGuessed(r.qid)).groups;
  }
  // Text, not a bar — so the text-safe variants, which are darker in the light
  // theme. The fill colours read 2.83 to 4.09 against our own surfaces.
  function accColor(a) { return a >= 0.75 ? "var(--mnx-good-txt)" : a >= 0.5 ? "var(--mnx-warn-txt)" : "var(--mnx-bad-txt)"; }
  function openBreakdown() {
    const rows = blockRows();
    if (!rows.length) { toast("Couldn't read the results table — open the test results (and set the page size to All)."); return; }
    const dims = [["system", "System"], ["subject", "Subject"], ["topic", "Topic"]].filter(([k]) => rows.some(r => r[k]));
    if (!dims.length) { toast("No Subject/System/Topic columns found on this results table."); return; }
    let key = dims[0][0];
    const m = buildModal("Block breakdown — weakest first");
    let seg;
    if (dims.length > 1) {
      seg = document.createElement("div"); seg.className = "mnx-seg"; seg.style.marginBottom = "8px";
      dims.forEach(([k, label]) => {
        const b = document.createElement("button"); b.type = "button"; b.textContent = label; if (k === key) b.className = "on";
        b.addEventListener("click", onUserClick(() => { key = k; Array.from(seg.children).forEach(c => c.classList.remove("on")); b.classList.add("on"); render(); }));
        seg.appendChild(b);
      });
      m.body.appendChild(seg);
    }
    const sub = document.createElement("div"); sub.className = "mnx-brk-sub";
    const list = document.createElement("div");
    m.body.appendChild(sub); m.body.appendChild(list);
    const why = document.createElement("div"); why.className = "mnx-md-hint"; why.style.marginTop = "12px";
    why.textContent = "Ranked by accuracy adjusted for how many questions each has, so one unlucky question " +
      "doesn't outrank a real weak spot. Groups with fewer than " + Wk.MIN_N + " questions are listed last. " +
      "Guessed and “no idea” answers count as missed." +
      (rows.omittedKnown ? "" : " Omitted questions count as correct here — open the test's Question List once to count them as missed.");
    m.body.appendChild(why);
    let shownGroups = [];
    function render() {
      const groups = aggregateBy(rows, key);
      shownGroups = groups;
      const total = rows.length, correct = rows.filter(r => !isMissed(r)).length;
      const pag = (total === 10 || total === 20 || total === 25) ? " · set page size to All for the whole block" : "";
      sub.textContent = total + " questions · " + correct + " correct (" + Math.round(100 * correct / total) + "%)" + pag;
      list.replaceChildren();
      groups.forEach(g => {
        const row = document.createElement("div"); row.className = "mnx-brk-row";
        const name = document.createElement("div"); name.className = "mnx-brk-name"; name.textContent = g.name;
        if (g.few) {
          const few = document.createElement("span"); few.className = "mnx-brk-few"; few.textContent = "few questions";
          few.title = "Only " + g.total + " question" + (g.total === 1 ? "" : "s") + " — too few to call it a weak area yet";
          name.appendChild(few);
        }
        const pct = document.createElement("div"); pct.className = "mnx-brk-pct"; pct.textContent = Math.round(g.acc * 100) + "%"; pct.style.color = accColor(g.acc);
        pct.title = "Raw " + Math.round(g.acc * 100) + "% · adjusted " + Math.round(g.smoothed * 100) + "% (used for the order)";
        const bar = document.createElement("div"); bar.className = "mnx-brk-bar";
        const fill = document.createElement("div"); fill.className = "mnx-brk-fill"; fill.style.width = Math.round(g.acc * 100) + "%"; fill.style.background = accColor(g.acc); bar.appendChild(fill);
        const meta = document.createElement("div"); meta.className = "mnx-brk-meta";
        const cnt = document.createElement("span"); cnt.className = "mnx-brk-count";
        cnt.textContent = g.correct + "/" + g.total + (g.guessed ? " · " + g.guessed + " guessed" : "");
        meta.appendChild(cnt);
        if (g.wrongQids.length) {
          const open = document.createElement("button"); open.type = "button"; open.className = "mnx-brk-open";
          open.textContent = "Open " + g.wrongQids.length + " missed";
          open.addEventListener("click", onUserClick(() => runBrowse(g.wrongQids)));
          meta.appendChild(open);
        }
        row.appendChild(name); row.appendChild(pct); row.appendChild(bar); row.appendChild(meta);
        list.appendChild(row);
      });
    }
    render();

    // The breakdown told you where you're weak but left you to open each group
    // by hand. This takes the three worst groups that actually have misses and
    // sends the lot to Anki in one go — the drill you'd have assembled yourself.
    function drillWeakest() {
      const weak = Wk.weakest(shownGroups, 3);
      if (!weak.length) { toast("No missed questions to drill in this block."); return; }
      const seen = new Set(); const qids = [];
      weak.forEach(g => g.wrongQids.forEach(q => { if (!seen.has(q)) { seen.add(q); qids.push(q); } }));
      toast("Opening " + qids.length + " missed from " + weak.map(g => g.name).join(", ") + ".");
      runBrowse(qids);
    }
    m.foot.appendChild(mdButton("Drill weakest 3", "mnx-md-cancel", drillWeakest));
    m.foot.appendChild(mdButton("Open all missed", "mnx-md-cancel", () => runBrowse(rows.filter(isMissed).map(r => r.qid))));
    m.foot.appendChild(mdButton("Close", "mnx-md-ok", m.close));
  }
  // Marked status only exists in the Question List popup - so require it (cached
  // is fine); the results table can't tell us which questions were flagged.
  function runMarked() {
    const d = questionListData();
    if (!d) { toast("Open the test's “Question List” once so I can read your flagged questions, then click Anki: Marked again."); return; }
    const qids = d.filter(r => r.marked).map(r => r.qid);
    if (!qids.length) { toast("No marked questions in this test."); return; }
    runBrowse(qids);
  }
  function buildTagQuery(qids, sv) {
    return qids.filter(q => safeQidOrNull(q)).map(q => qidQuery(q, sv)).join(" OR ");
  }
  const HY_LEVELS = ["HighYield", "RelativelyHighYield"];
  function runBrowse(qids) {
    if (!qids.length) { toast("No matching questions found on this page."); return; }
    getSv().then(sv => {
      const query = buildTagQuery(qids, sv);
      // Every id was unreadable. An empty query is not "browse nothing" in
      // Anki -- it selects the whole collection, so stop here instead.
      if (!query) { toast("Couldn't read the question ids on this page."); return; }
      if (easyOn) { easyUnsuspend(query); return; }
      if (hyOn) { browseHighYield(query); return; }
      bridge("openBrowser", { query }).catch(e => toast(bridgeFailure(e)));
    });
  }
  // High Yield Only (Browse): resolve the exact high-yield card ids, then open
  // the Browser scoped to just those cards. Yield comes from the parsed level,
  // not a tag-text match, so the parent #Low/HighYield tag can't leak in.
  function browseHighYield(query) {
    bridge("cardStats", { queries: [query] }).then(r => {
      const cards = (r && r[0]) || [];
      if (!cards.length) { toast("None of these matched a card in your deck yet."); return; }
      const cids = cards.filter(c => HY_LEVELS.includes(c.yield)).map(c => c.cid).filter(x => x != null);
      if (!cids.length) { toast("No high-yield cards among these questions."); return; }
      bridge("openBrowser", { query: "cid:" + cids.join(",") }).catch(e => toast(bridgeFailure(e)));
    }).catch(e => toast(bridgeFailure(e)));
  }
  // Easy mode: count matches, confirm with the locked number, then unsuspend.
  function easyUnsuspend(query) {
    bridge("cardStats", { queries: [query] }).then(r => {
      let cards = (r && r[0]) || [];
      if (hyOn) cards = cards.filter(c => HY_LEVELS.includes(c.yield));
      const matched = cards.length;
      const locked = cards.filter(c => c.suspended).length;
      if (!matched) { toast(hyOn ? "No high-yield cards among these questions." : "None of these matched a card in your deck yet."); return; }
      if (!locked) { toast("All " + matched + " matching card" + (matched === 1 ? " is" : "s are") + " already in your reviews."); return; }
      showConfirm(matched, locked, () => {
        const params = { queries: [query] };
        if (hyOn) params.yields = HY_LEVELS;
        bridge("unsuspend", params).then(r2 => {
          const n = (r2 && r2[0] && r2[0].unlocked) || 0;
          toast("Added " + n + " card" + (n === 1 ? "" : "s") + " to your reviews.");
        }).catch(e => toast(bridgeFailure(e)));
      });
    }).catch(e => toast(bridgeFailure(e)));
  }
  function showConfirm(matched, locked, onYes) {
    const old = document.getElementById("mnx-confirm"); if (old) old.remove();
    const o = document.createElement("div");
    o.id = "mnx-confirm";
    o.classList.toggle("mnx-dark", darkMode);
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    function close() { document.removeEventListener("keydown", onKey, true); o.remove(); }
    o.addEventListener("click", e => { if (e.target === o) close(); });
    const box = document.createElement("div"); box.className = "mnx-cf-box";
    const h = document.createElement("div"); h.className = "mnx-cf-title"; h.textContent = "Add cards to your reviews?";
    const body = document.createElement("div"); body.className = "mnx-cf-body";
    const subj = matched === locked
      ? ("All " + locked + " matching card" + (locked === 1 ? "" : "s"))
      : (locked + " of " + matched + " matching cards");
    body.textContent = subj + " " + (locked === 1 ? "is" : "are") + " locked. Unlock " + (locked === 1 ? "it" : "them")
      + " so " + (locked === 1 ? "it shows" : "they show") + " up when you study?";
    const btns = document.createElement("div"); btns.className = "mnx-cf-btns";
    const cancel = document.createElement("button"); cancel.className = "mnx-cf-btn mnx-cf-cancel"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const ok = document.createElement("button"); ok.className = "mnx-cf-btn mnx-cf-ok"; ok.textContent = "Unlock " + locked;
    // The page could click this for you the moment it appears; only a real
    // click unlocks cards.
    ok.addEventListener("click", onUserClick(() => { close(); onYes(); }));
    btns.appendChild(cancel); btns.appendChild(ok);
    box.appendChild(h); box.appendChild(body); box.appendChild(btns);
    o.appendChild(box);
    (document.body || document.documentElement).appendChild(o);
    document.addEventListener("keydown", onKey, true);
  }
  // High-Yield button: always restrict to high-yield cards (QID tag AND the
  // AnKing #Low/HighYield level), regardless of the popup toggle. Yield is read
  // from the parsed level so the parent tag can't leak in.
  function runBrowseHighYield(qids) {
    if (!qids.length) { toast("No matching questions found on this page."); return; }
    getSv().then(sv => {
      const query = buildTagQuery(qids, sv);
      if (!query) { toast("Couldn't read the question ids on this page."); return; }
      browseHighYield(query);
    });
  }
  // Our UI lives in the page's DOM, which page script can also reach: it can call
  // .click() or dispatch synthetic events. Anything that talks to Anki goes
  // through here so it only ever runs on real user input.
  function onUserClick(fn) {
    return e => {
      if (!e || !e.isTrusted) return;
      if (typeof fn === "function") fn(e);
    };
  }
  function makeBtn(label, getQids, runner) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "review-button mnx-btn";
    b.addEventListener("click", onUserClick(() => (runner || runBrowse)(getQids())));
    return b;
  }
  function addButtons(toolbar) {
    const host = document.createElement("span");
    host.id = BTN_HOST_ID;
    host.appendChild(makeBtn("Anki: Missed", () => collectMissed()));          // wrong questions
    host.appendChild(makeBtn("Anki: All", () => collectAll()));                // every question on the page
    host.appendChild(makeBtn("Anki: Marked", () => null, runMarked));          // flagged questions (from Question List)
    const hy = makeBtn("Anki: High-Yield", () => collectAll(), runBrowseHighYield);
    hy.classList.add("mnx-hy");                                              // high-yield cards only
    host.appendChild(hy);
    const brk = makeBtn("📊 Weak areas", () => [], () => openBreakdown());     // per-system accuracy breakdown
    brk.classList.add("mnx-brkbtn");
    host.appendChild(brk);
    toolbar.appendChild(host);
  }

  // ============================================================
  // FEATURE 2 - resource table + image overlay on the REVIEW page
  // ============================================================
  // Resources shown in the review panel. The panel only renders the ones that
  // actually have content for a given question, so listing Step-1 and Step-2
  // resources together is safe: OME/Picmonic light up on Step 2/3, the rest on
  // Step 1. (All fields exist on the shared AnKingOverhaul note type.)
  const RESOURCES = [
    { label: "Sketchy",         color: "#1aa7e0", fields: ["Sketchy", "Sketchy 2", "Sketchy Extra"], tag: "#Sketchy" },
    { label: "Boards & Beyond", color: "#2f9e44", fields: ["Boards & Beyond", "Boards and Beyond", "B&B"], tag: ["#B&B", "#BoardsandBeyond", "#Boards_and_Beyond"] },
    { label: "OME",             color: "#ef6c3b", fields: ["OME"], tag: "#OME" },
    { label: "Bootcamp",        color: "#8e63d6", fields: ["Bootcamp"], tag: "#Bootcamp" },
    { label: "Physeo",          color: "#27a39a", fields: ["Physeo"], tag: "#Physeo" },
    { label: "Pixorize",        color: "#ec6aa0", fields: ["Pixorize"], tag: "#Pixorize" },
    { label: "Picmonic",        color: "#7b5cf6", fields: ["Picmonic"], tag: "#Picmonic" },
    { label: "First Aid",       color: "#f0a020", fields: ["First Aid"], tag: "#FirstAid" }
  ];
  // Image overlay sources: each key is the hotkey, `fields` are the AnKing field
  // names whose <img> tags get pulled. Field names confirmed against the live
  // AnKingOverhaul note type (2026-06-15). Add a row here on any unused letter
  // to expose more (e.g. Physeo / OME also carry images).
  const IMG_SOURCES = {
    F: { label: "First Aid",            fields: ["First Aid"] },
    S: { label: "Sketchy",              fields: ["Sketchy", "Sketchy 2", "Sketchy Extra"] },
    P: { label: "Physeo",               fields: ["Physeo"] },
    O: { label: "OME",                  fields: ["OME"] },
    // E and A open the whole field -- text and images, card by card -- not
    // just its pictures: on Step 2/3 cards these fields are mostly text, and a
    // text-only Extra used to answer "No Extra image for this question".
    E: { label: "Extra",                fields: ["Extra", "Back Extra"], field: true },
    A: { label: "Additional Resources", fields: ["Additional Resources"], field: true }
  };
  // The same two fields as rows at the top of the panel.
  const FIELD_ROWS = [
    { label: "Extra", key: "E", fields: ["Extra", "Back Extra"], color: "#64748b" },
    { label: "Additional Resources", key: "A", fields: ["Additional Resources"], color: "#0891b2" }
  ];
  function emptyFiles() { const o = {}; for (const k in IMG_SOURCES) o[k] = []; return o; }
  function emptyUris() { const o = {}; for (const k in IMG_SOURCES) o[k] = null; return o; }

  // ---- one question at a time ----------------------------------------------
  // Everything the page knows about the question on screen lives in ONE object,
  // replaced whole when the question changes. Each await in a build checks it
  // is still the current one before it writes anything.
  //
  // Before, this state was five separate globals. A slow answer from Anki for
  // question A, landing after you'd moved to B, painted A's cards and resources
  // onto B -- and Save, Preview and the image keys then acted on A's notes.
  //
  //   qid, gen     which question, and which attempt at building it
  //   sv, query    the step and the exact search that matched (follow-up calls
  //                reuse them, so they always agree with what the panel shows)
  //   notes        matched notes, most specific first
  //   files, uris  image filenames per overlay key, and their loaded data
  //   ready        the panel for this question is fully built
  let Q = null;
  let qGen = 0;
  function newSession(qid) {
    Q = { qid, gen: ++qGen, sv: null, query: null, found: null, notes: [], files: emptyFiles(),
          uris: emptyUris(), missing: {}, ready: false, building: false, retries: 0 };
    return Q;
  }
  const isLive = s => !!s && s === Q;

  // The review player prints "Question Id: NNNNN" in its header. We read that to
  // key every per-question feature (resource panel, overlay, copy buttons). The
  // scopes in SITE.headerSel are tried first (cheaper), then document.body.
  //
  // On Coursology the id has no dedicated element, so this used to read the
  // whole page's text several times a second. The element that held it last
  // time is checked first; the full scan only runs when that element is gone.
  let qidEl = null;
  function qidFromText(text) {
    for (const re of SITE.qidRe) { const m = (text || "").match(re); if (m) return m[1]; }
    return null;
  }
  function findQid() {
    // An adapter can read the id straight out of a dedicated element; the
    // header + regex scan below is the fallback for when that element moves.
    if (SITE.findQid) {
      try { const v = SITE.findQid(); if (v) return v; } catch (e) {}
    }
    // Still attached AND still shown: a hidden copy of the previous question
    // left in the DOM must never answer for the one on screen.
    if (qidEl && qidEl.isConnected && qidEl.getClientRects().length) {
      const v = qidFromText(qidEl.textContent);
      if (v) return v;
    }
    qidEl = null;
    for (const sel of SITE.headerSel) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const v = qidFromText(el.textContent);
      if (v) {
        if (el !== document.body) qidEl = el;
        else { const small = qidLabelEl(); if (small && qidFromText(small.textContent) === v) qidEl = small; }
        return v;
      }
    }
    return null;
  }
  // We show resources only while reviewing an answered question
  // (so we never spoil an unanswered one) and only once a QID is on the page.
  function isAnswered() {
    return SITE.isReviewing() && !!findQid();
  }
  // Resolve a field by name, case-insensitively, so capitalization/spacing drift
  // across AnKing deck versions still matches.
  function getField(note, name) {
    if (!note || !note.fields) return null;
    if (note.fields[name]) return note.fields[name];
    const lower = name.toLowerCase();
    for (const k in note.fields) if (k.toLowerCase() === lower) return note.fields[k];
    return null;
  }
  function fieldAnchors(note, names) {
    const out = [];
    const parser = new DOMParser();
    names.forEach(n => {
      const f = getField(note, n);
      if (!f || !f.value) return;
      const doc = parser.parseFromString(f.value, "text/html");
      doc.querySelectorAll("a[href]").forEach(a => {
        // Deck HTML is untrusted — keep only plain web links.
        const href = safeLinkUrl(a.getAttribute("href"));
        if (href) out.push({ href, text: a.textContent.trim() || href });
      });
    });
    return out;
  }
  function fieldImages(note, names) {
    const out = [];
    const parser = new DOMParser();
    names.forEach(n => {
      const f = getField(note, n);
      if (!f || !f.value) return;
      const doc = parser.parseFromString(f.value, "text/html");
      doc.querySelectorAll("img[src]").forEach(img => {
        const src = safeMediaSrc(img.getAttribute("src"));    // media filename or data: image
        if (src) out.push(src);
      });
    });
    return out;
  }
  function mimeFor(fn) {
    const ext = (fn.split(".").pop() || "").toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "svg") return "image/svg+xml";
    return "image/png";
  }
  // items: [{fn, card}] -> {pages: [{uri, card}], missing}. Three requests at a
  // time instead of one after another, so a six-page topic opens in a third of
  // the time. A file your collection doesn't have is COUNTED, not silently
  // dropped, so the overlay can say "2 images are missing" instead of quietly
  // showing four of six. A data: image already in the field is used as is.
  async function fetchImages(items, isCurrent) {
    const out = new Array(items.length);
    let missing = 0, next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++, it = items[i];
        if (isCurrent && !isCurrent()) return;
        if (/^data:/i.test(it.fn)) { out[i] = { uri: it.fn, card: it.card }; continue; }
        try {
          const b64 = await bridge("readMedia", { filename: it.fn });
          if (b64) out[i] = { uri: "data:" + mimeFor(it.fn) + ";base64," + b64, card: it.card };
          else missing++;
        } catch (e) { missing++; }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    return { pages: out.filter(Boolean), missing };
  }
  // `s` stamps the panel with the question it shows (data-qid), so a panel can
  // always be checked against the question on the page.
  function ensurePanel(s) {
    let panel = document.getElementById(PANEL_ID);
    if (panel) { panel.classList.toggle("mnx-dark", darkMode); if (s) panel.dataset.qid = s.qid; return panel; }
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    if (s) panel.dataset.qid = s.qid;
    if (darkMode) panel.classList.add("mnx-dark");
    const anchor = SITE.panelAnchor();
    if (anchor) anchor.appendChild(panel);
    else { panel.classList.add("mnx-float"); document.body.appendChild(panel); }
    return panel;
  }
  // If the qbank squashes or hides the in-flow card, pop it out as a floating card.
  function ensureVisible() {
    const p = document.getElementById(PANEL_ID);
    if (!p || p.classList.contains("mnx-float")) return;
    const r = p.getBoundingClientRect();
    if (p.offsetParent === null || r.height < 2 || r.width < 2) {
      p.classList.add("mnx-float");
      document.body.appendChild(p);
      return;
    }
    clearFixedOverlap(p);
  }

  // Qbanks pin their own furniture over the page — Coursology's question rail is
  // position:fixed, left:0, 118px wide, z-index 1000 — and it sat directly on top
  // of our first column, hiding the resource names entirely. Measure whatever is
  // actually pinned over our left edge and step out of its way.
  function clearFixedOverlap(p) {
    const r = p.getBoundingClientRect();
    if (r.width < 40) return;
    const mid = r.top + Math.min(r.height, window.innerHeight) / 2;
    let worst = 0;
    for (const el of document.querySelectorAll("div,nav,aside,header,section")) {
      if (el === p || p.contains(el) || el.contains(p)) continue;
      if (el.id && el.id.indexOf("mnx-") === 0) continue;
      // Cheap geometry first — getComputedStyle on every node would be slow.
      const b = el.getBoundingClientRect();
      if (b.width < 24 || b.height < 120) continue;          // not a rail
      if (b.left > r.left + 8) continue;                     // not over our left edge
      if (b.bottom < mid || b.top > mid) continue;            // not level with us
      const st = getComputedStyle(el);
      if (st.position !== "fixed" && st.position !== "sticky") continue;
      if (st.visibility === "hidden" || st.display === "none" || +st.opacity === 0) continue;
      const overlap = b.right - r.left;
      if (overlap > worst && overlap < r.width * 0.5) worst = overlap;
    }
    const pad = worst > 0 ? Math.ceil(worst) + 10 : 0;
    if (String(p.dataset.mnxPad || "") === String(pad)) return;
    p.dataset.mnxPad = String(pad);
    p.style.marginLeft = pad ? pad + "px" : "";
  }
  function akNorm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  function akLinkTopic(text) {
    return akNorm(text)
      .replace(/^watch\s+/, "").replace(/^associated\s+/, "")
      .replace(/^(bootcamp|sketchy)\s+/, "").replace(/^video\s+/, "").trim();
  }
  function akTokens(s) { return akNorm(s).split(" ").filter(w => w.length > 2); }
  function akClose(a, b) {            // true if within ~1 character edit (typo tolerance)
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    if (i < a.length || j < b.length) edits++;
    return edits <= 1;
  }
  function akTokenFound(w, arr) {
    for (const t of arr) { if (w === t) return true; if (w.length >= 4 && akClose(w, t)) return true; }
    return false;
  }
  // Returns null for anything that isn't a plain web link, so untrusted deck HTML
  // can never put a javascript:/data: URL in the panel. Callers must skip null.
  function makeLink(href, text, cls) {
    const safe = safeLinkUrl(href);
    if (!safe) return null;
    const a = document.createElement("a");
    a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = text; if (cls) a.className = cls;
    return a;
  }
  // grouped-by-chapter view; a leaf gets an inline "Watch" if a video link matches it
  function renderResource(td, paths, links) {
    links = links.slice();
    if (!paths.length) {
      links.forEach(l => { const a = makeLink(l.href, l.text, "mnx-link"); if (a) td.appendChild(a); });
      return;
    }
    const leaves = paths.map(p => ({ parent: p.segs.slice(0, -1).join(" › "), leaf: p.segs[p.segs.length - 1], n: p.n }));
    const linkTokens = links.map(l => akTokens(akLinkTopic(l.text)));
    const TH = 0.6;                 // a topic matches a video if >=60% of its words appear in it
    const pairs = [];
    leaves.forEach((lf, li) => {
      const L = akTokens(lf.leaf);
      if (!L.length) return;
      links.forEach((lk, ki) => {
        let hit = 0; for (const w of L) if (akTokenFound(w, linkTokens[ki])) hit++;
        const score = hit / L.length;
        if (score >= TH) pairs.push({ li, ki, score });
      });
    });
    pairs.sort((a, b) => b.score - a.score);   // assign strongest matches first
    const used = new Set(), usedLeaf = new Set();
    for (const p of pairs) {
      if (usedLeaf.has(p.li) || used.has(p.ki)) continue;
      leaves[p.li].watch = links[p.ki].href;
      usedLeaf.add(p.li); used.add(p.ki);
    }
    const order = []; const groups = new Map();
    for (const lf of leaves) {
      if (!groups.has(lf.parent)) { groups.set(lf.parent, []); order.push(lf.parent); }
      groups.get(lf.parent).push(lf);
    }
    for (const parent of order) {
      const g = document.createElement("div");
      g.className = "mnx-group";
      if (parent) {
        const ph = document.createElement("div");
        ph.className = "mnx-parent"; ph.textContent = parent;
        g.appendChild(ph);
      }
      for (const lf of groups.get(parent)) {
        const r = document.createElement("div");
        r.className = "mnx-leaf-row";
        const ls = document.createElement("span");
        ls.className = "mnx-leaf"; ls.textContent = lf.leaf;
        r.appendChild(ls);
        if (lf.n > 1) {
          const w = document.createElement("span");
          w.className = "mnx-weight"; w.textContent = "×" + lf.n;
          w.title = lf.n + " of this question's cards are tagged here";
          r.appendChild(w);
        }
        if (lf.watch) { const a = makeLink(lf.watch, "Watch", "mnx-watch"); if (a) r.appendChild(a); }
        g.appendChild(r);
      }
      td.appendChild(g);
    }
    const leftover = links.filter((_, i) => !used.has(i));
    if (leftover.length) {
      const g = document.createElement("div");
      g.className = "mnx-group";
      leftover.forEach(l => { const a = makeLink(l.href, l.text, "mnx-link"); if (a) g.appendChild(a); });
      td.appendChild(g);
    }
  }
  function msgBox(lines) {
    const n = document.createElement("div"); n.className = "mnx-msg";
    lines.forEach((l, i) => {
      const d = document.createElement("div");
      if (i) d.className = "mnx-msg-why";
      d.textContent = l;
      n.appendChild(d);
    });
    return n;
  }
  function msgButton(label, fn) {
    const b = document.createElement("button"); b.type = "button"; b.className = "mnx-pbtn mnx-msg-btn";
    b.textContent = label; b.addEventListener("click", onUserClick(fn));
    return b;
  }
  // While Anki answers. A slow lookup used to leave nothing on screen at all,
  // which looks exactly like "no cards".
  function renderLoading(s) {
    if (!isLive(s)) return;
    const panel = ensurePanel(s);
    panel.replaceChildren(msgBox(["Looking up this question's cards in Anki…"]));
    ensureVisible();
  }
  // Anki couldn't be asked. Each cause gets its own words, and the panel tries
  // again on its own (and on a click) instead of staying red until you change
  // question -- the old dead end when Anki was opened after the answer.
  function renderFailure(s, err) {
    if (!isLive(s)) return;
    const panel = ensurePanel(s);
    panel.replaceChildren();
    const box = msgBox([bridgeFailure(err)]);
    const code = err && err.code;
    if (code !== "reload" && code !== "refused") {
      const row = document.createElement("div"); row.className = "mnx-msg-actions";
      row.appendChild(msgButton("Retry", () => rebuild(s.qid)));
      if (s.retryIn) {
        const t = document.createElement("span"); t.className = "mnx-msg-why";
        t.textContent = "Trying again in " + Math.round(s.retryIn / 1000) + "s.";
        row.appendChild(t);
      }
      box.appendChild(row);
    }
    panel.appendChild(box);
    ensureVisible();
  }
  function renderRows(s, rows, msg, found) {
    if (!isLive(s)) return;
    const qid = s.qid;
    const panel = ensurePanel(s);
    panel.replaceChildren();
    addPanelHeader(s);
    if (msg) {
      panel.appendChild(msgBox(Array.isArray(msg) ? msg : [msg])); ensureVisible(); return;
    }
    if (!s.notes.length) {
      // "Nothing found" used to be a dead end. Say which steps were searched and
      // what the query was, so the cause is obvious: untagged deck, renumbered
      // qbank, or an id this deck simply doesn't cover.
      const tried = (found && found.tried && found.tried.length) ? found.tried : null;
      const n = msgBox([
        "No AnKing cards are tagged with question id " + qid +
          (tried ? " (searched Step " + tried.join(", ") + ")." : "."),
        found && found.broad
          ? "A broader search found nothing either."
          : "Either your deck doesn't tag this question, or this qbank renumbered it."
      ]);
      const q = document.createElement("code");
      q.className = "mnx-msg-q";
      q.textContent = safeQidOrNull(qid) ? qidQuery(qid, (found && found.sv) || 1) : "(no usable question id on this page)";
      n.appendChild(q);
      const hint = document.createElement("div");
      hint.className = "mnx-msg-why";
      hint.textContent = "Paste that into Anki's Browse to check it yourself.";
      n.appendChild(hint);
      if (found && !found.broad && safeQidOrNull(qid)) {
        const row = document.createElement("div"); row.className = "mnx-msg-actions";
        row.appendChild(msgButton("Broader search", () => rebuild(qid, true)));
        const t = document.createElement("span"); t.className = "mnx-msg-why";
        t.textContent = "Also tries looser tag shapes. It can find unrelated cards (COMLEX ids), and says so.";
        row.appendChild(t);
        n.appendChild(row);
      }
      panel.appendChild(n); ensureVisible(); return;
    }
    // Say how the match was made whenever it wasn't the plain, exact one.
    if (found && (found.loose || found.otherStep)) {
      const note = document.createElement("div");
      note.className = "mnx-match-note" + (found.loose ? " mnx-approx" : "");
      note.textContent = found.loose
        ? "Approximate match: found with a broad tag search, which can include unrelated questions (e.g. COMLEX ids). Check the cards before saving."
        : "Matched through your deck's Step " + found.sv + " tags (this page looked like Step " + found.detected + ").";
      panel.appendChild(note);
    }
    const fieldRows = s.fieldRows || [];
    if ((!rows || !rows.length) && !fieldRows.length) {
      // Cards matched, but none of them carries a resource tag or field. This
      // used to fall into the "no cards are tagged" message above -- untrue,
      // and it hid the Preview / Save buttons' reason to exist.
      panel.appendChild(msgBox([
        s.notes.length + (s.notes.length === 1 ? " card matches" : " cards match") + " this question, but " +
          (s.notes.length === 1 ? "it carries no" : "none of them carries") + " First Aid, Sketchy or other resource tags.",
        "Preview and Save to Missed Qs still work."
      ]));
      ensureVisible(); return;
    }
    // Most-opened resources first, then the deck's own order. Ties keep the
    // original order so the list doesn't reshuffle on every question.
    const ordered = rows
      .map((row, i) => ({ row, i, uses: resourceUses[row.R.label] || 0 }))
      .sort((a, b) => (b.uses - a.uses) || (a.i - b.i))
      .map(x => x.row);

    for (const fr of fieldRows) panel.appendChild(buildFieldRow(fr, s));
    for (const row of ordered) {
      panel.appendChild(buildResourceRow(row, s));
    }
    ensureVisible();
  }

  // One collapsed resource: a summary you can scan, a body you opt into.
  function buildResourceRow(row, s) {
    const sec = document.createElement("section");
    sec.className = "mnx-r";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "mnx-r-head";
    head.style.borderLeftColor = row.R.color;
    head.setAttribute("aria-expanded", "false");

    const chev = document.createElement("span");
    chev.className = "mnx-r-chev";
    chev.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "mnx-r-name";
    name.textContent = row.R.label;

    const count = document.createElement("span");
    count.className = "mnx-r-count";
    const nTopics = row.paths.length, nLinks = row.links.length;
    count.textContent = nTopics
      ? nTopics + (nLinks ? " + " + nLinks + "▶" : "")
      : nLinks + "▶";
    count.title = nTopics + " chapter" + (nTopics === 1 ? "" : "s") +
      (nLinks ? ", " + nLinks + " video" + (nLinks === 1 ? "" : "s") : "");

    // Enough of the actual topics to decide without opening it.
    const peek = document.createElement("span");
    peek.className = "mnx-r-peek";
    peek.textContent = row.paths.length
      ? row.paths.slice(0, 3).map(p => p.segs[p.segs.length - 1]).join(" · ")
      : row.links.slice(0, 2).map(l => l.text).join(" · ");

    head.append(chev, name);

    // The overlay key, where this resource has one (F / S / P / O / E / A).
    // Right beside the name, so the shortcut is learned by association.
    const key = Object.keys(IMG_SOURCES).find(k => IMG_SOURCES[k].label === row.R.label);
    if (key) {
      const kb = document.createElement("button");
      kb.type = "button";
      kb.className = "mnx-r-key";
      kb.textContent = key;
      const nImg = (s && s.files[key] || []).length;
      kb.title = nImg
        ? "Show " + nImg + " " + row.R.label + " image" + (nImg === 1 ? "" : "s") + " over the question (or press " + key + ")"
        : "No " + row.R.label + " images on these cards";
      kb.setAttribute("aria-label", nImg ? "Show " + row.R.label + " images" : "No " + row.R.label + " images");
      // Still a button (it says so when pressed), but it no longer looks like it
      // opens something when these cards carry no images for it.
      if (!nImg) kb.classList.add("mnx-r-key-empty");
      // The images were keyboard-only, which also meant the shortcuts toggle
      // could never switch F/S/P/O off without hiding the feature entirely.
      kb.addEventListener("click", onUserClick((e) => { e.stopPropagation(); showImages(key); }));
      head.appendChild(kb);
    }
    head.append(count, peek);

    const body = document.createElement("div");
    body.className = "mnx-r-body";
    body.hidden = true;
    let built = false;

    // Kept separate from the click handler: restoring saved state must not go
    // through onUserClick, which (correctly) refuses anything untrusted.
    function setOpen(open, remember) {
      sec.classList.toggle("open", open);
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && !built) { renderResource(body, row.paths, row.links); built = true; }
      body.hidden = !open;
      if (remember) rememberResource(row.R.label, open);
    }
    head.addEventListener("click", onUserClick(() => setOpen(!sec.classList.contains("open"), true)));

    sec.append(head, body);
    if (openResources.has(row.R.label)) setOpen(true, false);   // restore what you had open
    return sec;
  }
  // An Extra / Additional Resources row: the field from each matched card,
  // text and images, rendered when you open it (images are fetched then too).
  function buildFieldRow(fr, s) {
    const label = fr.F.label, key = fr.F.key;
    const sec = document.createElement("section");
    sec.className = "mnx-r mnx-r-field";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "mnx-r-head";
    head.style.borderLeftColor = fr.F.color;
    head.setAttribute("aria-expanded", "false");
    const chev = document.createElement("span"); chev.className = "mnx-r-chev"; chev.setAttribute("aria-hidden", "true");
    const name = document.createElement("span"); name.className = "mnx-r-name"; name.textContent = label;
    const kb = document.createElement("button");
    kb.type = "button"; kb.className = "mnx-r-key"; kb.textContent = key;
    kb.title = "Show " + label + " over the question (or press " + key + ")";
    kb.setAttribute("aria-label", "Show " + label);
    kb.addEventListener("click", onUserClick((e) => { e.stopPropagation(); showImages(key); }));
    const count = document.createElement("span"); count.className = "mnx-r-count";
    const n = fr.items.length;
    count.textContent = n + (n === 1 ? " card" : " cards");
    count.title = n + " of this question's cards have " + label;
    const peek = document.createElement("span"); peek.className = "mnx-r-peek";
    peek.textContent = fieldSummary(fr.items[0].html);
    head.append(chev, name, kb, count, peek);
    const body = document.createElement("div"); body.className = "mnx-r-body"; body.hidden = true;
    let built = false;
    function setOpen(open, remember) {
      sec.classList.toggle("open", open);
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && !built) {
        built = true;
        fr.items.forEach(it => {
          const card = document.createElement("div"); card.className = "mnx-r-fieldcard";
          if (n > 1) { const h = document.createElement("div"); h.className = "mnx-r-fieldcard-h"; h.textContent = "Card " + it.card; card.appendChild(h); }
          const content = document.createElement("div"); content.className = "mnx-r-fieldcard-body";
          setSafeHtml(content, it.html);
          card.appendChild(content);
          body.appendChild(card);
        });
        resolveMediaImages(body, () => isLive(s) && body.isConnected);
      }
      body.hidden = !open;
      if (remember) rememberResource(label, open);
    }
    head.addEventListener("click", onUserClick(() => setOpen(!sec.classList.contains("open"), true)));
    sec.append(head, body);
    if (openResources.has(label)) setOpen(true, false);
    return sec;
  }
  // E / A: the whole field over the question, card by card.
  function showFieldOverlay(key) {
    const src = IMG_SOURCES[key];
    const s = Q;
    if (!s || !s.ready) return;
    const fr = (s.fieldRows || []).find(r => r.F.key === key);
    if (!fr) { toast("No " + src.label + " on this question's cards."); return; }
    const o = ensureOverlay();
    o.dataset.key = key; o.style.display = "flex"; o.replaceChildren(); o._mnxPage = null;
    o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true"); o.setAttribute("aria-label", src.label);
    const dlg = document.createElement("div"); dlg.className = "mnx-dialog";
    dlg.appendChild(buildHead(o, src.label, key));
    const body = document.createElement("div"); body.className = "mnx-ovl-field";
    fr.items.forEach(it => {
      const card = document.createElement("div"); card.className = "mnx-ovl-fieldcard";
      if (fr.items.length > 1) { const h = document.createElement("div"); h.className = "mnx-ovl-fieldcard-h"; h.textContent = "Card " + it.card; card.appendChild(h); }
      const content = document.createElement("div");
      setSafeHtml(content, it.html);
      card.appendChild(content);
      body.appendChild(card);
    });
    dlg.appendChild(body);
    o.appendChild(dlg);
    resolveMediaImages(body, () => isLive(s) && o.dataset.key === key && o.style.display === "flex");
  }
  function addImageHint(s) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !isLive(s)) return;
    // Each row now shows its own key badge, so this is a nudge, not a legend.
    let any = false;
    for (const k in IMG_SOURCES) if (s.files[k] && s.files[k].length) { any = true; break; }
    let txt = any
      ? (kbShortcuts ? "Press a resource's key, or click it, for its images · Esc closes"
                     : "Click a resource's key for its images · Esc closes")
      : "";
    if (kbShortcuts) txt += (txt ? "   ·   " : "") + "? for all shortcuts";
    if (!txt) return;
    const n = document.createElement("div");
    n.className = "mnx-note";
    n.textContent = txt;
    panel.appendChild(n);
  }
  function sourceOf() {
    try { return SITE.questionSource ? SITE.questionSource() : "unknown"; } catch (e) { return "unknown"; }
  }
  // Start over on a question: a new session, so anything still in flight for
  // the old one is ignored when it lands. `broad` = the user asked for the
  // looser tag search.
  function rebuild(qid, broad, retries) {
    const s = newSession(qid);
    s.broad = !!broad;
    s.retries = retries || 0;
    buildTable(s);
    return s;
  }
  // Anki closed, busy or still loading a profile usually sorts itself out, so
  // try again on a widening schedule while you stay on the question. A refused
  // pairing code doesn't -- that waits for you (pasting a code retries at once).
  const RETRY_STEPS = [3000, 8000, 15000, 30000, 60000];
  function buildFailed(s, err) {
    if (!isLive(s)) return;
    const code = err && err.code;
    const auto = code === "offline" || code === "timeout" || code === "anki";
    s.retryIn = auto && s.retries < RETRY_STEPS.length ? RETRY_STEPS[s.retries] : 0;
    renderFailure(s, err);
    if (s.retryIn) {
      setTimeout(() => { if (isLive(s)) rebuild(s.qid, s.broad, s.retries + 1); }, s.retryIn);
    }
  }
  async function buildTable(s) {
    hideOverlay();
    s.building = true;
    try { await buildSession(s); }
    catch (e) { buildFailed(s, bridgeError(String(e), "anki")); }
    finally { s.building = false; }
  }
  async function buildSession(s) {
    const qid = s.qid;
    if (sourceOf() === "other") {
      s.ready = true;
      renderRows(s, null, [
        "This question bank isn't UWorld's, so AnKing's UWorld tags can't be matched to its questions.",
        "Copy for AI and Make card still work here."
      ]);
      return;
    }
    renderLoading(s);
    const found = await resolveNotes(qid, s.broad);
    if (!isLive(s)) return;                                   // you moved on
    if (found.error) { buildFailed(s, found.error); return; }
    s.found = found; s.sv = found.sv; s.query = found.query;
    if (!found.nids.length) { s.ready = true; renderRows(s, [], null, found); return; }
    let notes;
    try { notes = await bridge("noteInfo", { notes: found.nids }); }
    catch (e) { buildFailed(s, e); return; }
    if (!isLive(s)) return;                                   // you moved on
    // Most specific to THIS question first (lib/match.js): it decides the
    // first card in Preview, the default in Save, and the order of the images.
    s.notes = Mt.rankNotes(notes || []);
    const ranked = s.notes;

    // Image pages per overlay key, in note order, each remembering which card
    // it came from. Worked out before the rows so each key badge can say how
    // many images it opens.
    for (const key of Object.keys(IMG_SOURCES)) {
      const items = [], seen = new Set();
      ranked.forEach((note, i) => fieldImages(note, IMG_SOURCES[key].fields).forEach(fn => {
        if (!seen.has(fn)) { seen.add(fn); items.push({ fn, card: i + 1 }); }
      }));
      s.files[key] = items;
    }

    const rows = [];
    for (const R of RESOURCES) {
      const links = [];
      // A question matches several AnKing cards, each carrying its own chapter
      // tags. Listing them in tag order made a chapter tagged on one card look
      // as important as one tagged on all of them. Count the cards behind each
      // chapter and lead with what this question is most about.
      const byPath = new Map();
      for (const note of ranked) {
        fieldAnchors(note, R.fields).forEach(l => links.push(l));
        const seenHere = new Set();                    // count a chapter once per card
        Tg.tagPaths(note.tags, R.tag).forEach(segs => {
          const key = segs.join(" > ").toLowerCase().replace(/[^a-z0-9> ]+/g, "").replace(/\s+/g, " ").trim();
          if (seenHere.has(key)) return;
          seenHere.add(key);
          const e = byPath.get(key);
          if (e) e.n++; else byPath.set(key, { segs: segs, n: 1, i: byPath.size });
        });
      }
      const paths = Array.from(byPath.values()).sort((a, b) => (b.n - a.n) || (a.i - b.i));
      const seen = new Set();
      const ulinks = links.filter(l => !seen.has(l.href) && seen.add(l.href));
      if (ulinks.length || paths.length) rows.push({ R, links: ulinks, paths });
    }
    // Extra / Additional Resources: what the cards themselves say, card by card.
    s.fieldRows = FIELD_ROWS.map(F => ({
      F,
      items: ranked.map((note, i) => ({
        note, card: i + 1,
        html: F.fields.map(f => noteField(note, f)).filter(fieldHasContent).join("<br>")
      })).filter(x => x.html)
    })).filter(r => r.items.length);
    s.ready = true;
    renderRows(s, rows, null, found);
    addImageHint(s);
    ensureVisible();
    if (esOn) addExpectedLine(s);
    prefetchImages(s);
  }
  // Pasting a pairing code (or changing the port) in the popup should bring a
  // panel that couldn't reach Anki back without waiting for a retry.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.bridgeToken || changes.bridgePort)) return;
    if (Q && !Q.ready && !Q.building) rebuild(Q.qid, Q.broad);
  });

  // Image bytes used to be fetched only when you pressed the key, one readMedia
  // round-trip per page — so the first F on a five-page First Aid topic stalled.
  // Warm them while you're reading the explanation instead, most-used resource
  // first, and abandon the moment you move to another question.
  //
  // Deliberately only the CURRENT question: a whole block's images would be
  // hundreds of megabytes of data: URLs held in the page.
  const PREFETCH_BUDGET = 24 * 1024 * 1024;   // ~24MB of base64, then stop
  async function prefetchImages(s) {
    const keys = Object.keys(IMG_SOURCES)
      .filter(k => !IMG_SOURCES[k].field && (s.files[k] || []).length && !s.uris[k])
      .sort((a, b) => (resourceUses[IMG_SOURCES[b].label] || 0) - (resourceUses[IMG_SOURCES[a].label] || 0));
    let held = 0;
    for (const k of keys) {
      if (!isLive(s) || held > PREFETCH_BUDGET) return;      // moved on, or enough held
      const res = await loadKey(s, k);
      if (!isLive(s)) return;
      for (const p of res.pages) held += p.uri.length;
    }
  }
  // One load per key per question, shared by the prefetch and a key press, so
  // pressing F mid-prefetch waits for the same requests instead of repeating them.
  // The result is stored on THIS question's session only.
  function loadKey(s, k) {
    if (s.uris[k]) return Promise.resolve(s.uris[k]);
    if (!s.loading) s.loading = {};
    if (!s.loading[k]) {
      s.loading[k] = fetchImages(s.files[k] || [], () => isLive(s))
        .then(res => { if (isLive(s)) s.uris[k] = res; return res; })
        .catch(() => ({ pages: [], missing: (s.files[k] || []).length }));
    }
    return s.loading[k];
  }

  // ---------- image overlay (modal with X / backdrop / Esc) ----------
  function ensureOverlay() {
    let o = document.getElementById(OVERLAY_ID);
    if (o) { o.classList.toggle("mnx-dark", darkMode); return o; }
    o = document.createElement("div");
    o.id = OVERLAY_ID;
    if (darkMode) o.classList.add("mnx-dark");
    o.addEventListener("click", e => { if (e.target === o) hideOverlay(); }); // click backdrop closes
    document.body.appendChild(o);
    return o;
  }
  function hideOverlay() {
    const o = document.getElementById(OVERLAY_ID);
    if (o) { o.style.display = "none"; o.replaceChildren(); } // drop image data so Brave can free it
  }
  function buildHead(o, label, key) {
    const head = document.createElement("div");
    head.className = "mnx-ovl-head";
    const title = document.createElement("span");
    const b = document.createElement("b"); b.textContent = label;
    const hint = document.createElement("span"); hint.className = "mnx-ovl-hint";
    hint.textContent = "press " + key + " or Esc to close";
    title.appendChild(b); title.appendChild(hint);
    const x = document.createElement("button");
    x.className = "mnx-x"; x.textContent = "\u00d7"; x.title = "Close";
    x.addEventListener("click", () => hideOverlay());
    head.appendChild(title); head.appendChild(x);
    return head;
  }
  function renderOverlayMessage(o, label, key, msg) {
    o.dataset.key = key; o.style.display = "flex"; o.replaceChildren();
    const dlg = document.createElement("div"); dlg.className = "mnx-dialog";
    dlg.appendChild(buildHead(o, label, key));
    const n = document.createElement("div"); n.textContent = msg; dlg.appendChild(n);
    o.appendChild(dlg);
  }
  // res: {pages: [{uri, card}], missing} from fetchImages.
  function renderOverlay(o, key, label, res) {
    o.dataset.key = key; o.style.display = "flex"; o.replaceChildren();
    o._mnxPage = null;
    o.setAttribute("role", "dialog");
    o.setAttribute("aria-modal", "true");
    o.setAttribute("aria-label", label + " images");
    const dlg = document.createElement("div"); dlg.className = "mnx-dialog";
    const head = buildHead(o, label, key);
    dlg.appendChild(head);
    const pages = (res && res.pages) || [];
    const uris = pages.map(p => p.uri);
    const missing = (res && res.missing) || 0;
    const cards = new Set(pages.map(p => p.card));
    // Pages from more than one card say which card each came from -- a topic
    // spread over nine notes is easier to follow knowing where you are in it.
    const fromCard = i => (cards.size > 1 && pages[i]) ? " · card " + pages[i].card : "";
    if (missing) {
      const n = document.createElement("div"); n.className = "mnx-ovl-missing";
      n.textContent = missing + " image" + (missing === 1 ? " is" : "s are") +
        " missing from your Anki media folder. Syncing, or Tools → Check Media in Anki, usually brings " +
        (missing === 1 ? "it" : "them") + " back.";
      dlg.appendChild(n);
    }

    if (!uris.length) {
      const n = document.createElement("div");
      n.textContent = missing ? "None of these images could be loaded." : "(couldn't load images)";
      dlg.appendChild(n);
      o.appendChild(dlg); return;
    }
    if (uris.length === 1) {
      const img = document.createElement("img");
      img.src = uris[0]; img.className = "mnx-ovl-img"; img.alt = label + " page";
      dlg.appendChild(img);
      o.appendChild(dlg); return;
    }

    // Several pages — a First Aid topic routinely has four or five. Stacking
    // them in one scroll gave no clue how many there were or where you are, so
    // page through them instead, with the whole set visible as thumbnails.
    let idx = 0;
    const stage = document.createElement("div"); stage.className = "mnx-ovl-stage";
    const img = document.createElement("img"); img.className = "mnx-ovl-img";
    stage.appendChild(img);

    const nav = document.createElement("div"); nav.className = "mnx-ovl-nav";
    const prev = document.createElement("button"); prev.className = "mnx-ovl-arrow"; prev.type = "button";
    prev.textContent = "‹ Prev"; prev.title = "Previous page (←)";
    const count = document.createElement("span"); count.className = "mnx-ovl-count";
    const next = document.createElement("button"); next.className = "mnx-ovl-arrow"; next.type = "button";
    next.textContent = "Next ›"; next.title = "Next page (→)";
    nav.append(prev, count, next);
    head.insertBefore(nav, head.lastElementChild);

    const thumbs = document.createElement("div"); thumbs.className = "mnx-ovl-thumbs";
    const thumbEls = uris.map((u, i) => {
      const t = document.createElement("button");
      t.type = "button"; t.className = "mnx-ovl-thumb"; t.title = "Page " + (i + 1);
      const ti = document.createElement("img"); ti.src = u; ti.alt = "Page " + (i + 1);
      t.appendChild(ti);
      t.addEventListener("click", onUserClick(() => show(i)));
      thumbs.appendChild(t);
      return t;
    });

    function show(i) {
      idx = (i + uris.length) % uris.length;
      img.src = uris[idx];
      img.alt = label + " page " + (idx + 1) + " of " + uris.length;
      count.textContent = (idx + 1) + " / " + uris.length + fromCard(idx);
      thumbEls.forEach((t, k) => t.classList.toggle("on", k === idx));
      stage.scrollTop = 0;
    }
    prev.addEventListener("click", onUserClick(() => show(idx - 1)));
    next.addEventListener("click", onUserClick(() => show(idx + 1)));

    dlg.append(stage, thumbs);
    o.appendChild(dlg);
    o._mnxPage = { show: (d) => show(idx + d) };
    show(0);
  }
  async function showImages(key) {
    const src = IMG_SOURCES[key];
    const existing = document.getElementById(OVERLAY_ID);
    if (existing && existing.style.display === "flex" && existing.dataset.key === key) {
      hideOverlay(); return; // same key hides it
    }
    if (src.field) { showFieldOverlay(key); return; }
    const s = Q;
    if (!s || !s.ready) return;
    const files = s.files[key] || [];
    if (!files.length) { toast("No " + src.label + " image for this question."); return; }
    const o = ensureOverlay();
    if (s.uris[key]) { renderOverlay(o, key, src.label, s.uris[key]); return; }
    renderOverlayMessage(o, src.label, key, "Loading…");
    const res = await loadKey(s, key);
    // The question changed while the images loaded: they belong to the old
    // one, so close rather than show them over the new question.
    if (!isLive(s)) { if (o.dataset.key === key) hideOverlay(); return; }
    if (o.style.display !== "flex" || o.dataset.key !== key) return;   // closed, or another key opened
    renderOverlay(o, key, src.label, res);
  }
  // While OUR overlay is open, the keys that drive it must not also reach the
  // qbank. preventDefault() only cancels the browser's own default action --
  // it does nothing to the page's listeners, so paging through a five-page
  // First Aid topic was also pressing "next question" five times underneath,
  // and you came out of the overlay several questions along.
  //
  // Capture on window fires before any capture listener on document, and
  // stopImmediatePropagation ends the event there.
  function overlayIsOpen() {
    const o = document.getElementById(OVERLAY_ID);
    return !!(o && o.style.display === "flex");
  }
  window.addEventListener("keydown", e => {
    if (!e.isTrusted) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!overlayIsOpen()) return;
    const k = (e.key || "").toLowerCase();
    if (k !== "arrowleft" && k !== "arrowright" && k !== "escape") return;
    const o = document.getElementById(OVERLAY_ID);
    if (k === "escape") hideOverlay();
    else if (o._mnxPage) o._mnxPage.show(k === "arrowright" ? 1 : -1);
    // A single-page overlay has nothing to turn, but the arrow still must not
    // reach the page: the question would change underneath the overlay.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  // The keyboard obeys the same rule as the panel: nothing until the question is
  // answered and its panel is up. The header carries the question id DURING a
  // test, so checking for an id alone let D open Anki on this question's own
  // cards mid-question -- the answer -- and on a bank where letters pick a
  // choice, choosing D did it by accident. Before that point every key goes to
  // the qbank untouched.
  //
  // Once we act on a key we claim it outright: capture phase on window, then
  // stopImmediatePropagation, so the qbank never also acts on it.
  // Which letter was pressed. The letter typed, when it is a Latin letter --
  // so AZERTY/QWERTZ users get the key printed on their keyboard. Otherwise the
  // PHYSICAL key: with an Arabic (or any non-Latin) layout active the F key
  // types "ب", and matching only the typed character made every shortcut dead.
  function shortcutLetter(e) {
    const k = e.key || "";
    if (k.length === 1 && /[a-z]/i.test(k)) return k.toUpperCase();
    const m = /^Key([A-Z])$/.exec(e.code || "");
    return m ? m[1] : "";
  }
  function isHelpKey(e) {
    return e.key === "?" || e.key === "؟" || (e.code === "Slash" && e.shiftKey);   // ? / Arabic ؟
  }
  // Typing somewhere? Read the REAL target: an event from inside a web
  // component's shadow root reaches window retargeted to the component, so
  // e.target looked like a plain element and "f" typed into its text box
  // opened First Aid.
  function typingInto(e) {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const t = path[0] || e.target;
    if (!t || t.nodeType !== 1) return false;
    const tag = (t.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || !!t.isContentEditable;
  }
  const SHORTCUT_LETTERS = new Set(Object.keys(IMG_SOURCES).concat(["G", "Q", "V", "D"]));
  window.addEventListener("keydown", e => {
    if (!e.isTrusted) return;            // page script must not drive the shortcuts
    const claim = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    if (e.key === "Escape") {
      const su = document.getElementById(SUMMARY_ID);
      if (su && su.style.display === "flex") { closeSummary(); claim(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (typingInto(e)) return;
    if (document.getElementById("mnx-md-overlay")) return;   // a dialog is open — don't hijack keys
    if (!kbShortcuts) return;            // the toggle turns ALL of them off; overlays stay a click away
    // Only for the question whose panel is up. Between a question changing and
    // the next tick noticing, Q still describes the OLD one; the page's own id
    // is checked so a key in that second can't act on it.
    const s = Q;
    if (!s || !s.ready || !isAnswered() || findQid() !== s.qid) return;
    const up = shortcutLetter(e);
    const ours = isHelpKey(e) || SHORTCUT_LETTERS.has(up);
    if (!ours) return;
    claim();
    if (e.repeat) return;                // holding a key down must not flicker the overlay open and shut
    const qid = s.qid;
    if (isHelpKey(e)) showShortcutHelp();
    else if (IMG_SOURCES[up]) showImages(up);                                                             // F/S/P/O/E/A image overlays
    else if (up === "G") openMakeCardDialog(String((window.getSelection && window.getSelection()) || "")); // make card
    else if (up === "Q") copyFullQuestion(qid);                                                           // copy for AI
    else if (up === "V") openSaveDialog(s);                                                                // save to Missed Qs
    else if (up === "D") openInAnki(s);                                                                    // open in Anki
  }, true);
  // small keyboard cheatsheet (press ?)
  function showShortcutHelp() {
    const m = buildModal("Keyboard shortcuts");
    const rows = [
      ["G", "Make a card (uses your text selection)"],
      ["Q", "Copy for AI"],
      ["V", "Save to Missed Qs"],
      ["D", "Open this question's cards in Anki"],
      ["F S P O E A", "Overlay First Aid / Sketchy / Physeo / OME / Extra / Additional images"],
      ["Esc", "Close a dialog or image overlay"],
      ["?", "Show this help"]
    ];
    const tbl = document.createElement("div"); tbl.className = "mnx-kb";
    rows.forEach(([keys, desc]) => {
      const r = document.createElement("div"); r.className = "mnx-kb-row";
      const kk = document.createElement("div"); kk.className = "mnx-kb-keys";
      keys.split(" ").forEach(one => { const kb = document.createElement("kbd"); kb.textContent = one; kk.appendChild(kb); });
      const dd = document.createElement("span"); dd.className = "mnx-kb-desc"; dd.textContent = desc;
      r.appendChild(kk); r.appendChild(dd); tbl.appendChild(r);
    });
    m.body.appendChild(tbl);
    const note = document.createElement("div"); note.className = "mnx-md-hint"; note.style.marginTop = "10px";
    note.textContent = "Keys are ignored while you're typing in a field. Toggle these off in the popup.";
    m.body.appendChild(note);
    m.foot.appendChild(mdButton("Close", "mnx-md-ok", m.close));
  }

  // ============================================================
  // FEATURE 2b - card preview, copy-Q, and "Save to Missed Qs"
  // The review-page note-taking workflow: read the card, copy the question, or
  // duplicate the matched card into a chapter deck with your note appended.
  // Uses the question session Q (set by buildTable) + the bridge write actions.
  // ============================================================
  const MISSED_TAG = "Mnestic::Missed";
  // AnkiHub overwrites a managed note's fields on a deck update unless the field
  // is protected. Verified against the AnkiHub add-on's own note_conversion.py:
  // protection_tag_for_field(name) -> "AnkiHub_Protect::<name with _ for spaces>".
  // Mnestic writes your notes into "Missed Questions", so it protects it too —
  // otherwise a term of notes can vanish on a routine deck update.
  const PROTECT_TAG = "AnkiHub_Protect::Missed_Questions";
  // Written by the add-on on every copy it makes. Undo deletes a note only
  // if it carries this, so "remove from missed" can never eat a real card.
  const COPY_TAG = "Mnestic::Copy";
  let deckCache = null;                 // cached deckNames list from the bridge

  function revealCloze(html) {          // we're past the answer, so show clozes
    return (html || "").replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/gis, '<span class="cloze">$1</span>');
  }
  // ---------- safe rendering of card HTML ----------
  // A note's fields are HTML. They come from the user's own collection, but decks
  // get shared and imported, so we treat them as UNTRUSTED. We never hand that
  // markup to innerHTML; we parse it inertly (DOMParser runs no script and loads
  // no images) and rebuild it from an allowlist, dropping every event handler,
  // script/iframe/object, and javascript: URL.
  const SAFE_TAGS = new Set(["B","STRONG","I","EM","U","S","STRIKE","SUB","SUP","BR","P","DIV","SPAN",
    "UL","OL","LI","TABLE","THEAD","TBODY","TFOOT","TR","TD","TH","CAPTION","COL","COLGROUP",
    "H1","H2","H3","H4","H5","H6","BLOCKQUOTE","CODE","PRE","HR","IMG","A","FONT","SMALL","BIG","CENTER","DL","DT","DD"]);
  // No "class": card HTML sits inside the qbank's page, where a class like
  // "fixed inset-0" means something to the SITE's stylesheet -- a card could
  // have laid itself over the page. Only our own "cloze" survives.
  const SAFE_ATTRS = {
    "*": ["title", "dir", "lang"],
    IMG: ["src", "alt", "width", "height"],
    A: ["href", "target"],
    TD: ["colspan", "rowspan"], TH: ["colspan", "rowspan"],
    COL: ["span"], COLGROUP: ["span"],
    FONT: ["color", "size", "face"]
  };
  // An image source Mnestic will load: an Anki media filename (which we then
  // inline from your own collection) or a data: image. Anything with a scheme
  // or a host -- https://, //cdn…, file: -- is refused. A remote image would be
  // fetched the moment a preview opened, telling whoever serves it your address
  // and that you just looked at that card.
  function safeMediaSrc(value) {
    const s = String(value || "").replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!s) return null;
    if (/^data\s*:/i.test(s)) return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(s) ? s : null;
    if (/^[a-z][a-z0-9+.-]*\s*:/i.test(s) || s.indexOf("//") === 0 || s.indexOf("\\\\") === 0) return null;
    return s;
  }
  function isRemoteSrc(value) {
    return /^\s*(?:https?:)?\/\//i.test(String(value || ""));
  }
  // Resource links (Sketchy / B&B / … videos) must resolve to a plain web URL.
  // Resolving against the page also normalises relative and protocol-relative
  // forms; anything whose scheme isn't http(s) — javascript:, data:, file:,
  // vbscript: — is rejected outright.
  function safeLinkUrl(href) {
    const raw = String(href || "").trim();
    if (!raw || raw.charAt(0) === "#") return null;   // empty/fragment would just self-link
    let u;
    try { u = new URL(raw, location.href); } catch (e) { return null; }
    return (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
  }
  function sanitizeInto(target, html) {
    const doc = new DOMParser().parseFromString("<body>" + (html || "") + "</body>", "text/html");
    (function walk(src, dest) {
      Array.prototype.forEach.call(src.childNodes, node => {
        if (node.nodeType === 3) { dest.appendChild(document.createTextNode(node.nodeValue)); return; }
        if (node.nodeType !== 1) return;                       // drop comments etc.
        const tag = node.tagName.toUpperCase();
        if (!SAFE_TAGS.has(tag)) { walk(node, dest); return; } // unknown tag: keep its text, drop the tag
        if (tag === "IMG" && isRemoteSrc(node.getAttribute("src"))) {
          const note = document.createElement("span");
          note.className = "mnx-remote-img";
          note.textContent = "[remote image not loaded]";
          note.title = "This card links an image on another website. Mnestic doesn't load it, so that site can't see you viewing the card.";
          dest.appendChild(note);
          return;
        }
        const el = document.createElement(tag);
        const allowed = SAFE_ATTRS["*"].concat(SAFE_ATTRS[tag] || []);
        Array.prototype.forEach.call(node.attributes, attr => {
          const name = attr.name.toLowerCase();
          if (name.indexOf("on") === 0) return;                // never an event handler
          if (name === "class") {                              // our own cloze styling only
            if (/(^|\s)cloze(\s|$)/.test(attr.value)) el.className = "cloze";
            return;
          }
          if (allowed.indexOf(name) === -1) return;
          let val = attr.value;
          if (name === "src") val = safeMediaSrc(val);
          else if (name === "href") val = safeLinkUrl(val);
          if (val === null) return;
          el.setAttribute(name, val);
        });
        if (tag === "IMG" && !el.getAttribute("src")) return;  // nothing safe to show
        if (tag === "A") { el.setAttribute("rel", "noopener noreferrer nofollow"); el.setAttribute("target", "_blank"); }
        walk(node, el);
        dest.appendChild(el);
      });
    })(doc.body, target);
    return target;
  }
  function setSafeHtml(el, html) { el.replaceChildren(); return sanitizeInto(el, html); }
  // Plain text out of card HTML, without ever touching the live DOM.
  // The visible text of some card HTML. Line breaks and block ends become
  // spaces ("Text<br>more" is two words, not "Textmore"); style and script
  // bodies, non-breaking and zero-width spaces don't count as text.
  function htmlToText(html) {
    const src = String(html || "").replace(/<(br|\/div|\/p|\/li|\/td|\/th|\/tr|\/h[1-6])\b[^>]*>/gi, " $&");
    const doc = new DOMParser().parseFromString("<body>" + src + "</body>", "text/html");
    doc.body.querySelectorAll("style,script,template,noscript").forEach(e => e.remove());
    return (doc.body.textContent || "").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
  }
  // Images that would actually show: a media file, an inline image, or a
  // remote one (shown as a "not loaded" note). <img> with no usable src is not.
  function imageCount(html) {
    const h = String(html || "");
    if (!/<img\b/i.test(h)) return 0;
    const doc = new DOMParser().parseFromString("<body>" + h + "</body>", "text/html");
    return Array.from(doc.body.querySelectorAll("img")).filter(im => {
      const v = im.getAttribute("src");
      return !!(safeMediaSrc(v) || isRemoteSrc(v));
    }).length;
  }
  function noteField(note, name) { const f = getField(note, name); return (f && f.value) || ""; }
  function noteSnippet(note) {
    let t = htmlToText(revealCloze(noteField(note, "Text")));
    if (!t) t = htmlToText(noteField(note, "Extra"));
    return t.length > 90 ? t.slice(0, 88) + "…" : (t || ("note " + note.noteId));
  }
  // A card at a glance, for choosing between matched cards in Save: its whole
  // Text with the answers in bold (three lines, the rest on hover), what Extra
  // and Additional Resources say, and how many images it carries. Text only --
  // nothing is fetched -- so the dialog opens as fast as before.
  const CLOZE_OPEN = "", CLOZE_CLOSE = "";
  function clozeGlance(html, into) {
    const marked = String(html || "").replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/gis, CLOZE_OPEN + "$1" + CLOZE_CLOSE);
    const text = htmlToText(marked);
    text.split(CLOZE_OPEN).forEach((part, i) => {
      const j = i ? part.indexOf(CLOZE_CLOSE) : -1;
      if (j >= 0) {
        const b = document.createElement("b"); b.className = "mnx-glance-ans";
        b.textContent = part.slice(0, j); into.appendChild(b);
        part = part.slice(j + 1);
      }
      part = part.split(CLOZE_CLOSE).join("");
      if (part) into.appendChild(document.createTextNode(part));
    });
    return text.split(CLOZE_OPEN).join("").split(CLOZE_CLOSE).join("");
  }
  function noteGlance(note, extra) {
    const box = document.createElement("span"); box.className = "mnx-glance";
    const main = document.createElement("span"); main.className = "mnx-glance-text";
    box.appendChild(main);
    const front = noteField(note, "Text") || noteField(note, "Front");
    let shown = clozeGlance(front, main);
    const subs = [["Extra", ["Extra", "Back Extra"]], ["Additional", ["Additional Resources"]]];
    subs.forEach(([label, names]) => {
      const v = names.map(n => htmlToText(noteField(note, n))).filter(Boolean).join(" ");
      if (!v) return;
      if (!shown) { main.textContent = v; main.title = v; shown = v; return; }   // no Text: Extra leads
      const line = document.createElement("span"); line.className = "mnx-glance-sub";
      const b = document.createElement("b"); b.textContent = label + " ";
      line.append(b, document.createTextNode(v)); line.title = v;
      box.appendChild(line);
    });
    if (!shown) main.textContent = "note " + note.noteId;
    else if (!main.title) main.title = shown;
    const imgs = orderedFields(note).reduce((n, f) => n + imageCount(f.value), 0);
    const meta = [];
    if (imgs) meta.push(imgs + (imgs === 1 ? " image" : " images"));
    if (extra) meta.push(extra);
    if (meta.length) {
      const m = document.createElement("span"); m.className = "mnx-glance-meta"; m.textContent = meta.join(" · ");
      box.appendChild(m);
    }
    return box;
  }
  // Read an element's visible text while temporarily hiding our own injected UI
  // (resource panel, modals, the QID button). innerText skips display:none, so
  // we hide → read → restore synchronously, with no visible flicker.
  function readTextWithoutAkuts(root) {
    if (!root) return "";
    const hidden = [];
    root.querySelectorAll("[id^='mnx-']").forEach(el => {
      hidden.push([el, el.style.display]);
      el.style.display = "none";
    });
    const text = root.innerText || root.textContent || "";
    hidden.forEach(([el, d]) => { el.style.display = d; });
    return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // The qbank's explanation only (for pasting into a note).
  function explanationText() {
    return readTextWithoutAkuts(SITE.explanationRoot());
  }
  // The whole question: stem + answer choices + explanation (for an AI assistant).
  function fullQuestionText() {
    return readTextWithoutAkuts(SITE.contentRoot()) || explanationText();
  }
  function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function mimeToExt(mime) {
    mime = (mime || "").toLowerCase();
    if (mime.indexOf("jpeg") >= 0 || mime.indexOf("jpg") >= 0) return "jpg";
    if (mime.indexOf("gif") >= 0) return "gif";
    if (mime.indexOf("webp") >= 0) return "webp";
    if (mime.indexOf("svg") >= 0) return "svg";
    return "png";
  }

  // ---- generic modal ----
  // A real dialog for assistive tech: labelled, modal, focus moved in and kept
  // in (Tab cycles inside it), and handed back to where it was on close.
  const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  let modalSeq = 0;
  function buildModal(titleText, onClose) {
    const old = document.getElementById("mnx-md-overlay"); if (old) old.remove();
    const before = document.activeElement;
    const ov = document.createElement("div"); ov.id = "mnx-md-overlay";
    ov.classList.toggle("mnx-dark", darkMode);
    const onKey = e => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const items = Array.from(md.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !md.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    function close() {
      document.removeEventListener("keydown", onKey, true);
      ov.remove();
      if (onClose) { try { onClose(); } catch (e) {} }
      try { if (before && before.isConnected && before.focus) before.focus(); } catch (e) {}
    }
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    const md = document.createElement("div"); md.className = "mnx-md";
    const titleId = "mnx-md-title-" + (++modalSeq);
    md.setAttribute("role", "dialog");
    md.setAttribute("aria-modal", "true");
    md.setAttribute("aria-labelledby", titleId);
    const head = document.createElement("div"); head.className = "mnx-md-head";
    const b = document.createElement("b"); b.textContent = titleText; b.id = titleId;
    const x = document.createElement("button"); x.className = "mnx-md-x"; x.textContent = "×";
    x.setAttribute("aria-label", "Close"); x.addEventListener("click", close);
    head.appendChild(b); head.appendChild(x);
    const body = document.createElement("div"); body.className = "mnx-md-body";
    const foot = document.createElement("div"); foot.className = "mnx-md-foot";
    md.appendChild(head); md.appendChild(body); md.appendChild(foot);
    ov.appendChild(md);
    (document.body || document.documentElement).appendChild(ov);
    document.addEventListener("keydown", onKey, true);
    // After the caller has filled it in; a dialog that focuses its own field
    // (Make card's text box) keeps that.
    setTimeout(() => { if (ov.isConnected && !md.contains(document.activeElement)) x.focus(); }, 0);
    return { ov, body, foot, close };
  }
  function mdButton(label, cls, onClick) {
    const b = document.createElement("button"); b.className = "mnx-md-btn " + cls; b.textContent = label;
    b.addEventListener("click", onUserClick(onClick)); return b;
  }

  // ---- Copy to clipboard ----
  function copyText(text, msg) {
    if (!text) { toast("Nothing to copy yet."); return; }
    const done = () => toast(msg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
    } else legacyCopy(text, done);
  }
  // Full question (stem + choices + explanation) + your AI prompt - for an AI assistant.
  function copyFullQuestion(qid) {
    const p = (aiPrompt && aiPrompt.trim()) ? (aiPrompt.trim() + "\n\n") : "";
    const head = SITE.label + " Question Id: " + qid + "\n" + location.href + "\n\n";
    copyText(p + head + fullQuestionText(), p ? "Copied with your AI prompt — paste to your assistant." : "Full question copied — paste to your assistant.");
  }
  // Explanation only - for adding to your notes.
  function copyExplanation() {
    copyText(explanationText(), "Explanation copied — paste into your note.");
  }
  function legacyCopy(text, done) {
    const ta = document.createElement("textarea"); ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Couldn't copy."); }
    ta.remove();
  }

  // ---- Preview matched cards inline (text only; images live in the F/S/P/E/A overlay).
  // Navigates the whole match list, not just the most relevant card. ----
  // Substantial images on the current question page (vignette + explanation
  // figures), excluding our own UI and small icons. Used by the "From this
  // question" picker to attach an image without snipping.
  function collectQuestionImages() {
    const out = []; const seen = new Set();
    const expl = SITE.explanationRoot();
    document.querySelectorAll("img").forEach(im => {
      if (im.closest("[id^='mnx-']")) return;               // skip our own UI
      const r = im.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return;               // skip icons / avatars
      const src = im.currentSrc || im.src || "";
      if (!src || /^data:/.test(src) || seen.has(src)) return;
      seen.add(src);
      out.push({ src, inExpl: !!(expl && expl.contains(im)) });
    });
    return out;
  }
  // Coursology CDN images are cross-origin and block page reads, so the
  // background worker fetches the bytes (it has the host permission).
  function fetchImageViaBg(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "fetchImage", url }, resp => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        if (!resp || !resp.ok) return reject((resp && resp.error) || "fetch failed");
        resolve(resp.dataUrl);
      });
    });
  }

  // Reusable image picker (paste / drop / choose / from-question) shared by
  // Save + Make card. Returns { el, images, handlePaste, upload }. Register
  // handlePaste on the document while the dialog is open (a plain <div> can't
  // receive paste).
  function makeImagePicker(labelText) {
    const images = [];                                   // { dataUrl, mime }
    const wrap = document.createElement("div");
    const lbl = document.createElement("label"); lbl.className = "mnx-md-lbl";
    lbl.textContent = labelText || "Images (optional)";
    // One field that looks like the text boxes around it: added images sit
    // inside it as small thumbnails, so it stays one line tall until you add one.
    const drop = document.createElement("div"); drop.className = "mnx-imgfield"; drop.tabIndex = 0;
    drop.setAttribute("role", "button");
    drop.setAttribute("aria-label", "Add images: paste a screenshot, drop files, or press Enter to choose files");
    const thumbs = document.createElement("div"); thumbs.className = "mnx-img-thumbs";
    const ph = document.createElement("span"); ph.className = "mnx-imgfield-ph";
    const kbd = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘V" : "Ctrl+V";
    const EMPTY_PH = "Paste a screenshot (" + kbd + "), drop, or click to add";
    ph.textContent = EMPTY_PH;
    const add = document.createElement("span"); add.className = "mnx-imgfield-add"; add.textContent = "+"; add.setAttribute("aria-hidden", "true");
    drop.append(thumbs, ph, add);
    const fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.multiple = true; fileInput.style.display = "none";
    wrap.appendChild(lbl); wrap.appendChild(drop); wrap.appendChild(fileInput);
    function refreshField() {
      drop.classList.toggle("has-imgs", images.length > 0);
      ph.textContent = images.length ? (images.length + (images.length === 1 ? " image" : " images") + " — paste or drop more")
                                     : EMPTY_PH;
    }
    function addImageFile(file) {
      if (!file || !/^image\//.test(file.type || "")) return;
      const reader = new FileReader();
      reader.onload = () => { const rec = { dataUrl: reader.result, mime: file.type }; images.push(rec); renderThumb(rec); };
      reader.onerror = () => toast("Couldn't read that image.");
      reader.readAsDataURL(file);
    }
    function renderThumb(rec) {
      const t = document.createElement("div"); t.className = "mnx-img-thumb";
      const img = document.createElement("img"); img.src = rec.dataUrl;
      img.alt = "attached image " + (images.indexOf(rec) + 1);
      const x = document.createElement("button"); x.type = "button"; x.className = "mnx-img-x"; x.textContent = "×";
      x.setAttribute("aria-label", "Remove this image");
      x.addEventListener("click", onUserClick((e) => {
        e.stopPropagation();                               // don't also open the file chooser
        const i = images.indexOf(rec); if (i >= 0) images.splice(i, 1); t.remove(); refreshField();
        if (rec.onRemove) rec.onRemove();
      }));
      t.addEventListener("click", e => e.stopPropagation());
      t.appendChild(img); t.appendChild(x); thumbs.appendChild(t);
      refreshField();
    }
    function handlePaste(e) {
      if (!e.isTrusted) return;                          // page script can forge a paste
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let used = false;
      for (const it of items) { if (it.type && it.type.indexOf("image") === 0) { const f = it.getAsFile(); if (f) { addImageFile(f); used = true; } } }
      if (used) e.preventDefault();                       // don't also paste the filename as text
    }
    // Page script can build a DataTransfer of its own files and dispatch a drop
    // or change event with it, so every way in requires a real user event.
    drop.addEventListener("click", onUserClick(() => fileInput.click()));
    drop.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.isTrusted && e.target === drop) { e.preventDefault(); fileInput.click(); }
    });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("mnx-img-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("mnx-img-over"));
    drop.addEventListener("drop", e => {
      e.preventDefault(); drop.classList.remove("mnx-img-over");
      if (!e.isTrusted) return;
      for (const f of (e.dataTransfer && e.dataTransfer.files) || []) addImageFile(f);
    });
    fileInput.addEventListener("change", e => {
      if (e.isTrusted) for (const f of fileInput.files) addImageFile(f);
      fileInput.value = "";
    });
    // "From this question" — click a page image's thumbnail to attach it.
    // Only offered where the worker is actually allowed to fetch the qbank's
    // images; showing thumbnails that can only ever error is worse than not
    // showing them (MedPark serves figures from a third-party storage domain).
    const qImgs = SITE.canAttachImages === false ? [] : collectQuestionImages();
    // Figures the explanation keeps behind a button (fetched only on click).
    const figures = (SITE.canAttachImages === false || !SITE.exhibits) ? [] : (() => { try { return SITE.exhibits(); } catch (e) { return []; } })();
    let fromRow = null;
    if (qImgs.length || figures.length) {
      fromRow = document.createElement("div"); fromRow.className = "mnx-img-from";
      const flbl = document.createElement("span"); flbl.className = "mnx-md-hint"; flbl.textContent = "From this question:";
      fromRow.appendChild(flbl);
      wrap.appendChild(fromRow);
    }
    if (qImgs.length) {
      const strip = fromRow;
      qImgs.forEach(qi => {
        const t = document.createElement("button"); t.type = "button"; t.className = "mnx-qthumb";
        t.title = "Add this " + (qi.inExpl ? "explanation figure" : "question image");
        const im = document.createElement("img"); im.src = qi.src; im.referrerPolicy = "no-referrer";
        t.appendChild(im);
        t.addEventListener("click", onUserClick(async () => {
          if (t.dataset.added || t.classList.contains("loading")) return;
          t.classList.add("loading");
          try {
            const dataUrl = await fetchImageViaBg(qi.src);
            const rec = { dataUrl, mime: (String(dataUrl).match(/^data:([^;]+)/) || [])[1] || "image/png" };
            rec.onRemove = () => { t.classList.remove("added"); delete t.dataset.added; };
            images.push(rec); renderThumb(rec);
            t.classList.add("added"); t.dataset.added = "1";
          } catch (e) { toast("Couldn't fetch that image (" + e + ")"); }
          t.classList.remove("loading");
        }));
        strip.appendChild(t);
      });
    }
    if (figures.length) {
      const row = fromRow;
      figures.forEach(fig => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "mnx-figchip"; b.textContent = fig.label;
        b.title = "Add the “" + fig.label + "” figure";
        b.addEventListener("click", onUserClick(async () => {
          if (b.dataset.added || b.classList.contains("loading")) return;
          b.classList.add("loading");
          try {
            const src = await fig.open();
            const dataUrl = await fetchImageViaBg(src);
            const rec = { dataUrl, mime: (String(dataUrl).match(/^data:([^;]+)/) || [])[1] || "image/png" };
            rec.onRemove = () => { b.classList.remove("added"); delete b.dataset.added; };
            images.push(rec); renderThumb(rec);
            b.classList.add("added"); b.dataset.added = "1";
          } catch (e) {
            toast("Couldn't get that figure (" + ((e && e.message) || e) + "). Open it on the page, then try again.");
          }
          b.classList.remove("loading");
        }));
        row.appendChild(b);
      });
    }
    async function upload(prefix) {
      const tags = [];
      for (const rec of images) {
        const b64 = String(rec.dataUrl).split(",")[1] || "";
        const fname = (prefix || SITE.id) + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + "." + mimeToExt(rec.mime);
        const stored = await bridge("writeMedia", { filename: fname, data: b64 });
        if (stored) tags.push('<img src="' + String(stored).replace(/"/g, "&quot;") + '">');
      }
      return tags;
    }
    return { el: wrap, images, handlePaste, upload };
  }

  // Resolve Anki media filenames in a preview to inline data URIs (lazy + cached),
  // so card images show without a media server. Cheap: a few small fetches/card.
  // A small least-recently-used cache: previews on question after question in
  // one tab used to keep every image they ever showed, as data: URLs.
  const MEDIA_CACHE_MAX = 60;
  const mediaCache = new Map();
  function cacheMedia(fn, uri) {
    mediaCache.delete(fn);
    mediaCache.set(fn, uri);
    while (mediaCache.size > MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value);
  }
  async function resolveMediaImages(container, stillCurrent) {
    for (const img of Array.from(container.querySelectorAll("img"))) {
      const src = img.getAttribute("src") || "";
      if (/^(https?:|data:)/i.test(src)) continue;
      const fn = decodeURIComponent((src.split(/[\\/]/).pop() || "").split("?")[0]);
      if (!fn) { continue; }
      let uri = mediaCache.get(fn);
      if (uri === undefined) {
        try { const b64 = await bridge("readMedia", { filename: fn }); uri = b64 ? ("data:" + mimeFor(fn) + ";base64," + b64) : null; }
        catch (e) { uri = null; }
      }
      cacheMedia(fn, uri);
      if (stillCurrent && !stillCurrent()) return;        // user navigated away
      if (uri) img.src = uri; else img.remove();
    }
  }

  // ---- the whole card ---------------------------------------------------------
  // Every field with something in it, in the note type's own order. Text and
  // the fields read most -- Extra, Additional Resources (the heart of a Step 2/3
  // card) and your own Missed Questions notes -- are open; the rest are one
  // click away, and their images load only when opened, because a full AnKing
  // card can carry dozens of them.
  const HIDDEN_FIELDS = /^(ankihub_id|guid|id|note id)$/i;
  const OPEN_FIELDS = /^(text|front|back|extra|back extra|additional resources|missed questions)$/i;
  // A field counts only if it shows something: text, or an image with a usable
  // source. Spaces, <br>s, empty boxes and src-less images are empty, and an
  // empty field is never shown -- in the panel, the preview or Save.
  function fieldHasContent(html) {
    return htmlToText(html).length > 0 || imageCount(html) > 0;
  }
  function fieldSummary(html) {
    const imgs = imageCount(html);
    const t = htmlToText(html);
    const bits = [];
    if (t) bits.push(t.length > 70 ? t.slice(0, 68) + "…" : t);
    if (imgs) bits.push(imgs + (imgs === 1 ? " image" : " images"));
    return bits.join(" · ");
  }
  function orderedFields(note) {
    const fields = (note && note.fields) || {};
    return Object.keys(fields)
      .map(name => ({ name, value: (fields[name] && fields[name].value) || "",
                      order: fields[name] && fields[name].order != null ? fields[name].order : 999 }))
      .filter(f => !HIDDEN_FIELDS.test(f.name) && fieldHasContent(f.value))
      .sort((a, b) => a.order - b.order);
  }
  function renderFullCard(container, note, isCurrent) {
    container.replaceChildren();
    const fields = orderedFields(note);
    if (!fields.length) { container.textContent = "This card has no filled fields."; return; }
    fields.forEach(f => {
      const html = /^(text|front)$/i.test(f.name) ? revealCloze(f.value) : f.value;
      const sec = document.createElement("details");
      sec.className = "mnx-field";
      const sum = document.createElement("summary");
      const nm = document.createElement("b"); nm.textContent = f.name;
      const hint = document.createElement("span"); hint.className = "mnx-field-hint"; hint.textContent = fieldSummary(f.value);
      sum.append(nm, hint);
      const body = document.createElement("div"); body.className = "mnx-md-prev mnx-field-body";
      sec.append(sum, body);
      let built = false;
      const build = () => { if (built) return; built = true; setSafeHtml(body, html); resolveMediaImages(body, isCurrent); };
      sec.addEventListener("toggle", () => { if (sec.open) build(); });
      if (OPEN_FIELDS.test(f.name)) { sec.open = true; build(); }
      container.appendChild(sec);
    });
  }

  function openPreview(list, startIdx) {
    const s = Q;
    list = (list && list.length) ? list : ((s && s.notes) || []);
    if (!list.length) { toast("No card to preview."); return; }
    let idx = Math.min(Math.max(0, startIdx || 0), list.length - 1);
    const m = buildModal("Card preview");
    const nav = document.createElement("div"); nav.className = "mnx-prev-nav";
    const prev = mdButton("‹ Prev", "mnx-md-cancel", () => { idx = (idx - 1 + list.length) % list.length; render(); });
    const counter = document.createElement("span"); counter.className = "mnx-prev-count";
    const next = mdButton("Next ›", "mnx-md-cancel", () => { idx = (idx + 1) % list.length; render(); });
    nav.appendChild(prev); nav.appendChild(counter); nav.appendChild(next);
    if (list.length > 1) m.body.appendChild(nav);
    const content = document.createElement("div"); m.body.appendChild(content);
    function render() {
      counter.textContent = "Card " + (idx + 1) + " of " + list.length;
      const myIdx = idx;
      // The whole card, not just Text and Extra (see renderFullCard).
      renderFullCard(content, list[idx], () => idx === myIdx && content.isConnected);
    }
    render();
    m.foot.appendChild(mdButton("Open in Anki", "mnx-md-cancel", () => openInAnki(s)));
    m.foot.appendChild(mdButton("Close", "mnx-md-ok", m.close));
  }

  // ---- Save to Missed Qs ------------------------------------------------------
  // Chapter detection and deck matching live in lib/tags.js (unit-tested).
  const deckLeaf = Tg.deckLeaf;
  function guessDeck(candidates, note) {
    const tnorm = ((note && note.tags) || []).map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    for (const d of candidates) {
      const leaf = Tg.normDeck(deckLeaf(d));
      if (leaf.length >= 4 && tnorm.some(t => t.includes(leaf))) return d;
    }
    return null;
  }
  // Same escaping the add-on applies: backslash first, then quote, so a deck
  // name carrying either cannot break out of the quoted search term.
  function searchLiteral(text) {
    return String(text || "")
      .split("\\").join("\\\\")
      .split('"').join('\\"');
  }
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

  // ---- what each save did, so undo can reverse exactly that ------------------
  // Keyed by NOTE id: { qid, mode, from, to, unsuspended: [card ids], at }.
  //
  // 1.3 kept one record per QUESTION id. A note saved from two questions had
  // its home deck recorded under one of them only, so undoing from the other
  // untagged it and left the card stranded in Missed Qs. And saving
  // unsuspended every card of every note on the question, which undo never put
  // back. Now a save unsuspends only the note you chose, remembers exactly
  // which cards that unlocked, and undo re-suspends just those.
  const SAVES_KEY = "mnxSaves", SAVES_MAX = 2000;
  function readSaves() {
    return new Promise(r => chrome.storage.local.get({ [SAVES_KEY]: {}, akHome: {} }, c => r({
      saves: isObj(c[SAVES_KEY]) ? c[SAVES_KEY] : {},
      legacyHome: isObj(c.akHome) ? c.akHome : {}           // 1.3's per-question record
    })));
  }
  function updateSaves(fn) {
    return new Promise(r => chrome.storage.local.get({ [SAVES_KEY]: {} }, c => {
      const map = isObj(c[SAVES_KEY]) ? c[SAVES_KEY] : {};
      fn(map);
      const keys = Object.keys(map);
      if (keys.length > SAVES_MAX) {
        keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
            .slice(0, keys.length - SAVES_MAX).forEach(k => delete map[k]);
      }
      chrome.storage.local.set({ [SAVES_KEY]: map }, r);
    }));
  }
  function recordSave(noteId, rec) { return updateSaves(map => { map[String(noteId)] = Object.assign({ at: Date.now() }, rec); }); }
  function forgetSave(noteId) { return updateSaves(map => { delete map[String(noteId)]; }); }
  function forgetLegacyHome(qid) {
    chrome.storage.local.get({ akHome: {} }, c => {
      const map = isObj(c.akHome) ? c.akHome : {};
      if (map[String(qid)]) { delete map[String(qid)]; chrome.storage.local.set({ akHome: map }); }
    });
  }

  // Which question(s) a saved note was saved from (its Mnestic::QID tags).
  const QID_TAG_RE = /^Mnestic::QID::(\d+)$/i;
  function savedQids(note) {
    return (note.tags || []).map(t => (QID_TAG_RE.exec(String(t)) || [])[1]).filter(Boolean);
  }
  function isSavedNote(note) { return (note.tags || []).some(t => /^mnestic::missed(::|$)/i.test(String(t))); }
  function isCopyNote(note) { return (note.tags || []).some(t => String(t).toLowerCase() === COPY_TAG.toLowerCase()); }

  // The saved notes that concern this question:
  //   mine    saved FROM this question -- or saved before 1.4, when nothing
  //           recorded which question a save came from
  //   shared  saved from this question AND another one: undo here drops only
  //           this question's link, and the note stays missed for the other
  //   others  saved from a different question that happens to share the note.
  //           Left alone: 1.3's undo untagged these too.
  async function savedForQuestion(s) {
    const out = { mine: [], shared: [], others: [] };
    const q = s.query || qidQuery(s.qid, s.sv || 1);
    const nids = (await bridge("searchNotes", { query: q + " (tag:" + MISSED_TAG + " OR tag:" + MISSED_TAG + "::*)" })) || [];
    if (!nids.length) return out;
    const notes = (await bridge("noteInfo", { notes: nids })) || [];
    const id = safeQid(s.qid);
    notes.filter(isSavedNote).forEach(n => {
      const qs = savedQids(n);
      if (!qs.length) out.mine.push(n);
      else if (qs.indexOf(id) < 0) out.others.push(n);
      else if (qs.length > 1) out.shared.push(n);
      else out.mine.push(n);
    });
    return out;
  }

  // ---- undo a save -----------------------------------------------------------
  // Reverses each note's own save: a copy is deleted (the add-on only ever
  // deletes notes it created), a moved card goes back to where it lived -- if
  // it is still where Mnestic put it -- and cards the save unsuspended are
  // suspended again. What it never touches, in any mode: the notes you typed
  // into Missed Questions, and the AnkiHub_Protect tag that guards them.
  async function unsaveMissed(s, onlyNoteId) {
    const found = await savedForQuestion(s);
    const { saves, legacyHome } = await readSaves();
    const id = safeQid(s.qid);
    const out = { notes: 0, deleted: 0, refused: 0, movedBack: [], resuspended: 0, unlinked: 0, others: found.others.length };
    let targets = found.mine.concat(found.shared);
    if (onlyNoteId) targets = targets.filter(n => String(n.noteId) === String(onlyNoteId));
    if (!targets.length) return Object.assign(out, { nothing: true });
    for (const note of targets) {
      const nid = note.noteId;
      const rec = saves[String(nid)] || null;
      const qs = savedQids(note);
      if (qs.length > 1) {                                   // still missed from another question
        await bridge("removeTags", { notes: [nid], tags: [Mt.qidTag(id)] });
        out.unlinked++;
        continue;
      }
      if (isCopyNote(note)) {
        const r = await bridge("deleteNotes", { notes: [nid] });
        out.deleted += (r && r.deleted) || 0;
        out.refused += (r && r.refused && r.refused.length) || 0;
        await forgetSave(nid);
        continue;
      }
      // Before the missed tag goes: the add-on only re-suspends cards of a
      // note that is still tagged missed.
      if (rec && rec.unsuspended && rec.unsuspended.length) {
        try {
          const r = await bridge("suspend", { cards: rec.unsuspended });
          out.resuspended += (r && r.suspended) || 0;
        } catch (e) { if (!e || e.code !== "old-addon") throw e; }
      }
      await bridge("removeTags", { notes: [nid], tags: qs.length ? [MISSED_TAG, Mt.qidTag(id)] : [MISSED_TAG] });
      out.notes++;
      // Put a moved card back -- only if it is still where Mnestic put it.
      // Someone who has since filed it somewhere of their own keeps that.
      const home = rec ? (rec.mode === "move" ? rec : null) : (!qs.length ? legacyHome[id] : null);
      if (home && home.from) {
        let still = true;
        if (home.to) {
          try {
            still = ((await bridge("searchNotes", { query: "nid:" + nid + ' "deck:' + searchLiteral(home.to) + '"' })) || []).length > 0;
          } catch (e) { still = false; }
        }
        if (still) {
          try { await bridge("setDeck", { notes: [nid], deck: home.from }); out.movedBack.push(home.from); } catch (e) {}
        }
      }
      await forgetSave(nid);
    }
    if (!onlyNoteId) forgetLegacyHome(id);
    return out;
  }
  function undoMessage(r) {
    const bits = [];
    if (r.notes) bits.push("untagged " + r.notes + (r.notes === 1 ? " note" : " notes"));
    if (r.deleted) bits.push("deleted " + r.deleted + (r.deleted === 1 ? " copy" : " copies"));
    if (r.movedBack.length) bits.push("moved " + (r.movedBack.length === 1 ? "it" : "them") + " back to " + deckLeaf(r.movedBack[0]));
    if (r.resuspended) bits.push("re-suspended " + r.resuspended + (r.resuspended === 1 ? " card" : " cards"));
    if (r.unlinked) bits.push(r.unlinked + (r.unlinked === 1 ? " note stays" : " notes stay") + " saved from another question");
    let msg = bits.length ? "Removed from Missed Qs — " + bits.join(", ") + "." : "Removed from Missed Qs.";
    // The add-on refuses to delete anything it did not create. Say so rather
    // than reporting a clean undo that did not happen.
    if (r.refused) msg += " " + r.refused + " note" + (r.refused === 1 ? " was" : "s were") + " left alone (not created by Mnestic).";
    if (r.others) msg += " " + r.others + " note" + (r.others === 1 ? "" : "s") + " saved from other questions " + (r.others === 1 ? "was" : "were") + " left as they are.";
    if (r.notes && !r.movedBack.length) msg += " Your notes in the card were kept.";
    return msg;
  }

  function extraLabel(imgTags) {
    return imgTags.length ? (" + " + imgTags.length + " image" + (imgTags.length === 1 ? "" : "s")) : "";
  }
  // The qbank's System / Subject for a question, if a results page has told us.
  function questionSystem(qid) {
    const e = trackerLog.answered[currentQbankSlug() + " " + qid];
    return (e && (e.sys || e.subj)) || "";
  }
  function questionSubject(qid) {
    const e = trackerLog.answered[currentQbankSlug() + " " + qid];
    return (e && e.subj) || "";
  }
  // Chapters you've picked before, to break ties the same way next time.
  let chapterPicks = {};
  chrome.storage.local.get({ mnxChapterPicks: {} }, c => { chapterPicks = isObj(c.mnxChapterPicks) ? c.mnxChapterPicks : {}; });
  function rememberChapterPick(name) {
    if (!name) return;
    const k = String(name).toLowerCase();
    chapterPicks[k] = (chapterPicks[k] || 0) + 1;
    chrome.storage.local.set({ mnxChapterPicks: chapterPicks });
  }

  function openSaveDialog(s) {
    s = s || Q;
    if (!s || !s.notes.length) { toast("No AnKing card matched this question to save."); return; }
    const qid = s.qid;
    const notes = s.notes;                         // most specific first
    const m = buildModal("Save to Missed Qs — QID " + qid, () => document.removeEventListener("paste", pics.handlePaste));
    let chosenNote = notes[0];
    const NEW_OPT = "➕ New deck…";
    let candidates = [];

    // 1) card picker (only if several notes matched), best match first
    const fullCard = document.createElement("details");
    if (notes.length > 1) {
      const lbl = document.createElement("label"); lbl.className = "mnx-md-lbl";
      lbl.textContent = "Card (" + notes.length + " matched — most specific to this question first)"; m.body.appendChild(lbl);
      const pick = document.createElement("div"); pick.className = "mnx-pick";
      notes.forEach((note, i) => {
        const row = document.createElement("label");
        const r = document.createElement("input"); r.type = "radio"; r.name = "mnx-note"; r.checked = i === 0;
        r.addEventListener("change", () => { chosenNote = note; refreshDeckGuess(); refreshFullCard(); });
        const ids = Mt.rankInfo(note).ids;
        const span = noteGlance(note, ids > 1 ? "tagged on " + ids + " questions" : "");
        row.appendChild(r); row.appendChild(span); pick.appendChild(row);
      });
      m.body.appendChild(pick);
    }
    // 1b) the whole chosen card, collapsed: read it before deciding, without
    // it taking any room (or any time) when you don't open it.
    fullCard.className = "mnx-fullcard";
    const fullSum = document.createElement("summary");
    fullSum.textContent = notes.length > 1 ? "Show the full selected card" : "Show the full card";
    const fullBody = document.createElement("div"); fullBody.className = "mnx-fullcard-body";
    fullCard.append(fullSum, fullBody);
    function refreshFullCard() {
      if (!fullCard.open) return;
      const n = chosenNote;
      renderFullCard(fullBody, n, () => fullCard.open && chosenNote === n && m.ov.isConnected);
    }
    fullCard.addEventListener("toggle", refreshFullCard);
    m.body.appendChild(fullCard);

    // 2) chapter deck
    const dlbl = document.createElement("label"); dlbl.className = "mnx-md-lbl"; dlbl.textContent = "Chapter deck";
    m.body.appendChild(dlbl);
    const sel = document.createElement("select"); m.body.appendChild(sel);
    const newWrap = document.createElement("div"); newWrap.style.cssText = "margin-top:6px;display:none";
    const newInput = document.createElement("input"); newInput.type = "text";
    newInput.placeholder = "e.g. Missed Qs";
    newWrap.appendChild(newInput); m.body.appendChild(newWrap);

    // The base deck you save under is remembered per Step, so Step 1 and
    // Step 2 can keep separate trees. Always the ROOT: remembering a chapter
    // deck ("Missed Qs::GI") as the base made every later save append another
    // chapter to it.
    const step = s.sv || 1;
    let knownBase = "";
    const rawDeck = () => (sel.value === NEW_OPT ? newInput.value.trim() : sel.value);
    const chapterDeckSelected = () => Tg.isChapterDeck(rawDeck(), knownBase);
    // The root of the tree the selected deck is in.
    function rootDeck() {
      const raw = rawDeck();
      if (!raw) return "";
      return chapterDeckSelected() ? Tg.missedRoot(raw, knownBase) : stripKnownChapter(raw);
    }

    // 2b) chapter subdeck — one click, several options, never forced. Ranked by
    // the question's own system (from the qbank's results page), then the
    // subdecks you already have, then the card's tags and your past picks
    // (lib/tags.js). Recomputed when the deck list arrives or the deck changes.
    const system = questionSystem(qid);
    let chapters = [];
    let chapter = null, customChapter = "", chapterTouched = false;
    // Two kinds of suggestion:
    //   a base deck selected ("Missed Qs")      -> the chapter to file it under
    //   a chapter deck selected ("Missed Qs::GI") -> it IS the chapter; the
    //     suggestions become optional subdecks INSIDE it: the question's
    //     Subject (Pharmacology on Step 1, Medicine/Surgery on Step 2/3), the
    //     subdecks you already have there, then topics from the card's tags
    //     that fit inside it -- never another chapter. "Just GI" stays the default.
    const subject = questionSubject(qid);
    function computeChapters() {
      if (chapterDeckSelected()) {
        const raw = rawDeck(), leaf = deckLeaf(raw);
        const kids = Tg.childDecks(deckCache || [], raw).map(deckLeaf);
        const list = [];
        const add = (name, from, extra) => {
          if (!name || Tg.sameChapter(name, leaf) || list.some(c => Tg.sameChapter(c.name, name))) return;
          list.push(Object.assign({ name, from, n: 1, mine: kids.some(k => Tg.sameChapter(k, name)) }, extra || {}));
        };
        if (subject) add(subject, "subject", { subject: true });
        kids.forEach(k => add(k, "your subdeck", { mine: true }));
        // From the card's tags, only what fits inside this chapter -- never a
        // sibling chapter ("Cardio" inside "Respiratory"); see Tg.fitsInside.
        Tg.chapterCandidates(notes, step, { system, preferred: chapterPicks, existing: kids, limit: 12 })
          .filter(c => Tg.fitsInside(leaf, c.name))
          .forEach(c => add(c.name, c.from, { n: c.n, system: c.system }));
        chapters = list.slice(0, 6);
        return;
      }
      const existing = Tg.childDecks(deckCache || [], rootDeck()).map(deckLeaf);
      chapters = Tg.chapterCandidates(notes, step, { system, preferred: chapterPicks, existing });
      if (subject && !chapters.some(c => Tg.sameChapter(c.name, subject))) {
        chapters.push({ name: subject, from: "subject", n: 1, subject: true,
                        mine: existing.some(k => Tg.sameChapter(k, subject)) });
      }
    }
    function defaultChapter() {
      // A chapter deck is already the chapter: save straight into it.
      if (chapterDeckSelected()) return null;
      return chapters.length ? chapters[0].name : null;
    }

    const subLbl = document.createElement("label");
    subLbl.className = "mnx-md-lbl";
    m.body.appendChild(subLbl);

    const chips = document.createElement("div");
    chips.className = "mnx-chapchips";
    m.body.appendChild(chips);

    const customInput = document.createElement("input");
    customInput.type = "text"; customInput.placeholder = "Type a chapter name";
    customInput.className = "mnx-chapcustom"; customInput.style.display = "none";
    m.body.appendChild(customInput);

    function drawChips() {
      const inChapter = chapterDeckSelected();
      subLbl.textContent = inChapter
        ? "“" + deckLeaf(rawDeck()) + "” is already a chapter — add a subdeck inside it? (optional)"
        : chapters.length ? "Chapter subdeck" : "Chapter subdeck (none found in this card's tags)";
      chips.replaceChildren();
      const opts = chapters.map(c => ({ key: c.name, label: c.name,
        hint: (c.subject ? "this question's subject" : c.from) + (c.n > 1 ? " · ×" + c.n : "") +
              (c.system ? " · this question's system" : "") + (c.mine && c.from !== "your subdeck" ? " · your subdeck" : "") }));
      opts.push({ key: "__custom", label: "Custom…", hint: "" });
      opts.push(inChapter ? { key: null, label: "Just " + deckLeaf(rawDeck()), hint: "the deck you picked" }
                          : { key: null, label: "No subdeck", hint: "" });
      opts.forEach(o => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "mnx-chapchip" + ((o.key === "__custom" ? (chapter === customChapter && customInput.style.display !== "none") : chapter === o.key) ? " on" : "");
        const t = document.createElement("span"); t.textContent = o.label; b.appendChild(t);
        if (o.hint) { const h = document.createElement("i"); h.textContent = o.hint; b.appendChild(h); }
        b.addEventListener("click", onUserClick(() => {
          chapterTouched = true;
          if (o.key === "__custom") {
            customInput.style.display = "block";
            chapter = customInput.value.trim() || null;
            customInput.focus();
          } else {
            customInput.style.display = "none";
            chapter = o.key;
          }
          drawChips(); refreshDest();
        }));
        chips.appendChild(b);
      });
    }
    customInput.addEventListener("input", () => {
      chapterTouched = true;
      customChapter = customInput.value.trim();
      chapter = customChapter || null;
      refreshDest();
    });

    const dest = document.createElement("div");
    dest.className = "mnx-md-dest";
    m.body.appendChild(dest);

    // Strip a chapter we previously appended, whichever one it was.
    function stripKnownChapter(path) {
      if (!path) return path;
      const rawLeaf = deckLeaf(path);
      // Compare normalised, so a deck already named "03_Respiratory" is
      // recognised as the Respiratory chapter and we don't append a second one.
      const leaf = Tg.normDeck(rawLeaf);
      if (!leaf) return path;
      const known = chapters.map(c => Tg.normDeck(c.name));
      if (customChapter) known.push(Tg.normDeck(customChapter));
      if (known.indexOf(leaf) >= 0 && path.indexOf("::") > 0) return path.slice(0, -(rawLeaf.length + 2));
      return path;
    }
    // The deck the card goes to. A subdeck you already have is reused
    // ("03_Respiratory", "GI") rather than a parallel one created beside it. A
    // chapter deck you picked is used as it is -- or, if you pick a suggestion
    // too, that suggestion becomes a subdeck INSIDE it ("Missed Qs::GI::Pharm").
    function targetDeck() {
      const raw = rawDeck();
      if (!raw) return "";
      if (chapterDeckSelected()) {
        if (!chapter) return raw;
        return Tg.existingChapterDeck(deckCache, raw, chapter) || (raw + "::" + chapter);
      }
      if (!chapter) return stripKnownChapter(raw);
      const base = rootDeck();
      return Tg.existingChapterDeck(deckCache, base, chapter) || (base + "::" + chapter);
    }
    function refreshDest() {
      const t = targetDeck();
      dest.replaceChildren();
      const lbl = document.createElement("span"); lbl.textContent = "Saves to ";
      const path = document.createElement("b"); path.textContent = t || "(pick a deck)";
      dest.append(lbl, path);
    }
    // The selected deck changed (or the deck list arrived): the suggestions and,
    // unless you've chosen a chapter yourself, the default follow it.
    function onDeckChange() {
      computeChapters();
      if (!chapterTouched) { chapter = defaultChapter(); customInput.style.display = "none"; }
      drawChips();
      refreshDest();
    }
    onDeckChange();
    newInput.addEventListener("input", onDeckChange);

    function refreshDeckGuess() { const g = guessDeck(candidates, chosenNote); if (g) sel.value = g; onDeckChange(); }
    function fillDecks(all) {
      const missed = all.filter(d => /missed/i.test(d));
      candidates = (missed.length ? missed : all).slice().sort();
      // Someone who has never saved one has no Missed deck yet; offer the name
      // from the popup (or a sensible default) so the first save just works.
      if (!missed.length) candidates.unshift(plannedMissedDeck || "Missed Qs");
      sel.replaceChildren();
      candidates.forEach(d => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
      const o = document.createElement("option"); o.value = NEW_OPT; o.textContent = NEW_OPT; sel.appendChild(o);
      chrome.storage.local.get({ akMissedDeck: null, akMissedDeckByStep: {} }, c => {
        let want = (c.akMissedDeckByStep && c.akMissedDeckByStep[step]) || c.akMissedDeck;
        // 1.3 could remember a chapter deck as the base; read it as its root.
        if (want) want = Tg.missedRoot(want) || want;
        knownBase = want || "";
        if (want && candidates.includes(want)) { sel.value = want; onDeckChange(); }
        else refreshDeckGuess();
      });
    }
    sel.addEventListener("change", () => {
      newWrap.style.display = sel.value === NEW_OPT ? "block" : "none";
      onDeckChange();
    });
    if (deckCache) fillDecks(deckCache);
    else {
      const o = document.createElement("option"); o.value = ""; o.textContent = "Loading decks…"; sel.appendChild(o);
      bridge("listDecks").then(d => { deckCache = d || []; fillDecks(deckCache); })
        .catch(e => { deckCache = deckCache || []; sel.replaceChildren();
          const oo = document.createElement("option"); oo.value = NEW_OPT; oo.textContent = NEW_OPT; sel.appendChild(oo);
          newWrap.style.display = "block"; toast("Couldn't list decks: " + bridgeFailure(e)); });
    }

    // 3) your note (pre-filled with any text you've selected on the page)
    const nlbl = document.createElement("label"); nlbl.className = "mnx-md-lbl";
    nlbl.textContent = "Your note (appended to “Missed Questions”)"; m.body.appendChild(nlbl);
    const ta = document.createElement("textarea");
    ta.value = ((window.getSelection && String(window.getSelection())) || "").trim();
    ta.placeholder = "What you want to remember from this question…"; m.body.appendChild(ta);

    // 3b) images — paste a screenshot straight into the note, or add files
    const pics = makeImagePicker("Images");
    m.body.appendChild(pics.el);
    document.addEventListener("paste", pics.handlePaste);   // removed on close (see buildModal onClose)

    // 4) what is already saved for this question
    const savedBox = document.createElement("div");
    savedBox.className = "mnx-saved";
    savedBox.style.display = "none";
    m.body.appendChild(savedBox);

    const modeNote = document.createElement("div");
    modeNote.className = "mnx-md-dest";
    modeNote.textContent = missedMode === "copy"
      ? "Mode: make a copy — the copy won't receive AnKing updates. Change in the Mnestic popup."
      : missedMode === "tag"
        ? "Mode: tag only — nothing moves decks. Change in the Mnestic popup."
        : "Mode: move the card — keeps its history and AnKing updates. Change in the Mnestic popup.";
    m.body.appendChild(modeNote);

    const saveBtn = mdButton(missedMode === "copy" ? "Save copy" : missedMode === "tag" ? "Tag it" : "Move it", "mnx-md-ok", async () => {
      const label = saveBtn.textContent;
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        // The deck list may still be in flight. Without it, an existing
        // "Missed Qs::03_Respiratory" can't be matched and we'd create a
        // parallel "Missed Qs::Respiratory". Wait for it, THEN resolve the deck.
        if (deckCache === null) {
          try { deckCache = (await bridge("listDecks")) || []; } catch (e) { deckCache = []; }
        }
        const deck = targetDeck();
        if (!deck) {
          toast("Pick or type a deck.");
          saveBtn.disabled = false; saveBtn.textContent = label;
          return;
        }
        const imgTags = await pics.upload(SITE.id + "-" + qid);
        let noteHtml = ta.value.trim() ? escapeHtml(ta.value.trim()).replace(/\n/g, "<br>") : "";
        if (imgTags.length) noteHtml += (noteHtml ? "<br>" : "") + imgTags.join("<br>");
        // Anki splits tags on whitespace, and a chapter name comes from deck
        // tags we don't control — cleanSeg turns "_" into " ", so a segment
        // like "Cardio_marked_leech" would fan out into three tags and write
        // "marked" and "leech" onto the note. Collapse it back to one tag.
        // The chapter tag follows the deck: Mnestic::Missed::<chapter>, and
        // inside a chapter deck Mnestic::Missed::<chapter>::<subdeck>.
        const inChapterDeck = chapterDeckSelected();
        const tagChapter = inChapterDeck ? Tg.cleanSeg(deckLeaf(rawDeck())) : chapter;
        const tagPath = [tagChapter, inChapterDeck ? chapter : null].filter(Boolean)
          .map(seg => String(seg).split("::").join("_").replace(/\s+/g, "_"));
        const chapTag = tagPath.length ? MISSED_TAG + "::" + tagPath.join("::") : MISSED_TAG;
        // Mnestic::QID::<id> records WHICH question this was missed on, so the
        // missed list and undo work per question rather than per note.
        const tags = [MISSED_TAG, chapTag, Mt.qidTag(qid)];
        //   move  the ORIGINAL card moves into the chapter subdeck. Real deck,
        //         no duplicate, keeps its review history, and the note keeps its
        //         ankihub_id so AnKing updates keep arriving.
        //   tag   nothing moves; the note is tagged Mnestic::Missed::<chapter>.
        //   copy  duplicate the note into the subdeck. A separate card that will
        //         never receive AnKing updates again — offered, not the default.
        let what;
        if (missedMode === "copy") {
          let existing = [];
          try { existing = (await bridge("searchNotes", { query: (s.query || qidQuery(qid, s.sv || 1)) + " tag:" + COPY_TAG })) || []; }
          catch (e) { existing = []; }
          if (existing.length) {
            // Already copied: add to that copy rather than make another.
            if (noteHtml) await bridge("updateNote", { noteId: existing[0], fieldAppends: { "Missed Questions": noteHtml }, addTags: [PROTECT_TAG, Mt.qidTag(qid)] });
            what = noteHtml ? "Added your note" + extraLabel(imgTags) + " to the copy you already saved."
                            : "You've already saved a copy of this question — nothing to add.";
          } else {
            const params = { noteId: chosenNote.noteId, deck, addTags: tags.slice() };
            if (noteHtml) { params.fieldAppends = { "Missed Questions": noteHtml }; params.addTags.push(PROTECT_TAG); }
            const res = await bridge("copyNote", params);
            const copyId = (res && typeof res === "object") ? res.noteId : res;
            if (copyId) await recordSave(copyId, { qid, mode: "copy", copyOf: chosenNote.noteId });
            what = "Saved a copy to " + deckLeaf(deck) + (noteHtml ? " with your note" + extraLabel(imgTags) + "." : ".");
          }
        } else {
          const params = { noteId: chosenNote.noteId, addTags: tags.slice() };
          if (noteHtml) { params.fieldAppends = { "Missed Questions": noteHtml }; params.addTags.push(PROTECT_TAG); }
          await bridge("updateNote", params);
          // Unsuspend the card you chose -- not every card of every note on the
          // question, as 1.3 did -- and keep the list so undo can put it back.
          let unsuspended = [];
          try {
            const r = await bridge("unsuspend", { queries: ["nid:" + chosenNote.noteId] });
            unsuspended = (r && r[0] && Array.isArray(r[0].cids)) ? r[0].cids : [];
          } catch (e) {}
          if (missedMode === "move" && deck) {
            // The browser updates the extension on its own; the Anki add-on has
            // to be updated by hand. Someone can easily be running a new
            // extension against an old bridge, where setDeck doesn't exist —
            // the tag above has already been written, so degrade to that rather
            // than failing the save and losing their note.
            let res = null, tooOld = false;
            try { res = await bridge("setDeck", { notes: [chosenNote.noteId], deck }); }
            catch (err) {
              if (err && err.code === "old-addon") tooOld = true; else throw err;
            }
            if (tooOld) {
              await recordSave(chosenNote.noteId, { qid, mode: "tag", unsuspended });
              what = "Tagged it, but your Mnestic Bridge add-on is too old to move cards — " +
                     "update the add-on in Anki to use Move mode.";
            } else {
              const n = (res && res.moved) || 0;
              // res.from is the deck the card actually lived in. Only the add-on
              // knows it, and only right now -- after this it is gone.
              await recordSave(chosenNote.noteId, { qid, mode: "move", from: (res && res.from) || "", to: deck, unsuspended });
              what = "Moved " + n + (n === 1 ? " card" : " cards") + " to " + deckLeaf(deck) +
                (noteHtml ? " with your note" + extraLabel(imgTags) + "." : ".");
            }
          } else {
            await recordSave(chosenNote.noteId, { qid, mode: "tag", unsuspended });
            what = "Tagged " + chapTag + (noteHtml ? " and added your note" + extraLabel(imgTags) + "." : ".");
          }
        }

        rememberChapterPick(inChapterDeck ? chapter : tagChapter);
        // The ROOT of the tree, per Step (see fillDecks).
        const root = rootDeck();
        chrome.storage.local.get({ akMissedDeckByStep: {} }, c => {
          const byStep = isObj(c.akMissedDeckByStep) ? c.akMissedDeckByStep : {};
          byStep[step] = root;
          chrome.storage.local.set({ akMissedDeck: root, akMissedDeckByStep: byStep });
        });
        if (deckCache && !deckCache.includes(deck)) deckCache.push(deck);
        m.close();
        toast(what);
      } catch (e) {
        saveBtn.disabled = false; saveBtn.textContent = label;
        toast("Couldn't save: " + bridgeFailure(e));
      }
    });
    // Saving by mistake used to be permanent: nothing in the extension could
    // take a question back out of Missed Qs, and the only fix was Anki's Browse
    // window. The button appears once we know there IS something to undo.
    async function runUndo(btn, onlyNoteId) {
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "Removing…";
      try {
        const r = await unsaveMissed(s, onlyNoteId);
        if (r.nothing) { toast("This question isn't saved."); m.close(); return; }
        m.close();
        toast(undoMessage(r));
      } catch (e) {
        btn.disabled = false; btn.textContent = label;
        toast(e && e.code === "old-addon"
          ? "Update the Mnestic Bridge add-on in Anki to undo a save."
          : "Couldn't remove it: " + bridgeFailure(e));
      }
    }
    const undoBtn = mdButton("Remove from Missed Qs", "mnx-md-undo", () => runUndo(undoBtn));
    undoBtn.style.display = "none";
    m.foot.appendChild(undoBtn);
    m.foot.appendChild(mdButton("Cancel", "mnx-md-cancel", m.close));
    m.foot.appendChild(saveBtn);

    // What's already saved for this question. A round trip, so the dialog
    // opens without waiting and this joins it when the answer arrives -- the
    // common case is a question that was never saved.
    (async () => {
      let found;
      try { found = await savedForQuestion(s); } catch (e) { return; }
      if (!m.ov.isConnected) return;
      const mine = found.mine.concat(found.shared);
      if (!mine.length && !found.others.length) return;
      savedBox.style.display = "";
      if (mine.length) {
        undoBtn.style.display = "";
        const h = document.createElement("div"); h.className = "mnx-md-lbl";
        h.textContent = "Already saved from this question";
        savedBox.appendChild(h);
        mine.forEach(n => {
          const row = document.createElement("div"); row.className = "mnx-saved-row";
          const t = document.createElement("span"); t.textContent = noteSnippet(n) + (isCopyNote(n) ? " (copy)" : "");
          row.appendChild(t);
          if (mine.length > 1) {
            const b = document.createElement("button"); b.type = "button"; b.className = "mnx-saved-x";
            b.textContent = "Remove"; b.title = "Remove only this card from Missed Qs";
            b.addEventListener("click", onUserClick(() => runUndo(b, n.noteId)));
            row.appendChild(b);
          }
          savedBox.appendChild(row);
        });
        const note = document.createElement("div"); note.className = "mnx-md-hint";
        note.textContent = "Saving again adds to the card you pick; picking a different card saves that one too.";
        savedBox.appendChild(note);
      }
      if (found.others.length) {
        const o = document.createElement("div"); o.className = "mnx-md-hint";
        o.textContent = found.others.length + " card" + (found.others.length === 1 ? " on this question is" : "s on this question are") +
          " already in Missed Qs from another question. Removing here leaves " + (found.others.length === 1 ? "it" : "them") + " alone.";
        savedBox.appendChild(o);
      }
    })();
  }

  // ---- panel header (sits atop the resource panel on the review page) ----
  function pbtn(label, cls, onClick) {
    const b = document.createElement("button"); b.className = "mnx-pbtn " + (cls || ""); b.textContent = label;
    b.addEventListener("click", onUserClick(onClick)); return b;
  }
  function addPanelHeader(s) {
    const panel = document.getElementById(PANEL_ID); if (!panel) return;
    const qid = s.qid;
    const head = document.createElement("div"); head.className = "mnx-phead";
    head.appendChild(pbtn("🤖 Copy for AI", "", () => copyFullQuestion(qid)));   // full Q + your AI prompt
    head.appendChild(pbtn("📝 Copy explanation", "", () => copyExplanation()));  // for your notes
    head.appendChild(pbtn("✚ Make card", "", () => openMakeCardDialog(String((window.getSelection && window.getSelection()) || ""))));
    if (s.notes.length) {
      head.appendChild(pbtn("👁 Preview", "", () => openPreview(s.notes, 0)));
      head.appendChild(pbtn("★ Save to Missed Qs", "mnx-save", () => openSaveDialog(s)));
    }
    panel.appendChild(head);
    addConfidenceRow(qid);
    if (s.notes.length) addCardStatus(s);
  }

  // A question you got RIGHT by guessing is the highest-yield thing to review,
  // and no qbank records it — they only see "correct". One tap does.
  const CONFIDENCE = [
    ["knew", "Knew it", "You could explain why"],
    ["guessed", "Guessed", "Right, but you weren't sure — review this"],
    ["noidea", "No idea", "Flag it for a proper read"]
  ];
  function addConfidenceRow(qid) {
    const panel = document.getElementById(PANEL_ID); if (!panel) return;
    const row = document.createElement("div");
    row.className = "mnx-recall";
    const lbl = document.createElement("span");
    lbl.className = "mnx-recall-lbl"; lbl.textContent = "How did that go?";
    row.appendChild(lbl);
    const slug = currentQbankSlug();
    const current = (trackerLog.answered[slug + " " + qid] || {}).conf || null;
    CONFIDENCE.forEach(([key, label, title]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mnx-recall-btn mnx-recall-" + key + (current === key ? " on" : "");
      b.setAttribute("aria-pressed", current === key ? "true" : "false");
      b.textContent = label; b.title = title;
      b.addEventListener("click", onUserClick(() => {
        setConfidence(qid, current === key ? null : key);
        const again = panel.querySelector(".mnx-recall");
        if (again) { again.remove(); addConfidenceRow(qid); }
      }));
      row.appendChild(b);
    });
    const headEl = panel.querySelector(".mnx-phead");
    if (headEl && headEl.nextSibling) panel.insertBefore(row, headEl.nextSibling);
    else panel.appendChild(row);
  }
  // Rating a question is not answering it. Rating one from an old block you're
  // reviewing used to create a record dated NOW, which put it on today's count,
  // streak and pace. A question the panel never saw you answer stays undated.
  function setConfidence(qid, conf) {
    const slug = currentQbankSlug();
    const key = slug + " " + qid;
    const e = trackerLog.answered[key] || (trackerLog.answered[key] = { ts: null, slug, qid, src: "rating" });
    if (conf) e.conf = conf; else delete e.conf;
    saveLog();
    if (conf === "guessed") toast("Noted — a right answer you weren't sure of counts as weak.");
  }

  // How ready are you for THIS question? The panel already knows which cards
  // match it; showing their state turns "here are your resources" into "here's
  // where you actually stand", and surfaces suspended cards you'd never see.
  async function addCardStatus(s) {
    const panel = document.getElementById(PANEL_ID); if (!panel) return;
    const strip = document.createElement("div");
    strip.className = "mnx-cards";
    const bar = document.createElement("div"); bar.className = "mnx-cards-bar";
    const txt = document.createElement("span"); txt.className = "mnx-cards-txt";
    txt.textContent = "Checking your cards…";
    strip.append(bar, txt);
    // Directly under the button row, above the resources.
    const headEl = panel.querySelector(".mnx-phead");
    if (headEl && headEl.nextSibling) panel.insertBefore(strip, headEl.nextSibling);
    else panel.appendChild(strip);

    // The search that matched -- so these counts are about the cards on screen.
    const query = s.query || qidQuery(s.qid, s.sv || 1);
    let m;
    try { m = (await bridge("cardMaturity", { queries: [query] }))[0]; }
    catch (e) { strip.remove(); return; }
    if (!isLive(s)) { strip.remove(); return; }          // moved on while we waited
    if (!m || !m.total) { strip.remove(); return; }

    const SEGS = [
      ["mature", m.mature, "mature"],
      ["young", m.young, "still young"],
      ["learning", m.learning, "learning"],
      ["new", m.new, "unseen"],
      ["suspended", m.suspended, "suspended"]
    ];
    for (const [cls, n] of SEGS) {
      if (!n) continue;
      const i = document.createElement("i");
      i.className = "mnx-seg-" + cls;
      i.style.width = (100 * n / m.total) + "%";
      bar.appendChild(i);
    }
    const parts = SEGS.filter(x => x[1]).map(x => x[1] + " " + x[2]);
    txt.replaceChildren();
    const strong = document.createElement("b");
    strong.textContent = m.total + (m.total === 1 ? " card" : " cards");
    txt.append(strong, document.createTextNode(parts.length ? "  ·  " + parts.join("  ·  ") : ""));
    bar.title = parts.join(", ");

    if (m.suspended > 0) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "mnx-unsus";
      btn.textContent = "Unsuspend " + m.suspended;
      btn.title = "Unsuspend this question's suspended AnKing cards";
      btn.addEventListener("click", onUserClick(async () => {
        btn.disabled = true; btn.textContent = "Unsuspending…";
        try {
          await bridge("unsuspend", { queries: [query] });
          toast("Unsuspended " + m.suspended + (m.suspended === 1 ? " card" : " cards") + ".");
          btn.remove();
          const again = document.querySelector("#" + PANEL_ID + " .mnx-cards");
          if (again && isLive(s)) { again.remove(); addCardStatus(s); }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Unsuspend " + m.suspended;
          toast("Couldn't unsuspend: " + bridgeFailure(e));
        }
      }));
      strip.appendChild(btn);
    }
  }

  // ============================================================
  // FEATURE 2c - make a NEW card (Cloze/Basic) from selected text
  // ============================================================
  // Wrap the selection (or the whole text) in the next cloze. lib/cards.js
  // keeps a selection containing "::" or "}}" from breaking the card.
  function clozeWrap(ta) {
    const r = Cd.wrapCloze(ta.value, ta.selectionStart, ta.selectionEnd);
    if (r.wrapped) ta.value = r.text;
    ta.focus();
  }
  function sourceHtml(qid) {
    const link = '<a href="' + location.href.replace(/"/g, "&quot;") + '">' + escapeHtml(SITE.label) + "</a>";
    return (qid ? SITE.label + " QID " + qid + " · " : "") + link;
  }
  function openMakeCardDialog(prefill) {
    hideSelChip();
    prefill = (prefill || "").replace(/\s+/g, " ").trim();
    const qid = findQid();
    const m = buildModal("Make a card", () => document.removeEventListener("paste", pics.handlePaste));
    let kind = "cloze";

    const seg = document.createElement("div"); seg.className = "mnx-seg";
    const segCloze = document.createElement("button"); segCloze.type = "button"; segCloze.textContent = "Cloze"; segCloze.className = "on";
    const segBasic = document.createElement("button"); segBasic.type = "button"; segBasic.textContent = "Basic";
    seg.appendChild(segCloze); seg.appendChild(segBasic); m.body.appendChild(seg);

    const clozeView = document.createElement("div");
    const clLbl = document.createElement("label"); clLbl.className = "mnx-md-lbl"; clLbl.textContent = "Text";
    const clozeTa = document.createElement("textarea"); clozeTa.value = prefill;
    clozeTa.placeholder = "Highlight a word below, then “Make cloze”…";
    const clRow = document.createElement("div"); clRow.className = "mnx-inline";
    const clozeBtn = document.createElement("button"); clozeBtn.type = "button"; clozeBtn.className = "mnx-md-btn mnx-md-cancel"; clozeBtn.textContent = "Make cloze {{c}}";
    clozeBtn.addEventListener("click", onUserClick(() => clozeWrap(clozeTa)));
    const clHint = document.createElement("span"); clHint.className = "mnx-md-hint"; clHint.textContent = "Highlight the word to hide, then click.";
    clRow.appendChild(clozeBtn); clRow.appendChild(clHint);
    const exLbl = document.createElement("label"); exLbl.className = "mnx-md-lbl"; exLbl.textContent = "Extra (optional — hint / why)";
    const extraTa = document.createElement("textarea");
    clozeView.appendChild(clLbl); clozeView.appendChild(clozeTa); clozeView.appendChild(clRow); clozeView.appendChild(exLbl); clozeView.appendChild(extraTa);

    const basicView = document.createElement("div"); basicView.style.display = "none";
    const fLbl = document.createElement("label"); fLbl.className = "mnx-md-lbl"; fLbl.textContent = "Front (your prompt)";
    const frontTa = document.createElement("textarea"); frontTa.placeholder = "Ask yourself a question…";
    const bLbl = document.createElement("label"); bLbl.className = "mnx-md-lbl"; bLbl.textContent = "Back (answer)";
    const backTa = document.createElement("textarea"); backTa.value = prefill;
    basicView.appendChild(fLbl); basicView.appendChild(frontTa); basicView.appendChild(bLbl); basicView.appendChild(backTa);
    m.body.appendChild(clozeView); m.body.appendChild(basicView);

    function setKind(k) {
      kind = k; const c = k === "cloze";
      segCloze.classList.toggle("on", c); segBasic.classList.toggle("on", !c);
      clozeView.style.display = c ? "block" : "none"; basicView.style.display = c ? "none" : "block";
    }
    segCloze.addEventListener("click", onUserClick(() => setKind("cloze")));
    segBasic.addEventListener("click", onUserClick(() => setKind("basic")));

    const dlbl = document.createElement("label"); dlbl.className = "mnx-md-lbl"; dlbl.textContent = "Deck"; m.body.appendChild(dlbl);
    const sel = document.createElement("select"); m.body.appendChild(sel);
    const newWrap = document.createElement("div"); newWrap.style.cssText = "margin-top:6px;display:none";
    const newInput = document.createElement("input"); newInput.type = "text"; newInput.placeholder = "e.g. Missed Qs::My cards";
    newWrap.appendChild(newInput); m.body.appendChild(newWrap);
    const NEW_OPT = "➕ New deck…";
    function fillDecks(all) {
      const list = (all || []).slice().sort();
      sel.replaceChildren();
      list.forEach(d => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
      const o = document.createElement("option"); o.value = NEW_OPT; o.textContent = NEW_OPT; sel.appendChild(o);
      chrome.storage.local.get({ akMakeDeck: null, akMissedDeck: null }, c => {
        const want = c.akMakeDeck || c.akMissedDeck;
        if (want && list.includes(want)) sel.value = want;
      });
    }
    sel.addEventListener("change", () => {
      newWrap.style.display = sel.value === NEW_OPT ? "block" : "none";
    });
    function targetDeck() { return sel.value === NEW_OPT ? newInput.value.trim() : sel.value; }
    if (deckCache) fillDecks(deckCache);
    else {
      const o = document.createElement("option"); o.value = ""; o.textContent = "Loading decks…"; sel.appendChild(o);
      bridge("listDecks").then(d => { deckCache = d || []; fillDecks(deckCache); })
        .catch(e => { sel.replaceChildren(); const oo = document.createElement("option"); oo.value = NEW_OPT; oo.textContent = NEW_OPT; sel.appendChild(oo); newWrap.style.display = "block"; toast("Couldn't list decks: " + bridgeFailure(e)); });
    }

    const pics = makeImagePicker("Images (optional)");
    m.body.appendChild(pics.el);
    document.addEventListener("paste", pics.handlePaste);   // removed on close (buildModal onClose)

    const srcWrap = document.createElement("label"); srcWrap.className = "mnx-md-check";
    const srcCb = document.createElement("input"); srcCb.type = "checkbox"; srcCb.checked = true;
    const srcTxt = document.createElement("span"); srcTxt.textContent = qid ? ("Add source (QID " + qid + " + link)") : "Add page link as source";
    srcWrap.appendChild(srcCb); srcWrap.appendChild(srcTxt); m.body.appendChild(srcWrap);

    // Anki's own duplicate check: the same first field in the same note type.
    // The first click that finds one asks; the second creates it anyway.
    let allowDuplicate = false, uploaded = null;
    const dupNote = document.createElement("div"); dupNote.className = "mnx-md-dest mnx-dup"; dupNote.style.display = "none";
    dupNote.setAttribute("role", "status");
    m.body.appendChild(dupNote);
    const saveBtn = mdButton("Create card", "mnx-md-ok", async () => {
      const deck = targetDeck();
      if (!deck) { toast("Pick or type a deck."); return; }
      let rawCloze;
      if (kind === "cloze") {
        rawCloze = clozeTa.value.trim();
        if (!rawCloze) { toast("Add some text."); return; }
        if (rawCloze.indexOf("{{c") < 0) { toast("Make at least one cloze first (highlight a word → Make cloze)."); return; }
      } else if (!frontTa.value.trim() && !backTa.value.trim() && !pics.images.length) {
        toast("Add a front, back, or image."); return;
      }
      const label = saveBtn.textContent;
      saveBtn.disabled = true; saveBtn.textContent = "Creating…";
      try {
        // Uploaded once: asking "create anyway?" must not store the images twice.
        const imgTags = uploaded || (uploaded = await pics.upload("card-" + (qid || "x")));
        const imgs = imgTags.join("<br>");
        const src = srcCb.checked ? ('<div style="font-size:12px;opacity:.7;margin-top:8px">' + sourceHtml(qid) + '</div>') : "";
        // Linked to the question it came from, so it shows up with that
        // question's cards the next time you see it.
        const tags = ["Mnestic::Made"];
        if (safeQidOrNull(qid)) tags.push(Mt.qidTag(qid));
        const params = { deck, kind, addTags: tags, checkDuplicate: true, allowDuplicate };
        if (kind === "cloze") {
          params.text = escapeHtml(rawCloze).replace(/\n/g, "<br>");
          const parts = [extraTa.value.trim() ? escapeHtml(extraTa.value.trim()).replace(/\n/g, "<br>") : "", imgs].filter(Boolean);
          const extra = parts.join("<br><br>") + src;
          if (extra) params.extra = extra;
        } else {
          params.front = escapeHtml(frontTa.value.trim()).replace(/\n/g, "<br>");
          const parts = [escapeHtml(backTa.value.trim()).replace(/\n/g, "<br>"), imgs].filter(Boolean);
          params.back = parts.join("<br><br>") + src;
        }
        const res = await bridge("newNote", params);
        if (res && res.duplicate) {
          allowDuplicate = true;
          dupNote.textContent = "You already have a " + (res.model || kind) + " card with exactly this text. " +
            "Click “Create anyway” to add a second one, or Cancel.";
          dupNote.style.display = "";
          saveBtn.disabled = false; saveBtn.textContent = "Create anyway";
          return;
        }
        chrome.storage.local.set({ akMakeDeck: deck });
        if (deckCache && !deckCache.includes(deck)) deckCache.push(deck);
        m.close();
        const extraMsg = imgTags.length ? (" (+" + imgTags.length + " image" + (imgTags.length === 1 ? "" : "s") + ")") : "";
        toast("Created a " + kind + " card in " + deckLeaf(deck) + extraMsg + ".");
      } catch (e) { saveBtn.disabled = false; saveBtn.textContent = label; toast("Couldn't create the card: " + bridgeFailure(e)); }
    });
    m.foot.appendChild(mdButton("Cancel", "mnx-md-cancel", m.close));
    m.foot.appendChild(saveBtn);
    setTimeout(() => (kind === "cloze" ? clozeTa : frontTa).focus(), 30);
  }

  // floating "✚ Make card" chip that appears when you select text on the page
  let selChipEl = null;
  function ensureSelChip() {
    if (selChipEl && document.body.contains(selChipEl)) return selChipEl;
    const b = document.createElement("button"); b.id = "mnx-selchip"; b.type = "button"; b.textContent = "✚ Make card";
    b.addEventListener("mousedown", e => e.preventDefault());           // keep the text selection
    b.addEventListener("click", onUserClick(e => { e.preventDefault(); e.stopPropagation(); openMakeCardDialog(b.dataset.text || ""); }));
    document.body.appendChild(b); selChipEl = b; return b;
  }
  function hideSelChip() { if (selChipEl) selChipEl.style.display = "none"; }
  function selInsideAkuts(node) { while (node) { if (node.nodeType === 1 && (node.id || "").indexOf("mnx-") === 0) return true; node = node.parentNode; } return false; }
  function maybeShowSelChip() {
    if (!SITE.inTest()) { hideSelChip(); return; }
    const s = window.getSelection && window.getSelection();
    const text = s ? String(s).trim() : "";
    if (!text || text.length < 6 || text.length > 4000 || !s.rangeCount) { hideSelChip(); return; }
    if (s.anchorNode && selInsideAkuts(s.anchorNode)) { hideSelChip(); return; }
    let rect; try { rect = s.getRangeAt(0).getBoundingClientRect(); } catch (e) { hideSelChip(); return; }
    if (!rect || (!rect.width && !rect.height)) { hideSelChip(); return; }
    const chip = ensureSelChip(); chip.dataset.text = text; chip.style.display = "flex";
    const cw = chip.offsetWidth || 120, ch = chip.offsetHeight || 34;
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(6, Math.min(window.innerWidth - cw - 6, left));
    let top = rect.top - ch - 8; if (top < 6) top = rect.bottom + 8;
    chip.style.left = left + "px"; chip.style.top = top + "px";
  }
  document.addEventListener("mouseup", () => setTimeout(maybeShowSelChip, 0));
  document.addEventListener("mousedown", e => { if (selChipEl && e.target !== selChipEl) hideSelChip(); });
  document.addEventListener("scroll", hideSelChip, true);

  // ---- one-click "Anki" button next to the Question Id in the player header ----
  const QID_BTN_ID = "mnx-qid-open";
  // Sit the "Anki" button next to whatever the site calls the id — "Question Id"
  // on Coursology/UWorld, "UW Id" on MedPark — so use the adapter's own regexes
  // rather than one hard-coded label.
  function qidLabelEl() {
    let best = null;
    for (const el of document.querySelectorAll("span, div, p, h1, h2, h3, h4, label, li, td")) {
      if (el.id === QID_BTN_ID) continue;
      const txt = el.textContent || "";
      if (txt.length > 60) continue;                      // skip large wrappers
      if (!SITE.qidRe.some(re => re.test(txt))) continue;
      if (!best || txt.length < best.textContent.length) best = el;   // smallest = most specific
    }
    return best;
  }
  function ensureQidButton() {
    const qid = findQid();
    const existing = document.getElementById(QID_BTN_ID);
    // The question id sits in the header for every question of a test, so an
    // id alone put this button beside every UNANSWERED question -- one click
    // from opening Anki on its own cards, which is the answer. It follows the
    // panel's rule now: nothing until the question is answered.
    if (!qid || !isAnswered()) { if (existing) existing.remove(); return; }
    if (existing) { existing.dataset.qid = qid; return; }   // keep button, just refresh target
    const btn = document.createElement("button");
    btn.id = QID_BTN_ID; btn.type = "button"; btn.className = "mnx-qid-open";
    btn.textContent = "Anki";
    btn.title = "Open this question's AnKing cards in Anki";
    btn.dataset.qid = qid;
    btn.addEventListener("click", onUserClick(e => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.qid || findQid();
      if (id) openInAnki(Q && Q.qid === id ? Q : id);
    }));
    const label = qidLabelEl();
    if (label) label.insertAdjacentElement("afterend", btn);
    else { btn.classList.add("mnx-qid-float"); document.body.appendChild(btn); }
  }

  // ============================================================
  // FEATURE 3 - study logging (data only; the dashboard lives in the popup)
  // Logs each question the moment you answer it (we see it unanswered, then the
  // explanation appears), deduped by qid forever, and scrapes the qbank totals
  // off the Welcome/Performance dashboard so "remaining" is summed automatically.
  // The popup reads this storage and renders Today / This week / Remaining.
  // ============================================================
  const TRACKER_KEY = "akTrackerV2";   // the storage key; the log inside is v3 (lib/tracker.js)
  // answered  per-question detail (correctness, confidence, system) — our own observation
  // totals    the qbank's own Used/Unused/Total, per bank
  // daily     questions the qbank counted that we never saw, by calendar day and bank
  // undated   the same, when the counter moved across several days we can't tell apart
  // snaps     one reading of the counter per bank per day, for the pace
  let trackerLog = Trk.normalizeLog(null);
  let logLoaded = false;
  // Nothing is written until the stored log has been read, or an early write
  // would replace it with this empty one.
  function saveLog() {
    if (!logLoaded) return;
    try { chrome.storage.local.set({ [TRACKER_KEY]: trackerLog }); } catch (e) {}
  }
  chrome.storage.local.get({ [TRACKER_KEY]: null }, c => {
    const stored = c[TRACKER_KEY];
    trackerLog = Trk.normalizeLog(stored);
    logLoaded = true;
    if (stored && stored.v !== Trk.VERSION) saveLog();     // one-time upgrade of a 1.3 log
  });
  // Another qbank tab (or the popup) wrote the log: carry on from that, not
  // from a stale copy that would overwrite it on our next save.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[TRACKER_KEY] && changes[TRACKER_KEY].newValue) {
      trackerLog = Trk.normalizeLog(changes[TRACKER_KEY].newValue);
    }
  });

  function currentQbankSlug() { try { return SITE.blockSlug() || "default"; } catch (e) { return "default"; } }
  // qid -> how many consecutive ticks we saw it UNANSWERED. Reviewing a finished
  // test renders the explanation immediately, but the SPA can flash the stem
  // first — one such frame used to count as "answered today" and inflate the
  // streak. Require the question to sit unanswered for a couple of seconds.
  const seenUnanswered = new Map();
  const ANSWER_MIN_TICKS = 2;

  // Reliable correctness: backfill from the results table / Question List (both
  // mark each qid correct/incorrect), instead of scanning the player's answer
  // marks — which the left navigator's per-question ✓/✗ would falsely trip.
  function backfillCorrectness(rows) {
    if (!rows || !rows.length) return;
    const slug = currentQbankSlug();
    let changed = false;
    rows.forEach(r => {
      const key = slug + " " + r.qid;
      let e = trackerLog.answered[key];
      if (!e) {
        // Seen only in a results table — we have no idea WHEN it was answered,
        // and a block reviewed weeks later must not count toward today. ts stays
        // null: it feeds weak areas and the retest list, never the streak.
        e = trackerLog.answered[key] = { ts: null, slug, qid: r.qid, src: "results" };
        changed = true;
      }
      const correct = !isMissed(r);
      if (e.correct !== correct) { e.correct = correct; changed = true; }
    });
    if (changed) saveLog();
  }

  // Record a question the first time it's answered (counted once, ever). A
  // question first seen in a results table or rated in review has a record
  // with no date; watching it answered gives it one.
  function logAnswered(qid) {
    const slug = currentQbankSlug();
    const key = slug + " " + qid;
    const e = trackerLog.answered[key];
    if (e && e.ts) return;
    trackerLog.answered[key] = Object.assign(e || { slug, qid }, { ts: Date.now(), sv: (Q && Q.sv) || undefined });
    saveLog();
  }

  // Read "Used / Unused / Total Questions" off the dashboard (best-effort, body text).
  let lastScrape = 0;
  function scrapeDashboardTotals() {
    if (!SITE.isDashboard()) return;
    // A bank's OWN dashboard only. Coursology's home page shows totals across
    // every bank; stored as a bank called "default", they made "remaining" jump
    // depending on which page you'd opened last, and mixed banks into the pace.
    const slug = currentQbankSlug();
    if (slug === "default") return;
    const now = Date.now(); if (now - lastScrape < 4000) return; lastScrape = now;
    const bt = document.body ? (document.body.innerText || "") : "";
    const num = re => { const m = bt.match(re); return m ? parseInt(m[1].replace(/,/g, ""), 10) : null; };
    const total = num(/Total Questions\s*([\d,]+)/i);
    const used = num(/\bUsed Questions\s*([\d,]+)/i);
    const unused = num(/Unused Questions\s*([\d,]+)/i);
    if (total == null && used == null && unused == null) return;
    const prev = trackerLog.totals[slug] || {};

    // The panel only sees questions you actually review, so a timed block you
    // never opened used to leave no trace at all. The qbank's own "Used" count
    // can't miss one — so it decides HOW MANY, while our log keeps saying which
    // ones and how they went. What the counter saw that we didn't is credited
    // to today only if the last reading was also today; otherwise it is kept
    // undated (lib/tracker.js). 1.3 put a whole week of blocks on the day you
    // happened to open the dashboard.
    const credit = Trk.creditCounter(trackerLog, slug, prev, used, now);
    const day = Dt.dayKey(now);
    const snapBefore = (trackerLog.snaps[slug] || {})[day];
    if (used != null) Trk.recordSnapshot(trackerLog, slug, day, used);
    const snapChanged = used != null && snapBefore !== used;
    const totalsChanged = !(prev.total === total && prev.used === used && prev.unused === unused);
    if (totalsChanged) trackerLog.totals[slug] = { total, used, unused, ts: now };
    if (totalsChanged || snapChanged || credit.kind === "dated" || credit.kind === "undated") saveLog();
  }

  // Called each main-loop tick: detect a fresh answer + keep totals current +
  // backfill correctness from any results table on screen.
  function trackerTick() {
    if (!logLoaded) return;
    const qid = findQid();
    if (qid) {
      if (SITE.isReviewing()) {
        if ((seenUnanswered.get(qid) || 0) >= ANSWER_MIN_TICKS) logAnswered(qid);
        seenUnanswered.delete(qid);
      } else {
        seenUnanswered.set(qid, (seenUnanswered.get(qid) || 0) + 1);
      }
    }
    scrapeDashboardTotals();
    // Correctness used to be recorded only if you happened to open a results
    // page, so "% correct, last 7 days" was blank for anyone who doesn't. Take
    // it from whatever the qbank is showing: the results table, or the
    // Question List already captured -- read from the cache off a results page,
    // which used to scan every element on every page once a second.
    if (SITE.isResultsPage()) {
      const outcomes = resultData();
      if (outcomes && outcomes.length) backfillCorrectness(outcomes);
      const meta = blockRows();
      if (meta.length) rememberQuestionMeta(meta);
    } else {
      const cached = qlistCached();
      if (cached && cached.length) backfillCorrectness(cached);
    }
  }

  // Auto-expand the results table to its largest page size (100) so the Anki
  // buttons + Weak-areas cover the whole block, not just the first 10 rows.
  let expandedResultsFor = null;
  function ensureResultsShowAll() {
    // Opt-in per site. This hunts for a page-size button reading 10/25/50/100 —
    // harmless next to Coursology's results table, but UWorld's nav grid and
    // MedPark's question rail are *also* buttons numbered 1..40, so on those
    // sites it would happily click "10" and jump the user to another question.
    if (!SITE.expandsResults) return;
    if (!SITE.isResultsPage()) return;
    if (expandedResultsFor === location.pathname) return;
    const btn = Array.from(document.querySelectorAll("button")).find(b => /^(10|25|50|100)$/.test((b.textContent || "").trim()));
    if (!btn) return;                                    // control not rendered yet — retry next tick
    expandedResultsFor = location.pathname;
    if ((btn.textContent || "").trim() === "100") return;
    try {
      btn.click();
      setTimeout(() => {
        const opt = Array.from(document.querySelectorAll("li,button,a,div,span")).find(el => el.children.length === 0 && (el.textContent || "").trim() === "100" && el !== btn);
        if (opt) opt.click(); else btn.click();          // close the menu if no "100"
      }, 250);
    } catch (e) {}
  }

  // ---------- main loop ----------
  // A results table that re-renders -- pagination, virtual scrolling, a framework
  // repaint -- can read as EMPTY for a tick. Removing the bar on that one tick
  // and building it again on the next gives a brand-new element with none of the
  // placement it had settled on, so it starts at the top and slides back down.
  // Once a second, that is a bar bouncing. Let it miss a few ticks first.
  const RESULTS_GRACE = 4;
  let emptyTicks = 0;

  setInterval(() => {
    // Result rows are read on a results page and nowhere else (see
    // genericResultRows): elsewhere the toolbar offered to send an
    // explanation's numbered bullets, or a list of test scores, to Anki.
    const onResults = SITE.isResultsPage();
    const hasResults = onResults && SITE.resultRows().length > 0;
    emptyTicks = hasResults ? 0 : emptyTicks + 1;
    let toolbar = onResults ? SITE.toolbar() : null;
    if (!toolbar && hasResults) toolbar = ensureFloatingToolbar();
    if (toolbar && !document.getElementById(BTN_HOST_ID)) addButtons(toolbar);
    if (emptyTicks > RESULTS_GRACE) {
      const fb = document.getElementById("mnx-float-toolbar"); if (fb) fb.remove();
    }
    const host = document.getElementById(BTN_HOST_ID);
    if (host) syncExpectedButton(host);

    trackerTick();
    ensureQidButton();
    captureQuestionList();
    ensureResultsShowAll();

    const answered = isAnswered();
    const qid = answered ? findQid() : null;
    if (qid && answered) {
      if (!Q || Q.qid !== qid) {
        rebuild(qid);                                    // a new question: a new session
      } else if (!document.getElementById(PANEL_ID) && !Q.building) {
        // The qbank can re-render the explanation under us (Coursology does when
        // its question rail is toggled), taking the panel with it while the id
        // stays the same -- so a missing panel is a reason to rebuild too.
        rebuild(qid, Q.broad);
      }
    } else {
      Q = null;                                          // anything still in flight is now stale
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove();
      hideOverlay();
    }
  }, 1000);

  // ============================================================
  // Expected Score (Beta)
  // ============================================================
  const ES_GUESS = 0.2;   // 5-option MCQ guess floor
  const YIELD_W = { HighYield: 2.0, RelativelyHighYield: 1.6, "HighYield-temporary": 1.4, LowerYield: 0.8, LowYield: 0.5 };
  // Question-id matching (safeQid, qidQuery, ...) lives in lib/match.js.
  // probability you know one card's fact right now (0..1)
  function cardMaturity(c) {
    if (c.type === 2) {                                // review card
      const eff = Math.max((c.ivl || 0) * Math.pow(0.7, c.lapses || 0), (c.ivl || 0) * 0.4);
      return 1 / (1 + Math.exp(-0.1 * (eff - 21)));    // sigmoid: 21d -> 0.5
    }
    if (c.type === 1 || c.type === 3) return 0.15;     // learning / relearning
    return 0;                                          // new
  }
  function yieldWeight(y) { return (y && YIELD_W[y]) || 1.0; }
  // yield-weighted preparedness for one question's cards -> {prep,n,review} or null
  function prepFor(cards) {
    const usable = (cards || []).filter(c => !c.suspended);
    if (!usable.length) return null;                   // uncovered
    let sw = 0, swm = 0, review = 0;
    for (const c of usable) {
      const w = yieldWeight(c.yield);
      sw += w; swm += w * cardMaturity(c);
      if (c.type === 2) review++;
    }
    return { prep: sw > 0 ? swm / sw : 0, n: usable.length, review };
  }
  // mixture w/ guess floor: either you know it (~prep) or you guess (~20%)
  function predFrom(prep) { return ES_GUESS + (1 - ES_GUESS) * prep; }
  // reliability of the estimate (geometric mean of four factors)
  function confidence(details, nTotal) {
    const cov = details.filter(Boolean);
    const nCov = cov.length;
    if (!nCov) return { score: 0, label: "Insufficient" };
    const coverage = Math.min(1, nCov / (0.5 * nTotal));
    const sumInv = cov.reduce((s, q) => s + (q.n > 0 ? 1 / q.n : 0), 0);
    const H = sumInv > 0 ? nCov / sumInv : 0;
    const density = Math.min(1, H / 4);
    const sample = Math.min(1, nCov / 10);
    const totalCards = cov.reduce((s, q) => s + q.n, 0);
    const reviewCards = cov.reduce((s, q) => s + q.review, 0);
    const quality = totalCards > 0 ? reviewCards / totalCards : 0;
    const score = Math.pow(coverage * density * sample * quality, 0.25);
    const label = score >= 0.7 ? "High" : score >= 0.4 ? "Medium" : score >= 0.15 ? "Low" : "Insufficient";
    return { score, label };
  }
  const ES_MSG = {
    mature_wrong: ["Oof \u2014 your cards say you knew this one.", "Mature in Anki but missed \u2014 sneaky one, or a slip.", "Your reviews had this down. Go revisit it.", "This was in your wheelhouse \u2014 worth a careful look.", "You'd matured this. Don't let it slide."],
    mature_right: ["Nailed it \u2014 and your cards backed you up.", "Solid. Your reps clearly paid off.", "Matured and correct. Textbook.", "Clean hit \u2014 well-drilled.", "Your Anki grind showed here. Nice."],
    mature_unknown: ["Your cards on this are mature.", "Well-drilled in Anki.", "This one's locked in your reviews."],
    mid_wrong: ["Still bedding this one in \u2014 fair enough.", "Young card, missed it. It'll stick soon.", "Not matured yet \u2014 keep the reps up.", "This one's still settling in Anki."],
    mid_right: ["Got it while it's still young \u2014 nice.", "Correct, and it's still settling. Bonus.", "Ahead of your reviews on this one.", "Young card, right answer \u2014 good sign."],
    mid_unknown: ["Still young in your reviews.", "This one's settling in Anki.", "Halfway home on this card."],
    low_wrong: ["Barely started this in Anki \u2014 no shame.", "Fresh card, fair miss. It's coming.", "Hardly reviewed yet \u2014 expected.", "Early days for this one."],
    low_right: ["Correct on a card you've barely touched \u2014 clutch.", "Reasoned that one out before Anki caught up.", "Got it ahead of your reviews. Slick.", "Nice \u2014 that wasn't from the deck yet."],
    low_unknown: ["Barely reviewed in Anki yet.", "Fresh in your deck.", "Early days for this card."],
    none_wrong: ["Not in your deck yet \u2014 totally fair miss.", "No card for this one. Can't fault you.", "Off-deck question \u2014 not on you.", "Your deck doesn't cover this yet."],
    none_right: ["Not in your deck \u2014 pure reasoning. Respect.", "No card for this, and you still got it. Nice.", "Off-deck and correct \u2014 real understanding.", "Deck doesn't cover this \u2014 you earned that one."],
    none_unknown: ["Not in your deck yet.", "No matching card for this one.", "Your deck doesn't cover this question."]
  };
  function esPick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function phraseFor(chance, correct) {
    const band = chance === null ? "none" : chance >= 0.8 ? "mature" : chance >= 0.45 ? "mid" : "low";
    const who = correct === true ? "right" : correct === false ? "wrong" : "unknown";
    return esPick(ES_MSG[band + "_" + who] || ES_MSG[band + "_unknown"]);
  }
  function expectedStatus(chance, correct) {
    if (chance !== null && chance >= 0.8 && correct === false) return "warn";
    if (correct === true) return "good";
    return "";
  }
  function answerResult() {
    const txt = (document.body.textContent || "");
    if (/answered\s+incorrectly/i.test(txt)) return false;
    if (/answered\s+correctly/i.test(txt)) return true;
    return null;                                        // couldn't tell
  }
  async function addExpectedLine(s) {
    let cards;
    try { const r = await bridge("cardStats", { queries: [s.query || qidQuery(s.qid, s.sv || 1)] }); cards = r && r[0]; }
    catch (e) { return; }
    if (!isLive(s)) return;                             // moved on while waiting
    const panel = document.getElementById(PANEL_ID);
    if (!panel || document.getElementById("mnx-expected")) return;
    const d = prepFor(cards);
    const chance = d ? d.prep : null;
    const correct = answerResult();
    const line = document.createElement("div");
    line.id = "mnx-expected";
    line.className = "mnx-expected " + expectedStatus(chance, correct);
    line.textContent = phraseFor(chance, correct);
    panel.insertBefore(line, panel.firstChild);
  }
  function syncExpectedButton(host) {
    const ID = "mnx-es-btn";
    const existing = document.getElementById(ID);
    if (esOn && !existing) {
      const b = document.createElement("button");
      b.id = ID; b.textContent = "Expected Score"; b.className = "review-button mnx-btn mnx-es";
      b.addEventListener("click", onUserClick(() => computeSummary()));
      host.appendChild(b);
    } else if (!esOn && existing) { existing.remove(); }
  }
  // A session (the question on screen: its exact matched search) or a bare
  // question id (a row of the expected-score list).
  function openInAnki(target) {
    const run = query => bridge("openBrowser", { query }).catch(e => toast(bridgeFailure(e)));
    if (target && typeof target === "object") { run(target.query || qidQuery(target.qid, target.sv || 1)); return; }
    getSv().then(sv => run(qidQuery(target, sv))).catch(() => {});
  }
  async function computeSummary() {
    const items = resultData().map(r => ({ qid: r.qid, correct: !isMissed(r) }));
    if (!items.length) { toast("No questions found on this page."); return; }
    let sv; try { sv = await getSv(); } catch (e) { sv = 1; }
    let byQ;
    try { byQ = await bridge("cardStats", { queries: items.map(it => qidQuery(it.qid, sv)) }); }
    catch (e) { toast(bridgeFailure(e)); return; }
    items.forEach((it, i) => {
      const d = prepFor(byQ[i]);
      it.detail = d;
      it.prep = d ? d.prep : null;
      it.pred = d ? predFrom(d.prep) : null;
    });
    renderSummary(items);
  }
  function metric(label, value) {
    const d = document.createElement("div"); d.className = "mnx-metric";
    const v = document.createElement("div"); v.className = "mnx-metric-v"; v.textContent = value;
    const l = document.createElement("div"); l.className = "mnx-metric-l"; l.textContent = label;
    d.appendChild(v); d.appendChild(l); return d;
  }
  function closeSummary() { const o = document.getElementById(SUMMARY_ID); if (o) { o.style.display = "none"; o.replaceChildren(); } }
  function renderSummary(items) {
    const total = items.length;
    const overallCorrect = items.filter(it => it.correct).length;
    const overallPct = total ? Math.round(100 * overallCorrect / total) : 0;
    const covered = items.filter(it => it.pred !== null);
    const nCov = covered.length;
    const correctCov = covered.filter(it => it.correct).length;
    const expectedPct = nCov ? Math.round(100 * covered.reduce((s, it) => s + it.pred, 0) / nCov) : null;
    const actualPct = nCov ? Math.round(100 * correctCov / nCov) : null;
    const conf = confidence(covered.map(it => it.detail), total);
    const covPct = total ? Math.round(100 * nCov / total) : 0;
    const missed = covered.filter(it => !it.correct).sort((a, b) => b.prep - a.prep);

    let o = document.getElementById(SUMMARY_ID);
    if (!o) {
      o = document.createElement("div"); o.id = SUMMARY_ID;
      o.addEventListener("click", e => { if (e.target === o) closeSummary(); });
      document.body.appendChild(o);
    }
    o.classList.toggle("mnx-dark", darkMode);
    o.style.display = "flex"; o.replaceChildren();

    const dlg = document.createElement("div"); dlg.className = "mnx-sum-dialog";
    const head = document.createElement("div"); head.className = "mnx-sum-head";
    const h = document.createElement("span"); h.textContent = "Expected score (beta)";
    const x = document.createElement("button"); x.className = "mnx-x"; x.textContent = "\u00d7"; x.title = "Close";
    x.addEventListener("click", closeSummary);
    head.appendChild(h); head.appendChild(x); dlg.appendChild(head);

    // A — the score you already know from the qbank
    const score = document.createElement("div"); score.className = "mnx-sum-score";
    const sval = document.createElement("span"); sval.className = "mnx-score-v"; sval.textContent = overallPct + "%";
    const slbl = document.createElement("span"); slbl.className = "mnx-score-l"; slbl.textContent = "your block score \u00b7 " + overallCorrect + " of " + total;
    score.appendChild(sval); score.appendChild(slbl); dlg.appendChild(score);

    // B — how much of the block AnKing can even evaluate
    const cov = document.createElement("div"); cov.className = "mnx-cov";
    const bar = document.createElement("div"); bar.className = "mnx-cov-bar";
    const fill = document.createElement("div"); fill.className = "mnx-cov-fill"; fill.style.width = covPct + "%";
    bar.appendChild(fill);
    const covLbl = document.createElement("div"); covLbl.className = "mnx-cov-lbl";
    covLbl.textContent = nCov + " of " + total + " questions matched to AnKing (" + covPct + "%)";
    cov.appendChild(bar); cov.appendChild(covLbl); dlg.appendChild(cov);

    if (!nCov) {
      const p = document.createElement("div"); p.className = "mnx-sum-note";
      p.textContent = "Not enough data \u2014 none of these questions matched a card in your deck yet.";
      dlg.appendChild(p); o.appendChild(dlg); return;
    }

    // C — preparedness analysis, scoped to the covered questions only
    const sub = document.createElement("div"); sub.className = "mnx-sum-lbl";
    sub.textContent = "On the " + nCov + " covered question" + (nCov === 1 ? "" : "s") + ":";
    dlg.appendChild(sub);

    const row = document.createElement("div"); row.className = "mnx-sum-row";
    const gap = actualPct - expectedPct;
    row.appendChild(metric("Expected", expectedPct + "%"));
    row.appendChild(metric("You got", actualPct + "%"));
    row.appendChild(metric("Gap", (gap >= 0 ? "+" : "") + gap + " pts"));
    dlg.appendChild(row);

    const badge = document.createElement("div");
    badge.className = "mnx-conf mnx-conf-" + conf.label.toLowerCase();
    badge.textContent = "Confidence: " + conf.label;
    dlg.appendChild(badge);

    const note = document.createElement("div"); note.className = "mnx-sum-note";
    const interp = gap > 4 ? "you beat what your reviews predicted \u2014 reasoning, outside knowledge, or luck filled the gap."
      : gap < -4 ? "you came in under \u2014 these may have tested angles your cards don't cover."
      : "right about where your Anki history predicted.";
    const trust = conf.label === "High" ? "This estimate is well-supported."
      : conf.label === "Medium" ? "Reasonable, but limited data \u2014 use with some caution."
      : conf.label === "Low" ? "Rough estimate \u2014 directionally informative only."
      : "Very thin data \u2014 treat as a loose approximation.";
    note.textContent = "Your Anki prep predicted ~" + expectedPct + "% on these; you got " + actualPct + "% \u2014 " + interp + " " + trust + " \u201cExpected\u201d weighs card maturity by yield and floors at ~20% for guessing \u2014 it's a guide, not a grade.";
    dlg.appendChild(note);

    const lbl = document.createElement("div"); lbl.className = "mnx-sum-lbl";
    lbl.textContent = missed.length ? "Missed \u2014 best-prepared first (worth a look):" : "No covered questions missed \u2014 nice.";
    dlg.appendChild(lbl);
    missed.forEach(it => {
      const r = document.createElement("div"); r.className = "mnx-sum-item";
      const left = document.createElement("span");
      left.textContent = "QID " + it.qid + "  \u00b7  " + Math.round(it.prep * 100) + "% prepared";
      const a = document.createElement("a"); a.href = "#"; a.textContent = "open in Anki";
      a.addEventListener("click", e => { e.preventDefault(); if (e.isTrusted) openInAnki(it.qid); });
      r.appendChild(left); r.appendChild(a);
      dlg.appendChild(r);
    });
    o.appendChild(dlg);
  }

  // ============================================================
  // Page check (diagnostics)
  // ------------------------------------------------------------
  // The popup's "Check this page" button asks the active tab what the adapter
  // can see. This reports STRUCTURE ONLY — tag names, ids and class names — and
  // never any question text, answer, or account detail, so a report is safe to
  // paste into a bug report.
  // ============================================================
  function nodePath(el) {
    if (!el) return null;
    const bits = [];
    for (let n = el; n && n.nodeType === 1 && bits.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += "#" + n.id;
      const cls = (typeof n.className === "string" ? n.className : "").trim().split(/\s+/).slice(0, 2).join(".");
      if (cls) s += "." + cls;
      bits.unshift(s);
      if (n.id) break;
    }
    return bits.join(" > ");
  }
  // Where does a "Question Id"-ish label actually live on this page? Report the
  // element's path only — not what it says beyond the digits we need.
  function qidCandidates() {
    const out = [];
    const res = [/Question\s*Id\s*[:#]?\s*(\d+)/i, /\bQ\s*Id\s*[:#]?\s*(\d+)/i, /\bItem\s*Id\s*[:#]?\s*(\d+)/i];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (el.children.length) continue;               // leaf nodes only
      if (el.closest("[id^='mnx-']")) continue;       // skip our own UI
      const t = (el.textContent || "").slice(0, 120);
      for (const re of res) {
        const m = t.match(re);
        if (m) { out.push({ path: nodePath(el), label: m[0].replace(/\d+/, "<id>") }); break; }
      }
      if (out.length >= 5) break;
    }
    return out;
  }
  function diagnose() {
    let anchor = null, expl = null, rows = 0, sample = [], err = null;
    try { anchor = SITE.panelAnchor(); } catch (e) { err = String(e); }
    try { expl = SITE.explanationRoot(); } catch (e) { err = err || String(e); }
    try {
      // Read the way the toolbar reads them: only on a results page.
      const r = SITE.isResultsPage() ? SITE.resultRows() : [];
      rows = r.length;
      sample = r.slice(0, 3).map(x => x.qid);   // ids only — no correctness
    } catch (e) { err = err || String(e); }
    return {
      version: chrome.runtime.getManifest().version,
      adapter: SITE.id,
      source: sourceOf(),
      host: location.hostname,
      path: location.pathname,
      qid: findQid(),
      qidSeenAt: qidCandidates(),
      reviewing: (() => { try { return !!SITE.isReviewing(); } catch (e) { return null; } })(),
      explanationAt: nodePath(expl),
      panelAnchorAt: nodePath(anchor),
      resultRows: rows,
      resultSample: sample,
      qidAnchorAt: nodePath(qidLabelEl()),
      features: {
        resultsButtons: rows > 0,
        questionImages: SITE.canAttachImages !== false,
        expandsResults: !!SITE.expandsResults
      },
      questionListRows: (() => { try { const r = parseQuestionList(); return r ? r.length : 0; } catch (e) { return -1; } })(),
      step: detectStepFromUrl(),
      hasMain: !!document.querySelector("main, [role='main']"),
      tables: document.querySelectorAll("table").length,
      error: err
    };
  }
  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (!msg || msg.type !== "mnx-diagnose") return;
    try { send(diagnose()); } catch (e) { send({ error: String(e) }); }
  });
})();
