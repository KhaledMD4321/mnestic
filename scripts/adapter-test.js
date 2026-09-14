// Site-adapter tests.
//
// Drives the REAL extension/content.js against fixture pages served under the
// real hostnames (Playwright route interception, so location.hostname decides
// the adapter), stubs the chrome.* APIs, then calls the extension's own
// mnx-diagnose listener and asserts on what the adapter found.
//
// Run:  npm install playwright-core   (once)
//       npx playwright install chromium   (or set MNX_CHROME to a Chrome path)
//       node scripts/adapter-test.js
//
// Adding a question bank? Add fixtures here — at minimum a reviewing question,
// an UNANSWERED one (the spoiler gate), and a results table. See
// docs/adding-a-qbank.md.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const EXE = process.env.MNX_CHROME || undefined;   // undefined -> playwright's own chromium
const CONTENT = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

const CHROME_STUB = `
  window.__mnxListeners = [];
  // Chromium already exposes a read-only window.chrome on a normal page, so
  // replacing it silently fails — overwrite its properties instead.
  if (!window.chrome) window.chrome = {};
  Object.assign(window.chrome, {
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb({ ok: false, error: "stub" }), 0); },
      onMessage: { addListener: (fn) => window.__mnxListeners.push(fn) },
      lastError: null
    },
    storage: {
      local: {
        get: (defs, cb) => cb(typeof defs === "object" ? defs : {}),
        set: (o, cb) => cb && cb()
      },
      onChanged: { addListener: () => {} }
    }
  });
`;

// ---- fixtures -------------------------------------------------------------
const page = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;

const LOREM = "Text of an explanation. ".repeat(40);

const FIXTURES = [
  {
    name: "Coursology — reviewing (regression)",
    url: "https://coursology-qbank.com/qbanks/usmle2/test/1",
    html: page(`
      <div class="question-header">Question Id: 4211</div>
      <div id="question-explanation" style="min-height:400px">
        <h3>Explanation</h3><p>${LOREM}</p>
      </div>`),
    expect: { adapter: "coursology", qid: "4211", reviewing: true, step: 2 }
  },
  {
    name: "Coursology — unanswered (no spoiler)",
    url: "https://coursology-qbank.com/qbanks/usmle1/test/1",
    html: page(`<div class="question-header">Question Id: 4211</div><div>A 34-year-old man…</div>`),
    expect: { adapter: "coursology", qid: "4211", reviewing: false, step: 1 }
  },
  // --- UWorld: markup shaped like the real Angular player ---
  {
    name: "UWorld — reviewing (real selectors)",
    url: "https://apps.uworld.com/courseapp/launchtest",
    html: page(`
      <div class="nbme-header d-flex justify-content-between accessibility-triggers">
        <span class="qb-name">USMLE STEP1</span>
        <span class="question-id ng-star-inserted">Question Id: 12345</span>
      </div>
      <common-content><div class="left-content">A 34-year-old man…</div>
        <div class="right-content question-content">
          <div class="stats-bar" role="alert">Correct</div>
          <div id="explanation-container" style="min-height:400px">
            <h2>Explanation</h2><p>${LOREM}</p>
          </div>
        </div></common-content>`),
    expect: { adapter: "uworld", qid: "12345", reviewing: true, step: 1 }
  },
  {
    name: "UWorld — unanswered (no spoiler)",
    url: "https://apps.uworld.com/courseapp/launchtest",
    html: page(`
      <div class="nbme-header"><span class="question-id">Question Id: 55</span></div>
      <common-content><div class="left-content">A 62-year-old woman…</div></common-content>`),
    expect: { adapter: "uworld", qid: "55", reviewing: false }
  },
  {
    name: "UWorld — id element with digits only",
    url: "https://apps.uworld.com/courseapp/launchtest",
    html: page(`
      <span class="question-id">987654</span>
      <div id="explanation-container" style="min-height:400px"><h2>Explanation</h2><p>${LOREM}</p></div>`),
    expect: { adapter: "uworld", qid: "987654", reviewing: true }
  },
  {
    name: "UWorld — redesigned: heuristic fallback still finds it",
    url: "https://apps.uworld.com/courseapp/launchtest",
    html: page(`
      <div class="css-1x2y3z"><span class="css-9a8b">QId: 424242</span></div>
      <div class="css-aa11"><div class="css-bb22" style="min-height:400px">
        <h3 class="css-cc33">Explanation</h3><p>${LOREM}</p>
      </div></div>`),
    expect: { adapter: "uworld", qid: "424242", reviewing: true }
  },
  {
    name: "UWorld — results table, 'Block 3 - 12345' id cells",
    url: "https://apps.uworld.com/courseapp/performance",
    html: page(`
      <table><thead><tr><th>#</th><th>ID</th><th>Result</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>Block 3 - 12345</td><td><i class="fa-xmark"></i></td></tr>
        <tr><td>2</td><td>Block 3 - 12346</td><td><i class="fa-check"></i></td></tr>
        <tr><td>3</td><td>Block 3 - 12347</td><td><i class="fa-xmark"></i></td></tr>
      </tbody></table>`),
    // the id is the LAST number in the cell, not the first
    expect: { adapter: "uworld", resultRows: 3, resultSample: ["12345", "12346", "12347"] }
  },
  // --- MedPark: markup copied from the live player (2026-09-14) ---
  {
    name: "MedPark — answered (explanation-area.visible)",
    url: "https://medpark.io/dashboard/test/221648?step=1&qBankId=19",
    html: page(`
      <div class="test-page">
        <header class="exam-header"><div class="toolbar-section"><div>
          <span>Item 10 of 10</span><span>UW Id: 1633</span></div></div></header>
        <div class="exam-container"><main class="exam-content split-mode">
          <section class="question-area has-explanation">A 56-year-old man…</section>
          <section class="explanation-area visible" style="min-height:400px">
            <div class="explanation-section"><div><div>
              <h4 class="explanation-title">Explanation</h4>
              <div class="explanation-content"><p>${LOREM}</p></div>
            </div></div></div>
          </section>
        </main></div>
      </div>`),
    expect: { adapter: "medpark", qid: "1633", reviewing: true, step: 1, resultRows: 0 }
  },
  {
    // THE SAFETY CASE: MedPark renders the pane before you answer — it just has
    // no .visible and zero height. The panel must stay shut.
    name: "MedPark — UNANSWERED: pane present but hidden (no spoiler)",
    url: "https://medpark.io/dashboard/test/221649?step=1&qBankId=19",
    html: page(`
      <div class="test-page">
        <header class="exam-header"><div class="toolbar-section"><div>
          <span>Item 1 of 1</span><span>UW Id: 19633</span></div></div></header>
        <div class="exam-container"><main class="exam-content">
          <section class="question-area">A 34-year-old woman…</section>
          <section class="explanation-area" style="height:0;overflow:hidden">
            <div class="explanation-section"><h4 class="explanation-title">Explanation</h4>
            <div class="explanation-content"><p>${LOREM}</p></div></div>
          </section>
        </main></div>
      </div>`),
    expect: { adapter: "medpark", qid: "19633", reviewing: false, step: 1 }
  },
  {
    // The Anki button must dock next to whatever the site calls the id.
    name: "MedPark — Anki button docks next to the 'UW Id' label",
    url: "https://medpark.io/dashboard/test/221648",
    html: page(`
      <div class="test-page"><header class="exam-header"><div class="toolbar-section"><div>
        <span>Item 10 of 10</span><span class="uwid">UW Id: 1633</span></div></div></header></div>`),
    expect: { adapter: "medpark", qid: "1633", qidAnchorAt: "header.exam-header > div.toolbar-section > div > span.uwid" }
  },
  {
    // A stats page using the words correct/incorrect/omitted/marked must NOT be
    // mistaken for a question-id list — that would invent ids out of the numbers.
    name: "MedPark — stats page is not a question list",
    url: "https://medpark.io/dashboard/welcome-classic?step=1&qBankId=19",
    html: page(`
      <div class="stats">
        <div>Total Correct <b>12</b></div><div>Total Incorrect <b>34</b></div>
        <div>Total Omitted <b>56</b></div><div>Marked <b>78</b></div>
        <div>Used Questions 10 Unused Questions 3644 Total Questions 3654</div>
      </div>`),
    expect: { adapter: "medpark", resultRows: 0, questionListRows: 0, reviewing: false }
  },
  {
    // Same page shape on Coursology SHOULD still parse — the opt-in is per site.
    name: "Coursology — question list still parses (opt-in intact)",
    url: "https://coursology-qbank.com/qbanks/usmle1/results",
    html: page(`
      <div><div>Correct</div><div>Incorrect</div><div>Marked</div><div>Omitted</div>
        <span class="text-lime-500">101</span><span class="text-red-500">102</span>
        <span class="text-sky-500">103</span></div>`),
    expect: { adapter: "coursology", questionListRows: 3 }
  }
];

(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let fail = 0;

  for (const f of FIXTURES) {
    const p = await ctx.newPage();
    await p.route("**/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: f.html })
    );
    await p.goto(f.url, { waitUntil: "domcontentloaded" });
    p.on("pageerror", e => console.log("      [pageerror] " + e.message));
    await p.addScriptTag({ content: CHROME_STUB });   // after navigation: the browser re-creates window.chrome
    await p.addScriptTag({ content: CONTENT });
    await p.waitForTimeout(150);

    const d = await p.evaluate(() => {
      let out = null;
      window.__mnxListeners.forEach((fn) => fn({ type: "mnx-diagnose" }, {}, (r) => (out = r)));
      return out;
    });

    const bad = [];
    if (!d) bad.push("no diagnose response");
    else
      for (const k of Object.keys(f.expect)) {
        const got = Array.isArray(d[k]) ? d[k].join(",") : String(d[k]);
        const want = Array.isArray(f.expect[k]) ? f.expect[k].join(",") : String(f.expect[k]);
        if (got !== want) bad.push(`${k}: got ${JSON.stringify(d[k])}, want ${JSON.stringify(f.expect[k])}`);
      }

    if (bad.length) { fail++; console.log(`FAIL  ${f.name}\n      ${bad.join("\n      ")}`); }
    else console.log(`ok    ${f.name}   (qid=${d.qid} expl=${d.explanationAt || "-"})`);
    await p.close();
  }

  await browser.close();
  console.log(fail ? `\nRESULT: ${fail} FAILING` : "\nRESULT: ALL PASS");
  process.exit(fail ? 1 : 0);
})();
