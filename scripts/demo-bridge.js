// A bridge for the DEMO recorder — same wire protocol as the add-on, but with
// presentable data instead of the test doubles in mock-bridge.js.
//
// It is not a test double for correctness: it exists so the recorder can drive
// the real extension through a realistic session without anyone's collection.
// Resource images are supplied by demo-capture.js after it renders them.
//
//     node scripts/demo-bridge.js     (to poke at the demo UI by hand)
const http = require("http");

const PORT = Number(process.env.MNX_DEMO_PORT || 8790);

// filename -> base64 PNG. Filled in by the recorder before it drives the UI.
const media = {};
function setMedia(map) { Object.assign(media, map); }

const QID = "4211";
const TAG = "#AK_Step1_v12::#UWorld::Step::" + QID;

// One AnKing-shaped note, tagged the way a real Step 1 card is: the UWorld id
// plus a resource tag per resource, which is where the panel's rows come from.
const NOTE = {
  noteId: 1700000000001,
  modelName: "Cloze-AnKingMaster",
  mod: 1760000000,
  tags: [
    TAG,
    "#AK_Step1_v12::#FirstAid::FA2025::03_Respiratory::Obstructive_Lung_Diseases",
    "#AK_Step1_v12::#Sketchy::Path::Respiratory::COPD",
    "#AK_Step1_v12::#Physeo::Pulmonary::Obstructive_Disease",
    "#AK_Step1_v12::#OME::Step1::Pulmonology::Obstructive_Lung_Disease",
    "#AK_Step1_v12::#B&B::Pulmonary::Obstructive_and_Restrictive",
    "#AK_Step1_v12::#AK_Step1_v12_Yield::HighYield",
    "#AK_Other::AnKing_Image::!Subjects::Pulmonology::Emphysema"
  ],
  fields: {
    Text: {
      value: "In emphysema, loss of elastic recoil <b>{{c1::increases}}</b> lung " +
             "compliance, and airways collapse on {{c2::expiration}}.", order: 0
    },
    Extra: { value: "TLC and RV both rise. DLCO falls with alveolar surface area.", order: 1 },
    "First Aid": { value: '<img src="fa-1.png"><img src="fa-2.png"><img src="fa-3.png">', order: 2 },
    Sketchy: { value: '<img src="sketchy-1.png">', order: 3 },
    Physeo: { value: '<img src="physeo-1.png">', order: 4 },
    OME: { value: '<a href="https://example.org/ome/obstructive-lung-disease">Obstructive Lung Disease</a>', order: 5 },
    "Boards and Beyond": { value: '<a href="https://example.org/bnb/obstructive">Obstructive &amp; Restrictive</a>', order: 6 },
    "Missed Questions": { value: "", order: 7 },
    ankihub_id: { value: "e3f1c2a4-demo", order: 8 }
  }
};

const DECKS = [
  "Default",
  "AnKing Step 1",
  "AnKing Step 1::01_Cardiology",
  "AnKing Step 1::02_Renal",
  "AnKing Step 1::03_Respiratory",
  "Missed Qs",
  "Missed Qs::01_Cardiology",
  "Missed Qs::03_Respiratory"
];

// Saving and undoing both really change this, so a recorded run shows the same
// state transitions a user would see.
const state = { saved: false, homeDeck: "AnKing Step 1::03_Respiratory" };

const OPS = {
  ping: () => ({ name: "Mnestic Bridge", version: "1.3.0" }),
  auth: () => ({ paired: true }),
  status: () => ({
    name: "Mnestic Bridge", version: "1.3.0", ankiVersion: "26.09", profile: true,
    taggedByStep: { "1": 9272, "2": 9084, "3": 3619 }, mediaDir: true
  }),
  searchNotes: (a) => {
    const q = a.query || "";
    if (q.indexOf("-tag:Mnestic::Copy") >= 0) return state.saved ? [NOTE.noteId] : [];
    if (q.indexOf("tag:Mnestic::Copy") >= 0) return [];
    if (q.indexOf("tag:Mnestic::Missed") >= 0) return state.saved ? [NOTE.noteId] : [];
    if (q.indexOf('"deck:') >= 0) return state.saved ? [NOTE.noteId] : [];
    return q.indexOf(QID) >= 0 ? [NOTE.noteId] : [];
  },
  noteInfo: () => [NOTE],
  countNotes: (a) => (a.queries || []).map(() => 9272),
  listTags: () => NOTE.tags,
  listDecks: () => DECKS.slice(),
  readMedia: (a) => media[a.filename] || null,
  writeMedia: (a) => a.filename,
  openBrowser: () => true,
  cardStats: () => ([[
    { cid: 1, type: 2, ivl: 34, lapses: 1, suspended: false, yield: "HighYield" },
    { cid: 2, type: 2, ivl: 12, lapses: 0, suspended: false, yield: "HighYield" },
    { cid: 3, type: 0, ivl: 0, lapses: 0, suspended: true, yield: "HighYield" }
  ]]),
  cardMaturity: () => ([{ new: 1, learning: 1, young: 2, mature: 5, suspended: 1, total: 10 }]),
  unsuspend: () => ([{ matched: 3, unlocked: 1 }]),
  createDeck: (a) => ({ deck: a.deck, created: true }),
  setDeck: (a) => {
    const from = state.saved ? a.deck : state.homeDeck;
    state.saved = a.deck.indexOf("Missed") >= 0;
    return { moved: 3, deck: a.deck, created: false, from };
  },
  updateNote: () => { state.saved = true; return { noteId: NOTE.noteId }; },
  copyNote: () => ({ noteId: 1700000000002, cards: [9], deck: "Missed Qs" }),
  newNote: () => ({ noteId: 1700000000003, cards: [10], model: "Cloze-AnKingMaster", deck: "Missed Qs" }),
  removeTags: (a) => { state.saved = false; return { updated: 1, removed: (a.tags || []).slice() }; },
  deleteNotes: (a) => ({ deleted: (a.notes || []).length, refused: [] }),
  filteredDeck: (a) => ({ deck: a.name, cards: 24, search: a.search }),
  missedIds: () => ([
    { qid: "4211", chapter: "03_Respiratory", mod: 9 },
    { qid: "4225", chapter: "03_Respiratory", mod: 8 },
    { qid: "4212", chapter: "01_Cardiology", mod: 7 },
    { qid: "4213", chapter: "01_Cardiology", mod: 6 },
    { qid: "4214", chapter: "01_Cardiology", mod: 5 },
    { qid: "4217", chapter: "02_Renal", mod: 4 }
  ])
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
    const fn = OPS[msg.op];
    res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, cors));
    if (!fn) return res.end(JSON.stringify({ ok: false, error: "unknown op " + msg.op }));
    try { res.end(JSON.stringify({ ok: true, data: fn(msg.args || {}) })); }
    catch (e) { res.end(JSON.stringify({ ok: false, error: String(e) })); }
  });
});

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

module.exports = { listen, setMedia, state, QID, close: () => server.close() };

if (require.main === module) {
  listen(PORT).then((p) => console.log("demo bridge on http://127.0.0.1:" + p));
}
