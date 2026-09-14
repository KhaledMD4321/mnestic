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
  {
    name: "UWorld — class hint, reviewing",
    url: "https://apps.uworld.com/test/step1/item/7",
    html: page(`
      <header><span>Item 7 of 40</span><span>Question Id: 12345</span></header>
      <div class="qbank-explanation-wrapper" style="min-height:400px">
        <h2>Explanation</h2><p>${LOREM}</p>
      </div>`),
    expect: { adapter: "uworld", qid: "12345", reviewing: true, step: 1 }
  },
  {
    name: "UWorld — obfuscated classes, heading only",
    url: "https://apps.uworld.com/app",
    html: page(`
      <div class="css-1x2y3z"><span class="css-9a8b">QId: 987654</span></div>
      <div class="css-aa11"><div class="css-bb22" style="min-height:400px">
        <h3 class="css-cc33">Explanation</h3><p>${LOREM}</p>
      </div></div>`),
    expect: { adapter: "uworld", qid: "987654", reviewing: true }
  },
  {
    name: "UWorld — unanswered (no spoiler)",
    url: "https://apps.uworld.com/test/item/8",
    html: page(`<header><span>Question Id: 55</span></header><div>A 62-year-old woman…</div>`),
    expect: { adapter: "uworld", qid: "55", reviewing: false }
  },
  {
    name: "UWorld — end-of-block table",
    url: "https://test.uworld.com/results",
    html: page(`
      <table><thead><tr><th>#</th><th>ID</th><th>Result</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>12345</td><td><i class="fa-xmark"></i></td></tr>
        <tr><td>2</td><td>12346</td><td><i class="fa-check"></i></td></tr>
        <tr><td>3</td><td>12347</td><td><i class="fa-xmark"></i></td></tr>
      </tbody></table>`),
    expect: { adapter: "uworld", resultRows: 3 }
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
        if (String(d[k]) !== String(f.expect[k])) bad.push(`${k}: got ${JSON.stringify(d[k])}, want ${JSON.stringify(f.expect[k])}`);
      }

    if (bad.length) { fail++; console.log(`FAIL  ${f.name}\n      ${bad.join("\n      ")}`); }
    else console.log(`ok    ${f.name}   (qid=${d.qid} expl=${d.explanationAt || "-"})`);
    await p.close();
  }

  await browser.close();
  console.log(fail ? `\nRESULT: ${fail} FAILING` : "\nRESULT: ALL PASS");
  process.exit(fail ? 1 : 0);
})();
