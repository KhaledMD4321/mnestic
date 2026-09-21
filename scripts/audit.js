// Exploratory pass over the whole extension, for eyes rather than assertions.
//
// e2e-test.js proves the things we already know to check. This drives the same
// real extension through every user-visible surface on all three banks, in both
// themes, and writes screenshots to dist/audit/ plus a report of anything that
// looks wrong on its own terms: console errors, page errors, clipped or
// overflowing UI, controls that do nothing, text that ran out of its box.
//
//   node scripts/audit.js            everything
//   node scripts/audit.js --dark     dark theme only
//
// Findings are printed at the end. Screenshots are for looking at afterwards.

const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");
const mock = require("./mock-bridge");
const fx = require("./demo-fixtures");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "dist", "audit");
const VIEW = { width: 1440, height: 900 };

// The real Anki may be on 8790; step past anything already bound.
function listenFree(server, from) {
  return new Promise((resolve, reject) => {
    let port = from;
    const tryPort = () => {
      server.removeAllListeners("error");
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && port < from + 20) { port++; tryPort(); }
        else reject(e);
      });
      server.listen(port, "127.0.0.1", () => resolve(port));
    };
    tryPort();
  });
}

const findings = [];
const note = (where, what, detail) => {
  findings.push({ where, what, detail: detail === undefined ? "" : String(detail) });
  console.log("  ! " + where + " — " + what + (detail ? "  [" + detail + "]" : ""));
};
const ok = (m) => console.log("    " + m);

// Fixtures that match each bank's real DOM closely enough for the adapters.
const LOREM = "Explanation body text that runs long enough to fill the column. ".repeat(14);
const shell = (b) => `<!doctype html><meta charset="utf-8"><title>qbank</title>
  <style>body{margin:0;font:15px/1.6 system-ui,sans-serif;background:#eef1f7;color:#1f2430}
  .pane{background:#fff;margin:14px;padding:16px;border-radius:10px}</style><body>${b}</body>`;

const BANKS = [
  {
    id: "coursology",
    review: "https://coursology-qbank.com/qbanks/usmle1/test/3/q/1",
    results: "https://coursology-qbank.com/qbanks/usmle1/test/3/results",
    qid: "4211",
    reviewHtml: shell(`<div class="question-header">Question Id: 4211</div>
      <div class="pane">A 62-year-old man with worsening dyspnoea…</div>
      <div class="pane" id="question-explanation" style="min-height:460px">
        <h3>Explanation</h3><p>${LOREM}</p></div>`)
  },
  {
    id: "uworld",
    review: "https://apps.uworld.com/courseapp/launchtest",
    results: "https://apps.uworld.com/courseapp/performance/review",
    qid: "12345",
    reviewHtml: shell(`<div class="nbme-header"><span class="qb-name">USMLE STEP1</span>
      <span class="question-id">Question Id: 12345</span></div>
      <common-content><div class="left-content pane">A 34-year-old man…</div>
      <div class="pane" id="explanation-container" style="min-height:460px">
        <h2>Explanation</h2><p>${LOREM}</p></div></common-content>`)
  },
  {
    id: "medpark",
    review: "https://medpark.io/dashboard/test/221648?step=1&qBankId=19",
    results: "https://medpark.io/dashboard/test/221648/results?qBankId=19",
    qid: "1633",
    reviewHtml: shell(`<div class="test-page">
      <header class="exam-header"><div class="toolbar-section"><div>
        <span>Item 10 of 10</span><span>UW Id: 1633</span></div></div></header>
      <div class="exam-container"><main class="exam-content split-mode">
        <section class="question-area has-explanation pane">A 56-year-old man…</section>
        <section class="explanation-area visible pane" style="min-height:460px">
          <div class="explanation-section"><h4 class="explanation-title">Explanation</h4>
          <div class="explanation-content"><p>${LOREM}</p></div></div>
        </section></main></div></div>`)
  }
];

// Anything drawn outside its own container, or spilling past the viewport, is a
// visual bug whether or not a test asserts on it.
async function checkLayout(page, where) {
  const bad = await page.evaluate(() => {
    const out = [];
    const vw = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll("[id^='mnx-'], [id^='mnx-'] *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 2 || r.left < -2) {
        out.push({ what: "outside the viewport",
          el: el.id || el.className || el.tagName,
          detail: Math.round(r.left) + ".." + Math.round(r.right) + " vs " + vw });
      }
      // text clipped by its own box (not a deliberate scroller)
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const st = getComputedStyle(el);
        if (st.overflowX === "visible" || st.overflowX === "hidden") {
          out.push({ what: "text clipped horizontally",
            el: el.id || el.className || el.tagName,
            detail: el.scrollWidth + " > " + el.clientWidth });
        }
      }
    }
    return out.slice(0, 6);
  });
  bad.forEach((b) => note(where, b.what, b.el + " " + b.detail));
  if (!bad.length) ok("layout clean");
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await listenFree(mock.server, mock.PORT);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mnx-audit-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: VIEW,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const cfg = async (o) => {
    const c = await ctx.newPage();
    await c.goto(`chrome-extension://${extId}/popup.html`);
    await c.evaluate((x) => new Promise((r) => chrome.storage.local.set(x, r)), o);
    await c.close();
  };

  const themes = process.argv.includes("--dark") ? ["dark"] : ["light", "dark"];

  for (const theme of themes) {
    // These are the extension's real storage keys -- `dark` is a BOOLEAN, and
    // akToken/mnxStep/mnxKb do not exist, so setting those silently left the
    // defaults in place and made both passes light.
    await cfg({ bridgePort: port, bridgeToken: "demo", sv: 1,
                akMissedDeck: "Missed Questions", mnxMissedMode: "move",
                kbShortcuts: true, dark: theme === "dark" });

    for (const bank of BANKS) {
      const tag = bank.id + "-" + theme;
      console.log("\n" + tag);
      const p = await ctx.newPage();
      const errs = [];
      p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
      p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
      await p.route("**/*", (r) => {
        const u = r.request().url();
        const body = /result|performance/.test(u) ? fx.resultsPage(fx.RESULT_ROWS) : bank.reviewHtml;
        return r.fulfill({ status: 200, contentType: "text/html", body });
      });

      // ---- the review page -------------------------------------------------
      await p.goto(bank.review, { waitUntil: "domcontentloaded" });
      let panel = true;
      try { await p.waitForSelector("#mnx-resources", { timeout: 15000 }); }
      catch (e) { panel = false; note(tag, "no resource panel on an answered question"); }
      if (panel) {
        await p.waitForTimeout(1400);
        await p.screenshot({ path: path.join(OUT, tag + "-panel.png") });
        await checkLayout(p, tag + " panel");

        // every advertised overlay key
        for (const key of ["f", "s", "p", "o"]) {
          await p.keyboard.press(key);
          await p.waitForTimeout(700);
          const open = await p.evaluate(() => {
            const o = document.getElementById("mnx-overlay");
            return !!(o && getComputedStyle(o).display !== "none");
          });
          if (open) {
            await p.screenshot({ path: path.join(OUT, tag + "-overlay-" + key + ".png") });
            await checkLayout(p, tag + " overlay " + key);
            await p.keyboard.press("Escape");
            await p.waitForTimeout(350);
          }
        }

        // the save dialog, its chapter chips and its undo affordance
        const save = p.locator("#mnx-resources button", { hasText: "Save to Missed Qs" });
        if (await save.count()) {
          await save.click();
          try {
            await p.waitForSelector("#mnx-md-overlay textarea", { timeout: 8000 });
            await p.waitForTimeout(1000);
            await p.screenshot({ path: path.join(OUT, tag + "-save.png") });
            await checkLayout(p, tag + " save dialog");
            const chips = await p.locator("#mnx-md-overlay .mnx-chapchip").count();
            if (!chips) note(tag, "save dialog offers no chapter chips");
            await p.keyboard.press("Escape");
            await p.waitForTimeout(300);
          } catch (e) { note(tag, "save dialog did not open"); }
        } else note(tag, "no Save to Missed Qs button");

        // preview
        const prev = p.locator("#mnx-resources button", { hasText: "Preview" });
        if (await prev.count()) {
          await prev.click();
          await p.waitForTimeout(900);
          await p.screenshot({ path: path.join(OUT, tag + "-preview.png") });
          await checkLayout(p, tag + " preview");
          await p.keyboard.press("Escape");
          await p.waitForTimeout(300);
        }

        // the shortcut cheatsheet
        await p.keyboard.press("?");
        await p.waitForTimeout(700);
        await p.screenshot({ path: path.join(OUT, tag + "-shortcuts.png") });
        await p.keyboard.press("Escape");
      }

      // ---- the results page ------------------------------------------------
      await p.goto(bank.results, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(2500);
      // The buttons live in the site's own toolbar when it has one, and in a
      // floating bar when it does not. Either way #mnx-buttons is the signal
      // that they rendered -- looking only for the floating bar reports a
      // false miss on any page with a native anchor.
      const barSeen = await p.evaluate(() => !!document.getElementById("mnx-buttons"));
      if (barSeen) {
        await p.waitForTimeout(600);
        await p.screenshot({ path: path.join(OUT, tag + "-results.png") });
        await checkLayout(p, tag + " results");
        const weak = p.locator(".mnx-btn", { hasText: "Weak areas" }).first();
        if (await weak.count()) {
          await weak.click();
          await p.waitForTimeout(1500);
          await p.screenshot({ path: path.join(OUT, tag + "-weak.png") });
          await checkLayout(p, tag + " weak areas");
          const pct = await p.locator("#mnx-md-overlay").innerText().catch(() => "");
          if (/\b100%\b/.test(pct) && !/\b\d\d%\b/.test(pct.replace(/100%/g, "")))
            note(tag, "weak areas shows everything at 100% — status parsing may be off");
          await p.keyboard.press("Escape");
        }
      } else if (bank.id !== "medpark") {
        note(tag, "no results toolbar on a results table");
      } else ok("no results toolbar on MedPark (expected)");

      if (errs.length) errs.slice(0, 4).forEach((e) => note(tag, "runtime error", e));
      else ok("no console or page errors");
      await p.close();
    }
  }

  // ---- the popup, both themes -------------------------------------------
  for (const theme of themes) {
    await cfg({ dark: theme === "dark" });
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 460, height: 900 });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.waitForTimeout(1800);
    await pop.screenshot({ path: path.join(OUT, "popup-" + theme + ".png"), fullPage: true });
    await checkLayout(pop, "popup " + theme);
    const dead = await pop.evaluate(() =>
      [...document.querySelectorAll("a[href]")].filter((a) => a.getAttribute("href") === "#")
        .map((a) => (a.textContent || "").trim()).filter(Boolean));
    if (dead.length) note("popup", "link goes nowhere (href=#)", dead.join(", "));
    await pop.close();
  }

  mock.server.close();
  await ctx.close();

  console.log("\n" + "=".repeat(60));
  if (!findings.length) console.log("AUDIT: nothing flagged");
  else {
    console.log("AUDIT: " + findings.length + " thing(s) to look at");
    findings.forEach((f) => console.log("  " + f.where + " — " + f.what +
      (f.detail ? "  [" + f.detail + "]" : "")));
  }
  console.log("screenshots: " + path.relative(ROOT, OUT));
}

run().catch((e) => { console.error(e); process.exit(1); });
