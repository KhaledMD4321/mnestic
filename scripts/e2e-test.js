// End-to-end tests: loads the REAL unpacked extension into Chromium and drives
// it against pages served under each qbank's real hostname, with a mock bridge
// standing in for Anki (scripts/mock-bridge.js).
//
// Unlike adapter-test.js — which calls the diagnose hook — this exercises the
// whole chain the user sees: manifest matching, content-script injection, the
// service worker, the resource panel, overlays, and the card composer.
//
// Run:  npm install playwright-core && npx playwright install chromium
//       node scripts/e2e-test.js            (set MNX_CHROME to use another Chrome)
//       node scripts/e2e-test.js --shots    (also write screenshots to dist/e2e)
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");
const mock = require("./mock-bridge");

const EXT = path.join(__dirname, "..", "extension");
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = path.join(__dirname, "..", "dist", "e2e");

const LOREM = "Explanation body text. ".repeat(40);
const page = (b) => `<!doctype html><meta charset="utf-8"><title>qbank</title><body>${b}</body>`;

// Answered/reviewing markup for each bank, matching the live DOM.
const SITES = [
  {
    id: "coursology",
    url: "https://coursology-qbank.com/qbanks/usmle1/test/1",
    qid: "4211",
    html: page(`
      <div class="question-header">Question Id: 4211</div>
      <div id="question-explanation" style="min-height:420px;padding:12px">
        <h3>Explanation</h3><p>${LOREM}</p></div>`)
  },
  {
    id: "uworld",
    url: "https://apps.uworld.com/courseapp/launchtest",
    qid: "12345",
    html: page(`
      <div class="nbme-header"><span class="qb-name">USMLE STEP1</span>
        <span class="question-id">Question Id: 12345</span></div>
      <common-content><div class="left-content">A 34-year-old man…</div>
        <div id="explanation-container" style="min-height:420px;padding:12px">
          <h2>Explanation</h2><p>${LOREM}</p></div></common-content>`)
  },
  {
    id: "medpark",
    url: "https://medpark.io/dashboard/test/221648?step=1&qBankId=19",
    qid: "1633",
    html: page(`
      <div class="test-page">
        <header class="exam-header"><div class="toolbar-section"><div>
          <span>Item 10 of 10</span><span>UW Id: 1633</span></div></div></header>
        <div class="exam-container"><main class="exam-content split-mode">
          <section class="question-area has-explanation">A 56-year-old man…</section>
          <section class="explanation-area visible" style="min-height:420px;padding:12px">
            <div class="explanation-section"><h4 class="explanation-title">Explanation</h4>
            <div class="explanation-content"><p>${LOREM}</p></div></div>
          </section></main></div></div>`)
  }
];

const results = [];
function check(site, name, pass, detail) {
  results.push({ site, name, pass, detail });
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${pass || !detail ? "" : "  — " + detail}`);
}

// 8790 is the real add-on's port. If Anki is running we must not fight it —
// bind anywhere free and tell the extension where we landed.
function listenFree(server, from) {
  return new Promise((resolve, reject) => {
    let port = from;
    const tryPort = () => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && port < from + 20) { port++; tryPort(); }
        else reject(e);
      });
      server.listen(port, "127.0.0.1", () => resolve(port));
    };
    tryPort();
  });
}

(async () => {
  const port = await listenFree(mock.server, mock.PORT);
  console.log("mock bridge on 127.0.0.1:" + port + (port === mock.PORT ? "" : "  (8790 busy - real Anki is running)"));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mnx-e2e-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.MNX_CHROME || undefined,
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

  // Point the extension at the mock, via its own storage.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const cfg = await ctx.newPage();
  await cfg.goto(`chrome-extension://${extId}/popup.html`);
  await cfg.evaluate((pp) => new Promise((r) => chrome.storage.local.set({ bridgePort: pp }, r)), port);
  await cfg.close();

  for (const site of SITES) {
    console.log(site.id + ":");
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e.message)));
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await p.route("**/*", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: site.html })
    );
    await p.goto(site.url, { waitUntil: "domcontentloaded" });

    // 1. the content script actually injected on this host
    let injected = false;
    try { await p.waitForSelector("#mnx-qid-open, #mnx-resources", { timeout: 12000 }); injected = true; } catch (e) {}
    check(site.id, "content script runs on this host", injected);
    if (!injected) { await p.close(); continue; }

    // 2. the resource panel built itself from the bridge's note
    let panel = false;
    try { await p.waitForSelector("#mnx-resources", { timeout: 12000 }); panel = true; } catch (e) {}
    check(site.id, "resource panel rendered", panel);

    // 3. it asked Anki for THIS question's tag
    const asked = mock.calls().filter((c) => c.op === "searchNotes").map((c) => c.args.query || "");
    check(site.id, "queried the right AnKing tag",
      asked.some((q) => q.endsWith("::" + site.qid)),
      "queries seen: " + JSON.stringify(asked.slice(-2)));

    // 4. the matched resources are listed
    const panelText = panel ? await p.textContent("#mnx-resources") : "";
    const named = ["First Aid", "Sketchy", "Physeo"].filter((n) => (panelText || "").includes(n));
    check(site.id, "resources listed in the panel (" + named.join(", ") + ")", named.length >= 2);

    // 5. the Anki button docked next to the site's own id label
    const dock = await p.evaluate(() => {
      const b = document.getElementById("mnx-qid-open");
      if (!b) return "missing";
      return b.classList.contains("mnx-qid-float") ? "floating" : (b.previousElementSibling || {}).tagName || "docked";
    });
    check(site.id, "Anki button docked to the id label, not floating", dock !== "floating" && dock !== "missing", "got " + dock);

    // 5b. images are warmed while you read, so the first keypress is instant
    await p.waitForTimeout(1500);
    const warmed = mock.calls().filter((c) => c.op === "readMedia").length;
    check(site.id, "images prefetched before any keypress (" + warmed + " fetched)", warmed > 0);

    // 6. pressing F opens the First Aid overlay
    await p.keyboard.press("f");
    let overlay = false;
    try { await p.waitForSelector("#mnx-overlay", { state: "visible", timeout: 6000 }); overlay = true; } catch (e) {}
    check(site.id, "F opens the resource overlay", overlay);
    const gotMedia = mock.calls().some((c) => c.op === "readMedia");
    check(site.id, "overlay pulled image bytes from the bridge", gotMedia);

    // 6b. a multi-page resource pages instead of stacking into one long scroll.
    //     Images arrive from the bridge after the overlay opens, so wait for
    //     the pager itself rather than assuming it is there.
    try { await p.waitForSelector("#mnx-overlay .mnx-ovl-count", { timeout: 10000 }); } catch (e) {}
    const pager = await p.evaluate(() => {
      const c = document.querySelector("#mnx-overlay .mnx-ovl-count");
      return {
        count: c ? c.textContent.trim() : null,
        thumbs: document.querySelectorAll("#mnx-overlay .mnx-ovl-thumb").length,
        shown: document.querySelectorAll("#mnx-overlay .mnx-ovl-stage img").length
      };
    });
    check(site.id, "multi-page overlay paginates (" + pager.count + ", " +
      pager.thumbs + " thumbs, " + pager.shown + " shown)",
      pager.count === "1 / 3" && pager.thumbs === 3 && pager.shown === 1);
    await p.keyboard.press("ArrowRight");
    await p.waitForTimeout(250);
    const after = await p.evaluate(() => {
      const c = document.querySelector("#mnx-overlay .mnx-ovl-count");
      return c ? c.textContent.trim() : null;
    });
    check(site.id, "right arrow turns the page", after === "2 / 3", "got " + after);
    await p.keyboard.press("Escape");

    // 7. no javascript: link survived the deck sanitiser. Rows render their
    //    body lazily, so open every one first or this asserts nothing.
    for (const h of await p.$$("#mnx-resources .mnx-r-head")) {
      if ((await h.getAttribute("aria-expanded")) !== "true") await h.click();
    }
    const links = await p.evaluate(() =>
      [...document.querySelectorAll("#mnx-resources a")].map((a) => a.getAttribute("href") || "")
    );
    check(site.id, "every row expands (" + links.length + " links shown)", links.length > 0);
    check(site.id, "javascript: link from the deck was dropped",
      !links.some((h) => /^javascript:/i.test(h)) && links.some((h) => /^https:/i.test(h)),
      JSON.stringify(links.slice(0, 3)));

    // 7b. the card-readiness strip, and one-click unsuspend
    let strip = null;
    try {
      await p.waitForSelector("#mnx-resources .mnx-cards-txt b", { timeout: 8000 });
      strip = await p.textContent("#mnx-resources .mnx-cards-txt");
    } catch (e) {}
    check(site.id, "card status strip shows (" + (strip || "").trim() + ")",
      !!strip && /9 cards/.test(strip) && /3 mature/.test(strip) && /2 suspended/.test(strip));
    const segs = await p.$$eval("#mnx-resources .mnx-cards-bar i", (n) => n.length);
    check(site.id, "readiness bar is segmented (" + segs + " segments)", segs === 5);
    const before = mock.calls().filter((c) => c.op === "unsuspend").length;
    try { await p.locator("#mnx-resources .mnx-unsus").click({ timeout: 4000 }); } catch (e) {}
    await p.waitForTimeout(600);
    check(site.id, "Unsuspend reaches the bridge",
      mock.calls().filter((c) => c.op === "unsuspend").length > before);

    // 8. a SYNTHETIC click must be ignored — the page's own scripts share this
    //    DOM, so every control that can reach Anki requires a trusted event.
    await p.evaluate(() => {
      const b = [...document.querySelectorAll("#mnx-resources button")].find((x) => /make card/i.test(x.textContent || ""));
      if (b) b.click();                       // untrusted: isTrusted === false
    });
    await p.waitForTimeout(400);
    check(site.id, "synthetic click cannot open the composer (trusted-event gate)",
      !(await p.$("#mnx-md-overlay")));

    // 9. ...but a real user click does
    let composer = false;
    try {
      await p.locator("#mnx-resources button", { hasText: "Make card" }).first().click({ timeout: 5000 });
      await p.waitForSelector("#mnx-md-overlay", { timeout: 5000 });
      composer = true;
    } catch (e) {}
    check(site.id, "real click opens the card composer", composer);
    if (composer) await p.keyboard.press("Escape");

    if (SHOTS) {
      await p.screenshot({ path: path.join(SHOT_DIR, site.id + ".png"), fullPage: false });
    }
    check(site.id, "no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await p.close();
    console.log("");
  }

  // Weak areas -> "Drill weakest 3" sends the worst groups to Anki in one go.
  console.log("weak areas:");
  {
    const rowsHtml = [
      ["1", "101", "Cardiovascular", "fa-xmark"], ["2", "102", "Cardiovascular", "fa-xmark"],
      ["3", "103", "Renal", "fa-xmark"], ["4", "104", "Renal", "fa-check"],
      ["5", "105", "Pulmonary", "fa-xmark"], ["6", "106", "Pulmonary", "fa-check"],
      ["7", "107", "Neurology", "fa-check"], ["8", "108", "Neurology", "fa-check"]
    ].map(([n, id, sys, icon]) =>
      `<tr><td>${n}</td><td>${id}</td><td>${sys}</td><td><i class="${icon}"></i></td></tr>`).join("");
    const html = page(`<table><thead><tr><th>#</th><th>ID</th><th>System</th><th>Result</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>`);
    const p2 = await ctx.newPage();
    await p2.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await p2.goto("https://coursology-qbank.com/qbanks/usmle1/dashboard/previous-tests",
      { waitUntil: "domcontentloaded" });
    let ok = false;
    try { await p2.waitForSelector("#mnx-float-toolbar", { timeout: 12000 }); ok = true; } catch (e) {}
    check("coursology", "results toolbar appears on a results table", ok);

    // it must not sit on top of the site's own controls
    const clear = await p2.evaluate(() => {
      const bar = document.getElementById("mnx-float-toolbar");
      if (!bar) return false;
      const r = bar.getBoundingClientRect();
      return ![...document.querySelectorAll("input,button,select")].some((el) => {
        if (el.closest("[id^='mnx-']")) return false;
        const b = el.getBoundingClientRect();
        return b.width > 8 && b.height > 8 &&
          b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      });
    });
    check("coursology", "toolbar does not cover the site's own controls", clear);

    if (ok) {
      const before = mock.calls().filter((c) => c.op === "openBrowser").length;
      try {
        await p2.locator("#mnx-float-toolbar button", { hasText: "Weak areas" }).click({ timeout: 5000 });
        await p2.waitForSelector("#mnx-md-overlay", { timeout: 5000 });
        await p2.locator("#mnx-md-overlay button", { hasText: "Drill weakest" }).click({ timeout: 5000 });
        await p2.waitForTimeout(800);
      } catch (e) {}
      const call = mock.calls().filter((c) => c.op === "openBrowser").slice(-1)[0];
      const q = call ? call.args.query || "" : "";
      // the three weakest systems are Cardiovascular (0%), Renal and Pulmonary (50%)
      const wanted = ["101", "102", "103", "105"];
      check("coursology", "Drill weakest 3 opens the worst groups' missed questions",
        mock.calls().filter((c) => c.op === "openBrowser").length > before &&
        wanted.every((id) => q.includes("::" + id)) && !q.includes("::107"),
        q.slice(0, 120));
    }
    await p2.close();
  }
  console.log("");

  // The unanswered case, on every site: the panel must NOT appear.
  console.log("spoiler gate (unanswered):");
  const UNANSWERED = [
    ["coursology", "https://coursology-qbank.com/qbanks/usmle1/test/1",
      page(`<div class="question-header">Question Id: 4211</div><div>stem only</div>`)],
    ["uworld", "https://apps.uworld.com/courseapp/launchtest",
      page(`<div class="nbme-header"><span class="question-id">Question Id: 55</span></div><div>stem only</div>`)],
    ["medpark", "https://medpark.io/dashboard/test/221649",
      page(`<div class="test-page"><header class="exam-header"><span>UW Id: 19633</span></header>
        <main class="exam-content"><section class="question-area">stem only</section>
        <section class="explanation-area" style="height:0;overflow:hidden">
          <div class="explanation-content">THE ANSWER</div></section></main></div>`)]
  ];
  for (const [id, url, html] of UNANSWERED) {
    const p = await ctx.newPage();
    await p.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await p.goto(url, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);
    const shown = await p.$("#mnx-resources");
    check(id, "no resource panel before answering", !shown);
    await p.close();
  }

  await ctx.close();
  mock.server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + (failed.length
    ? `RESULT: ${failed.length} FAILING of ${results.length}`
    : `RESULT: ALL ${results.length} PASS`));
  process.exit(failed.length ? 1 : 0);
})();
