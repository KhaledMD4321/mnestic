// Mnestic — popup: study tracker, settings, topic search, and the Anki
// connection (pairing) status. Talks to the bridge through the background
// worker with {type:"bridge", op, args}.

const sel = document.getElementById("sv");
const saved = document.getElementById("saved");
const darkToggle = document.getElementById("darkToggle");
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

function applyDark(on) {
  document.body.classList.toggle("dark", on);
  darkToggle.checked = on;
}

chrome.storage.local.get({ sv: 1, dark: false, expectedScore: false, easy: false, highYield: false, kbShortcuts: true }, (cfg) => {
  sel.value = String(cfg.sv);
  applyDark(!!cfg.dark);
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

darkToggle.addEventListener("change", () => {
  const on = darkToggle.checked;
  document.body.classList.toggle("dark", on);
  chrome.storage.local.set({ dark: on });
});
esToggle.addEventListener("change", () => chrome.storage.local.set({ expectedScore: esToggle.checked }));
easyToggle.addEventListener("change", () => chrome.storage.local.set({ easy: easyToggle.checked }));
hyToggle.addEventListener("change", () => chrome.storage.local.set({ highYield: hyToggle.checked }));
kbToggle.addEventListener("change", () => chrome.storage.local.set({ kbShortcuts: kbToggle.checked }));

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
const TRK_KEY = "akTrackerV2";
function startOfDayMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeekMs() { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function prettySlug(s) { return (s || "").replace(/([a-z])(\d)/i, "$1 $2").toUpperCase(); }
function setText(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; }
function setFill(id, frac, on) {
  const e = document.getElementById(id); if (!e) return;
  e.parentElement.style.visibility = on ? "visible" : "hidden";
  if (on) { e.style.width = Math.min(100, Math.round(frac * 100)) + "%"; e.classList.toggle("over", frac >= 1); }
}
const DAY = 86400000;
function dayStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function fmtDate(ms) { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function currentStreak(buckets, d0) {
  let cur = 0, d = d0;
  if (!(buckets[d] > 0)) d -= DAY; // today not done yet -> don't break the streak
  while (buckets[d] > 0) { cur++; d -= DAY; }
  return cur;
}
function bestStreak(buckets) {
  const days = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const d of days) { run = (prev != null && d - prev === DAY) ? run + 1 : 1; if (run > best) best = run; prev = d; }
  return best;
}
function heatLevel(count, daily) {
  if (!count) return "";
  if (daily > 0) { const f = count / daily; return f >= 1 ? "l4" : f >= 0.67 ? "l3" : f >= 0.34 ? "l2" : "l1"; }
  return count >= 40 ? "l4" : count >= 20 ? "l3" : count >= 10 ? "l2" : "l1";
}
function renderHeatmap(buckets, daily) {
  const cal = document.getElementById("trkCal"); if (!cal) return;
  cal.replaceChildren();
  const weeks = 16, today = startOfDayMs();
  const firstMon = startOfWeekMs() - (weeks - 1) * 7 * DAY; // Monday, 16 weeks back
  let sum = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const day = firstMon + i * DAY;
    const cell = document.createElement("div");
    if (day > today) { cell.className = "trk-day future"; }
    else { const c = buckets[day] || 0; sum += c; cell.className = "trk-day " + heatLevel(c, daily); cell.title = fmtDate(day) + ": " + c + " q"; }
    cal.appendChild(cell);
  }
  setText("trkCalHint", sum ? (sum + " questions") : "");
}
function renderTracker(t) {
  t = t || { answered: {}, totals: {}, targets: { weekly: 0, daily: 0 } };
  const answered = t.answered || {};
  const d0 = startOfDayMs(), w0 = startOfWeekMs();
  const daily = (t.targets && t.targets.daily) || 0, weekly = (t.targets && t.targets.weekly) || 0;

  const buckets = {};
  let today = 0, week = 0, last14 = 0, acc7C = 0, acc7T = 0;
  const cut14 = d0 - 13 * DAY, cut7 = d0 - 6 * DAY;
  for (const k in answered) {
    const e = answered[k], ts = e.ts; if (!ts) continue;
    const day = dayStart(ts);
    buckets[day] = (buckets[day] || 0) + 1;
    if (ts >= d0) today++;
    if (ts >= w0) week++;
    if (day >= cut14) last14++;
    if ((e.correct === true || e.correct === false) && day >= cut7) { acc7T++; if (e.correct) acc7C++; }
  }

  setText("trkToday", today + (daily ? " / " + daily : ""));
  setText("trkWeek", week + (weekly ? " / " + weekly : ""));
  setFill("trkTodayFill", daily ? today / daily : 0, !!daily);
  setFill("trkWeekFill", weekly ? week / weekly : 0, !!weekly);

  const cur = currentStreak(buckets, d0), best = bestStreak(buckets);
  setText("trkStreak", cur > 0 ? ("🔥 " + cur + "-day" + (best > cur ? " · best " + best : "")) : (best > 0 ? "best " + best : ""));

  renderHeatmap(buckets, daily);

  // remaining, from the most recently scraped qbank dashboard
  let slug = null, bestTs = -1;
  for (const s in (t.totals || {})) { const ts = t.totals[s].ts || 0; if (ts > bestTs) { bestTs = ts; slug = s; } }
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
    setText("trkRemainLbl", "Remaining"); setText("trkRemain", "— open dashboard"); setFill("trkRemainFill", 0, false);
  }

  // projection + 7-day accuracy
  const proj = document.getElementById("trkProj");
  if (proj) {
    const pace = last14 / 14, bits = [];
    if (remain != null && remain > 0 && pace > 0) {
      const daysLeft = Math.ceil(remain / pace);
      bits.push("≈ " + daysLeft + " days left at your pace · finish ~" + fmtDate(d0 + daysLeft * DAY));
    }
    if (acc7T > 0) bits.push(Math.round(100 * acc7C / acc7T) + "% correct · last 7 days (" + acc7T + " q)");
    proj.innerHTML = bits.join("<br>");
    proj.style.display = bits.length ? "block" : "none";
  }

  const di = document.getElementById("trkDaily"); if (di && document.activeElement !== di) di.value = daily || "";
  const wi = document.getElementById("trkWeekly"); if (wi && document.activeElement !== wi) wi.value = weekly || "";
}
function saveTargets() {
  chrome.storage.local.get({ [TRK_KEY]: null }, (c) => {
    const t = c[TRK_KEY] || { answered: {}, totals: {}, targets: {} };
    t.targets = t.targets || {};
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

async function checkConnection() {
  setPill("checking");
  const ping = await bridge("ping");
  if (!ping.ok) { setPill("off"); return; }   // bridge/add-on not reachable
  const auth = await bridge("auth");
  setPill(auth.ok ? "on" : "pair");            // reachable — paired or not
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
