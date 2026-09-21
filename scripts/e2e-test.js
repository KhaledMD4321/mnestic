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
  async function setCfg(obj) {
    const c = await ctx.newPage();
    await c.goto(`chrome-extension://${extId}/popup.html`);
    await c.evaluate((o) => new Promise((r) => chrome.storage.local.set(o, r)), obj);
    await c.close();
  }
  async function readTracker() {
    const c = await ctx.newPage();
    await c.goto(`chrome-extension://${extId}/popup.html`);
    const out = await c.evaluate(() => new Promise((r) =>
      chrome.storage.local.get({ akTrackerV2: null }, (v) => r(v.akTrackerV2))));
    await c.close();
    return out;
  }
  await setCfg({ bridgePort: port });

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
      asked.some((q) => q.includes("::#UWorld::Step::" + site.qid)),
      "queries seen: " + JSON.stringify(asked.slice(-2)));

    // 3b. the query must name the UWorld namespace precisely. A bare "*"
    //     wildcard also matches COMLEX ids — a different exam — and misses the
    //     older bare Step 3 tag shape entirely.
    const q0 = asked.filter((q) => q.includes(site.qid)).slice(-1)[0] || "";
    check(site.id, "query targets ::Step:: and the bare form, not a wildcard",
      q0.includes("::#UWorld::Step::" + site.qid) &&
      q0.includes("::#UWorld::" + site.qid) &&
      !q0.includes("::*::"),
      q0.slice(0, 90));

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

    // The qbank listens for the same arrows to change QUESTION. preventDefault
    // only cancels the browser's own default action, so paging a five-page
    // topic used to press "next question" five times underneath, and you came
    // out of the overlay several questions along.
    await p.evaluate(() => {
      window.__mnxPageArrows = 0;
      const bump = () => { window.__mnxPageArrows++; };
      // the shapes a qbank actually uses: document bubble, and window capture
      document.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") bump();
      });
      window.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") bump();
      });
    });
    await p.keyboard.press("ArrowRight");
    await p.keyboard.press("ArrowLeft");
    await p.waitForTimeout(300);
    const leaked = await p.evaluate(() => window.__mnxPageArrows);
    check(site.id, "overlay arrows do not also reach the qbank", leaked === 0,
      "page saw " + leaked + " arrow key(s)");
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

    // 7c. chapters carried by more cards rank first and show their weight
    const sketchy = await p.evaluate(() => {
      const heads = [...document.querySelectorAll("#mnx-resources .mnx-r-head")];
      const h = heads.find((x) => /Sketchy/.test(x.textContent || ""));
      if (!h) return null;
      const sec = h.closest(".mnx-r");
      const leaves = [...sec.querySelectorAll(".mnx-leaf")].map((n) => n.textContent.trim());
      const weights = [...sec.querySelectorAll(".mnx-weight")].map((n) => n.textContent.trim());
      return { first: leaves[0] || null, leaves: leaves.length, weights };
    });
    check(site.id, "shared chapters rank first, with their weight (" +
      (sketchy && sketchy.first) + " " + JSON.stringify(sketchy && sketchy.weights) + ")",
      !!sketchy && sketchy.first === "Beta Blockers" && sketchy.weights[0] === "×2");

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
    // A row of site controls pinned top-right, like Coursology's own header.
    // Without something the bar has to dodge, placeFloatingToolbar never moves
    // it and the bounce this fixture exists to catch cannot happen.
    const html = page(`
      <div style="position:fixed;top:40px;right:20px;height:46px;display:flex;gap:10px;
                  align-items:center;z-index:50;background:#fff">
        <button style="width:34px;height:34px">A</button>
        <button style="width:34px;height:34px">B</button>
        <button style="width:34px;height:34px">C</button>
      </div>
      <!-- a control in NORMAL FLOW sitting in the bar's band: it scrolls away,
           so the bar must ignore it rather than chase it -->
      <div style="position:absolute;top:90px;right:24px">
        <button style="width:120px;height:40px">Scrolls away</button>
      </div>
      <div style="height:1600px"></div>
      <table><thead><tr><th>#</th><th>ID</th><th>System</th><th>Result</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>`);
    const p2 = await ctx.newPage();
    await p2.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await p2.goto("https://coursology-qbank.com/qbanks/usmle1/dashboard/previous-tests",
      { waitUntil: "domcontentloaded" });
    let ok = false;
    try { await p2.waitForSelector("#mnx-float-toolbar", { timeout: 12000 }); ok = true; } catch (e) {}
    check("coursology", "results toolbar appears on a results table", ok);

    // it must not sit on top of the site's own controls.
    // Placement waits for the bar's buttons, so it happens a tick after the bar
    // appears -- wait for it rather than racing the loop.
    try {
      await p2.waitForFunction(
        () => !!document.getElementById("mnx-float-toolbar")?.dataset.mnxPlaced,
        { timeout: 8000 });
    } catch (e) {}
    await p2.waitForTimeout(400);           // let `transition: top` finish
    const cover = await p2.evaluate(() => {
      const bar = document.getElementById("mnx-float-toolbar");
      if (!bar) return { clear: false, why: "no bar" };
      const r = bar.getBoundingClientRect();
      const hit = [...document.querySelectorAll("input,button,select")].find((el) => {
        if (el.closest("[id^='mnx-']")) return false;
        const b = el.getBoundingClientRect();
        return b.width > 8 && b.height > 8 &&
          b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
      });
      const box = (e) => { const b = e.getBoundingClientRect();
        return Math.round(b.top) + ".." + Math.round(b.bottom); };
      return { clear: !hit,
        why: "placed=" + bar.dataset.mnxPlaced + " settled=" + bar.dataset.mnxTop +
             " styleTop=" + bar.style.top + " | " +
             (hit ? ("bar " + box(bar) + " over " + (hit.textContent || "").trim() + " " + box(hit))
                  : "bar " + box(bar)) };
    });
    check("coursology", "toolbar does not cover the site's own controls", cover.clear, cover.why);

    // The bar is position:fixed but used to dodge ANY control it overlapped,
    // including ones in normal flow. Those scroll, so their viewport position
    // changed every tick, the target moved with them, and the bar's own
    // `transition: top` rendered the chase as a slow bounce. Scroll while
    // watching it: a scrolling control must not drag the bar around.
    const settled = await p2.evaluate(() => new Promise((resolve) => {
      const bar = document.getElementById("mnx-float-toolbar");
      if (!bar) return resolve({ ok: false, seen: [] });
      const seen = [];
      const t0 = Date.now();
      let y = 0;
      const id = setInterval(() => {
        window.scrollTo(0, (y += 40) % 400);            // keep the page moving
        seen.push(Math.round(bar.getBoundingClientRect().top));
        if (Date.now() - t0 > 4200) {
          clearInterval(id);
          // Allow the first placement to settle, then require stillness.
          const tail = seen.slice(-14);
          resolve({ ok: new Set(tail).size === 1, seen: [...new Set(seen)] });
        }
      }, 120);
    }));
    check("coursology", "the toolbar holds still while the page scrolls",
      settled.ok, "tops seen: " + JSON.stringify(settled.seen));

    // A results table that blinks empty for a tick must not destroy the bar:
    // rebuilding it loses the position it settled on, and it slides in from the
    // top again -- which is the bounce, once per blink.
    const survived = await p2.evaluate(() => new Promise((resolve) => {
      const tbody = document.querySelector("tbody");
      const rows = tbody ? [...tbody.children] : [];
      const before = document.getElementById("mnx-float-toolbar");
      const topBefore = before ? before.dataset.mnxTop : null;
      rows.forEach((r) => r.remove());                       // blink empty
      setTimeout(() => {
        rows.forEach((r) => tbody.appendChild(r));           // and back
        setTimeout(() => {
          const after = document.getElementById("mnx-float-toolbar");
          resolve({ stillThere: !!after,
                    keptPlacement: !!after && after.dataset.mnxTop === topBefore,
                    topBefore, topAfter: after ? after.dataset.mnxTop : null });
        }, 1600);
      }, 1200);
    }));
    check("coursology", "a table that blinks empty does not rebuild the toolbar",
      survived.stillThere && survived.keptPlacement,
      JSON.stringify(survived));

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

  // ---- accuracy: the step the deck actually uses, not the one we guessed ----
  console.log("step fallback:");
  {
    mock.state.onlyStep = 2;                 // this deck only tags Step 2
    await setCfg({ sv: 1 });                 // ...but the popup says Step 1
    const p3 = await ctx.newPage();
    await p3.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: SITES[0].html }));
    await p3.goto(SITES[0].url, { waitUntil: "domcontentloaded" });
    let found = false;
    try { await p3.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 15000 }); found = true; } catch (e) {}
    check("coursology", "finds cards even when the step setting is wrong", found);
    const q2 = mock.calls().filter((c) => c.op === "searchNotes").map((c) => c.args.query || "");
    check("coursology", "it retried the other steps",
      q2.some((q) => q.includes("#AK_Step1_")) && q2.some((q) => q.includes("#AK_Step2_")));
    // follow-up calls must use the step that actually matched, not the guess
    const mat = mock.calls().filter((c) => c.op === "cardMaturity").slice(-1)[0];
    const mq = mat ? (mat.args.queries || [""])[0] : "";
    check("coursology", "follow-up calls use the step that matched", mq.includes("#AK_Step2_"), mq.slice(0, 60));
    await p3.close();
    mock.state.onlyStep = null;
    await setCfg({ sv: 1 });
  }
  console.log("");

  // ---- how a missed question is kept: move / tag / copy ----
  console.log("save to Missed Qs:");
  {
    async function openAndSave(p, note) {
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click({ timeout: 6000 });
      await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
      await p.fill("#mnx-md-overlay textarea", note);
      const btn = p.locator("#mnx-md-overlay .mnx-md-ok").last();
      await btn.click({ timeout: 6000 });
      await p.waitForTimeout(900);
    }
    async function run(mode, fn) {
      await setCfg({ mnxMissedMode: mode });
      const p = await ctx.newPage();
      await p.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: SITES[0].html }));
      await p.goto(SITES[0].url, { waitUntil: "domcontentloaded" });
      await p.waitForSelector("#mnx-resources", { timeout: 15000 });
      const before = mock.calls().length;
      try { await fn(p); } catch (e) {}
      const since = mock.calls().slice(before);
      await p.close();
      return since;
    }

    // move: the original card moves, nothing is duplicated
    let calls = await run("move", (p) => openAndSave(p, "note A"));
    const moved = calls.find((c) => c.op === "setDeck");
    check("coursology", "move mode moves the original card (" + (moved && moved.args.deck) + ")",
      !!moved && !calls.some((c) => c.op === "copyNote"));
    check("coursology", "move mode reuses the existing numbered subdeck",
      !!moved && moved.args.deck === "Missed Questions::03_Respiratory",
      moved && moved.args.deck);
    const tagged = calls.find((c) => c.op === "updateNote");
    // Anki splits tags on whitespace, so every tag we write must be one token.
    const allTags = (tagged && tagged.args.addTags) || [];
    check("coursology", "every tag written is a single token (no fan-out)",
      allTags.length > 0 && allTags.every((t) => !/\s/.test(t)), JSON.stringify(allTags));
    check("coursology", "move mode tags the note by chapter",
      !!tagged && (tagged.args.addTags || []).some((t) => /^Mnestic::Missed::/.test(t)),
      JSON.stringify(tagged && tagged.args.addTags));

    // tag: nothing moves at all
    calls = await run("tag", (p) => openAndSave(p, "note B"));
    check("coursology", "tag mode moves nothing and copies nothing",
      !calls.some((c) => c.op === "setDeck") && !calls.some((c) => c.op === "copyNote") &&
      calls.some((c) => c.op === "updateNote"));

    // copy: the old behaviour, still available.
    // Both counters, not just copies: the move tests above marked this question
    // saved, and "already saved" is what makes copy mode append instead.
    mock.state.savedCopies = 0; mock.state.savedTagged = 0;
    calls = await run("copy", (p) => openAndSave(p, "note C"));
    check("coursology", "copy mode still makes a copy",
      calls.some((c) => c.op === "copyNote") && !calls.some((c) => c.op === "setDeck"));

    // and copying twice still appends instead of duplicating
    calls = await run("copy", (p) => openAndSave(p, "note D"));
    check("coursology", "copying a second time appends instead of duplicating",
      !calls.some((c) => c.op === "copyNote") && calls.some((c) => c.op === "updateNote"));
    mock.state.savedCopies = 0; mock.state.savedTagged = 0;

    // Saving before the deck list arrives must still reuse the existing
    // numbered subdeck, not create a parallel one.
    mock.state.slowDecks = 2500;
    calls = await run("move", async (p) => {
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click({ timeout: 6000 });
      await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
      await p.locator("#mnx-md-overlay .mnx-md-ok").last().click({ timeout: 6000 });   // immediately
      await p.waitForTimeout(4000);
    });
    mock.state.slowDecks = 0;
    const raced = calls.find((c) => c.op === "setDeck");
    check("coursology", "saving before decks load still reuses the existing subdeck",
      !!raced && raced.args.deck === "Missed Questions::03_Respiratory",
      raced && raced.args.deck);

    // The browser updates the extension by itself; the add-on doesn't. A new
    // extension against an old bridge must degrade, not lose the save.
    await setCfg({ mnxMissedMode: "move" });
    mock.state.oldAddon = true;
    calls = await run("move", (p) => openAndSave(p, "note E"));
    mock.state.oldAddon = false;
    check("coursology", "an out-of-date add-on still tags rather than failing the save",
      !!calls.find((c) => c.op === "setDeck") && !!calls.find((c) => c.op === "updateNote"));

    await setCfg({ mnxMissedMode: "move" });
  }
  console.log("");

  // ---- undoing a save: the only way out used to be Anki's Browse window ----
  console.log("taking a question back out of Missed Qs:");
  {
    async function openModal(mode) {
      await setCfg({ mnxMissedMode: mode || "move" });
      const p = await ctx.newPage();
      await p.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: SITES[0].html }));
      await p.goto(SITES[0].url, { waitUntil: "domcontentloaded" });
      await p.waitForSelector("#mnx-resources", { timeout: 15000 });
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click({ timeout: 6000 });
      await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
      await p.waitForTimeout(700);              // the "is it saved?" round trip
      return p;
    }
    const undo = (p) => p.locator("#mnx-md-overlay .mnx-md-undo");

    // nothing saved: there is nothing to undo, so nothing is offered
    mock.state.savedCopies = 0; mock.state.savedTagged = 0;
    let p = await openModal("move");
    check("undo", "no Remove button on a question that was never saved",
      !(await undo(p).isVisible()));
    await p.close();

    // move mode, the whole round trip: save it for real (which is the only
    // moment the home deck is knowable), then take it back out again.
    mock.state.savedTagged = 0; mock.state.lastRemoveTags = null;
    p = await openModal("move");
    await p.fill("#mnx-md-overlay textarea", "note for undo");
    await p.locator("#mnx-md-overlay .mnx-md-ok").last().click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    // reopen on the same question: it is saved now, so undo is on offer
    await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click({ timeout: 6000 });
    await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
    await p.waitForTimeout(900);
    const shown = await undo(p).isVisible();
    let before = mock.calls().length;
    await undo(p).click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    let since = mock.calls().slice(before);
    await p.close();
    check("undo", "the Remove button appears once the question IS saved", shown);
    const rt = since.find((c) => c.op === "removeTags");
    check("undo", "it removes the missed tag", !!rt && (rt.args.tags || []).indexOf("Mnestic::Missed") >= 0,
      JSON.stringify(rt && rt.args.tags));
    const backHome = since.filter((c) => c.op === "setDeck").slice(-1)[0];
    check("undo", "and moves the card back to the deck it came from",
      !!backHome && backHome.args.deck === "AnKing Step 1", backHome && backHome.args.deck);

    // the whole point of the field: someone's own notes must survive the undo
    check("undo", "it never strips the tag protecting your typed notes",
      !!rt && !(rt.args.tags || []).some((t) => /AnkiHub_Protect/i.test(t)) &&
      !since.some((c) => c.op === "updateNote"),
      JSON.stringify(rt && rt.args.tags));
    check("undo", "and never deletes a note it did not create",
      !since.some((c) => c.op === "deleteNotes"));

    // If someone has since filed the card somewhere of their own, undo unties
    // it from Missed Qs but leaves it where they put it.
    mock.state.savedTagged = 0; mock.state.cardElsewhere = true;
    p = await openModal("move");
    await p.fill("#mnx-md-overlay textarea", "note for undo 2");
    await p.locator("#mnx-md-overlay .mnx-md-ok").last().click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click({ timeout: 6000 });
    await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
    await p.waitForTimeout(900);
    before = mock.calls().length;
    await undo(p).click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    since = mock.calls().slice(before);
    await p.close();
    mock.state.cardElsewhere = false;
    check("undo", "a card you have since refiled yourself is left where you put it",
      since.some((c) => c.op === "removeTags") && !since.some((c) => c.op === "setDeck"),
      JSON.stringify(since.map((c) => c.op)));

    // copy mode: the copy is Mnestic's own, so undo removes it
    mock.state.savedTagged = 0; mock.state.savedCopies = 1; mock.state.lastDeleted = null;
    p = await openModal("copy");
    before = mock.calls().length;
    await undo(p).click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    since = mock.calls().slice(before);
    await p.close();
    const del = since.find((c) => c.op === "deleteNotes");
    check("undo", "copy mode deletes the copy it made", !!del && (del.args.notes || []).length > 0,
      JSON.stringify(del && del.args.notes));

    // a refusal from the add-on must reach the user, not be swallowed
    mock.state.savedCopies = 1; mock.state.refuseDelete = true;
    p = await openModal("copy");
    await undo(p).click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    const toastText = (await p.locator(".mnx-toast").last().textContent().catch(() => "")) || "";
    await p.close();
    mock.state.refuseDelete = false;
    check("undo", "a note the add-on refuses to delete is reported, not hidden",
      /left alone/i.test(toastText), toastText.slice(0, 90));

    // an old add-on has neither op: say so instead of failing silently
    mock.state.savedTagged = 1; mock.state.oldAddon = true;
    p = await openModal("move");
    await undo(p).click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    const oldToast = (await p.locator(".mnx-toast").last().textContent().catch(() => "")) || "";
    await p.close();
    mock.state.oldAddon = false;
    check("undo", "an out-of-date add-on is named as the reason",
      /update the mnestic bridge/i.test(oldToast), oldToast.slice(0, 90));

    mock.state.savedCopies = 0; mock.state.savedTagged = 0;
    await setCfg({ mnxMissedMode: "move" });
  }
  console.log("");

  // ---- the loop closes: retest what you missed, study what you missed ----
  console.log("missed questions in the popup:");
  {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.waitForTimeout(1500);
    const summary = (await p.textContent("#missedSummary")) || "";
    check("popup", "lists saved missed questions by chapter", /3 saved across 2 chapters/.test(summary), summary.slice(0, 70));
    const rows = await p.$$eval(".mlist .mrow .mname", (n) => n.map((x) => x.textContent));
    check("popup", "groups them (" + rows.join(", ") + ")",
      rows[0] === "All" && rows.indexOf("Respiratory") > 0);

    const before = mock.calls().filter((c) => c.op === "filteredDeck").length;
    await p.click("#missedStudy");
    await p.waitForTimeout(800);
    const fd = mock.calls().filter((c) => c.op === "filteredDeck").slice(-1)[0];
    check("popup", "Study them builds a filtered deck from the missed tag",
      mock.calls().filter((c) => c.op === "filteredDeck").length > before &&
      !!fd && /tag:Mnestic::Missed/.test(fd.args.search || ""),
      fd && fd.args.search);

    // A new user has missed nothing yet. Anki refuses to build a filtered deck
    // that gathers no cards and explains itself in backend prose about
    // suspended cards, which reads like a failure. It must not reach them.
    mock.state.emptyFiltered = true;
    await p.click("#missedStudy");
    await p.waitForTimeout(800);
    const hint = (await p.textContent("#missedStudyHint")) || "";
    check("popup", "nothing missed yet reads as a normal state, not an error",
      /nothing to study yet/i.test(hint) && !/couldn't build|suspended/i.test(hint),
      hint.slice(0, 80));
    mock.state.emptyFiltered = false;
    await p.close();
  }
  console.log("");

  // ---- the tracker counts blocks it never watched ----
  console.log("tracker:");
  {
    const dash = (used, unused) => page(`<div style="padding:20px">
      <h2>Welcome</h2>
      <div>Used Questions ${used}</div>
      <div>Unused Questions ${unused}</div>
      <div>Total Questions 3654</div></div>`);
    let usedNow = 100;
    const p = await ctx.newPage();
    await p.route("**/*", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: dash(usedNow, 3654 - usedNow) }));
    const url = "https://coursology-qbank.com/qbanks/usmle1/dashboard/welcome";
    await p.goto(url, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);                 // first snapshot, no delta yet

    usedNow = 115;                                // a 15-question block, never reviewed
    await p.goto(url, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);

    // storage lives in the extension's context, not the page's
    const log = await readTracker();
    const today = String(new Date(new Date().setHours(0, 0, 0, 0)).getTime());
    const got = log && log.daily && log.daily.usmle1 && log.daily.usmle1[today];
    check("tracker", "credits questions the qbank counted but we never saw (" + got + ")", got === 15);

    // a Reset QBank must not produce a negative day
    usedNow = 0;
    await p.goto(url, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);
    const after = await readTracker();
    const got2 = after.daily.usmle1[today];
    check("tracker", "a QBank reset re-baselines instead of going negative (" + got2 + ")", got2 === 15);
    await p.close();

    // and the popup shows it, labelled for what it is
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.waitForTimeout(1200);
    const todayTxt = (await pop.textContent("#trkToday")) || "";
    const projTxt = (await pop.textContent("#trkProj")) || "";
    check("tracker", "popup counts them today (" + todayTxt.trim() + ")", /15/.test(todayTxt));
    check("tracker", "popup says where the number came from",
      /from your qbank's own counter/.test(projTxt), projTxt.slice(0, 80));
    await pop.close();
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
