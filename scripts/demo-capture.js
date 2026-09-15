// Records the demos in docs/media/ by driving the REAL extension.
//
// Nothing here is mocked up in a drawing program: Chromium loads the unpacked
// extension, a demo bridge stands in for Anki (scripts/demo-bridge.js), and the
// recorder clicks through the same UI a user does. What you see in the GIFs is
// the extension running.
//
// The question, the card and the resource images are written for the demo — see
// the note at the top of demo-fixtures.js.
//
//   node scripts/demo-capture.js              everything
//   node scripts/demo-capture.js --shots      stills only (fast)
//   node scripts/demo-capture.js --only=save  one scene
//
// Requires playwright-core + a chromium install, and ffmpeg on PATH for the GIFs
// (set MNX_FFMPEG to point at one).

const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fx = require("./demo-fixtures");
const bridge = require("./demo-bridge");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "docs", "media");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mnx-demo-"));
const FFMPEG = process.env.MNX_FFMPEG || "ffmpeg";

const SHOTS_ONLY = process.argv.includes("--shots");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || "";

const VIEW = { width: 1440, height: 900 };
const URL_REVIEW = "https://coursology-qbank.com/qbanks/usmle1/test/3/q/14";
const URL_RESULTS = "https://coursology-qbank.com/qbanks/usmle1/test/3/results";

const log = (m) => console.log("  " + m);

// A tracker with nothing in it draws an empty heatmap and a zero streak, which
// shows the feature working and tells you nothing about it. So the demo profile
// starts with a plausible eight weeks behind it: a real study pattern with days
// off, and a run going into today.
const SLUG = "usmle1";
function seedTracker() {
  const DAY = 86400000;
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const today = d0.getTime();
  const answered = {}, daily = {};
  daily[SLUG] = {};
  let qid = 9000, done = 0;
  for (let back = 55; back >= 0; back--) {
    const day = today - back * DAY;
    const dow = new Date(day).getDay();
    // Sundays off, Saturdays light, and one fallow week seven weeks back.
    let n = dow === 0 ? 0 : dow === 6 ? 22 : 38 + ((back * 7) % 11);
    if (back > 47 && back < 52) n = 0;
    if (back <= 2 && back > 0) n = 44;
    if (back === 0) n = 18;                       // today, still in progress
    if (!n) continue;
    done += n;
    // Half the day is questions we watched (so accuracy and confidence exist),
    // half is credited from the qbank's own counter, as a real week looks.
    const live = Math.round(n * 0.55);
    for (let i = 0; i < live; i++) {
      const correct = ((qid + i) % 10) > 2;       // ~74%
      const e = { ts: day + 10 * 3600000 + i * 60000, slug: SLUG, qid: String(qid + i), correct };
      if (!correct && i % 3 === 0) e.conf = "guessed";
      answered[SLUG + " " + (qid + i)] = e;
    }
    daily[SLUG][String(day)] = n - live;          // the inferred remainder
    qid += n;
  }
  return {
    answered, daily,
    totals: { [SLUG]: { total: 3200, used: done, unused: 3200 - done, ts: Date.now() } },
    targets: { daily: 40, weekly: 200 }
  };
}
const wait = (p, ms) => p.waitForTimeout(ms);

// ---------------------------------------------------------------- resource art
// The overlay shows whatever bytes the bridge returns for a filename, so the
// diagrams are rendered here once and handed to the bridge as base64.
async function renderArt(browser) {
  const page = await browser.newPage({ viewport: { width: 820, height: 560 } });
  const media = {};
  for (const [name, html] of Object.entries(fx.RESOURCE_ART)) {
    await page.setContent(html);
    const el = await page.$(".f");
    media[name] = (await el.screenshot({ type: "png" })).toString("base64");
  }
  await page.close();
  log(`rendered ${Object.keys(media).length} resource images`);
  return media;
}

// ------------------------------------------------------------------- recording
// Playwright writes one webm per PAGE, so each scene gets its own context and
// the file is whole by the time the context closes.
async function scene(name, fn, { record = true, art, port, gif } = {}) {
  if (ONLY && ONLY !== name) return;
  const profile = fs.mkdtempSync(path.join(TMP, "prof-"));
  const videoDir = path.join(TMP, "vid-" + name);
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: VIEW,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    recordVideo: record && !SHOTS_ONLY ? { dir: videoDir, size: VIEW } : undefined
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  const cfg = async (obj) => {
    const c = await ctx.newPage();
    await c.goto(`chrome-extension://${extId}/popup.html`);
    await c.evaluate((o) => new Promise((r) => chrome.storage.local.set(o, r)), obj);
    await c.close();
  };
  // Paired, on Step 1, with a Missed Qs deck already chosen — the state someone
  // is in after setup, which is what the demos are about.
  await cfg({
    bridgePort: port, akToken: "demo", mnxStep: 1, akMissedDeck: "Missed Qs",
    mnxMissedMode: "move", mnxKb: true, mnxDark: "auto",
    akTrackerV2: seedTracker()
  });

  const page = await ctx.newPage();
  await page.route("**/*", (route) => {
    const u = route.request().url();
    if (!/coursology-qbank\.com/.test(u)) return route.abort();
    const body = /results/.test(u)
      ? fx.resultsPage(fx.RESULT_ROWS)
      : fx.reviewPage(bridge.QID, art.figure);
    return route.fulfill({ status: 200, contentType: "text/html", body });
  });

  const shot = async (label, target) => {
    fs.mkdirSync(OUT, { recursive: true });
    await (target || page).screenshot({ path: path.join(OUT, label + ".png") });
    log("shot  " + label + ".png");
  };

  try {
    await fn({ page, ctx, extId, shot, cfg });
  } finally {
    await ctx.close();
  }

  if (record && !SHOTS_ONLY) {
    const webm = fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"))
      .map((f) => path.join(videoDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    if (webm) {
      // keep the source next to the gif's temp home, so the encode can be
      // retuned without sitting through another recording
      fs.copyFileSync(webm, path.join(TMP, name + ".webm"));
      toGif(webm, path.join(OUT, name + ".gif"), gif);
    }
  }
}

// ------------------------------------------------------------------- ffmpeg
// Two passes: build a palette from the whole clip, then map to it. A single
// pass dithers against a generic 216-colour palette and the UI banding shows.
function toGif(webm, out, { fps = 10, width = 820, ss = 0, t = 0, speed = 1 } = {}) {
  const pal = out.replace(/\.gif$/, "-palette.png");
  // Flat UI colour, so: no dithering and a small palette. Dithering is what
  // makes a screen-recording GIF enormous — it turns every flat panel into
  // noise that cannot be run-length encoded. 128 colours is plenty here.
  const chain = `fps=${fps},setpts=${(1 / speed).toFixed(3)}*PTS,scale=${width}:-1:flags=lanczos`;
  const trim = [];
  if (ss) trim.push("-ss", String(ss));
  if (t) trim.push("-t", String(t));
  try {
    execFileSync(FFMPEG, ["-y", "-v", "error", ...trim, "-i", webm,
      "-vf", `${chain},palettegen=max_colors=128:stats_mode=diff`, pal], { stdio: "pipe" });
    execFileSync(FFMPEG, ["-y", "-v", "error", ...trim, "-i", webm, "-i", pal, "-lavfi",
      `${chain}[x];[x][1:v]paletteuse=dither=none`, out], { stdio: "pipe" });
    fs.unlinkSync(pal);
    const kb = Math.round(fs.statSync(out).size / 1024);
    log(`gif   ${path.basename(out)}  ${kb} KB`);
    // A README GIF nobody waits for is a GIF nobody sees.
    if (kb > 2600) log(`      ^ heavy for a README — trim it (gif: {ss, t}) or raise speed`);
  } catch (e) {
    log("ffmpeg failed for " + path.basename(out) + ": " + (e.stderr || e).toString().slice(-300));
  }
}

// ------------------------------------------------------------------- the scenes
async function main() {
  if (!fs.existsSync(EXT)) throw new Error("extension/ not found");
  const port = await bridge.listen(Number(process.env.MNX_DEMO_PORT || 8791));
  log("demo bridge on 127.0.0.1:" + port);

  const boot = await chromium.launch({ headless: true });
  const media = await renderArt(boot);
  // the in-question figure is its own image, not an Anki one
  const figPage = await boot.newPage({ viewport: { width: 820, height: 420 } });
  await figPage.setContent(fx.artFrame(`
    <h2>Flow–volume loops</h2><div class="sub">Sample figure for this demo</div>
    <svg width="700" height="270" viewBox="0 0 700 300">
      <line x1="60" y1="260" x2="660" y2="260" stroke="#c7cedd" stroke-width="2"/>
      <line x1="60" y1="20" x2="60" y2="260" stroke="#c7cedd" stroke-width="2"/>
      <path d="M90 260 L200 60 L420 220 L620 260" fill="none" stroke="#2f6fd6" stroke-width="3"/>
      <path d="M120 260 L235 110 C330 195 380 235 470 260" fill="none" stroke="#d6564f" stroke-width="3"/>
      <text x="500" y="52" font-size="13" fill="#2f6fd6">Normal</text>
      <text x="500" y="76" font-size="13" fill="#d6564f">This patient</text>
    </svg>`, 760, 380));
  const figure = "data:image/png;base64," +
    (await (await figPage.$(".f")).screenshot({ type: "png" })).toString("base64");
  await figPage.close();
  await boot.close();
  bridge.setMedia(media);
  const art = { figure };

  fs.mkdirSync(OUT, { recursive: true });

  // 1 — the panel and an image overlay, the thing used every question
  await scene("overlay", async ({ page, shot }) => {
    await page.goto(URL_REVIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#mnx-resources", { timeout: 20000 });
    await wait(page, 1600);
    await page.locator("#mnx-resources").scrollIntoViewIfNeeded();
    await wait(page, 600);
    await shot("panel");
    // and the panel on its own, for embedding at a readable size
    await shot("panel-closeup", page.locator("#mnx-resources"));
    // open a resource row, so the collapsed-by-default design reads
    const row = page.locator("#mnx-resources .mnx-r-head").first();
    if (await row.count()) { await row.click(); await wait(page, 900); }
    await shot("panel-open");
    await shot("panel-open-closeup", page.locator("#mnx-resources"));
    await page.keyboard.press("f");                       // First Aid overlay
    await wait(page, 1700);
    await shot("overlay-firstaid");
    await page.keyboard.press("ArrowRight");               // page 2 of 3
    await wait(page, 1300);
    await page.keyboard.press("ArrowRight");
    await wait(page, 1300);
    await page.keyboard.press("Escape");
    await wait(page, 700);
    await page.keyboard.press("s");                        // a second resource
    await wait(page, 1700);
    await page.keyboard.press("Escape");
    await wait(page, 900);
  }, { art, port, gif: { ss: 3.4, t: 9 } });

  // 2 — keeping a missed question, and taking it back out again
  await scene("save-and-undo", async ({ page, shot }) => {
    await page.goto(URL_REVIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#mnx-resources", { timeout: 20000 });
    await wait(page, 1200);
    await page.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
    await page.waitForSelector("#mnx-md-overlay textarea", { timeout: 10000 });
    await wait(page, 1200);
    await shot("save-dialog");
    await page.locator("#mnx-md-overlay textarea")
      .type("Recoil ↓ → compliance ↑, airways collapse on expiration.", { delay: 26 });
    await wait(page, 900);
    await shot("save-dialog-typed");
    await page.locator("#mnx-md-overlay .mnx-md-ok").last().click();
    await wait(page, 2200);                                 // the toast
    await shot("save-toast");
    // ...and the undo, which is the new part
    await page.locator("#mnx-resources button", { hasText: "Save to Missed Qs" }).click();
    await page.waitForSelector("#mnx-md-overlay textarea", { timeout: 10000 });
    await wait(page, 1600);                                 // "Already in Missed Qs"
    await shot("undo-offered");
    await page.locator("#mnx-md-overlay .mnx-md-undo").click();
    await wait(page, 2400);
    await shot("undo-toast");
  }, { art, port, gif: { ss: 2.2, t: 13, speed: 1.5 } });

  // 3 — the end of a block: results buttons and the weak-area breakdown
  await scene("weak-areas", async ({ page, shot }) => {
    await page.goto(URL_RESULTS, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#mnx-results-bar, .mnx-btn", { timeout: 20000 });
    await wait(page, 1500);
    await shot("results-bar");
    const bar = page.locator("#mnx-float-toolbar, .mnx-results-bar").first();
    if (await bar.count()) await shot("results-bar-closeup", bar);
    const weak = page.locator(".mnx-btn", { hasText: "Weak areas" }).first();
    if (await weak.count()) {
      await weak.click();
      await wait(page, 2200);
      await shot("weak-areas");
      await wait(page, 1400);
    } else {
      log("weak-areas button not found — skipping click");
    }
  }, { art, port, gif: { ss: 2.0, t: 7 } });

  // 4 — the popup: tracker, missed list, settings
  await scene("popup", async ({ page, ctx, extId, shot }) => {
    // give the tracker something to draw before the popup is opened
    await page.goto(URL_REVIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#mnx-resources", { timeout: 20000 });
    await wait(page, 1200);
    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 460, height: 900 });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await wait(pop, 2200);
    await shot("popup", pop);
    const refresh = pop.locator("#missedRefresh");
    if (await refresh.count()) { await refresh.click(); await wait(pop, 1600); }
    await shot("popup-missed", pop);
    await pop.close();
  }, { art, port, record: false });

  bridge.close();
  console.log("\nwrote " + path.relative(ROOT, OUT));
  for (const f of fs.readdirSync(OUT).sort()) {
    const kb = Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
    console.log("  " + f.padEnd(26) + kb + " KB");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
