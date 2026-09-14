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

(async () => {
  await new Promise((r) => mock.server.listen(mock.PORT, "127.0.0.1", r));
  console.log("mock bridge listening on 127.0.0.1:" + mock.PORT + "\n");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mnx-e2e-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.MNX_CHROME || undefined,
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

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

    // 6. pressing F opens the First Aid overlay
    await p.keyboard.press("f");
    let overlay = false;
    try { await p.waitForSelector("#mnx-overlay", { state: "visible", timeout: 6000 }); overlay = true; } catch (e) {}
    check(site.id, "F opens the resource overlay", overlay);
    const gotMedia = mock.calls().some((c) => c.op === "readMedia");
    check(site.id, "overlay pulled image bytes from the bridge", gotMedia);
    await p.keyboard.press("Escape");

    // 7. no javascript: link survived the deck sanitiser
    const badHref = await p.evaluate(() =>
      [...document.querySelectorAll("#mnx-resources a")].some((a) => /^javascript:/i.test(a.getAttribute("href") || ""))
    );
    check(site.id, "javascript: link from the deck was dropped", !badHref);

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
