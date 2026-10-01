// Mnestic — reading AnKing tags: resource chapters, and which chapter a saved
// question belongs in.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE.
(function (root) {
  "use strict";

  function cleanSeg(s) {
    return String(s || "")
      .replace(/^[!*\s]+/, "")        // leading ! or * markers
      .replace(/^\d+[_\-.]\s*/, "")   // leading number prefix: 03_  06-  1.
      .replace(/_/g, " ")
      .trim();
  }
  function isNoiseSeg(s) {
    return /^\^/.test(s)                  // tracking tags: ^physeo_image_update, ^Missing_image
        || /retired/i.test(s)             // ##_Retired_Lessons
        || /old[\s_]*version/i.test(s)    // [OLD VERSION]
        || /\[old/i.test(s)
        || /alt[_\s]*tagging/i.test(s)    // 03_Neoplasia_Alt_Tagging
        || /^pathoma\s*20\d{2}/i.test(s)  // Pathoma2018 (old edition)
        || /^20\d{2}$/.test(s);           // a bare old-edition year
  }
  // Some decks slot an edition between the resource and the chapter
  // (#FirstAid::FA2024::07_Cardiovascular), others don't. A segment with a
  // year in it and few letters is an edition, never a chapter.
  function isEditionSeg(seg) {
    const t = String(seg || "");
    let digits = 0, letters = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c >= 48 && c <= 57) digits++;
      else if ((c | 32) >= 97 && (c | 32) <= 122) letters++;
    }
    if (digits < 4 || letters > 4) return false;
    return /(19|20)\d\d/.test(t);
  }
  // Chapter paths under a resource: "#AK_Step1_v12::#FirstAid::03_Respiratory::Asthma"
  // -> ["Respiratory", "Asthma"] (last 3 segments kept). A tree with a noise
  // segment anywhere -- retired lessons, a bare old-edition year -- is skipped.
  function tagPaths(tags, needles) {
    const arr = (Array.isArray(needles) ? needles : [needles]).map((s) => s.toLowerCase());
    const out = [];
    for (const t of (tags || [])) {
      const tl = String(t).toLowerCase();
      if (!arr.some((nd) => tl.includes(nd))) continue;
      const seg = String(t).split("::");
      const rest = seg.slice(2);
      if (!rest.length || rest.some(isNoiseSeg)) continue;
      const cleaned = rest.map(cleanSeg).filter(Boolean);
      if (cleaned.length > 1 && /^extra$/i.test(cleaned[cleaned.length - 1])) cleaned.pop();
      if (!cleaned.length) continue;
      out.push(cleaned.slice(-3));
    }
    return out;
  }

  // ---- where a saved question belongs ----------------------------------
  // Step 1 organises by organ system (#FirstAid::07_Cardiovascular), Step 2 by
  // rotation (#Resources_by_rotation::IM). Read the roots that carry chapters,
  // best source first.
  const ROTATION_NAMES = {
    im: "Internal Medicine", fm: "Family Medicine", peds: "Pediatrics",
    obgyn: "ObGyn", psych: "Psychiatry", neuro: "Neurology",
    surgery: "Surgery", em: "Emergency Medicine"
  };
  const CHAPTER_ROOTS = [
    { root: "#Resources_by_rotation", from: "rotation", rotation: true },
    { root: "!Shelf",                 from: "shelf",    rotation: true },
    { root: "#FirstAid",              from: "First Aid" },
    { root: "#B&B",                   from: "B&B" },
    { root: "#Bootcamp",              from: "Bootcamp" },
    { root: "#Physeo",                from: "Physeo" },
    { root: "#SketchyIM",             from: "Sketchy" }
  ];
  function chapterNoise(seg) {
    if (!seg) return true;
    if (seg.charAt(0) === "#") return true;
    const l = seg.toLowerCase();
    if (l.indexOf("highyield") >= 0 || l.indexOf("loweryield") >= 0) return true;
    if (l.indexOf("lowyield") >= 0 || l.indexOf("retired") >= 0) return true;
    if (l === "other" || l === "extra" || l === "misc" || l.indexOf("test") === 0) return true;
    return isNoiseSeg(seg);
  }

  // The qbank names a question's System ("Pulmonary & Critical Care",
  // "Renal/Urinary"); AnKing names chapters ("Respiratory", "Renal"). A few
  // words mean the same organ system under different names.
  const SYNONYMS = {
    pulmonary: "respiratory", lung: "respiratory", lungs: "respiratory",
    urinary: "renal", kidney: "renal", nephrology: "renal",
    gi: "gastrointestinal", digestive: "gastrointestinal", nutrition: "gastrointestinal",
    heme: "hematology", oncology: "hematology", blood: "hematology",
    nervous: "neurology", neuro: "neurology", neurologic: "neurology",
    heart: "cardiovascular", cardiology: "cardiovascular", cardiac: "cardiovascular",
    endocrinology: "endocrine", diabetes: "endocrine", metabolism: "endocrine",
    behavioral: "psychiatry", psychiatric: "psychiatry",
    dermatology: "skin", rheumatology: "musculoskeletal", orthopedics: "musculoskeletal",
    obstetrics: "reproductive", gynecology: "reproductive", breast: "reproductive",
    infectious: "microbiology"
  };
  const STOP = new Set(["and", "the", "system", "systems", "general", "principles", "care", "critical", "special", "senses", "disorders", "connective", "tissue"]);
  function systemTokens(s) {
    return String(s || "").toLowerCase().split(/[^a-z]+/)
      .filter((w) => w.length >= 2 && !STOP.has(w))
      .map((w) => SYNONYMS[w] || w);
  }
  function matchesSystem(chapter, system) {
    if (!system) return false;
    const want = new Set(systemTokens(system));
    return systemTokens(chapter).some((w) => w.length >= 4 && want.has(w));
  }

  // Ranked chapters this question's cards agree on: [{name, from, n, system}].
  //   opts.system     the qbank's System for this question, when known
  //   opts.preferred  {chapterLower: timesChosen} -- what you picked before
  // Order: a chapter matching the question's own system first, then the best
  // source, then how many of the cards carry it, then what you chose before.
  // Before, a tie fell to alphabetical order: a pulmonary omalizumab question
  // pre-selected Immunology.
  function chapterCandidates(notes, step, opts) {
    opts = opts || {};
    step = step || 1;
    const roots = CHAPTER_ROOTS.slice().sort((a, b) => {
      const w = (r) => (step === 2 ? (r.rotation ? 0 : 1) : (r.rotation ? 1 : 0));
      return w(a) - w(b);
    });
    const prefix = "#AK_Step" + step + "_";
    const found = new Map();
    (notes || []).forEach((note) => {
      const all = note.tags || [];
      const mine = all.filter((t) => String(t).indexOf(prefix) === 0);
      const tags = mine.length >= 3 ? mine : all;
      const here = new Set();
      tags.forEach((tag) => {
        const parts = String(tag).split("::");
        roots.forEach((src, rank) => {
          const i = parts.indexOf(src.root);
          if (i < 0) return;
          let at = i + 1;
          if (isEditionSeg(parts[at])) at++;
          if (!parts[at]) return;
          const raw = parts[at];
          if (chapterNoise(raw)) return;
          let name = cleanSeg(raw);
          if (src.rotation) name = ROTATION_NAMES[name.toLowerCase()] || name;
          if (!name || name.length < 2) return;
          const key = rank + "|" + name.toLowerCase();
          if (here.has(key)) return;
          here.add(key);
          const e = found.get(key);
          if (e) e.n++; else found.set(key, { name, from: src.from, n: 1, rank });
        });
      });
    });
    const pref = opts.preferred || {};
    const out = Array.from(found.values());
    out.forEach((c) => {
      c.system = matchesSystem(c.name, opts.system);
      c.pref = +pref[c.name.toLowerCase()] || 0;
    });
    out.sort((a, b) => (b.system - a.system) || (a.rank - b.rank) || (b.n - a.n) ||
      (b.pref - a.pref) || a.name.localeCompare(b.name));
    const seen = new Set();
    return out.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, 4);
  }

  function deckLeaf(name) { const p = String(name || "").split("::"); return p[p.length - 1]; }
  function normDeck(s) { return String(s || "").toLowerCase().replace(/^\d+[_\-.\s]*/, "").replace(/[^a-z0-9]+/g, ""); }
  // A subdeck of `base` you already have for this chapter, so "Missed Qs::03_Respiratory"
  // is reused rather than a parallel "Missed Qs::Respiratory" created beside it.
  // Exact name first, then one name being the start of the other ("Cardio" /
  // "Cardiovascular"). Never a match in the middle: "Pharm" must not land in
  // "Psych Pharm".
  function existingChapterDeck(decks, base, chap) {
    if (!base || !chap || !decks) return null;
    const want = normDeck(chap);
    if (want.length < 3) return null;
    const prefix = base + "::";
    const kids = decks.filter((d) => d.indexOf(prefix) === 0 && d.slice(prefix.length).indexOf("::") < 0);
    const exact = kids.find((d) => normDeck(deckLeaf(d)) === want);
    if (exact) return exact;
    return kids.find((d) => {
      const leaf = normDeck(deckLeaf(d));
      const short = leaf.length < want.length ? leaf : want;
      return short.length >= 4 && (leaf.indexOf(want) === 0 || want.indexOf(leaf) === 0);
    }) || null;
  }

  const api = { cleanSeg, isNoiseSeg, isEditionSeg, tagPaths, chapterNoise, chapterCandidates, matchesSystem,
                deckLeaf, normDeck, existingChapterDeck, ROTATION_NAMES, CHAPTER_ROOTS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).tags = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
