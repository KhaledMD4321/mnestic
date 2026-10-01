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
    pulmonary: "respiratory", lung: "respiratory", lungs: "respiratory", pulm: "respiratory", pulmonology: "respiratory",
    urinary: "renal", kidney: "renal", nephrology: "renal",
    gi: "gastrointestinal", digestive: "gastrointestinal", nutrition: "gastrointestinal", gastroenterology: "gastrointestinal",
    heme: "hematology", oncology: "hematology", blood: "hematology", onc: "hematology", hemeonc: "hematology",
    nervous: "neurology", neuro: "neurology", neurologic: "neurology",
    heart: "cardiovascular", cardiology: "cardiovascular", cardiac: "cardiovascular", cardio: "cardiovascular", cards: "cardiovascular",
    endocrinology: "endocrine", diabetes: "endocrine", metabolism: "endocrine", endo: "endocrine",
    behavioral: "psychiatry", psychiatric: "psychiatry", psych: "psychiatry",
    dermatology: "skin", derm: "skin", rheumatology: "musculoskeletal", orthopedics: "musculoskeletal",
    rheum: "musculoskeletal", msk: "musculoskeletal", ortho: "musculoskeletal",
    obstetrics: "reproductive", gynecology: "reproductive", breast: "reproductive", repro: "reproductive",
    obgyn: "reproductive", pregnancy: "reproductive",
    infectious: "microbiology", micro: "microbiology", immuno: "immunology", biochem: "biochemistry",
    pharm: "pharmacology", pharmaco: "pharmacology"
  };
  // Organ systems and basic sciences: how a deck tree is organised when its
  // chapters are systems rather than rotations.
  const SYSTEM_WORDS = new Set(["respiratory", "renal", "gastrointestinal", "hematology", "neurology",
    "cardiovascular", "endocrine", "psychiatry", "skin", "musculoskeletal", "reproductive",
    "microbiology", "immunology", "biochemistry", "pharmacology", "genetics", "pathology"]);
  function isSystemName(name) {
    return systemTokens(name).some((w) => SYSTEM_WORDS.has(w));
  }
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

  // Do two chapter names mean the same chapter? Exactly, one being the start
  // of the other ("Cardio" / "Cardiovascular"), or the same organ system under
  // another name ("GI" / "Gastrointestinal", "Pulm" / "Respiratory"). Never a
  // word in the middle: "Pharm" is not "Psych Pharm".
  function sameChapter(a, b) {
    const x = normDeck(a), y = normDeck(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const ra = rotationKey(a);
    if (ra && ra === rotationKey(b)) return true;           // "Medicine" / "Internal Medicine" / "IM"
    const short = x.length < y.length ? x : y;
    if (short.length >= 4 && (x.indexOf(y) === 0 || y.indexOf(x) === 0)) return true;
    const tx = systemTokens(a).filter((w) => SYSTEM_WORDS.has(w));
    const ty = new Set(systemTokens(b).filter((w) => SYSTEM_WORDS.has(w)));
    return tx.length > 0 && tx.length === ty.size && tx.every((w) => ty.has(w));
  }
  // The clinical rotation a name means, if it is one (Step 2/3 subjects, the
  // #Resources_by_rotation and !Shelf chapters, Bootcamp's "Medicine").
  const ROTATION_KEYS = {
    "internal medicine": "im", medicine: "im", im: "im",
    pediatrics: "peds", peds: "peds",
    surgery: "surgery", "general surgery": "surgery",
    obgyn: "obgyn", "ob gyn": "obgyn", "obstetrics gynecology": "obgyn", "obstetrics and gynecology": "obgyn",
    "family medicine": "fm", fm: "fm", "ambulatory medicine": "fm",
    "emergency medicine": "em", em: "em"
  };
  function rotationKey(name) {
    const k = cleanSeg(name).toLowerCase().replace(/[^a-z]+/g, " ").trim();
    return ROTATION_KEYS[k] || null;
  }
  // What kind of chapter a name is: an organ system ("Respiratory"), a
  // discipline ("Pharmacology") or a rotation ("Internal Medicine"); null when
  // it is none of those ("Week 3", "Hard ones").
  const ORGAN_WORDS = new Set(["respiratory", "renal", "gastrointestinal", "hematology", "neurology",
    "cardiovascular", "endocrine", "psychiatry", "skin", "musculoskeletal", "reproductive"]);
  const DISCIPLINE_WORDS = new Set(["microbiology", "immunology", "biochemistry", "pharmacology", "genetics",
    "pathology", "physiology", "anatomy", "histology", "embryology", "biostatistics", "biostats",
    "epidemiology", "ethics"]);
  function chapterKind(name) {
    if (rotationKey(name)) return "rotation";
    const t = systemTokens(cleanSeg(name));
    if (t.some((w) => ORGAN_WORDS.has(w))) return "system";
    if (t.some((w) => DISCIPLINE_WORDS.has(w))) return "discipline";
    return null;
  }
  // Is `name` a sensible subdeck INSIDE the chapter deck `chapter`? A chapter
  // is already a chapter: another chapter of the same kind is a sibling, not a
  // subtopic ("Cardio" inside "Respiratory", "Surgery" inside "Internal
  // Medicine"). What fits is the other axis -- the question's subject:
  // Pharmacology inside Respiratory on Step 1, Medicine or Surgery inside
  // Endocrine on Step 2/3, Cardiovascular inside Internal Medicine.
  function fitsInside(chapter, name) {
    if (!name || sameChapter(chapter, name)) return false;
    const a = chapterKind(chapter), b = chapterKind(name);
    if (!a || !b) return true;               // your own kind of deck, or a name we can't place
    if (a === "rotation") return b !== "rotation";
    return b !== "system";
  }

  // Is this deck tree organised by organ system (Cardiovascular, GI, Repro…)
  // rather than by rotation (Internal Medicine, Pediatrics…)?
  function systemStyle(names) {
    const list = (names || []).filter(Boolean);
    if (list.length < 2) return false;
    return list.filter(isSystemName).length * 2 >= list.length;
  }

  // Ranked chapters this question's cards agree on: [{name, from, n, system, mine}].
  //   opts.system     the qbank's System for this question, when known
  //   opts.preferred  {chapterLower: timesChosen} -- what you picked before
  //   opts.existing   names of the subdecks you already have under the base deck
  // Order: a chapter matching the question's own system; then one matching a
  // subdeck you already have; then the best source -- rotations first on
  // Step 2, unless your subdecks are organ systems, in which case systems
  // first there too -- then how many of the cards carry it, then what you
  // chose before. Before, a tie fell to alphabetical order: a pulmonary
  // omalizumab question pre-selected Immunology.
  function chapterCandidates(notes, step, opts) {
    opts = opts || {};
    step = step || 1;
    const existing = (opts.existing || []).filter(Boolean);
    const rotationsFirst = step === 2 && !systemStyle(existing);
    const roots = CHAPTER_ROOTS.slice().sort((a, b) => {
      const w = (r) => (rotationsFirst ? (r.rotation ? 0 : 1) : (r.rotation ? 1 : 0));
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
      c.mine = existing.some((e) => sameChapter(c.name, e));
      c.pref = +pref[c.name.toLowerCase()] || 0;
    });
    out.sort((a, b) => (b.system - a.system) || (b.mine - a.mine) || (a.rank - b.rank) || (b.n - a.n) ||
      (b.pref - a.pref) || a.name.localeCompare(b.name));
    // One chip per chapter: "Respiratory" (First Aid), "Pulm" (B&B) and
    // "Pulmonology" (Bootcamp) are the same chapter, and all would land in the
    // same subdeck. The best-ranked name stands for it.
    const kept = [];
    out.forEach((c) => { if (!kept.some((k) => sameChapter(k.name, c.name))) kept.push(c); });
    return kept.slice(0, opts.limit || 4);
  }

  function deckLeaf(name) { const p = String(name || "").split("::"); return p[p.length - 1]; }
  function normDeck(s) { return String(s || "").toLowerCase().replace(/^\d+[_\-.\s]*/, "").replace(/[^a-z0-9]+/g, ""); }
  // The direct subdecks of `base`.
  function childDecks(decks, base) {
    if (!base || !decks) return [];
    const prefix = base + "::";
    return decks.filter((d) => d.indexOf(prefix) === 0 && d.slice(prefix.length).indexOf("::") < 0);
  }
  // A subdeck of `base` you already have for this chapter, so "Missed Qs::03_Respiratory"
  // is reused rather than a parallel "Missed Qs::Respiratory" created beside it,
  // and "Missed Qs::GI" rather than a new "Missed Qs::Gastrointestinal".
  // Exact name first, then the start of one another, then the same organ system.
  // Never a word in the middle: "Pharm" must not land in "Psych Pharm".
  function existingChapterDeck(decks, base, chap) {
    if (!base || !chap || !decks) return null;
    const want = normDeck(chap);
    if (want.length < 2) return null;
    const kids = childDecks(decks, base);
    const exact = kids.find((d) => normDeck(deckLeaf(d)) === want);
    if (exact) return exact;
    if (want.length < 3) return null;
    const prefix = kids.find((d) => {
      const leaf = normDeck(deckLeaf(d));
      const short = leaf.length < want.length ? leaf : want;
      return short.length >= 4 && (leaf.indexOf(want) === 0 || want.indexOf(leaf) === 0);
    });
    if (prefix) return prefix;
    return kids.find((d) => sameChapter(deckLeaf(d), chap)) || null;
  }

  // Which deck in a Missed Qs tree is the ROOT, and is `deck` a chapter below it?
  // "Missed Qs::GI" is already a chapter: saving there must not get another
  // chapter appended ("Missed Qs::GI::Gastrointestinal"). `knownBase` is the
  // base deck you saved under before, when there is one.
  function missedRoot(deck, knownBase) {
    const d = String(deck || "");
    if (knownBase && d.indexOf(knownBase + "::") === 0) return knownBase;
    const seg = d.split("::");
    for (let i = seg.length - 2; i >= 0; i--) {
      if (/missed/i.test(seg[i])) return seg.slice(0, i + 1).join("::");
    }
    return null;
  }
  function isChapterDeck(deck, knownBase) { return !!missedRoot(deck, knownBase); }

  const api = { cleanSeg, isEditionSeg, tagPaths, chapterCandidates, matchesSystem,
                sameChapter, systemStyle, chapterKind, fitsInside, deckLeaf, normDeck, childDecks,
                existingChapterDeck, missedRoot, isChapterDeck };
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Mnx = root.Mnx || {}).tags = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
