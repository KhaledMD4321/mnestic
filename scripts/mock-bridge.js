// A stand-in for the Mnestic Bridge add-on, for end-to-end tests without Anki.
//
// Speaks the same wire protocol as anki-addon/mnestic_bridge (POST / with
// {op, args} and the code in X-Mnestic-Token -> {ok, data}) and keeps a tiny
// in-memory collection -- notes with tags, decks and suspended cards -- so the
// extension's whole chain can be driven, including saves that tag and move a
// note and undos that have to find exactly what a save did.
//
// It is a TEST DOUBLE — it never touches a collection. Started by
// scripts/e2e-test.js; run it directly to poke at the UI by hand:
//     node scripts/mock-bridge.js
const http = require("http");

const PORT = Number(process.env.MNX_MOCK_PORT || 8790);

// A 2x2 red PNG — stands in for an AnKing resource image.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P8z8Dwn4EI" +
  "wDiqkL4KAV/hA/2kFkSzAAAAAElFTkSuQmCC";

// Every fixture question id (one per site) is tagged on both notes.
const UW = (id) => "#AK_Step1_v12::#UWorld::Step::" + id;
const QIDS = ["1633", "12345", "4211"];

const NOTE = {
  noteId: 1111111111111,
  modelName: "Cloze-AnKingMaster",
  mod: 1700000000,
  tags: QIDS.map(UW).concat([
    "#AK_Step1_v12::#FirstAid::FA2024::03_Respiratory::Obstructive_Lung_Disease",
    // a hostile-looking chapter: cleanSeg turns _ into spaces, and Anki
    // splits tags on whitespace — this must still produce ONE tag
    "#AK_Step1_v12::#Bootcamp::04_Cardio_marked_leech::01_Intro",
    "#AK_Step1_v12::#Sketchy::Pharm::Beta_Blockers",
    "#AK_Step1_v12::#Physeo::Cardio::Heart_Failure",
    "#AK_Step1_v12::#OME::Step1::Cardiology",
    "#AK_Step1_v12::#B&B::Cardio::Murmurs"
  ]),
  fields: {
    Text: { value: "The {{c1::cochlea}} transduces sound.", order: 0 },
    // a remote image: the preview must not load it
    Extra: { value: 'Extra note text.<img src="https://tracker.invalid/pixel.png">', order: 1 },
    // several pages, so the overlay pager is covered by the e2e run
    "First Aid": { value: '<img src="fa-1.png"><img src="fa-2.png"><img src="fa-3.png">', order: 2 },
    Sketchy: { value: '<img src="sketchy-1.png">', order: 3 },
    Physeo: { value: '<img src="physeo-1.png">', order: 4 },
    OME: { value: '<a href="https://example.org/ome-lesson">OME lesson</a>', order: 5 },
    // one hostile + one legitimate link: the row must render, minus the bad one
    "Additional Resources": {
      value: '<a href="javascript:alert(1)">bad</a>' +
             '<a href="https://example.org/extra-reading">Extra reading</a>',
      order: 6
    },
    "Missed Questions": { value: "", order: 7 },
    // looks filled, shows nothing: must count as empty everywhere
    Lecture_Notes: { value: "&nbsp;<br><div> </div><img>​<style>p{}</style>", order: 8 },
    ankihub_id: { value: "ah-note-1", order: 9 }
  }
};

// A second card for the same question, sharing ONE Sketchy chapter with the
// first and adding another. The shared chapter must outrank the unshared ones.
const NOTE2 = {
  noteId: 1111111111112,
  modelName: "Cloze-AnKingMaster",
  mod: 1700000001,
  tags: QIDS.map(UW).concat([
    "#AK_Step1_v12::#Sketchy::Pharm::Beta_Blockers",
    "#AK_Step1_v12::#Sketchy::Micro::Gram_Positives"
  ]),
  fields: {
    Text: { value: "A second card on the same question.", order: 0 },
    Sketchy: { value: "", order: 1 },
    ankihub_id: { value: "ah-note-2", order: 2 }
  }
};

// A question whose only card carries no resource tag or field at all.
const NOTE3 = {
  noteId: 1111111111113,
  modelName: "Cloze-AnKingMaster",
  mod: 1700000002,
  tags: [UW("7777")],
  fields: { Text: { value: "A bare card with no resources.", order: 0 }, ankihub_id: { value: "ah-note-3", order: 1 } }
};

const seen = [];   // every {op,args} the extension sent — asserted on by the test

// Test knobs, so a run can simulate a real collection's state:
//   onlyStep     - the deck only has tags for this step (exercises step fallback)
//   oldAddon     - the add-on predates the newer ops
//   slowDecks / slowNoteInfo - answer those ops late (races)
//   cardElsewhere - "is the card still in deck X?" says no (it was refiled)
//   refuseDelete  - deleteNotes refuses everything
//   rejectToken   - every authenticated op answers 403, like a wrong pairing code
const state = { onlyStep: null, oldAddon: false, slowDecks: 0, slowNoteInfo: 0, emptyFiltered: false,
                cardElsewhere: false, refuseDelete: false, rejectToken: false };

// ---- the in-memory collection -------------------------------------------------
let notes, nextId;
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function reset() {
  notes = new Map();
  nextId = 2222222222222;
  [NOTE, NOTE2, NOTE3].forEach((n, i) => {
    const c = clone(n);
    c.deck = "AnKing Step 1";
    c.cards = [0, 1].map((k) => ({ cid: n.noteId * 10 + k, suspended: true }));
    notes.set(c.noteId, c);
  });
}
reset();

function addNote(src, extra) {
  const n = Object.assign(clone(src), extra || {});
  n.noteId = nextId++;
  n.cards = (n.cards || [{}]).map((_, k) => ({ cid: n.noteId * 10 + k, suspended: false }));
  notes.set(n.noteId, n);
  return n;
}

// -- test helpers: put the collection in a known state --
function markMissed(noteId, qid, extraTags) {
  const n = notes.get(noteId);
  ["Mnestic::Missed", "Mnestic::Missed::Respiratory"].concat(qid ? ["Mnestic::QID::" + qid] : [], extraTags || [])
    .forEach((t) => { if (n.tags.indexOf(t) < 0) n.tags.push(t); });
}
function addCopy(ofNoteId, qid) {
  const src = notes.get(ofNoteId);
  const tags = src.tags.concat(["Mnestic::Copy", "Mnestic::Missed", "Mnestic::Missed::Respiratory"])
    .concat(qid ? ["Mnestic::QID::" + qid] : []);
  const c = addNote(src, { tags, deck: "Missed Questions::03_Respiratory" });
  c.fields.ankihub_id = { value: "", order: 9 };
  return c.noteId;
}

// ---- a small Anki search evaluator ----------------------------------------
// Enough of the grammar for what the extension sends: parentheses, OR, implicit
// AND, a leading "-", and tag:/nid:/cid:/deck:/is:suspended terms.
function tokenize(q) {
  const out = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (c === " ") { i++; continue; }
    if (c === "(" || c === ")") { out.push(c); i++; continue; }
    if (c === '"' || (c === "-" && q[i + 1] === '"')) {
      const neg = c === "-"; if (neg) i++;
      let j = i + 1, s = "";
      while (j < q.length && q[j] !== '"') { if (q[j] === "\\") j++; s += q[j]; j++; }
      out.push((neg ? "-" : "") + s); i = j + 1; continue;
    }
    let j = i, s = "";
    while (j < q.length && q[j] !== " " && q[j] !== "(" && q[j] !== ")") s += q[j++];
    out.push(s); i = j;
  }
  return out;
}
function globRe(p) {
  return new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
}
function termMatches(note, term) {
  const neg = term[0] === "-";
  const t = neg ? term.slice(1) : term;
  const low = t.toLowerCase();
  let hit = false;
  if (low.startsWith("tag:")) {
    // The step in "#AK_Step2_v*" is honoured by onlyStep instead (see searchNotes).
    const pat = t.slice(4).replace(/^#AK_Step\d_/i, "#AK_Step*_");
    const re = globRe(pat), child = globRe(pat + "::*");
    hit = note.tags.some((x) => re.test(x) || child.test(x));
  } else if (low.startsWith("nid:")) {
    hit = low.slice(4).split(",").indexOf(String(note.noteId)) >= 0;
  } else if (low.startsWith("cid:")) {
    const ids = low.slice(4).split(",");
    hit = note.cards.some((c) => ids.indexOf(String(c.cid)) >= 0);
  } else if (low.startsWith("deck:")) {
    const d = t.slice(5);
    hit = !state.cardElsewhere && (note.deck === d || note.deck.indexOf(d + "::") === 0);
  } else if (low === "is:suspended") {
    hit = note.cards.some((c) => c.suspended);
  }
  return neg ? !hit : hit;
}
function evaluate(tokens, note) {
  let pos = 0;
  function orExpr() {
    let v = andExpr();
    while (tokens[pos] === "OR") { pos++; const r = andExpr(); v = v || r; }
    return v;
  }
  function andExpr() {
    let v = true, any = false;
    while (pos < tokens.length && tokens[pos] !== ")" && tokens[pos] !== "OR") {
      let r;
      if (tokens[pos] === "(") { pos++; r = orExpr(); pos++; }
      else r = termMatches(note, tokens[pos++]);
      v = v && r; any = true;
    }
    return any && v;
  }
  return orExpr();
}
function search(q) {
  if (state.onlyStep && /#AK_Step(\d)_/.test(q) && q.indexOf("#AK_Step" + state.onlyStep + "_") < 0) return [];
  // Refuse the old wildcard form so a regression back to it fails loudly.
  if (q.indexOf("::#UWorld::*::") >= 0) return [];
  const toks = tokenize(q);
  return Array.from(notes.values()).filter((n) => evaluate(toks, n)).map((n) => n.noteId);
}
function wire(n) { return { noteId: n.noteId, modelName: n.modelName, mod: n.mod, tags: n.tags.slice(), fields: n.fields }; }

const OPS = {
  ping: () => ({ name: "Mnestic Bridge (mock)" }),
  auth: () => ({ paired: true, version: "1.4.0-mock" }),
  searchNotes: (a) => search(a.query || ""),
  noteInfo: (a) => (a.notes || []).map((id) => notes.get(+id)).filter(Boolean).map(wire),
  readMedia: () => PNG_B64,
  writeMedia: (a) => a.filename,
  openBrowser: () => true,
  // a numbered chapter subdeck, like a real user's
  listDecks: () => ["Default", "AnKing Step 1", "Missed Questions", "Missed Questions::03_Respiratory"],
  // Per query, one row per card of the matching notes, with its real suspension.
  cardStats: (a) => (a.queries || []).map((q) => {
    const rows = [];
    search(q).forEach((id) => notes.get(id).cards.forEach((c, k) =>
      rows.push(Object.assign({ cid: c.cid, type: 2, ivl: 30, lapses: 0, suspended: c.suspended, yield: "HighYield" },
                              state.oldAddon ? {} : { nid: id, ord: k }))));
    return rows;
  }),
  cardMaturity: (a) => (a.queries || []).map(() =>
    ({ new: 1, learning: 1, young: 2, mature: 3, suspended: 2, total: 9 })),
  unsuspend: (a) => (a.queries || []).map((q) => {
    const one = /^\s*cid:(\d+)\s*$/i.exec(q);              // one card, like the real add-on
    if (one) {
      for (const n of notes.values()) {
        const c = n.cards.find((x) => String(x.cid) === one[1]);
        if (c) { const was = c.suspended; c.suspended = false; return { matched: 1, unlocked: was ? 1 : 0, cids: was ? [c.cid] : [] }; }
      }
      return { matched: 0, unlocked: 0, cids: [] };
    }
    const ids = search(q);
    const cids = [];
    let matched = 0;
    ids.forEach((id) => notes.get(id).cards.forEach((c) => { matched++; if (c.suspended) { c.suspended = false; cids.push(c.cid); } }));
    return state.oldAddon ? { matched, unlocked: cids.length } : { matched, unlocked: cids.length, cids };
  }),
  suspend: (a) => {
    let n = 0; const refused = [];
    (a.cards || []).forEach((cid) => {
      for (const note of notes.values()) {
        const c = note.cards.find((x) => x.cid === cid);
        if (!c) continue;
        // the add-on's rule: a saved note, or one linked to a question (1.5);
        // an add-on before 1.5 only took saved notes
        const ok = note.tags.some((t) => /^mnestic::missed(::|$)/i.test(t)) ||
          (!state.oldAddon && note.tags.some((t) => /^#AK_Step[1-3]_v[^:\s]*::#UWorld::(Step::)?\d+$/i.test(t) || /^Mnestic::QID::\d+$/i.test(t)));
        if (!ok) { refused.push(cid); return; }
        if (!c.suspended) { c.suspended = true; n++; }
      }
    });
    return { suspended: n, refused };
  },
  countNotes: (a) => (a.queries || []).map(() => 4242),
  status: () => ({ name: "Mnestic Bridge (mock)", version: "1.4.0-mock", taggedByStep: { "1": 4242, "2": 0, "3": 0 } }),
  setDeck: (a) => {
    const ids = a.notes || [];
    const first = notes.get(+ids[0]);
    const from = first ? first.deck : "";
    let moved = 0;
    ids.forEach((id) => { const n = notes.get(+id); if (n) { n.deck = a.deck; moved += n.cards.length; } });
    return { moved, deck: a.deck, created: false, from };
  },
  createDeck: (a) => ({ deck: a.deck, created: true }),
  filteredDeck: (a) => ({ deck: a.name, cards: state.emptyFiltered ? 0 : 37, empty: state.emptyFiltered, search: a.search }),
  missedIds: () => ([
    { qid: "1633", chapter: "Respiratory", mod: 3, exact: true },
    { qid: "1634", chapter: "Respiratory", mod: 2, exact: true },
    { qid: "2101", chapter: "Cardiovascular", mod: 1, exact: true }
  ]),
  copyNote: (a) => {
    const src = notes.get(+a.noteId);
    const tags = src.tags.concat(["Mnestic::Copy"]).concat((a.addTags || []).filter((t) => src.tags.indexOf(t) < 0));
    const c = addNote(src, { tags, deck: a.deck });
    c.fields.ankihub_id = { value: "", order: 9 };
    return { noteId: c.noteId, cards: c.cards.map((x) => x.cid), deck: a.deck };
  },
  updateNote: (a) => {
    const n = notes.get(+a.noteId);
    if (!n) throw new Error("no such note");
    (a.addTags || []).forEach((t) => { if (n.tags.indexOf(t) < 0) n.tags.push(t); });
    for (const f in (a.fieldAppends || {})) {
      const key = Object.keys(n.fields).find((k) => k.toLowerCase() === f.toLowerCase());
      if (key) n.fields[key].value += (n.fields[key].value ? "<br><br>" : "") + a.fieldAppends[f];
    }
    return { noteId: n.noteId };
  },
  newNote: (a) => {
    const text = a.kind === "cloze" ? a.text : a.front;
    const dup = Array.from(notes.values()).some((n) => n.fields.Text && n.fields.Text.value === text);
    if (a.checkDuplicate && dup && !a.allowDuplicate) return { duplicate: true, model: "Cloze", deck: a.deck };
    const n = addNote({ modelName: a.kind === "cloze" ? "Cloze" : "Basic", mod: 1, tags: a.addTags || [],
      fields: { Text: { value: text || "", order: 0 } }, cards: [{}] }, { deck: a.deck });
    return { noteId: n.noteId, cards: n.cards.map((c) => c.cid), model: n.modelName, deck: a.deck };
  },
  removeTags: (a) => {
    const wanted = (a.tags || []).map((t) => t.toLowerCase());
    let updated = 0; const removed = [];
    (a.notes || []).forEach((id) => {
      const n = notes.get(+id); if (!n) return;
      const keep = n.tags.filter((t) => !wanted.some((w) => t.toLowerCase() === w || t.toLowerCase().indexOf(w + "::") === 0));
      if (keep.length !== n.tags.length) { removed.push(...n.tags.filter((t) => keep.indexOf(t) < 0)); n.tags = keep; updated++; }
    });
    return { updated, removed };
  },
  deleteNotes: (a) => {
    if (state.refuseDelete) return { deleted: 0, refused: (a.notes || []).slice() };
    let deleted = 0; const refused = [];
    (a.notes || []).forEach((id) => {
      const n = notes.get(+id); if (!n) return;
      const ok = n.tags.indexOf("Mnestic::Copy") >= 0 && !(n.fields.ankihub_id && n.fields.ankihub_id.value);
      if (ok) { notes.delete(+id); deleted++; } else refused.push(+id);
    });
    return { deleted, refused };
  }
};
const NEWER_OPS = ["setDeck", "createDeck", "filteredDeck", "missedIds", "countNotes", "removeTags", "deleteNotes", "suspend"];

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || "";
  const cors = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Mnestic-Token",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg = {};
    try { msg = JSON.parse(body || "{}"); } catch (e) {}
    let fn = OPS[msg.op];
    // simulate an out-of-date add-on that predates the newer ops
    if (state.oldAddon && NEWER_OPS.indexOf(msg.op) >= 0) fn = null;
    seen.push({ op: msg.op, args: msg.args || {} });
    if (state.rejectToken && msg.op !== "ping") {
      res.writeHead(403, Object.assign({ "Content-Type": "application/json" }, cors));
      return res.end(JSON.stringify({ ok: false, error: "invalid or missing pairing code" }));
    }
    res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, cors));
    if (!fn) return res.end(JSON.stringify({ ok: false, error: "unknown op " + msg.op }));
    try {
      const payload = JSON.stringify({ ok: true, data: fn(msg.args || {}) });
      // let a test reproduce "user saved before the deck list arrived"
      if (msg.op === "listDecks" && state.slowDecks) setTimeout(() => res.end(payload), state.slowDecks);
      // ...and "a panel build still in flight when the next tick looks"
      else if (msg.op === "noteInfo" && state.slowNoteInfo) setTimeout(() => res.end(payload), state.slowNoteInfo);
      else res.end(payload);
    }
    catch (e) { res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
  });
});

function calls() { return seen; }
function note(id) { return notes.get(id); }

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => console.log("mock bridge on 127.0.0.1:" + PORT));
}
module.exports = { server, calls, PORT, NOTE, NOTE2, NOTE3, state, reset, note, markMissed, addCopy, search };
