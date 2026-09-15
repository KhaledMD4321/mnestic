// A stand-in for the Mnestic Bridge add-on, for end-to-end tests without Anki.
//
// Speaks the same wire protocol as anki-addon/mnestic_bridge (POST / with
// {op, token, args} -> {ok, data}) and returns one fabricated AnKing note, so
// the extension's whole UI chain can be driven: resource panel, image overlays,
// card composer, unsuspend, card stats.
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

const NOTE = {
  noteId: 1111111111111,
  modelName: "Cloze-AnKingMaster",
  mod: 1700000000,
  tags: [
    "#AK_Step1_v12::#UWorld::Respiratory::1633",
    "#AK_Step1_v12::#FirstAid::FA2024::03_Respiratory::Obstructive_Lung_Disease",
    // a hostile-looking chapter: cleanSeg turns _ into spaces, and Anki
    // splits tags on whitespace — this must still produce ONE tag
    "#AK_Step1_v12::#Bootcamp::04_Cardio_marked_leech::01_Intro",
    "#AK_Step1_v12::#Sketchy::Pharm::Beta_Blockers",
    "#AK_Step1_v12::#Physeo::Cardio::Heart_Failure",
    "#AK_Step1_v12::#OME::Step1::Cardiology",
    "#AK_Step1_v12::#B&B::Cardio::Murmurs"
  ],
  fields: {
    Text: { value: "The {{c1::cochlea}} transduces sound.", order: 0 },
    Extra: { value: "Extra note text.", order: 1 },
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
    Lecture_Notes: { value: "", order: 8 }
  }
};

// A second card for the same question, sharing ONE Sketchy chapter with the
// first and adding another. The shared chapter must outrank the unshared ones.
const NOTE2 = {
  noteId: 1111111111112,
  modelName: "Cloze-AnKingMaster",
  mod: 1700000001,
  tags: [
    "#AK_Step1_v12::#UWorld::Respiratory::1633",
    "#AK_Step1_v12::#Sketchy::Pharm::Beta_Blockers",
    "#AK_Step1_v12::#Sketchy::Micro::Gram_Positives"
  ],
  fields: {
    Text: { value: "A second card on the same question.", order: 0 },
    Sketchy: { value: "", order: 1 }
  }
};

const seen = [];   // every {op,args} the extension sent — asserted on by the test

// Test knobs, so a run can simulate a real collection's state:
//   onlyStep    - the deck only has tags for this step (exercises step fallback)
//   savedCopies - how many "Missed Qs" copies exist (exercises the dup guard)
const state = { onlyStep: null, savedCopies: 0, oldAddon: false };

const OPS = {
  ping: () => ({ name: "Mnestic Bridge (mock)", version: "1.0.2-mock" }),
  auth: () => ({ paired: true }),
  searchNotes: (a) => {
    const q = a.query || "";
    // the already-saved-copy lookup
    if (q.indexOf("tag:Mnestic::Missed") >= 0) return state.savedCopies ? [9999] : [];
    if (state.onlyStep && q.indexOf("#AK_Step" + state.onlyStep + "_") < 0) return [];
    // The real query is an OR of the precise tag shapes, e.g.
    //   (tag:…::#UWorld::Step::1633 OR tag:…::#UWorld::1633)
    // Refuse the old wildcard form so a regression back to it fails loudly.
    if (q.indexOf("::*::") >= 0) return [];
    return /(?:^|::)(1633|12345|4211)(?![0-9])/.test(q) ? [NOTE.noteId] : [];
  },
  noteInfo: () => [NOTE, NOTE2],
  readMedia: () => PNG_B64,
  writeMedia: (a) => a.filename,
  openBrowser: () => true,
  listTags: () => NOTE.tags,
  // a numbered chapter subdeck, like a real user's
  listDecks: () => ["Default", "AnKing Step 1", "Missed Questions", "Missed Questions::03_Respiratory"],
  cardStats: () => ({ [NOTE.noteId]: [{ type: 2, ivl: 30, lapses: 0, suspended: false, yield: "HighYield" }] }),
  cardMaturity: (a) => (a.queries || []).map(() =>
    ({ new: 1, learning: 1, young: 2, mature: 3, suspended: 2, total: 9 })),
  unsuspend: () => 1,
  countNotes: (a) => (a.queries || []).map(() => 4242),
  status: () => ({ name: "Mnestic Bridge (mock)", version: "1.1.0-mock",
    taggedByStep: { "1": 4242, "2": 0, "3": 0 } }),
  setDeck: (a) => ({ moved: 2, deck: a.deck, created: false }),
  createDeck: (a) => ({ deck: a.deck, created: true }),
  filteredDeck: (a) => ({ deck: a.name, cards: 37, search: a.search }),
  missedIds: () => ([
    { qid: "1633", chapter: "Respiratory", mod: 3 },
    { qid: "1634", chapter: "Respiratory", mod: 2 },
    { qid: "2101", chapter: "Cardiovascular", mod: 1 }
  ]),
  copyNote: () => { state.savedCopies++; return 2222222222222; },
  updateNote: () => true,
  newNote: () => 3333333333333
};

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
    if (state.oldAddon && ["setDeck", "createDeck", "filteredDeck", "missedIds", "countNotes"].indexOf(msg.op) >= 0) fn = null;
    seen.push({ op: msg.op, args: msg.args || {} });
    res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, cors));
    if (!fn) return res.end(JSON.stringify({ ok: false, error: "unknown op " + msg.op }));
    try { res.end(JSON.stringify({ ok: true, data: fn(msg.args || {}) })); }
    catch (e) { res.end(JSON.stringify({ ok: false, error: String(e) })); }
  });
});

// A second endpoint the test reads to see what the extension actually asked for.
server.on("request", () => {});
function calls() { return seen; }

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => console.log("mock bridge on 127.0.0.1:" + PORT));
}
module.exports = { server, calls, PORT, NOTE, state };
