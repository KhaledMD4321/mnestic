// Mnestic — background service worker.
//
// Every call to the local Mnestic Bridge add-on happens here (not in the page), so
// the site's in-page request rules can't interfere. The content script and popup
// send a {type:"bridge", op, args} message; we forward it to 127.0.0.1:<port>
// with the pairing token and hand back {ok, data} / {ok:false, error}.

const DEFAULT_PORT = 8790;

function settings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ bridgePort: DEFAULT_PORT, bridgeToken: "" }, (c) =>
      resolve({ port: c.bridgePort || DEFAULT_PORT, token: c.bridgeToken || "" })
    );
  });
}

async function bridge(op, args) {
  const { port, token } = await settings();
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mnestic-Token": token },
    body: JSON.stringify({ op, token, args: args || {} }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("the bridge sent an unreadable response");
  }
  if (!data || !data.ok) throw new Error((data && data.error) || "bridge error");
  return data.data;
}

// Fetch a cross-origin image (e.g. a qbank CDN image with no CORS header) from
// the worker and return it as a data: URL the content script can attach.
async function fetchImageDataUrl(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const type = (res.headers.get("content-type") || "image/png").split(";")[0];
  return "data:" + type + ";base64," + btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "bridge") {
    bridge(msg.op, msg.args)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async
  }
  if (msg.type === "fetchImage" && msg.url) {
    fetchImageDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async
  }
});
