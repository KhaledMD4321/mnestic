// Mnestic — background service worker.
//
// Every call to the local Mnestic Bridge add-on happens here (not in the page), so
// the site's in-page request rules can't interfere. The content script and popup
// send a {type:"bridge", op, args} message; we forward it to 127.0.0.1:<port>
// with the pairing token and hand back {ok, data} / {ok:false, error, code}.
//
// `code` tells the UI WHICH failure it is, so it can say something useful:
//   offline    nothing answered: Anki is closed or the add-on isn't installed
//   auth       the add-on answered but refused the pairing code
//   timeout    Anki didn't answer in time (busy syncing, a modal dialog open)
//   old-addon  the add-on predates this op
//   refused    this worker won't send that request (unknown op, bad args)
//   anki       Anki answered with an error of its own
//
// Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General
// Public License v3 or later; see LICENSE. No warranty, to the extent
// permitted by law.

const DEFAULT_PORT = 8790;

// What each side of the extension may ask the bridge to do. The content script
// runs inside the qbank's page, so it gets only the ops its own features use --
// if it were ever subverted, this list is what it could reach, and it cannot
// build filtered decks, create decks, or read the missed list. The popup is an
// extension page and needs its own, different handful.
const CONTENT_OPS = new Set([
  "ping", "auth", "searchNotes", "noteInfo", "readMedia", "writeMedia", "openBrowser",
  "listDecks", "cardStats", "cardMaturity", "unsuspend", "suspend", "copyNote",
  "updateNote", "newNote", "setDeck", "removeTags", "deleteNotes"
]);
const PAGE_OPS = new Set([
  "ping", "auth", "status", "listDecks", "createDeck", "missedIds", "filteredDeck",
  "openBrowser", "countNotes", "searchNotes"
]);
const MAX_ARGS = 1024 * 1024;             // plenty for every op but one
const MAX_MEDIA_ARGS = 33 * 1024 * 1024;  // writeMedia carries a base64 image
const MAX_IMAGE = 15 * 1024 * 1024;       // one qbank figure

function settings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ bridgePort: DEFAULT_PORT, bridgeToken: "" }, (c) =>
      resolve({ port: c.bridgePort || DEFAULT_PORT, token: c.bridgeToken || "" })
    );
  });
}

class BridgeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function classify(message) {
  if (/unknown op/i.test(message)) return "old-addon";
  if (/timed out/i.test(message)) return "timeout";
  return "anki";
}

async function bridge(op, args) {
  const { port, token } = await settings();
  // ping/auth are "is it there?" checks; the rest can legitimately take a while
  // on a big collection, but never longer than the add-on's own 20s budget.
  const quick = op === "ping" || op === "auth";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), quick ? 5000 : 30000);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mnestic-Token": token },
      body: JSON.stringify({ op, args: args || {} }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new BridgeError("Anki didn't answer in time", "timeout");
    throw new BridgeError("couldn't reach Anki", "offline");
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new BridgeError("the bridge sent an unreadable response", "anki");
  }
  if (res.status === 403 && /pairing code/i.test((data && data.error) || "")) {
    throw new BridgeError("the pairing code was not accepted", "auth");
  }
  if (!data || !data.ok) {
    const msg = (data && data.error) || "bridge error";
    throw new BridgeError(msg, res.status >= 400 ? "refused" : classify(msg));
  }
  return data.data;
}

// Is this message from us, and which side of us?
function senderContext(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  const own = chrome.runtime.getURL("");
  if (sender.url && sender.url.indexOf(own) === 0) return "page";
  if (sender.tab) return "content";
  return null;
}

function checkRequest(ctx, op, args) {
  const allowed = ctx === "page" ? PAGE_OPS : CONTENT_OPS;
  if (typeof op !== "string" || !allowed.has(op)) throw new BridgeError("not allowed: " + String(op), "refused");
  if (args != null && (typeof args !== "object" || Array.isArray(args))) throw new BridgeError("bad arguments", "refused");
  const size = JSON.stringify(args || {}).length;
  if (size > (op === "writeMedia" ? MAX_MEDIA_ARGS : MAX_ARGS)) throw new BridgeError("request too large", "refused");
}

// Fetch a cross-origin image (e.g. a qbank CDN image with no CORS header) from
// the worker and return it as a data: URL the content script can attach.
//
// Only a supported question bank's own https images are allowed: this worker is
// the privileged context, so it must never fetch an arbitrary URL handed to it.
//
// Adding a question bank? Add its registrable domain here AND to the manifest's
// host_permissions/matches — these two lists must stay in step, and this one is
// the security boundary.
//
// Deliberately NOT here: the third-party storage host MedPark serves its
// question figures from. It isn't MedPark's own domain and isn't something we
// or the user can vouch for, so "attach this question's image" is simply
// unavailable on MedPark rather than granting the worker a wildcard fetch there.
const QBANK_DOMAINS = ["coursology-qbank.com", "uworld.com", "medpark.io"];
const IMAGE_URL_OK = new RegExp(
  "^https://([a-z0-9-]+\\.)*(" + QBANK_DOMAINS.map((d) => d.replace(/\./g, "\\.")).join("|") + ")/",
  "i"
);

function toBase64(bytes) {
  // Chunked: building one character per byte into a single string is quadratic
  // in the worst case and slow on a multi-megabyte figure.
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function fetchImageDataUrl(url) {
  if (!IMAGE_URL_OK.test(String(url || ""))) throw new Error("blocked: not a question-bank image URL");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { credentials: "omit", signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const type0 = (res.headers.get("content-type") || "").toLowerCase();
    if (type0 && !type0.startsWith("image/")) throw new Error("blocked: not an image");
    const declared = parseInt(res.headers.get("content-length") || "0", 10);
    if (declared > MAX_IMAGE) throw new Error("that image is too large");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE) throw new Error("that image is too large");
    const type = (type0 || "image/png").split(";")[0];
    return "data:" + type + ";base64," + toBase64(bytes);
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const ctx = senderContext(sender);
  if (msg.type === "bridge") {
    Promise.resolve()
      .then(() => {
        if (!ctx) throw new BridgeError("unknown sender", "refused");
        checkRequest(ctx, msg.op, msg.args);
        return bridge(msg.op, msg.args);
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({
        ok: false,
        error: String((err && err.message) || err),
        code: (err && err.code) || "anki"
      }));
    return true; // async
  }
  if (msg.type === "fetchImage" && msg.url) {
    if (ctx !== "content") { sendResponse({ ok: false, error: "not allowed" }); return; }
    fetchImageDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async
  }
});
