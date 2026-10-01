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

const EXT = process.env.MNX_EXT || path.join(__dirname, "..", "extension");   // MNX_EXT: test another build
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

    // 5c. the qbank can re-render the explanation and take the panel with it
    //     (Coursology does when its question rail is toggled). The id hasn't
    //     changed, so the panel must come back on its own -- built once, not
    //     once a tick while a slow Anki call is still in flight.
    const builds = () => mock.calls().filter((c) => c.op === "noteInfo").length;
    const beforeRe = builds();
    mock.state.slowNoteInfo = 2600;          // the rebuild spans two or three ticks
    await p.evaluate(() => document.getElementById("mnx-resources").remove());
    let back = false;
    try { await p.waitForSelector("#mnx-resources", { timeout: 8000 }); back = true; } catch (e) {}
    mock.state.slowNoteInfo = 0;
    await p.waitForTimeout(3000);
    check(site.id, "panel comes back after the page re-renders it away, built once",
      back && builds() - beforeRe === 1, "back=" + back + ", rebuilds=" + (builds() - beforeRe));

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
    await p.waitForTimeout(250);

    // Once answered, a key we act on is ours: the qbank must not also act on
    // it. Same class as the arrows, for the letter shortcuts.
    await p.evaluate(() => {
      window.__mnxPageLetters = 0;
      const bump = (e) => { if ("dfDF".indexOf(e.key) >= 0) window.__mnxPageLetters++; };
      document.addEventListener("keydown", bump);
      window.addEventListener("keydown", bump);
    });
    const beforeD = mock.calls().filter((c) => c.op === "openBrowser").length;
    await p.keyboard.press("d");                          // open in Anki
    await p.waitForTimeout(500);
    await p.keyboard.press("f");                          // First Aid overlay
    await p.waitForTimeout(700);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
    const letters = await p.evaluate(() => window.__mnxPageLetters);
    const openedD = mock.calls().filter((c) => c.op === "openBrowser").length > beforeD;
    check(site.id, "answered: D reaches Anki and the qbank never sees D or F",
      openedD && letters === 0, "opened=" + openedD + ", page saw " + letters + " letter key(s)");

    // The images used to be keyboard-only. The key badge on each row now opens
    // them too -- without also toggling the row it sits in.
    const badge = p.locator("#mnx-resources button.mnx-r-key", { hasText: "F" }).first();
    if (await badge.count()) {
      const rowWasOpen = await badge.evaluate((b) => b.closest("section.mnx-r").classList.contains("open"));
      await badge.click();
      let byClick = false;
      try { await p.waitForSelector("#mnx-overlay", { state: "visible", timeout: 5000 }); byClick = true; } catch (e) {}
      const rowNowOpen = await badge.evaluate((b) => b.closest("section.mnx-r").classList.contains("open"));
      check(site.id, "clicking a resource's key badge opens its images",
        byClick && rowWasOpen === rowNowOpen, "overlay=" + byClick + ", row toggled=" + (rowWasOpen !== rowNowOpen));
      await p.keyboard.press("Escape");
      await p.waitForTimeout(250);
    } else {
      check(site.id, "clicking a resource's key badge opens its images", false, "no F badge rendered");
    }

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
    await p2.goto("https://coursology-qbank.com/qbanks/usmle1/dashboard/performance/test/1883996777/results",
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

    // copy: the old behaviour, still available. Start from a clean collection:
    // the move tests above already saved this question.
    mock.reset();
    calls = await run("copy", (p) => openAndSave(p, "note C"));
    check("coursology", "copy mode still makes a copy",
      calls.some((c) => c.op === "copyNote") && !calls.some((c) => c.op === "setDeck"));

    // and copying twice still appends instead of duplicating
    calls = await run("copy", (p) => openAndSave(p, "note D"));
    check("coursology", "copying a second time appends instead of duplicating",
      !calls.some((c) => c.op === "copyNote") && calls.some((c) => c.op === "updateNote"));
    mock.reset();

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
    mock.reset();
    let p = await openModal("move");
    check("undo", "no Remove button on a question that was never saved",
      !(await undo(p).isVisible()));
    await p.close();

    // move mode, the whole round trip: save it for real (which is the only
    // moment the home deck is knowable), then take it back out again.
    mock.reset();
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
    mock.reset(); mock.state.cardElsewhere = true;
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
    mock.reset(); mock.addCopy(mock.NOTE.noteId, null);   // a copy saved before 1.4
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
    mock.reset(); mock.addCopy(mock.NOTE.noteId, null); mock.state.refuseDelete = true;
    p = await openModal("copy");
    await undo(p).click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    const toastText = (await p.locator(".mnx-toast").last().textContent().catch(() => "")) || "";
    await p.close();
    mock.state.refuseDelete = false;
    check("undo", "a note the add-on refuses to delete is reported, not hidden",
      /left alone/i.test(toastText), toastText.slice(0, 90));

    // an old add-on has neither op: say so instead of failing silently
    mock.reset(); mock.markMissed(mock.NOTE.noteId, null); mock.state.oldAddon = true;
    p = await openModal("move");
    await undo(p).click({ timeout: 6000 });
    await p.waitForTimeout(1200);
    const oldToast = (await p.locator(".mnx-toast").last().textContent().catch(() => "")) || "";
    await p.close();
    mock.state.oldAddon = false;
    check("undo", "an out-of-date add-on is named as the reason",
      /update the mnestic bridge/i.test(oldToast), oldToast.slice(0, 90));

    mock.reset();
    await setCfg({ mnxMissedMode: "move" });
  }
  console.log("");

  // ---- make a card from the explanation: selection -> chip -> Anki ----
  // "Create card" once threw a ReferenceError and did nothing at all, with no
  // message, so this drives the dialog all the way to the newNote call.
  console.log("make a card:");
  {
    async function openFromSelection() {
      const p = await ctx.newPage();
      await p.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: SITES[0].html }));
      await p.goto(SITES[0].url, { waitUntil: "domcontentloaded" });
      await p.waitForSelector("#mnx-resources", { timeout: 15000 });
      await p.evaluate(() => {
        const para = document.querySelector("#question-explanation p");
        const r = document.createRange();
        r.setStart(para.firstChild, 0); r.setEnd(para.firstChild, 22);        // "Explanation body text."
        getSelection().removeAllRanges(); getSelection().addRange(r);
        para.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await p.locator("#mnx-selchip").click({ timeout: 6000 });
      await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
      await p.waitForTimeout(500);                                          // the deck list
      return p;
    }
    const made = () => mock.calls().filter((c) => c.op === "newNote");

    let p = await openFromSelection();
    const prefill = await p.locator("#mnx-md-overlay textarea").first().inputValue();
    await p.evaluate(() => { const ta = document.querySelector("#mnx-md-overlay textarea"); ta.focus(); ta.setSelectionRange(12, 16); });
    await p.locator("#mnx-md-overlay button", { hasText: "Make cloze" }).click({ timeout: 6000 });
    const before = made().length;
    await p.locator("#mnx-md-overlay .mnx-md-ok").last().click({ timeout: 6000 });
    await p.waitForTimeout(900);
    const call = made().slice(-1)[0];
    const toastText = (await p.locator(".mnx-toast").last().textContent().catch(() => "")) || "";
    check("make card", "the selection pre-fills the card", prefill === "Explanation body text.", prefill);
    check("make card", "Create card reaches Anki as a cloze into the chosen deck",
      made().length === before + 1 && call.args.kind === "cloze" &&
      /\{\{c1::body\}\}/.test(call.args.text || "") && !!call.args.deck,
      call ? JSON.stringify({ kind: call.args.kind, deck: call.args.deck, text: call.args.text }) : "no newNote call");
    check("make card", "it says so, and the dialog closes",
      /created a cloze card/i.test(toastText) && !(await p.locator("#mnx-md-overlay").count()), toastText);
    await p.close();

    // a deck typed by hand goes where it was typed
    p = await openFromSelection();
    await p.locator("#mnx-md-overlay select").selectOption("➕ New deck…");
    await p.locator("#mnx-md-overlay input[type=text]").fill("Missed Qs::Made by hand");
    await p.locator("#mnx-md-overlay .mnx-seg button", { hasText: "Basic" }).click();
    await p.locator("#mnx-md-overlay .mnx-md-ok").last().click({ timeout: 6000 });
    await p.waitForTimeout(900);
    const call2 = made().slice(-1)[0];
    check("make card", "a new deck typed by hand is where the card goes",
      call2 && call2 !== call && call2.args.deck === "Missed Qs::Made by hand" && call2.args.kind === "basic",
      call2 ? JSON.stringify({ kind: call2.args.kind, deck: call2.args.deck }) : "no newNote call");
    await p.close();
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
      !!fd && /tag:Mnestic::Missed(?!::)/.test(fd.args.search || ""),   // the bare tag too: "No subdeck" saves
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
    const d0 = new Date();
    const today = d0.getFullYear() + "-" + String(d0.getMonth() + 1).padStart(2, "0") + "-" + String(d0.getDate()).padStart(2, "0");
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

  // ---- 1.4: one block per audit finding, each written to fail on 1.3 ----
  console.log("1.4 hardening:");
  {
    const COURSO_URL = SITES[0].url;                  // /qbanks/usmle1/test/1
    const RESULTS_URL = "https://coursology-qbank.com/qbanks/usmle1/dashboard/performance/test/1883996777/results";
    const reviewHtml = (qid, extra) => page(`
      <div class="question-header">Question Id: ${qid}</div>
      <div id="question-explanation" style="min-height:420px;padding:12px">
        <h3>Explanation</h3><p>${LOREM}</p>${extra || ""}</div>`);
    async function openAt(html, url) {
      const p = await ctx.newPage();
      await p.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
      await p.goto(url || COURSO_URL, { waitUntil: "domcontentloaded" });
      return p;
    }
    const opsSince = (n, names) => mock.calls().slice(n).filter((c) => names.indexOf(c.op) >= 0);
    const WRITES = ["unsuspend", "suspend", "copyNote", "updateNote", "newNote", "setDeck", "removeTags",
                    "deleteNotes", "writeMedia", "openBrowser", "createDeck", "filteredDeck"];
    const panelText = (p) => p.evaluate(() => (document.getElementById("mnx-resources") || {}).innerText || "");
    const overlayOpen = (p) => p.evaluate(() => { const o = document.getElementById("mnx-overlay"); return !!(o && o.style.display === "flex"); });

    // B-03: a slow answer for the previous question must not land on this one.
    {
      mock.reset();
      mock.state.slowNoteInfo = 3500;
      const p = await openAt(reviewHtml("4211"));
      await p.waitForTimeout(1800);                  // 4211's note lookup is in flight
      await p.evaluate(() => { document.querySelector(".question-header").textContent = "Question Id: 5555"; });
      await p.waitForTimeout(5000);                  // 5555 settles; then 4211's answer arrives
      mock.state.slowNoteInfo = 0;
      const st = await p.evaluate(() => {
        const el = document.getElementById("mnx-resources");
        return { qid: el && el.dataset.qid, text: (el && el.innerText) || "" };
      });
      check("1.4", "a late answer for the previous question never lands on this one (panel shows " + st.qid + ")",
        st.qid === "5555" && /question id 5555/.test(st.text) && !/First Aid|Sketchy/.test(st.text), st.text.slice(0, 90));
      await p.close();
    }

    // B-06: the results toolbar only on a results page.
    {
      const p = await openAt(reviewHtml("4211", "<ul><li>5-alpha reductase inhibitors lower DHT</li><li>2 weeks of therapy</li></ul>"));
      await p.waitForSelector("#mnx-resources", { timeout: 12000 });
      await p.waitForTimeout(2500);
      check("1.4", "no results toolbar on a question whose explanation has numbered bullets", !(await p.$("#mnx-float-toolbar")));
      await p.close();
      const prevTests = page(`<table><thead><tr><th>Test</th><th>Score</th><th>Date</th></tr></thead><tbody>
        <tr><td>25</td><td>55%</td><td>Sep 29</td></tr><tr><td>40</td><td>70%</td><td>Sep 28</td></tr></tbody></table>
        <ul><li>55% correct</li><li>48 used</li></ul>`);
      const p2 = await openAt(prevTests, "https://coursology-qbank.com/qbanks/usmle1/dashboard/previous-tests");
      await p2.waitForTimeout(4000);
      check("1.4", "no results toolbar on the Previous tests list (its scores are not question ids)", !(await p2.$("#mnx-float-toolbar")));
      await p2.close();
    }

    // B-07 / B-20 / B-08: keys by physical position, one press per press, and
    // never while typing -- even inside a web component.
    {
      mock.reset();
      const p = await openAt(reviewHtml("4211", `<note-box></note-box><script>
        customElements.define("note-box", class extends HTMLElement { constructor(){ super();
          this.attachShadow({mode:"open"}).innerHTML = '<textarea id="t"></textarea>'; } });
      </script>`));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.waitForTimeout(800);
      const cdp = await ctx.newCDPSession(p);
      const key = (type, k, extra) => cdp.send("Input.dispatchKeyEvent",
        Object.assign({ type, key: k, code: "KeyF", windowsVirtualKeyCode: 70 }, type === "keyDown" ? { text: k } : {}, extra || {}));
      await key("keyDown", "ب"); await key("keyUp", "ب");
      await p.waitForTimeout(900);
      check("1.4", "F works with an Arabic keyboard layout (the key types ب)", await overlayOpen(p));
      await p.keyboard.press("Escape"); await p.waitForTimeout(400);
      await key("keyDown", "f");
      for (let i = 0; i < 3; i++) await key("keyDown", "f", { autoRepeat: true });
      await key("keyUp", "f");
      await p.waitForTimeout(900);
      check("1.4", "holding F opens the overlay once instead of flickering it", await overlayOpen(p));
      await p.keyboard.press("Escape"); await p.waitForTimeout(400);
      await p.evaluate(() => document.querySelector("note-box").shadowRoot.getElementById("t").focus());
      await p.keyboard.type("f");
      await p.waitForTimeout(900);
      check("1.4", "typing f into a web component's text box stays typing", !(await overlayOpen(p)));
      await p.close();
    }

    // S-04: page script can't reach Anki through any Mnestic control.
    {
      mock.reset();
      await setCfg({ easy: true });
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.waitForTimeout(1500);
      let since = mock.calls().length;
      await p.evaluate(() => document.querySelectorAll("#mnx-resources button, #mnx-qid-open").forEach((b) => b.click()));
      await p.waitForTimeout(1200);
      check("1.4", "page script clicking every panel control reaches nothing",
        !(await p.$("#mnx-md-overlay")) && opsSince(since, WRITES).length === 0,
        JSON.stringify(opsSince(since, WRITES).map((c) => c.op)));
      await p.close();

      const rows = `<tr><td>1</td><td>4211</td><td>Renal</td><td><i class="fa-xmark"></i></td></tr>
                    <tr><td>2</td><td>1633</td><td>Renal</td><td><i class="fa-check"></i></td></tr>`;
      const res = page(`<table><thead><tr><th>#</th><th>ID</th><th>System</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`);
      const p2 = await openAt(res, RESULTS_URL);
      await p2.waitForSelector("#mnx-float-toolbar .mnx-btn", { timeout: 12000 });
      since = mock.calls().length;
      await p2.evaluate(() => document.querySelectorAll("#mnx-float-toolbar button").forEach((b) => b.click()));
      await p2.waitForTimeout(1500);
      check("1.4", "page script clicking the results toolbar reaches nothing",
        opsSince(since, WRITES.concat(["cardStats"])).length === 0 && !(await p2.$("#mnx-md-overlay")) && !(await p2.$("#mnx-confirm")));
      // a real click opens Easy mode's confirmation; the page pressing OK must not unlock anything
      await p2.locator("#mnx-float-toolbar .mnx-btn", { hasText: "Anki: Missed" }).click();
      let confirm = false;
      try { await p2.waitForSelector("#mnx-confirm .mnx-cf-ok", { timeout: 6000 }); confirm = true; } catch (e) {}
      since = mock.calls().length;
      await p2.evaluate(() => { const b = document.querySelector("#mnx-confirm .mnx-cf-ok"); if (b) b.click(); });
      await p2.waitForTimeout(1000);
      check("1.4", "page script can't press OK on the unlock confirmation",
        confirm && opsSince(since, ["unsuspend"]).length === 0 && !!(await p2.$("#mnx-confirm")));
      await p2.locator("#mnx-confirm .mnx-cf-cancel").click().catch(() => {});
      // weak areas: a real click opens it; the page clicking "Open N missed" does nothing
      await p2.locator("#mnx-float-toolbar .mnx-btn", { hasText: "Weak areas" }).click();
      await p2.waitForSelector("#mnx-md-overlay .mnx-brk-open", { timeout: 6000 }).catch(() => {});
      since = mock.calls().length;
      await p2.evaluate(() => document.querySelectorAll("#mnx-md-overlay .mnx-brk-open").forEach((b) => b.click()));
      await p2.waitForTimeout(1000);
      // Easy mode is on, so a click that got through would ask Anki for card
      // stats and raise the unlock confirmation rather than open the browser.
      check("1.4", "page script clicking “Open N missed” reaches nothing",
        opsSince(since, ["openBrowser", "cardStats", "unsuspend"]).length === 0 && !(await p2.$("#mnx-confirm")));
      const few = await p2.$("#mnx-md-overlay .mnx-brk-few");
      check("1.4", "a group with too few questions to judge is labelled so", !!few);
      await p2.close();
      await setCfg({ easy: false });
    }

    // S-07: a card's remote image is never fetched by Preview.
    {
      mock.reset();
      const p = await openAt(reviewHtml("4211"));
      const remote = [];
      p.on("request", (r) => { if (/tracker\.invalid/.test(r.url())) remote.push(r.url()); });
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.locator("#mnx-resources button", { hasText: "Preview" }).click();
      await p.waitForSelector("#mnx-md-overlay .mnx-md-prev", { timeout: 6000 });
      await p.waitForTimeout(800);
      const r = await p.evaluate(() => ({
        placeholder: !!document.querySelector("#mnx-md-overlay .mnx-remote-img"),
        remoteImg: Array.from(document.querySelectorAll("#mnx-md-overlay img")).some((i) => /tracker\.invalid/.test(i.src))
      }));
      check("1.4", "Preview doesn't load a card's remote image (and says so)",
        r.placeholder && !r.remoteImg && remote.length === 0, JSON.stringify(r) + " requests=" + remote.length);
      await p.close();
    }

    // B-10 / B-12: a save unsuspends only the chosen card and records its
    // question; undo reverses exactly that.
    {
      mock.reset();
      await setCfg({ mnxMissedMode: "move" });
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      const since = mock.calls().length;
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
      await p.locator("#mnx-md-overlay .mnx-md-ok").last().click();
      await p.waitForTimeout(1500);
      const n1 = mock.note(mock.NOTE.noteId), n2 = mock.note(mock.NOTE2.noteId);
      const un = opsSince(since, ["unsuspend"]);
      check("1.4", "saving unsuspends only the card you chose",
        un.length === 1 && un[0].args.queries[0] === "nid:" + mock.NOTE.noteId &&
        n1.cards.every((c) => !c.suspended) && n2.cards.every((c) => c.suspended),
        JSON.stringify(un.map((c) => c.args.queries)));
      check("1.4", "the save records which question it was missed on",
        n1.tags.indexOf("Mnestic::QID::4211") >= 0 && n1.deck !== "AnKing Step 1", n1.tags.filter((t) => /Mnestic/.test(t)).join(" "));
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      let undoShown = false;
      try { await p.waitForSelector("#mnx-md-overlay .mnx-md-undo", { state: "visible", timeout: 6000 }); undoShown = true; } catch (e) {}
      if (undoShown) await p.locator("#mnx-md-overlay .mnx-md-undo").click();
      await p.waitForTimeout(1500);
      check("1.4", "undo re-suspends exactly the cards the save unsuspended",
        undoShown && n1.cards.every((c) => c.suspended) && n2.cards.every((c) => c.suspended));
      check("1.4", "undo untags it and puts it back in its own deck",
        !n1.tags.some((t) => /^Mnestic::(Missed|QID)/.test(t)) && n1.deck === "AnKing Step 1",
        n1.deck + " | " + n1.tags.filter((t) => /Mnestic/.test(t)).join(" "));
      await p.close();
    }

    // B-11: a card saved from ANOTHER question is left alone by this one's undo.
    {
      mock.reset();
      mock.markMissed(mock.NOTE.noteId, "9999");     // saved earlier, from question 9999
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
      await p.waitForTimeout(1300);
      const info = await p.evaluate(() => ({
        undo: (() => { const u = document.querySelector("#mnx-md-overlay .mnx-md-undo"); return !!(u && u.style.display !== "none"); })(),
        text: (document.querySelector("#mnx-md-overlay .mnx-saved") || {}).innerText || ""
      }));
      check("1.4", "a card saved from another question isn't offered for undo here, and that's explained",
        !info.undo && /another question/.test(info.text), JSON.stringify(info).slice(0, 140));
      await p.locator("#mnx-md-overlay .mnx-md-cancel").click();
      // saved from BOTH questions: undo here drops only this question's link
      mock.markMissed(mock.NOTE.noteId, "4211");
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      await p.waitForSelector("#mnx-md-overlay .mnx-md-undo", { state: "visible", timeout: 6000 }).catch(() => {});
      await p.locator("#mnx-md-overlay .mnx-md-undo").click().catch(() => {});
      await p.waitForTimeout(1500);
      const n1 = mock.note(mock.NOTE.noteId);
      check("1.4", "undo on a card saved from two questions keeps it saved for the other one",
        n1.tags.indexOf("Mnestic::QID::9999") >= 0 && n1.tags.indexOf("Mnestic::QID::4211") < 0 &&
        n1.tags.indexOf("Mnestic::Missed") >= 0, n1.tags.filter((t) => /Mnestic/.test(t)).join(" "));
      await p.close();
    }

    // B-15 + error states: Anki closed says so and recovers on its own; a
    // refused pairing code says to pair.
    {
      mock.reset();
      await setCfg({ bridgePort: port + 37 });       // nothing listens there
      const p = await openAt(reviewHtml("4211"));
      try { await p.waitForFunction(() => /isn't running/.test((document.getElementById("mnx-resources") || {}).innerText || ""), null, { timeout: 15000 }); } catch (e) {}
      const msg = await panelText(p);
      check("1.4", "Anki not running says so, with a Retry", /isn't running/.test(msg) && /Retry/.test(msg), msg.slice(0, 120));
      await setCfg({ bridgePort: port });            // Anki is back
      let back = false;
      try { await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 15000 }); back = true; } catch (e) {}
      check("1.4", "the panel recovers by itself once Anki answers", back);
      await p.close();

      mock.state.rejectToken = true;
      const p2 = await openAt(reviewHtml("4211"));
      try { await p2.waitForFunction(() => /paired/.test((document.getElementById("mnx-resources") || {}).innerText || ""), null, { timeout: 12000 }); } catch (e) {}
      const msg2 = await panelText(p2);
      mock.state.rejectToken = false;
      check("1.4", "a refused pairing code says to pair, not that Anki is closed",
        /isn't paired/.test(msg2) && !/isn't running/.test(msg2), msg2.slice(0, 120));
      await p2.close();
    }

    // B-26 / B-13 / B-23: what the panel says when there's nothing to show.
    {
      mock.reset();
      const p = await openAt(reviewHtml("7777"));
      try { await p.waitForFunction(() => /resource tags/.test((document.getElementById("mnx-resources") || {}).innerText || ""), null, { timeout: 12000 }); } catch (e) {}
      const t = await panelText(p);
      check("1.4", "cards with no resource tags say exactly that (not 'no cards')",
        /1 card matches this question/.test(t) && !/No AnKing cards are tagged/.test(t) && /Save to Missed Qs/.test(t), t.slice(0, 120));
      await p.close();

      const p2 = await openAt(reviewHtml("5555"));
      try { await p2.waitForSelector("#mnx-resources .mnx-msg-btn", { timeout: 12000 }); } catch (e) {}
      const before = mock.calls().length;
      await p2.locator("#mnx-resources .mnx-msg-btn", { hasText: "Broader search" }).click().catch(() => {});
      await p2.waitForTimeout(2500);
      const loose = opsSince(before, ["searchNotes"]).some((c) => /::#UWorld::\*::5555/.test(c.args.query || ""));
      const t2 = await panelText(p2);
      check("1.4", "the wildcard search runs only when asked for, and says how it went",
        loose && /broader search found nothing/i.test(t2), t2.slice(0, 120));
      await p2.close();

      const b0 = mock.calls().length;
      const p3 = await openAt(reviewHtml("4211"), "https://coursology-qbank.com/qbanks/nbme-30/test/1");
      try { await p3.waitForFunction(() => /isn't UWorld's/.test((document.getElementById("mnx-resources") || {}).innerText || ""), null, { timeout: 12000 }); } catch (e) {}
      const t3 = await panelText(p3);
      check("1.4", "a non-UWorld bank is never searched, and the panel says why",
        /isn't UWorld's/.test(t3) && opsSince(b0, ["searchNotes"]).length === 0, t3.slice(0, 100));
      await p3.close();
    }

    // B-18: a made card is linked to its question; a duplicate asks first.
    {
      mock.reset();
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.locator("#mnx-resources button", { hasText: "Make card" }).click();
      await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 6000 });
      await p.fill("#mnx-md-overlay textarea >> nth=0", "The {{c1::cochlea}} transduces sound.");   // same as NOTE's text
      const since = mock.calls().length;
      await p.locator("#mnx-md-overlay .mnx-md-ok").last().click();
      await p.waitForTimeout(1200);
      const asked = await p.evaluate(() => {
        const d = document.querySelector("#mnx-md-overlay .mnx-dup");
        return { shown: !!(d && d.style.display !== "none"), btn: (document.querySelector("#mnx-md-overlay .mnx-md-ok") || {}).textContent };
      });
      check("1.4", "a card that already exists asks before adding a duplicate", asked.shown && /anyway/.test(asked.btn), JSON.stringify(asked));
      await p.locator("#mnx-md-overlay .mnx-md-ok").last().click();
      await p.waitForTimeout(1200);
      const made = opsSince(since, ["newNote"]);
      const last = made[made.length - 1];
      check("1.4", "…creates it when you say so, linked to its question",
        made.length === 2 && !!last && last.args.allowDuplicate === true &&
        (last.args.addTags || []).indexOf("Mnestic::QID::4211") >= 0 && !(await p.$("#mnx-md-overlay")),
        JSON.stringify(last && last.args.addTags));
      const uploads = opsSince(since, ["writeMedia"]).length;
      check("1.4", "…without uploading anything twice", uploads === 0);
      await p.close();
    }

    // Extra and Additional Resources: rows at the top, and E/A show the field itself.
    {
      mock.reset();
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-field", { timeout: 12000 });
      const order = await p.evaluate(() => Array.from(document.querySelectorAll("#mnx-resources .mnx-r .mnx-r-name")).map((n) => n.textContent));
      check("1.4", "Extra and Additional Resources lead the panel", order[0] === "Extra" && order[1] === "Additional Resources", order.join(", "));
      await p.keyboard.press("e");
      let shown = "";
      try {
        await p.waitForSelector("#mnx-overlay .mnx-ovl-field", { timeout: 6000 });
        shown = await p.evaluate(() => document.querySelector("#mnx-overlay .mnx-ovl-field").innerText);
      } catch (e) {}
      check("1.4", "E shows the Extra text itself, not only its images", /Extra note text/.test(shown), shown.slice(0, 80));
      await p.keyboard.press("Escape");
      await p.close();
    }

    // The whole card in Preview: every filled field, the heavy ones one click away.
    {
      mock.reset();
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.waitForTimeout(1500);                  // let the panel's own prefetch finish
      const faReads = () => mock.calls().filter((c) => c.op === "readMedia" && /fa-\d/.test(c.args.filename || "")).length;
      const baseline = faReads();
      await p.locator("#mnx-resources button", { hasText: "Preview" }).click();
      await p.waitForSelector("#mnx-md-overlay .mnx-field", { timeout: 6000 });
      await p.waitForTimeout(600);
      const st = await p.evaluate(() => Array.from(document.querySelectorAll("#mnx-md-overlay .mnx-field")).map((d) =>
        d.querySelector("summary b").textContent + (d.open ? "(open)" : "") + ":" + d.querySelector(".mnx-field-hint").textContent));
      const fa = st.find((x) => /^First Aid/.test(x)) || "";
      check("1.4", "Preview lists every filled field, First Aid collapsed with its image count",
        st.some((x) => /^Text\(open\)/.test(x)) && st.some((x) => /^Extra\(open\)/.test(x)) && /^First Aid:.*3 images/.test(fa) &&
        !st.some((x) => /ankihub_id/i.test(x)), st.join(" | "));
      const collapsed = faReads();
      await p.locator("#mnx-md-overlay .mnx-field summary", { hasText: "First Aid" }).click();
      await p.waitForTimeout(1000);
      const opened = faReads();
      const imgs = await p.evaluate(() => Array.from(document.querySelectorAll("#mnx-md-overlay .mnx-field[open] img")).filter((i) => /^data:/.test(i.src)).length);
      check("1.4", "a collapsed field's images load only when it is opened",
        collapsed === baseline && opened > collapsed && imgs >= 3,
        "reads: baseline " + baseline + ", preview open " + collapsed + ", section open " + opened + ", shown " + imgs);
      await p.keyboard.press("Escape");
      await p.close();
    }

    // Save: the full chosen card is one click away and follows the radio.
    {
      mock.reset();
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      await p.waitForSelector("#mnx-md-overlay .mnx-fullcard", { timeout: 6000 });
      const closedFirst = await p.evaluate(() => !document.querySelector("#mnx-md-overlay .mnx-fullcard").open &&
        !document.querySelector("#mnx-md-overlay .mnx-fullcard .mnx-field"));
      // each matched card readable at a glance: its Text with the answer in
      // bold, what Extra says, how many images -- with nothing fetched
      const glance = await p.evaluate(() => {
        const row = document.querySelector("#mnx-md-overlay .mnx-pick label .mnx-glance");
        return row && { ans: (row.querySelector(".mnx-glance-ans") || {}).textContent, text: row.innerText.replace(/\s+/g, " "),
                        imgsLoaded: document.querySelectorAll("#mnx-md-overlay .mnx-pick img").length };
      });
      check("1.4", "Save's card rows show the card at a glance (answer in bold, Extra, image count)",
        !!glance && glance.ans === "cochlea" && /The cochlea transduces sound/.test(glance.text) && /Extra Extra note text/i.test(glance.text) &&
        /6 images/.test(glance.text) && glance.imgsLoaded === 0, JSON.stringify(glance));
      await p.locator("#mnx-md-overlay .mnx-fullcard > summary").click();
      await p.waitForTimeout(500);
      const one = await p.evaluate(() => document.querySelector("#mnx-md-overlay .mnx-fullcard-body").innerText);
      const names = await p.evaluate(() => Array.from(document.querySelectorAll("#mnx-md-overlay .mnx-fullcard-body .mnx-field > summary b")).map((b) => b.textContent));
      check("1.4", "a field holding only spaces, <br>s, empty boxes or a src-less image is not shown",
        names.indexOf("Lecture_Notes") < 0 && names.indexOf("Missed Questions") < 0 && names.indexOf("Text") >= 0, names.join(", "));
      await p.locator("#mnx-md-overlay .mnx-pick input[type=radio]").nth(1).check();
      await p.waitForTimeout(500);
      const two = await p.evaluate(() => document.querySelector("#mnx-md-overlay .mnx-fullcard-body").innerText);
      check("1.4", "Save shows the full selected card on demand, and follows the card you pick",
        closedFirst && /cochlea/.test(one) && /second card/.test(two) && !/cochlea/.test(two), (one.slice(0, 40) + " | " + two.slice(0, 40)));
      await p.locator("#mnx-md-overlay .mnx-md-cancel").last().click();
      await p.close();
    }

    // A chapter deck is a chapter: nothing is appended to it, and picking another
    // chapter goes beside it. The remembered base is the root, per Step.
    {
      mock.reset();
      await setCfg({ mnxMissedMode: "move", akMissedDeck: "Missed Questions::03_Respiratory", akMissedDeckByStep: {} });
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      await p.waitForSelector("#mnx-md-overlay select option[value='Missed Questions']", { state: "attached", timeout: 8000 });
      await p.waitForTimeout(900);
      const dest = () => p.evaluate(() => (document.querySelector("#mnx-md-overlay .mnx-md-dest b") || {}).textContent);
      const first = await p.evaluate(() => document.querySelector("#mnx-md-overlay select").value);
      check("1.4", "a chapter deck remembered by 1.3 opens as its root", first === "Missed Questions", first);
      await p.locator("#mnx-md-overlay select").selectOption("Missed Questions::03_Respiratory");
      await p.waitForTimeout(400);
      const direct = await dest();
      const chip = await p.evaluate(() => (document.querySelector("#mnx-md-overlay .mnx-chapchip.on") || {}).innerText || "");
      check("1.4", "picking a chapter deck saves straight into it, nothing appended",
        direct === "Missed Questions::03_Respiratory" && /Just 03_Respiratory/.test(chip), direct + " | " + chip.replace(/\s+/g, " "));
      // A chapter is already a chapter: another organ system ("Cardio", from
      // the card's B&B tag) is a sibling, never offered as a subdeck inside it.
      const inside = await p.evaluate(() => Array.from(document.querySelectorAll("#mnx-md-overlay .mnx-chapchip"))
        .map((c) => (c.querySelector("span") || {}).textContent));
      check("1.4", "inside a chapter deck, other chapters are not suggested as subdecks",
        inside.indexOf("Cardio") < 0 && inside.length >= 1, inside.join(" | "));
      await p.locator("#mnx-md-overlay .mnx-chapchip", { hasText: "Just 03_Respiratory" }).first().click();
      await p.locator("#mnx-md-overlay .mnx-md-ok").last().click();
      await p.waitForTimeout(1500);
      const moved = mock.calls().filter((c) => c.op === "setDeck").slice(-1)[0];
      const tagged = mock.calls().filter((c) => c.op === "updateNote").slice(-1)[0];
      check("1.4", "…and still tags the chapter it went into",
        !!moved && moved.args.deck === "Missed Questions::03_Respiratory" &&
        !!tagged && (tagged.args.addTags || []).indexOf("Mnestic::Missed::Respiratory") >= 0,
        JSON.stringify(tagged && tagged.args.addTags));
      const ext = await ctx.newPage();
      await ext.goto(`chrome-extension://${extId}/popup.html`);
      const stored = await ext.evaluate(() => new Promise((r) => chrome.storage.local.get({ akMissedDeck: null, akMissedDeckByStep: {} }, r)));
      await ext.close();
      check("1.4", "the base deck is remembered as the root, per Step",
        stored.akMissedDeck === "Missed Questions" && stored.akMissedDeckByStep["1"] === "Missed Questions", JSON.stringify(stored));
      await p.close();
      await setCfg({ akMissedDeck: "", akMissedDeckByStep: {} });
    }

    // The question's Subject is offered as a subdeck inside a chapter deck, and
    // the chapter tag follows the deck path.
    {
      mock.reset();
      await setCfg({ mnxMissedMode: "move", akMissedDeck: "Missed Questions", akMissedDeckByStep: {},
        akTrackerV2: { v: 3, answered: { "usmle1 4211": { ts: null, slug: "usmle1", qid: "4211", sys: "Pulmonary & Critical Care", subj: "Pharmacology" } },
                       totals: {}, daily: {}, undated: {}, snaps: {}, targets: { weekly: 0, daily: 0 } } });
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      await p.waitForSelector("#mnx-md-overlay select option[value='Missed Questions::03_Respiratory']", { state: "attached", timeout: 8000 });
      await p.waitForTimeout(800);
      await p.locator("#mnx-md-overlay select").selectOption("Missed Questions::03_Respiratory");
      await p.waitForTimeout(400);
      const chips = await p.evaluate(() => Array.from(document.querySelectorAll("#mnx-md-overlay .mnx-chapchip")).map((c) => (c.classList.contains("on") ? "*" : "") + c.innerText.replace(/\s+/g, " ")));
      check("1.4", "inside a chapter deck the deck itself stays the default, and the question's Subject is offered as a subdeck",
        /^\*Just 03_Respiratory/.test(chips[chips.length - 1]) && /^Pharmacology this question's subject/.test(chips[0]), chips.join(" | "));
      await p.locator("#mnx-md-overlay .mnx-chapchip").first().click();
      await p.locator("#mnx-md-overlay .mnx-md-ok").last().click();
      await p.waitForTimeout(1500);
      const moved = mock.calls().filter((c) => c.op === "setDeck").slice(-1)[0];
      const tagged = mock.calls().filter((c) => c.op === "updateNote").slice(-1)[0];
      check("1.4", "…and saving there files it at chapter::subject, tagged the same way",
        !!moved && moved.args.deck === "Missed Questions::03_Respiratory::Pharmacology" &&
        !!tagged && (tagged.args.addTags || []).indexOf("Mnestic::Missed::Respiratory::Pharmacology") >= 0,
        (moved && moved.args.deck) + " | " + JSON.stringify(tagged && tagged.args.addTags));
      await p.close();
      await setCfg({ akMissedDeck: "", akMissedDeckByStep: {}, akTrackerV2: null });
    }

    // A figure the explanation keeps behind a button can be attached: Mnestic
    // presses the site's own button, takes the image, and closes the site's viewer.
    {
      mock.reset();
      const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P8z8Dwn4EIwDiqkL4KAV/hA/2kFkSzAAAAAElFTkSuQmCC";
      await ctx.route("https://cdn.coursology-qbank.com/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG, "base64") }));
      const html = reviewHtml("4211", `<p>Seen in <button id="exhibit-abc123" class="font-bold rounded-full">dead space</button>.</p>
        <script>
          document.getElementById("exhibit-abc123").addEventListener("click", () => {
            window.__pressed = (window.__pressed || 0) + 1;
            const w = document.createElement("div"); w.id = "site-viewer";
            w.style.cssText = "position:fixed;top:40px;left:40px;z-index:99999;background:#fff;padding:8px";
            w.innerHTML = '<div>Dead Space <button class="w-5 h-5 rounded-full bg-lime-500">+</button><button class="w-5 h-5 rounded-full bg-red-500">x</button></div>' +
                          '<img src="https://cdn.coursology-qbank.com/media/fig1.png" width="300" height="200">';
            w.querySelector(".bg-red-500").addEventListener("click", () => w.remove());
            setTimeout(() => document.body.appendChild(w), 150);
          });
        </script>`);
      const p = await openAt(html);
      await p.waitForSelector("#mnx-resources .mnx-r-head", { timeout: 12000 });
      await p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
      let chip = false;
      try { await p.waitForSelector("#mnx-md-overlay .mnx-figchip", { timeout: 6000 }); chip = true; } catch (e) {}
      if (chip) await p.locator("#mnx-md-overlay .mnx-figchip").first().click();
      await p.waitForTimeout(3000);
      const st = await p.evaluate(() => ({
        pressed: window.__pressed || 0,
        viewerClosed: !document.getElementById("site-viewer"),
        added: !!document.querySelector("#mnx-md-overlay .mnx-figchip.added"),
        thumbs: document.querySelectorAll("#mnx-md-overlay .mnx-img-thumb").length,
        toast: (Array.from(document.querySelectorAll(".mnx-toast")).pop() || {}).textContent || ""
      }));
      check("1.4", "a figure behind an explanation button is offered and attached, and the site's viewer is closed again",
        chip && st.pressed === 1 && st.viewerClosed && st.added && st.thumbs === 1, JSON.stringify(st));
      // page script can't use the chip to press the site's buttons
      const before = await p.evaluate(() => window.__pressed);
      await p.evaluate(() => { const b = document.querySelector("#mnx-md-overlay .mnx-figchip"); b.classList.remove("added"); delete b.dataset.added; b.click(); });
      await p.waitForTimeout(1000);
      check("1.4", "…and page script clicking the chip presses nothing", (await p.evaluate(() => window.__pressed)) === before);
      await p.close();
      await ctx.unroute("https://cdn.coursology-qbank.com/**");
    }

    // Upgrading from 1.3: its log keyed days by local-midnight milliseconds.
    // The popup must read that history as calendar days (and the content
    // script rewrites it once as v3), with nothing lost.
    {
      const midnight = (back) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - back); return String(d.getTime()); };
      const v2 = { answered: { "usmle1 1633": { ts: Date.now(), slug: "usmle1", qid: "1633" } },
                   totals: {}, daily: { usmle1: { [midnight(1)]: 10, [midnight(2)]: 5 } }, targets: { weekly: 0, daily: 0 } };
      await setCfg({ akTrackerV2: v2 });
      const pop = await ctx.newPage();
      await pop.goto(`chrome-extension://${extId}/popup.html`);
      await pop.waitForTimeout(1200);
      const st = await pop.evaluate(() => ({ today: document.getElementById("trkToday").textContent, week: document.getElementById("trkWeek").textContent,
        streak: document.getElementById("trkStreak").textContent }));
      await pop.close();
      check("1.4", "a 1.3 study log reads correctly after the upgrade (3-day streak, nothing lost)",
        /^1/.test(st.today) && /3-day/.test(st.streak), JSON.stringify(st));
      // a qbank tab loads the log and stores it once in the new format
      const p = await openAt(reviewHtml("4211"));
      await p.waitForSelector("#mnx-resources", { timeout: 12000 });
      await p.waitForTimeout(1500);
      await p.close();
      const log = await readTracker();
      const keys = Object.keys((log && log.daily && log.daily.usmle1) || {});
      check("1.4", "…and is rewritten once as v3 with calendar-day keys",
        log && log.v === 3 && keys.length === 2 && keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)), JSON.stringify(log && log.daily));
      await setCfg({ akTrackerV2: null });
    }

    // B-04: a counter jump across days is kept undated, not put on today.
    {
      const yesterday = Date.now() - 86400000;
      await setCfg({ akTrackerV2: { answered: {}, totals: { usmle1: { total: 3654, used: 1000, unused: 2654, ts: yesterday } },
                                    daily: {}, targets: {} } });
      const dash = page(`<div><h2>Welcome</h2><div>Used Questions 1040</div><div>Unused Questions 2614</div>
                         <div>Total Questions 3654</div></div>`);
      const p = await openAt(dash, "https://coursology-qbank.com/qbanks/usmle1/dashboard/welcome");
      await p.waitForTimeout(3000);
      await p.close();
      const log = await readTracker();
      const und = (log && log.undated && log.undated.usmle1) || [];
      check("1.4", "40 questions counted since yesterday are kept undated, not booked to today",
        und.length === 1 && und[0].n === 40 && !Object.keys((log.daily && log.daily.usmle1) || {}).length, JSON.stringify(und));
      const pop = await ctx.newPage();
      await pop.goto(`chrome-extension://${extId}/popup.html`);
      await pop.waitForTimeout(1200);
      const todayTxt = ((await pop.textContent("#trkToday")) || "").trim();
      const projTxt = (await pop.textContent("#trkProj")) || "";
      check("1.4", "the popup's Today stays at 0 and it says where the 40 went",
        /^0/.test(todayTxt) && /not tied to a day/.test(projTxt), todayTxt + " | " + projTxt.slice(0, 90));
      // the background worker refuses an op the popup has no business sending
      const refused = await pop.evaluate(() => new Promise((r) =>
        chrome.runtime.sendMessage({ type: "bridge", op: "deleteNotes", args: { notes: [1] } }, (resp) => r(resp))));
      check("1.4", "the worker refuses an op this part of Mnestic never sends",
        refused && !refused.ok && refused.code === "refused", JSON.stringify(refused));
      await pop.close();
      await setCfg({ akTrackerV2: null });
    }
  }
  console.log("");

  // The unanswered case, on every site: the panel must NOT appear.
  // The popup's "Keyboard shortcuts" toggle used to leave F/S/P/O/E/A live,
  // because the images had no other way in. With the key badge clickable, off
  // now means off -- and the images are still one click away.
  console.log("shortcuts toggle:");
  {
    await setCfg({ kbShortcuts: false });
    const p = await ctx.newPage();
    await p.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: SITES[0].html }));
    await p.goto(SITES[0].url, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#mnx-resources", { timeout: 15000 });
    await p.waitForTimeout(1200);
    const before = mock.calls().filter((c) => c.op === "openBrowser").length;
    await p.keyboard.press("f");
    await p.keyboard.press("d");
    await p.waitForTimeout(800);
    const overlayByKey = await p.evaluate(() => {
      const o = document.getElementById("mnx-overlay");
      return !!(o && o.style.display === "flex");
    });
    const anki = mock.calls().filter((c) => c.op === "openBrowser").length > before;
    check("toggle", "with shortcuts off, F and D do nothing", !overlayByKey && !anki,
      "overlay=" + overlayByKey + ", openBrowser=" + anki);
    const badge = p.locator("#mnx-resources button.mnx-r-key", { hasText: "F" }).first();
    let byClick = false;
    if (await badge.count()) {
      await badge.click();
      try { await p.waitForSelector("#mnx-overlay", { state: "visible", timeout: 5000 }); byClick = true; } catch (e) {}
    }
    check("toggle", "with shortcuts off, the key badge still opens the images", byClick);
    await p.close();
    await setCfg({ kbShortcuts: true });
  }
  console.log("");

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
    // The quick-open button beside the question id opens Anki on this
    // question's cards. Shown mid-test, it is one click from the answer.
    const quick = await p.$("#mnx-qid-open");
    check(id, "no Anki quick-open button before answering", !quick);

    // The panel is gated, but the KEYBOARD must be too. The header carries the
    // question id during a test, so a shortcut that only checks for an id can
    // fire mid-question -- and D opens Anki on this question's cards, which is
    // the answer. On a bank where letters pick a choice, choosing D does it by
    // accident. Nothing may reach Anki, and no dialog may open, until answered.
    const before = mock.calls().length;
    for (const key of ["d", "q", "v", "g", "f", "s"]) {
      await p.keyboard.press(key);
      await p.waitForTimeout(150);
    }
    await p.waitForTimeout(700);
    const reached = mock.calls().slice(before)
      .filter((c) => c.op !== "ping" && c.op !== "auth" && c.op !== "status")
      .map((c) => c.op);
    const dialog = await p.$("#mnx-md-overlay, #mnx-overlay[style*='flex']");
    check(id, "shortcuts do nothing before answering (no Anki call, no dialog)",
      !reached.length && !dialog,
      "reached Anki: " + JSON.stringify(reached) + (dialog ? " + a dialog opened" : ""));
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
