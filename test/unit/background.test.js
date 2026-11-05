"use strict";
// The worker's rules, run against the real background.js with chrome and fetch stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "background.js"), "utf8");

function worker(fetchImpl) {
  let listener;
  const calls = [];
  const chrome = {
    runtime: { id: "mnx", getURL: (p) => "chrome-extension://mnx/" + p, onMessage: { addListener: (f) => { listener = f; } } },
    storage: { local: { get: (d, cb) => cb({ bridgePort: 8790, bridgeToken: "test-code" }) } }
  };
  const fetch = (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); };
  vm.runInNewContext(SRC, { chrome, fetch, AbortController, setTimeout, clearTimeout, btoa, Uint8Array, String, JSON, Promise, RegExp, Set, Error, parseInt });
  const send = (msg, sender) => new Promise((resolve) => listener(msg, sender, resolve));
  return { send, calls };
}
const CONTENT = { id: "mnx", tab: { id: 1 }, url: "https://apps.uworld.com/courseapp/" };
const image = (url, type) => async () => ({
  ok: true, status: 200, url,
  headers: { get: (h) => (h === "content-type" ? type : null) },
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
});
const SRC_IMG = "https://cdn.uworld.com/figure.png";

test("an image from a question bank comes back as data", async () => {
  const r = await worker(image(SRC_IMG, "image/png")).send({ type: "fetchImage", url: SRC_IMG }, CONTENT);
  assert.equal(r.ok, true);
  assert.match(r.dataUrl, /^data:image\/png;base64,/);
});

test("a redirect off the question bank is refused", async () => {
  const r = await worker(image("https://evil.example/x.png", "image/png")).send({ type: "fetchImage", url: SRC_IMG }, CONTENT);
  assert.equal(r.ok, false);
  assert.match(r.error, /not a question-bank image/);
});

test("a response with no image type, or SVG, is refused", async () => {
  for (const type of ["", "text/html", "image/svg+xml"]) {
    const r = await worker(image(SRC_IMG, type)).send({ type: "fetchImage", url: SRC_IMG }, CONTENT);
    assert.equal(r.ok, false, type);
    assert.match(r.error, /not an image/);
  }
});

test("a URL outside the question banks is never fetched", async () => {
  const w = worker(image("https://evil.example/x.png", "image/png"));
  const r = await w.send({ type: "fetchImage", url: "https://evil.example/x.png" }, CONTENT);
  assert.equal(r.ok, false);
  assert.equal(w.calls.length, 0);
});

const bridgeOk = async () => ({ status: 200, json: async () => ({ ok: true, data: true }) });

test("ping doesn't carry the pairing code; other requests do", async () => {
  const w = worker(bridgeOk);
  const popup = { id: "mnx", url: "chrome-extension://mnx/popup.html" };
  await w.send({ type: "bridge", op: "ping" }, popup);
  await w.send({ type: "bridge", op: "auth" }, popup);
  assert.equal("X-Mnestic-Token" in w.calls[0].opts.headers, false);
  assert.equal(w.calls[1].opts.headers["X-Mnestic-Token"], "test-code");
});

test("a page's content script can't reach popup-only requests", async () => {
  const w = worker(bridgeOk);
  const r = await w.send({ type: "bridge", op: "filteredDeck" }, CONTENT);
  assert.equal(r.ok, false);
  assert.equal(r.code, "refused");
  assert.equal(w.calls.length, 0);
});
