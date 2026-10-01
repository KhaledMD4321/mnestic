// Mnestic — popup: study tracker, settings, topic search, and the Anki
// connection (pairing) status. Talks to the bridge through the background
// worker with {type:"bridge", op, args}.
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE. No warranty, to the extent
// permitted by law.

const sel = document.getElementById("sv");
const saved = document.getElementById("saved");
const darkSelect = document.getElementById("darkSelect");
const missedMode = document.getElementById("missedMode");
const missedHint = document.getElementById("missedHint");
const esToggle = document.getElementById("esToggle");
const easyToggle = document.getElementById("easyToggle");
const hyToggle = document.getElementById("hyToggle");
const kbToggle = document.getElementById("kbToggle");

const pill = document.getElementById("pill");
const pillText = document.getElementById("pillText");
const pairBox = document.getElementById("pairBox");
const offHint = document.getElementById("offHint");

function bridge(op, args) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "bridge", op, args: args || {} }, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(resp || { ok: false, error: "no response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

// "auto" follows the qbank's own theme, then the OS. Light/Dark are overrides.
function prefersDark() {
  try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { return false; }
}
function applyDark(pref) {
  const on = pref === true ? true : pref === false ? false : prefersDark();
  document.body.classList.toggle("dark", on);
  darkSelect.value = pref === true ? "dark" : pref === false ? "light" : "auto";
}

// What "Save to Missed Qs" does. Changeable whenever you like — some people
// want a real subdeck, some won't move an AnKing card for anything.
const MISSED_HINTS = {
  move: "Moves the real card into a chapter subdeck, keeping its review history and AnKing updates. Your note is added to the card's “Missed Questions” field, and Mnestic tags it AnkiHub_Protect so a deck update can't overwrite it.",
  tag: "Tags the note Mnestic::Missed::Chapter and unsuspends it — nothing changes decks. Your note is added to the card's “Missed Questions” field, and Mnestic tags it AnkiHub_Protect so a deck update can't overwrite it.",
  copy: "Duplicates the card into a chapter subdeck as a local note, so nothing can overwrite it — but the copy never receives AnKing updates again. Undo deletes the copy."
};
function applyMissedMode(mode) {
  missedMode.value = mode;
  missedHint.textContent = MISSED_HINTS[mode] || "";
}
missedMode.addEventListener("change", () => {
  applyMissedMode(missedMode.value);
  chrome.storage.local.set({ mnxMissedMode: missedMode.value });
});

chrome.storage.local.get({ sv: 1, dark: "auto", expectedScore: false, easy: false, highYield: false, kbShortcuts: true, mnxMissedMode: "move" }, (cfg) => {
  applyMissedMode(cfg.mnxMissedMode || "move");
  sel.value = String(cfg.sv);
  applyDark(cfg.dark === true || cfg.dark === false ? cfg.dark : "auto");
  esToggle.checked = !!cfg.expectedScore;
  easyToggle.checked = !!cfg.easy;
  hyToggle.checked = !!cfg.highYield;
  kbToggle.checked = cfg.kbShortcuts !== false;
});

sel.addEventListener("change", () => {
  const sv = parseInt(sel.value, 10) || 1;
  chrome.storage.local.set({ sv }, () => {
    saved.textContent = "Saved — applies on your next click.";
    setTimeout(() => (saved.textContent = ""), 2500);
  });
});

darkSelect.addEventListener("change", () => {
  const v = darkSelect.value;
  const pref = v === "dark" ? true : v === "light" ? false : "auto";
  applyDark(pref);
  chrome.storage.local.set({ dark: pref });
});
esToggle.addEventListener("change", () => chrome.storage.local.set({ expectedScore: esToggle.checked }));
easyToggle.addEventListener("change", () => chrome.storage.local.set({ easy: easyToggle.checked }));
hyToggle.addEventListener("change", () => chrome.storage.local.set({ highYield: hyToggle.checked }));
kbToggle.addEventListener("change", () => chrome.storage.local.set({ kbShortcuts: kbToggle.checked }));

// ---- the Missed Qs deck, made from here rather than from Anki ----
const missedDeck = document.getElementById("missedDeck");
const missedDeckHint = document.getElementById("missedDeckHint");
chrome.storage.local.get({ akMissedDeck: "" }, (c) => { missedDeck.value = c.akMissedDeck || ""; });

async function createMissedDeck() {
  const name = (missedDeck.value || "").trim() || "Missed Qs";
  const btn = document.getElementById("missedDeckGo");
  btn.disabled = true; btn.textContent = "Creating…";
  // Give a brand-new deck the AnKing deck's options, so its daily limits don't
  // silently differ from the deck the cards came from.
  const decks = await bridge("listDecks");
  let optionsFrom = "";
  if (decks.ok && Array.isArray(decks.data)) {
    const ank = decks.data.filter((d) => /anking|step/i.test(d) && d.indexOf("::") < 0);
    optionsFrom = ank.sort((a, b) => a.length - b.length)[0] || "";
  }
  const r = await bridge("createDeck", { deck: name, optionsFrom });
  btn.disabled = false; btn.textContent = "Create";
  if (!r.ok) { missedDeckHint.textContent = "Couldn't create it — is Anki open? (" + r.error + ")"; return; }
  chrome.storage.local.set({ akMissedDeck: name });
  missedDeckHint.textContent = (r.data && r.data.created)
    ? "Created " + name + (optionsFrom ? " with " + optionsFrom + "'s options." : ".")
    : name + " already exists — it'll be used as the base.";
}
document.getElementById("missedDeckGo").addEventListener("click", createMissedDeck);
missedDeck.addEventListener("keydown", (e) => { if (e.key === "Enter") createMissedDeck(); });

// ---- missed questions: retest them, or study them ----------------------
// The question ids are already in the AnKing tags, so the qbank's own test
// builder can take them straight back — miss it, study it, sit it again.
const missedList = document.getElementById("missedList");
const missedSummary = document.getElementById("missedSummary");
const missedStudyHint = document.getElementById("missedStudyHint");
let missedRows = [];

function copyIds(ids, btn) {
  const text = ids.join(",");
  navigator.clipboard.writeText(text).then(
    () => { btn.textContent = "Copied " + ids.length; setTimeout(() => (btn.textContent = "Copy ids"), 1600); },
    () => { btn.textContent = "Copy failed"; setTimeout(() => (btn.textContent = "Copy ids"), 1600); }
  );
}

function renderMissed() {
  missedList.replaceChildren();
  if (!missedRows.length) {
    missedSummary.textContent = "Nothing saved yet. Use ★ Save to Missed Qs on a question.";
    return;
  }
  const byChapter = new Map();
  missedRows.forEach((r) => {
    const k = r.chapter || "No chapter";
    if (!byChapter.has(k)) byChapter.set(k, []);
    byChapter.get(k).push(r.qid);
  });
  missedSummary.textContent = missedRows.length + " saved across " + byChapter.size +
    (byChapter.size === 1 ? " chapter" : " chapters") + ". Paste the ids into your qbank's test builder.";
  // Since 1.4 a save records the question itself. A card saved earlier only
  // carries AnKing's own question tags, which can name questions you never
  // saw -- say so rather than pass them off as your misses.
  const approx = missedRows.filter((r) => r.exact === false).length;
  if (missedRows.every((r) => r.exact === undefined)) {
    // An add-on older than 1.4 can't tell them apart at all.
    missedSummary.textContent += " Update the Mnestic Bridge add-on so this lists only the questions you missed — " +
      "the version you have lists every question AnKing tags on each saved card.";
  } else if (approx) {
    missedSummary.textContent += " " + approx + (approx === 1 ? " id comes" : " ids come") +
      " from cards saved before Mnestic 1.4, which list every question AnKing tags on the card — some may be questions you didn't miss.";
  }

  const rows = [["All", missedRows.map((r) => r.qid)]]
    .concat(Array.from(byChapter.entries()).sort((a, b) => b[1].length - a[1].length));
  rows.forEach(([name, ids]) => {
    const row = document.createElement("div"); row.className = "mrow";
    const n = document.createElement("span"); n.className = "mname";
    n.textContent = String(name).replace(/_/g, " ");
    const c = document.createElement("span"); c.className = "mcount"; c.textContent = ids.length;
    const b = document.createElement("button"); b.className = "chip"; b.textContent = "Copy ids";
    b.addEventListener("click", () => copyIds(ids, b));
    row.append(n, c, b);
    missedList.appendChild(row);
  });
}

async function loadMissed() {
  missedSummary.textContent = "Reading your collection…";
  const sv = parseInt(sel.value, 10) || 1;
  const r = await bridge("missedIds", { step: sv });
  if (!r.ok) {
    missedSummary.textContent = r.error && /unknown op/i.test(r.error)
      ? "Update the Mnestic Bridge add-on to use this."
      : "Couldn't reach Anki.";
    return;
  }
  missedRows = Array.isArray(r.data) ? r.data : [];
  renderMissed();
}
document.getElementById("missedRefresh").addEventListener("click", loadMissed);

document.getElementById("missedStudy").addEventListener("click", async () => {
  const btn = document.getElementById("missedStudy");
  btn.disabled = true; btn.textContent = "Building…";
  const r = await bridge("filteredDeck", {
    name: "Mnestic — Missed",
    // Both forms: a question saved with "No subdeck" carries the bare tag, and
    // "Mnestic::Missed::*" alone left every one of those out of the deck.
    search: "(tag:Mnestic::Missed OR tag:Mnestic::Missed::*) -is:suspended",
    limit: 200
  });
  btn.disabled = false; btn.textContent = "Study them in Anki";
  if (r.ok && !r.data.cards) {
    // Nothing missed yet is where every new user starts, and Anki's own
    // "no cards matched" prose reads like a failure. Say what to do instead.
    missedStudyHint.textContent =
      "Nothing to study yet — save a question as missed and it lands here.";
  } else if (r.ok) {
    missedStudyHint.textContent =
      "Built “" + r.data.deck + "” with " + r.data.cards +
      " cards — open Anki to study it.";
  } else if (/unknown op/i.test(r.error || "")) {
    missedStudyHint.textContent = "Update the Mnestic Bridge add-on to use this.";
  } else {
    missedStudyHint.textContent = "Couldn't build it: " + r.error;
  }
});

// ---- find a topic in Anki (drill a hard topic outside the qbank) ----
const topicInput = document.getElementById("topicInput");
const topicGo = document.getElementById("topicGo");
async function findTopic() {
  const topic = (topicInput.value || "").trim();
  if (!topic) return;
  const sv = parseInt(sel.value, 10) || 1;
  const query = "tag:#AK_Step" + sv + "_v* " + topic; // AnKing Step deck AND the words
  const resp = await bridge("openBrowser", { query });
  if (!resp.ok) {
    saved.textContent = "Couldn't reach Anki.";
    setTimeout(() => (saved.textContent = ""), 2500);
  } else {
    window.close();
  }
}
topicGo.addEventListener("click", findTopic);
topicInput.addEventListener("keydown", (e) => { if (e.key === "Enter") findTopic(); });

// ---- AI prompt (prepended to "🤖 Copy for AI") ----
const AI_DEFAULT = "I'm studying for the USMLE. Below is a question with its answer choices and explanation. Explain the correct answer and why each other option is wrong, then give me the single highest-yield fact to remember. Be concise.";
const AI_PRESETS = [
  ["Explain", AI_DEFAULT],
  ["Differentiate", "I'm studying for the USMLE. For the question below, focus on how to tell the correct answer apart from the tempting distractors — what specific feature rules each one in or out. Be concise."],
  ["One-liner", "Give me one high-yield sentence to remember from the question below."],
  ["Simplify", "Explain the question below like I'm a beginner: the core concept in plain language, then the takeaway. Be concise."],
];
const aiPromptEl = document.getElementById("aiPrompt");
const aiPresetsEl = document.getElementById("aiPresets");
function saveAiPrompt() { chrome.storage.local.set({ aiPrompt: aiPromptEl.value }); }
AI_PRESETS.forEach(([label, text]) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "chip"; b.textContent = label;
  b.addEventListener("click", () => { aiPromptEl.value = text; saveAiPrompt(); });
  aiPresetsEl.appendChild(b);
});
chrome.storage.local.get({ aiPrompt: AI_DEFAULT }, (c) => { aiPromptEl.value = c.aiPrompt == null ? AI_DEFAULT : c.aiPrompt; });
aiPromptEl.addEventListener("change", saveAiPrompt);
aiPromptEl.addEventListener("blur", saveAiPrompt);

// ---- study tracker (reads the per-question log the content script writes) ----
// Days are calendar dates (lib/dates.js) and the arithmetic lives in
// lib/tracker.js, both unit-tested. Keying days by milliseconds and stepping
// 86,400,000 at a time broke the streak and heatmap on the days a clock changes.
const Dt = window.Mnx.dates;
const Trk = window.Mnx.tracker;
const TRK_KEY = "akTrackerV2";
function prettySlug(s) { return (s || "").replace(/([a-z])(\d)/i, "$1 $2").toUpperCase(); }
function setText(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; }
function setFill(id, frac, on) {
  const e = document.getElementById(id); if (!e) return;
  e.parentElement.style.visibility = on ? "visible" : "hidden";
  if (on) { e.style.width = Math.min(100, Math.round(frac * 100)) + "%"; e.classList.toggle("over", frac >= 1); }
}
function fmtDay(key) {
  const d = Dt.parseDay(key);
  return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : key;
}
function heatLevel(count, daily) {
  if (!count) return "";
  if (daily > 0) { const f = count / daily; return f >= 1 ? "l4" : f >= 0.67 ? "l3" : f >= 0.34 ? "l2" : "l1"; }
  return count >= 40 ? "l4" : count >= 20 ? "l3" : count >= 10 ? "l2" : "l1";
}
function renderHeatmap(counts, daily, today) {
  const cal = document.getElementById("trkCal"); if (!cal) return;
  cal.replaceChildren();
  const weeks = 16;
  const firstMon = Dt.addDays(Dt.weekStart(today), -(weeks - 1) * 7);   // Monday, 16 weeks back
  let sum = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const day = Dt.addDays(firstMon, i);
    const cell = document.createElement("div");
    if (day > today) { cell.className = "trk-day future"; }
    else { const c = counts[day] || 0; sum += c; cell.className = "trk-day " + heatLevel(c, daily); cell.title = fmtDay(day) + ": " + c + " q"; }
    cal.appendChild(cell);
  }
  setText("trkCalHint", sum ? (sum + " questions") : "");
}
function renderTracker(raw) {
  const t = Trk.normalizeLog(raw);
  const today = Dt.dayKey();
  const w0 = Dt.weekStart(today), cut7 = Dt.addDays(today, -6);
  const daily = t.targets.daily || 0, weekly = t.targets.weekly || 0;

  // Both dated signals: questions the panel watched, and counter jumps that
  // happened within one day. Undated jumps count toward totals, never a day.
  const counts = Trk.dayCounts(t);
  let todayN = counts[today] || 0, week = 0;
  for (const d in counts) if (d >= w0 && d <= today) week += counts[d];

  let acc7C = 0, acc7T = 0, guessed7 = 0;
  for (const k in t.answered) {
    const e = t.answered[k];
    if (!e || !e.ts) continue;                    // undated: a results table or a rating, not an answer
    const d = Dt.dayKey(e.ts);
    if (d < cut7) continue;
    if (e.conf === "guessed" || e.conf === "noidea") guessed7++;
    if (e.correct === true || e.correct === false) { acc7T++; if (e.correct) acc7C++; }
  }

  setText("trkToday", todayN + (daily ? " / " + daily : ""));
  setText("trkWeek", week + (weekly ? " / " + weekly : ""));
  setFill("trkTodayFill", daily ? todayN / daily : 0, !!daily);
  setFill("trkWeekFill", weekly ? week / weekly : 0, !!weekly);

  const cur = Dt.currentStreak(counts, today), best = Dt.bestStreak(counts);
  setText("trkStreak", cur > 0 ? ("🔥 " + cur + "-day" + (best > cur ? " · best " + best : "")) : (best > 0 ? "best " + best : ""));

  renderHeatmap(counts, daily, today);

  // remaining, from the most recently scraped bank dashboard
  let slug = null, bestTs = -1;
  for (const s in t.totals) { const ts = t.totals[s].ts || 0; if (ts > bestTs) { bestTs = ts; slug = s; } }
  const tot = slug ? t.totals[slug] : null;
  let remain = null;
  if (tot && (tot.unused != null || tot.total != null)) {
    remain = tot.unused != null ? tot.unused : Math.max(0, (tot.total || 0) - (tot.used || 0));
    setText("trkRemainLbl", prettySlug(slug) + " remaining");
    setText("trkRemain", remain + " left");
    setFill("trkRemainFill", tot.total ? (tot.total - remain) / tot.total : 0, !!tot.total);
    const el = document.getElementById("trkRemain");
    if (el) el.title = (tot.used != null ? tot.used + " used · " : "") + (tot.total != null ? tot.total + " total" : "");
  } else {
    setText("trkRemainLbl", "Remaining"); setText("trkRemain", "— open your bank's dashboard"); setFill("trkRemainFill", 0, false);
  }

  // projection + 7-day accuracy + where the numbers came from
  const proj = document.getElementById("trkProj");
  if (proj) {
    const bits = [];
    let inferredToday = 0;
    for (const b in t.daily) inferredToday += t.daily[b][today] || 0;
    if (inferredToday > 0) bits.push("+" + inferredToday + " of today's from your qbank's own counter");
    if (slug) {
      const und = t.undated[slug] || [];
      if (und.length) {
        const last = und[und.length - 1];
        bits.push("+" + last.n + " counted by " + prettySlug(slug) + " between " + fmtDay(last.from) + " and " +
          fmtDay(last.to) + " — not tied to a day, so not in Today or the streak");
      }
    }
    if (remain != null && slug) {
      const pace = Trk.pace(t, slug, today);
      const p = Trk.projection(remain, pace, today);
      if (p && p.done) bits.push("You've used every question in " + prettySlug(slug) + ".");
      else if (pace && pace.insufficient) bits.push("A finish date appears after 3 days of history.");
      else if (p && p.tooFar) bits.push("At your recent pace (" + pace.perDay.toFixed(1) + "/day) that's over 10 years — a daily target below gives a real date.");
      else if (p) {
        bits.push("≈ " + p.daysLeft + " days left at " + pace.perDay.toFixed(1) + "/day (your last " + pace.span +
          " days) · finish ~" + fmtDay(p.finish) +
          (pace.staleDays > 7 ? " · counts last read " + fmtDay(pace.to) + ", open the dashboard to update" : ""));
      }
      if (daily > 0 && remain > 0) {
        const tp = Trk.projection(remain, { perDay: daily }, today);
        if (tp && tp.finish) bits.push("At your target of " + daily + "/day: finish ~" + fmtDay(tp.finish));
      }
    }
    if (acc7T > 0) bits.push(Math.round(100 * acc7C / acc7T) + "% correct · last 7 days (" + acc7T + " q)");
    // A right answer you weren't sure of is the highest-yield thing to revisit.
    if (guessed7 > 0) bits.push(guessed7 + " you guessed or didn't know · last 7 days");
    proj.replaceChildren();
    bits.forEach((b, i) => {
      if (i) proj.appendChild(document.createElement("br"));
      proj.appendChild(document.createTextNode(b));
    });
    proj.style.display = bits.length ? "block" : "none";
  }

  const di = document.getElementById("trkDaily"); if (di && document.activeElement !== di) di.value = daily || "";
  const wi = document.getElementById("trkWeekly"); if (wi && document.activeElement !== wi) wi.value = weekly || "";
}
function saveTargets() {
  chrome.storage.local.get({ [TRK_KEY]: null }, (c) => {
    const t = Trk.normalizeLog(c[TRK_KEY]);
    t.targets.daily = Math.max(0, parseInt(document.getElementById("trkDaily").value, 10) || 0);
    t.targets.weekly = Math.max(0, parseInt(document.getElementById("trkWeekly").value, 10) || 0);
    chrome.storage.local.set({ [TRK_KEY]: t }, () => renderTracker(t));
  });
}
chrome.storage.local.get({ [TRK_KEY]: null }, (c) => renderTracker(c[TRK_KEY]));
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[TRK_KEY]) renderTracker(ch[TRK_KEY].newValue); });
document.getElementById("trkDaily").addEventListener("change", saveTargets);
document.getElementById("trkWeekly").addEventListener("change", saveTargets);

// ---- connection: is the bridge running, and is this browser paired? ----
function setPill(state) {
  pill.classList.remove("checking", "on", "off", "pair");
  pill.classList.add(state);
  pairBox.hidden = state !== "pair";
  offHint.hidden = state !== "off";
  pillText.textContent =
    state === "on" ? "Ready" :
    state === "pair" ? "Enter pairing code" :
    state === "off" ? "Anki not connected" : "Checking…";
}

// A first run has three things to get right, and the old popup only reported
// the middle one. Show them as a checklist that disappears once it's all done.
function setStep(id, state) {
  const li = document.getElementById(id);
  if (!li) return;
  li.classList.toggle("done", state === "done");
  li.classList.toggle("now", state === "now");
}
async function refreshSetup(ankiUp, paired) {
  const box = document.getElementById("setup");
  if (!box) return;
  setStep("su-anki", ankiUp ? "done" : "now");
  setStep("su-pair", paired ? "done" : ankiUp ? "now" : "");
  let tagged = null;
  if (paired) {
    const q = [1, 2, 3].map((n) => "tag:#AK_Step" + n + "_v*::#UWorld::*");
    const r = await bridge("countNotes", { queries: q });
    if (r.ok && Array.isArray(r.data)) tagged = r.data.some((n) => n > 0);
    else {
      const one = await bridge("searchNotes", { query: q[0] });
      tagged = one.ok && Array.isArray(one.data) ? one.data.length > 0 : null;
    }
  }
  setStep("su-deck", tagged ? "done" : paired ? "now" : "");
  box.hidden = !!(ankiUp && paired && tagged);
}

async function checkConnection() {
  setPill("checking");
  const ping = await bridge("ping");
  if (!ping.ok) { setPill("off"); refreshSetup(false, false); return; }   // bridge/add-on not reachable
  const auth = await bridge("auth");
  // Reachable, but only a refused CODE means "pair": a timeout or an Anki
  // error must not send someone off to re-enter a code that is fine.
  setPill(auth.ok ? "on" : auth.code === "auth" ? "pair" : "off");
  refreshSetup(true, !!auth.ok);
  if (auth.ok) loadMissed();                   // only once we know we can ask
}

// pairing-code + port inputs
const tokenInput = document.getElementById("tokenInput");
const portInput = document.getElementById("portInput");
chrome.storage.local.get({ bridgeToken: "", bridgePort: 8790 }, (c) => {
  tokenInput.value = c.bridgeToken || "";
  portInput.value = c.bridgePort || 8790;
});
document.getElementById("tokenSave").addEventListener("click", () => {
  chrome.storage.local.set({ bridgeToken: (tokenInput.value || "").trim() }, checkConnection);
});
tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") chrome.storage.local.set({ bridgeToken: (tokenInput.value || "").trim() }, checkConnection);
});
document.getElementById("portSave").addEventListener("click", () => {
  const p = parseInt(portInput.value, 10) || 8790;
  chrome.storage.local.set({ bridgePort: p }, checkConnection);
});

document.getElementById("retry").addEventListener("click", (e) => { e.preventDefault(); checkConnection(); });
checkConnection();

// ---- "Check my deck": can matching work at all? ----
// The commonest failure isn't a bug — it's a deck with no UWorld tags, or one
// tagged for a different Step than the selector says. Count them and say so.
const deckOut = document.getElementById("deckOut");
document.getElementById("deckBtn").addEventListener("click", async () => {
  const btn = document.getElementById("deckBtn");
  deckOut.hidden = false;
  deckOut.textContent = "Counting…";
  btn.disabled = true;
  const queries = [1, 2, 3].map((s) => "tag:#AK_Step" + s + "_v*::#UWorld::*");
  const counts = {};
  // countNotes returns three numbers. Older add-ons don't have it, so fall back
  // to searchNotes — which answers with every matching note id, roughly 26,000
  // integers for a full deck, to show three counts.
  const fast = await bridge("countNotes", { queries });
  if (fast.ok && Array.isArray(fast.data)) {
    [1, 2, 3].forEach((s, i) => (counts[s] = fast.data[i]));
  } else {
    for (const step of [1, 2, 3]) {
      const r = await bridge("searchNotes", { query: queries[step - 1] });
      counts[step] = r.ok && Array.isArray(r.data) ? r.data.length : -1;
    }
  }
  btn.disabled = false;
  if (Object.values(counts).every((n) => n < 0)) {
    deckOut.textContent = "Couldn't reach Anki. Open it, then try again.";
    return;
  }
  const chosen = parseInt(sel.value, 10) || 1;
  deckOut.replaceChildren();
  for (const step of [1, 2, 3]) {
    const row = document.createElement("div");
    const n = counts[step];
    row.textContent = "Step " + step + ": " +
      (n < 0 ? "couldn't check" : n.toLocaleString() + " tagged card" + (n === 1 ? "" : "s")) +
      (step === chosen ? "   ← selected" : "");
    row.style.color = n > 0 ? "inherit" : "#8a8f98";
    if (step === chosen) row.style.fontWeight = "700";
    deckOut.appendChild(row);
  }
  const best = [1, 2, 3].filter((s) => counts[s] > 0);
  const note = document.createElement("div");
  note.style.marginTop = "5px";
  if (!best.length) {
    note.textContent = "No AnKing UWorld tags found. Mnestic matches on tags like " +
      "#AK_Step1_v12::#UWorld::…::<id> — without them there's nothing to match.";
    note.style.color = "#b3261e";
  } else if (counts[chosen] > 0) {
    note.textContent = "Looks right — matching should work.";
    note.style.color = "#2e9e4f";
  } else {
    note.textContent = "Your Step is set to " + chosen + ", but the cards are in Step " +
      best.join(" and ") + ".";
    note.style.color = "#a86412";
    const fix = document.createElement("button");
    fix.className = "chip";
    fix.style.marginTop = "4px";
    fix.textContent = "Switch to Step " + best[0];
    fix.addEventListener("click", () => {
      sel.value = String(best[0]);
      chrome.storage.local.set({ sv: best[0] }, () => { fix.textContent = "Switched"; });
    });
    note.appendChild(document.createElement("br"));
    note.appendChild(fix);
  }
  deckOut.appendChild(note);
});

// ---- "Check this page": ask the qbank tab what the site adapter can see ----
// Structure only (tags / ids / classes) — never question text or account data —
// so the report is safe to paste into a bug report.
const diagOut = document.getElementById("diagOut");
const diagCopyRow = document.getElementById("diagCopyRow");
let diagText = "";

function renderDiag(d) {
  const yn = (v) => (v === true ? "yes" : v === false ? "no" : "—");
  const lines = [
    "Mnestic " + (d.version || "?") + "  ·  adapter: " + d.adapter,
    "host: " + d.host,
    "path: " + d.path,
    "question id found: " + (d.qid || "NO"),
    "reviewing (explanation visible): " + yn(d.reviewing),
    "explanation element: " + (d.explanationAt || "not found"),
    "panel anchor: " + (d.panelAnchorAt || "none (floating)"),
    "result rows parsed: " + d.resultRows +
      (d.resultSample && d.resultSample.length ? "  (first ids: " + d.resultSample.join(", ") + ")" : ""),
    "step detected: " + (d.step || "— (using the popup's Step)"),
    "<main> present: " + yn(d.hasMain) + "  ·  tables: " + d.tables,
    "Anki button docks at: " + (d.qidAnchorAt || "floating"),
    "features here: results buttons " + yn(d.features && d.features.resultsButtons) +
      " · attach question image " + yn(d.features && d.features.questionImages)
  ];
  if (d.qidSeenAt && d.qidSeenAt.length) {
    lines.push("id-looking labels on the page:");
    d.qidSeenAt.forEach((c) => lines.push("  • " + c.label + "   in   " + c.path));
  } else {
    lines.push('id-looking labels on the page: none — no "Question Id" text found');
  }
  if (d.error) lines.push("error: " + d.error);
  return lines.join("\n");
}

document.getElementById("diagBtn").addEventListener("click", () => {
  diagOut.hidden = false;
  diagOut.textContent = "Checking…";
  diagCopyRow.hidden = true;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) { diagOut.textContent = "No active tab."; return; }
    chrome.tabs.sendMessage(tab.id, { type: "mnx-diagnose" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        diagOut.textContent =
          "Mnestic isn't running on this tab.\n\n" +
          "Open a question in a supported question bank, then try again. " +
          "If you just installed or updated the extension, reload the page once.";
        return;
      }
      diagText = renderDiag(resp);
      diagOut.textContent = diagText;
      diagCopyRow.hidden = false;
    });
  });
});

document.getElementById("diagCopy").addEventListener("click", () => {
  const btn = document.getElementById("diagCopy");
  navigator.clipboard.writeText(diagText).then(
    () => { btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = "Copy report"), 1400); },
    () => { btn.textContent = "Copy failed"; setTimeout(() => (btn.textContent = "Copy report"), 1400); }
  );
});
