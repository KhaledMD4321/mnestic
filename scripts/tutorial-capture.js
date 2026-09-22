// Builds a narrated video walkthrough of Mnestic -- captions burned in,
// no voice. The real extension, driven by Playwright, exactly like the demo
// GIFs: nothing here is drawn or mocked up, it is the actual UI.
//
// Why captions instead of a voiceover: this repo has no text-to-speech tool,
// and a recording I cannot play back is a recording I cannot verify -- so the
// safer deliverable is one I CAN check, frame by frame, as PNGs. It also
// answers the actual complaint directly rather than working around it: a
// voice track was "confusing"; captions read at the viewer's own pace usually
// aren't, for a UI walkthrough.
//
//   node scripts/tutorial-capture.js
//
// Requires playwright-core + a chromium install, and ffmpeg on PATH.
// Output: dist/tutorial/mnestic-tutorial.mp4

const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fx = require("./demo-fixtures");
const bridge = require("./demo-bridge");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "dist", "tutorial");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mnx-tut-"));
const FFMPEG = process.env.MNX_FFMPEG || "ffmpeg";
const W = 1280, H = 800, FPS = 24;

const log = (m) => console.log("  " + m);
const wait = (p, ms) => p.waitForTimeout(ms);
const clips = [];

function ff(args) {
  execFileSync(FFMPEG, ["-y", "-v", "error", ...args], { stdio: "pipe" });
}

// ---------------------------------------------------------------- title cards
// A static full-frame card, held for `secs`. Built the same way the resource
// art was for the README GIFs: real HTML, screenshotted, so what gets
// captured is what actually renders -- nothing left to ffmpeg's text engine.
const CARD_CSS = `
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;width:${W}px;height:${H}px;background:linear-gradient(160deg,#171227,#241a3d 55%,#171227);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,Arial,sans-serif;
    display:flex;align-items:center;justify-content:center;color:#f0edfb;position:relative}
  .wrap{max-width:940px;padding:0 60px;text-align:center}
  .badge{display:inline-flex;align-items:center;gap:9px;background:rgba(255,255,255,.08);
    border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:7px 18px;font-size:14px;
    font-weight:600;letter-spacing:.02em;color:#c9bdfa;margin-bottom:26px}
  .badge .dot{width:7px;height:7px;border-radius:50%;background:#a48bff}
  h1{font-size:50px;font-weight:800;letter-spacing:-.02em;margin:0 0 16px;line-height:1.1}
  h1 .accent{color:#a48bff}
  p.sub{font-size:19px;color:#b8aee0;margin:0;line-height:1.55}
  ul.steps{list-style:none;margin:28px 0 0;padding:0;text-align:left;display:inline-block}
  ul.steps li{font-size:18px;color:#e7e1fa;padding:11px 0 11px 32px;position:relative;
    border-bottom:1px solid rgba(255,255,255,.08)}
  ul.steps li:last-child{border-bottom:none}
  ul.steps li b{color:#fff}
  ul.steps li::before{content:"";position:absolute;left:0;top:19px;width:14px;height:14px;
    border-radius:5px;background:#a48bff}
  .kbd-row{display:flex;gap:26px;justify-content:center;flex-wrap:wrap;margin-top:26px}
  .kbd-pair{display:flex;align-items:center;gap:11px}
  kbd{font:700 19px/1 -apple-system,sans-serif;background:#221a3a;border:1px solid #3a2f5c;
    border-bottom:3px solid #3a2f5c;border-radius:9px;padding:9px 14px;color:#e7e1fa;min-width:20px;
    text-align:center;display:inline-block}
  .kbd-pair span{font-size:15px;color:#b8aee0}
  .foot{position:absolute;bottom:34px;left:0;right:0;text-align:center;font-size:14px;
    color:#8c81ae;letter-spacing:.02em}
`;

let cardBrowser = null;
async function card(html, secs, name) {
  const page = await cardBrowser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CARD_CSS}</style><body>${html}</body>`);
  await page.waitForTimeout(150);
  const png = path.join(TMP, name + ".png");
  await page.screenshot({ path: png });
  await page.close();
  const mp4 = path.join(TMP, name + ".mp4");
  ff(["-loop", "1", "-i", png, "-t", String(secs),
    "-vf", `scale=${W}:${H},format=yuv420p`, "-r", String(FPS), "-c:v", "libx264", mp4]);
  clips.push(mp4);
  log(`card  ${name}  ${secs}s`);
  return png;
}

// --------------------------------------------------------------- caption bar
// A lower-third baked into the page before recording starts, so it is
// genuinely part of the frame rather than a second thing to keep in sync.
const CAPTION_CSS = `
  #mnxCap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
    background:linear-gradient(0deg,rgba(15,11,26,.96),rgba(15,11,26,.85));
    padding:20px 44px 24px;opacity:0;transform:translateY(8px);
    transition:opacity .3s ease,transform .3s ease;pointer-events:none}
  #mnxCap.on{opacity:1;transform:translateY(0)}
  #mnxCap .tag{display:inline-block;font:700 11.5px/1 -apple-system,sans-serif;letter-spacing:.06em;
    color:#c9bdfa;background:rgba(164,139,255,.16);border:1px solid rgba(164,139,255,.32);
    border-radius:999px;padding:4px 11px;margin-bottom:8px;text-transform:uppercase}
  #mnxCap .txt{font:600 20px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.5);max-width:1120px}
`;
async function installCaption(page) {
  await page.addStyleTag({ content: CAPTION_CSS });
  await page.evaluate(() => {
    const bar = document.createElement("div");
    bar.id = "mnxCap";
    bar.innerHTML = '<div class="tag"></div><div class="txt"></div>';
    document.body.appendChild(bar);
  });
}
async function say(page, tag, text, holdMs = 2600) {
  await page.evaluate(([t, x]) => {
    const bar = document.getElementById("mnxCap");
    bar.querySelector(".tag").textContent = t;
    bar.querySelector(".txt").textContent = x;
    bar.classList.add("on");
  }, [tag, text]);
  await wait(page, holdMs);
}
async function hideCaption(page) {
  await page.evaluate(() => { const b = document.getElementById("mnxCap"); if (b) b.classList.remove("on"); });
  await wait(page, 450);
}

// -------------------------------------------------------------- point + arrow
// A glowing outline around the exact element being discussed, plus a small
// labelled callout with a triangle tail so it visibly belongs to that
// element -- the same device an arrow serves in a screenshot, but one that
// tracks the real element's real position rather than being hand-placed.
const POINT_CSS = `
  #mnxPoint{position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:0;transition:opacity .25s ease}
  #mnxPoint.on{opacity:1}
  #mnxPoint .ring{position:absolute;border:3px solid #ffb238;border-radius:10px;
    box-shadow:0 0 0 4px rgba(255,178,56,.24),0 0 22px rgba(255,178,56,.55);
    animation:mnxPulse 1.3s ease-in-out infinite}
  @keyframes mnxPulse{0%,100%{box-shadow:0 0 0 4px rgba(255,178,56,.24),0 0 22px rgba(255,178,56,.55)}
    50%{box-shadow:0 0 0 9px rgba(255,178,56,.12),0 0 30px rgba(255,178,56,.8)}}
  #mnxPoint .tag{position:absolute;background:#ffb238;color:#241300;font:800 13.5px/1 -apple-system,sans-serif;
    padding:8px 13px;border-radius:8px;white-space:nowrap;box-shadow:0 5px 16px rgba(0,0,0,.4)}
  #mnxPoint .tag::after{content:"";position:absolute;left:22px;width:0;height:0;border:8px solid transparent}
  #mnxPoint .tag.above::after{top:100%;border-top-color:#ffb238}
  #mnxPoint .tag.below::after{bottom:100%;border-bottom-color:#ffb238}
`;
async function installPointer(page) {
  await page.addStyleTag({ content: POINT_CSS });
  await page.evaluate(() => {
    const w = document.createElement("div");
    w.id = "mnxPoint";
    w.innerHTML = '<div class="ring"></div><div class="tag"></div>';
    document.body.appendChild(w);
  });
}
// locator: a Playwright locator for the exact element. label: the callout text.
async function pointAt(page, locator, label, { pad = 8, holdMs = 1500 } = {}) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;
  await page.evaluate(([b, text, pad]) => {
    const w = document.getElementById("mnxPoint");
    const ring = w.querySelector(".ring"), tag = w.querySelector(".tag");
    ring.style.left = (b.x - pad) + "px";
    ring.style.top = (b.y - pad) + "px";
    ring.style.width = (b.width + pad * 2) + "px";
    ring.style.height = (b.height + pad * 2) + "px";
    tag.textContent = text;
    const above = b.y > 70;                       // enough room to sit above it?
    tag.className = "tag " + (above ? "above" : "below");
    tag.style.left = Math.max(10, b.x - pad) + "px";
    tag.style.top = above ? (b.y - pad - 44) + "px" : (b.y + b.height + pad + 12) + "px";
    w.classList.add("on");
  }, [box, label, pad]);
  await wait(page, holdMs);
}
async function unpoint(page) {
  await page.evaluate(() => { const w = document.getElementById("mnxPoint"); if (w) w.classList.remove("on"); });
  await wait(page, 250);
}

// ------------------------------------------------------------------- scenes
async function scene(name, fn, { port } = {}) {
  const profile = fs.mkdtempSync(path.join(TMP, "prof-"));
  const videoDir = path.join(TMP, "vid-" + name);
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: { width: W, height: H },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    recordVideo: { dir: videoDir, size: { width: W, height: H } }
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
  await cfg({ bridgePort: port, bridgeToken: "demo", sv: 1, akMissedDeck: "Missed Qs",
    mnxMissedMode: "move", kbShortcuts: true, dark: false });

  // A scene can open a second page (the popup, in its own tab) and every page
  // in the context records its own file, including the cfg() page above and
  // whichever tab sits idle the whole time -- so "pick the largest file in the
  // directory" is a guess, and it guessed wrong once already: a STATIC review
  // tab that stayed open for the popup's full ~17s encoded to MORE bytes than
  // the popup itself, and the final clip silently showed the wrong page for
  // its entire duration. Track the exact video object of the page we actually
  // want instead. `fn` may return a different page (the popup) to record; if
  // it returns nothing, `page` is used.
  const page = await ctx.newPage();
  const target = (await fn({ page, ctx, extId, cfg })) || page;
  const vid = target.video();
  if (target !== page) await page.close().catch(() => {});
  await target.close().catch(() => {});
  const videoPath = vid ? await vid.path().catch(() => null) : null;
  await ctx.close();

  if (!videoPath || !fs.existsSync(videoPath)) { log("!! no recording produced for " + name); return; }
  const mp4 = path.join(TMP, name + ".mp4");
  ff(["-i", videoPath, "-vf", `scale=${W}:${H},fps=${FPS},format=yuv420p`,
    "-c:v", "libx264", "-r", String(FPS), mp4]);
  clips.push(mp4);
  log(`scene ${name}  ${(fs.statSync(mp4).size / 1024 / 1024).toFixed(1)}MB`);
}

// ------------------------------------------------------------------- content
const URL_REVIEW = "https://coursology-qbank.com/qbanks/usmle1/test/3/q/14";
const URL_RESULTS = "https://coursology-qbank.com/qbanks/usmle1/test/3/results";

async function main() {
  if (!fs.existsSync(EXT)) throw new Error("extension/ not found");
  fs.mkdirSync(OUT, { recursive: true });

  const port = await bridge.listen(Number(process.env.MNX_DEMO_PORT || 8792));
  log("demo bridge on 127.0.0.1:" + port);

  // ---- render the "resource" art and the in-question figure, once --------
  cardBrowser = await chromium.launch({ headless: true });
  const artPage = await cardBrowser.newPage({ viewport: { width: 820, height: 560 } });
  const media = {};
  for (const [name, html] of Object.entries(fx.RESOURCE_ART)) {
    await artPage.setContent(html);
    const el = await artPage.$(".f");
    media[name] = (await el.screenshot({ type: "png" })).toString("base64");
  }
  await artPage.close();
  bridge.setMedia(media);

  const figPage = await cardBrowser.newPage({ viewport: { width: 820, height: 420 } });
  await figPage.setContent(fx.artFrame(`
    <h2>Flow–volume loops</h2><div class="sub">Sample figure for this demo</div>
    <svg width="700" height="270" viewBox="0 0 700 300">
      <line x1="60" y1="260" x2="660" y2="260" stroke="#c7cedd" stroke-width="2"/>
      <line x1="60" y1="20" x2="60" y2="260" stroke="#c7cedd" stroke-width="2"/>
      <path d="M90 260 L200 60 L420 220 L620 260" fill="none" stroke="#2f6fd6" stroke-width="3"/>
      <text x="500" y="52" font-size="13" fill="#2f6fd6">Normal</text>
    </svg>`, 760, 380));
  const figure = "data:image/png;base64," +
    (await (await figPage.$(".f")).screenshot({ type: "png" })).toString("base64");
  await figPage.close();

  // ==========================================================================
  // 1. TITLE
  // ==========================================================================
  await card(`
    <div class="wrap">
      <div class="badge"><span class="dot"></span>2-MINUTE WALKTHROUGH</div>
      <h1>Getting started with <span class="accent">Mnestic</span></h1>
      <p class="sub">Links the question you're studying straight to your own AnKing cards.
      Everything below happens on your own computer.</p>
    </div>`, 4.5, "01-title");

  // ==========================================================================
  // 2. SETUP (title card — no external accounts to click through safely)
  // ==========================================================================
  await card(`
    <div class="wrap">
      <div class="badge"><span class="dot"></span>ONE-TIME SETUP</div>
      <h1>Three steps, once</h1>
      <ul class="steps">
        <li><b>Install the Anki add-on</b> — Tools → Add-ons → Get Add-ons, paste <b>199262916</b>, restart Anki</li>
        <li><b>Add the extension</b> — Add Mnestic to Chrome from the Web Store</li>
        <li><b>Pair them</b> — in Anki, Tools → Mnestic Bridge → Pairing code, paste it into the popup</li>
      </ul>
      <div class="foot">Full written steps: the guide linked below the video</div>
    </div>`, 6.5, "02-setup");

  await card(`
    <div class="wrap">
      <div class="badge"><span class="dot"></span>BEFORE YOU START</div>
      <h1>Check your ids match — once</h1>
      <p class="sub">Take a question's id from the page, search it in Anki's Browse.<br>
      Same topic comes back? You're set for good.</p>
    </div>`, 4, "03-check-ids");

  // ==========================================================================
  // 3. ON A QUESTION — resource panel + overlays
  // ==========================================================================
  await scene("04-panel", async ({ page }) => {
    await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html",
      body: fx.reviewPage(bridge.QID, figure) }));
    await page.goto(URL_REVIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#mnx-resources", { timeout: 20000 });
    await page.locator("#mnx-resources").scrollIntoViewIfNeeded();
    await installCaption(page);
    await installPointer(page);
    await wait(page, 400);

    await say(page, "On a question", "Answer it, and Mnestic finds the matching resources on its own.", 1800);
    await pointAt(page, page.locator("#mnx-resources"), "The resource panel", { holdMs: 1400 });
    await unpoint(page);
    await hideCaption(page);

    const row = page.locator("#mnx-resources .mnx-r-head").first();
    await say(page, "Resource panel", "Everything your card links to — collapsed to one line each, so it never buries the explanation.", 1200);
    await pointAt(page, row, "Click to expand", { holdMs: 1600 });
    await unpoint(page);                // before the click: expanding shifts the layout under it
    await row.click();
    await wait(page, 900);
    await hideCaption(page);

    const fBadge = page.locator("#mnx-resources button.mnx-r-key", { hasText: "F" }).first();
    await say(page, "Overlay images", "Press F, or click the key badge — First Aid appears right over the question.", 1200);
    await pointAt(page, fBadge, "Press F, or click here", { holdMs: 1800 });
    await unpoint(page);                // before pressing F: the overlay covers this whole area
    await page.keyboard.press("f");
    await wait(page, 1200);
    await hideCaption(page);

    await say(page, "Multi-page topics", "Page through with the arrow keys.", 2000);
    await page.keyboard.press("ArrowRight");
    await wait(page, 1000);
    await page.keyboard.press("ArrowRight");
    await wait(page, 1200);
    await hideCaption(page);
    await page.keyboard.press("Escape");
    await wait(page, 500);

    const strip = page.locator("#mnx-resources .mnx-cards-txt").first();
    await say(page, "Card readiness", "How the matching cards actually stand, with one-click Unsuspend.", 1400);
    if (await strip.count()) await pointAt(page, strip, "9 cards, 3 mature…", { holdMs: 1600 });
    await unpoint(page);
    await wait(page, 500);
    await hideCaption(page);
  }, { port });

  // ==========================================================================
  // 4. SAVE TO MISSED QS + UNDO
  // ==========================================================================
  await scene("05-save-undo", async ({ page }) => {
    await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html",
      body: fx.reviewPage(bridge.QID, figure) }));
    await page.goto(URL_REVIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#mnx-resources", { timeout: 20000 });
    await installCaption(page);
    await installPointer(page);
    await wait(page, 500);

    const saveBtn = page.locator("#mnx-resources button", { hasText: "Save to Missed Qs" });
    await say(page, "Missed questions", "Keep one in a chapter subdeck — read straight off the card's own tags.", 1400);
    await pointAt(page, saveBtn, "Click here", { holdMs: 1800 });
    await unpoint(page);                // before the click: the dialog opens over this button
    await saveBtn.click();
    await page.waitForSelector("#mnx-md-overlay textarea", { timeout: 8000 });
    await wait(page, 700);
    await hideCaption(page);

    const chip = page.locator("#mnx-md-overlay .mnx-chapchip").first();
    if (await chip.count()) {
      await say(page, "Chapter subdeck", "Read straight off the card's own AnKing tags.", 1200);
      await pointAt(page, chip, "From the card's tags", { holdMs: 1600 });
      await unpoint(page);
      await hideCaption(page);
    }

    const textarea = page.locator("#mnx-md-overlay textarea");
    await say(page, "Your notes", "Type what you want to remember — it's appended to the card, never overwritten.", 1200);
    await pointAt(page, textarea, "Your note goes here", { holdMs: 1400 });
    await textarea.type("Recoil down -> compliance up, airways collapse on expiration.", { delay: 22 });
    await wait(page, 700);
    await unpoint(page);
    await hideCaption(page);

    const moveBtn = page.locator("#mnx-md-overlay .mnx-md-ok").last();
    await say(page, "Saved", "One click, and it moves — keeping its review history and AnKing updates.", 1200);
    await pointAt(page, moveBtn, "Move it", { holdMs: 1400 });
    await unpoint(page);                // before the click: it closes the dialog the ring is drawn on
    await moveBtn.click();
    await wait(page, 1600);
    await hideCaption(page);

    await say(page, "Changed your mind?", "Reopen the dialog on the same question...", 2200);
    await saveBtn.click();
    await page.waitForSelector("#mnx-md-overlay textarea", { timeout: 8000 });
    await wait(page, 1300);
    await hideCaption(page);

    const undo = page.locator("#mnx-md-overlay .mnx-md-undo");
    await say(page, "Undo", "...and Remove from Missed Qs takes it back out. Your notes are always kept.", 1200);
    if (await undo.count()) {
      await pointAt(page, undo, "One click undoes it", { holdMs: 1800 });
      await unpoint(page);              // before the click: this is the button that closes the dialog
      await undo.click();
    }
    await wait(page, 1600);
    await hideCaption(page);
  }, { port });

  // ==========================================================================
  // 5. RESULTS + WEAK AREAS
  // ==========================================================================
  await scene("06-weak-areas", async ({ page }) => {
    await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html",
      body: fx.resultsPage(fx.RESULT_ROWS) }));
    await page.goto(URL_RESULTS, { waitUntil: "domcontentloaded" });
    await wait(page, 2600);
    await installCaption(page);
    await installPointer(page);
    await wait(page, 300);

    const toolbar = page.locator("#mnx-buttons, #mnx-float-toolbar").first();
    await say(page, "After a block", "Open, missed, marked or high-yield only — straight to Anki, or unsuspended in bulk.", 1400);
    if (await toolbar.count()) await pointAt(page, toolbar, "These buttons", { holdMs: 1600 });
    await unpoint(page);
    await hideCaption(page);

    const weak = page.locator(".mnx-btn", { hasText: "Weak areas" }).first();
    await say(page, "Weak areas", "A per-system breakdown, weakest first...", 1200);
    if (await weak.count()) {
      await pointAt(page, weak, "Click here", { holdMs: 1600 });
      await unpoint(page);              // before the click: the breakdown dialog opens over it
      await weak.click();
    }
    await wait(page, 1200);
    await hideCaption(page);

    const openLink = page.locator("#mnx-md-overlay .mnx-brk-open").first();
    await say(page, "Open just those", "...with a button that sends exactly the missed ones in that group to Anki.", 1400);
    if (await openLink.count()) await pointAt(page, openLink, "Sends these to Anki", { holdMs: 2000 });
    await unpoint(page);
    await wait(page, 500);
    await hideCaption(page);
  }, { port });

  // ==========================================================================
  // 6. THE POPUP
  // ==========================================================================
  await scene("07-popup", async ({ page, ctx, extId }) => {
    await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html",
      body: fx.reviewPage(bridge.QID, figure) }));
    await page.goto(URL_REVIEW, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#mnx-resources", { timeout: 20000 });
    await wait(page, 800);

    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: W, height: H });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await wait(pop, 1400);
    await installCaption(pop);
    await installPointer(pop);
    await pop.evaluate(() => { document.body.style.transform = "scale(2)"; document.body.style.transformOrigin = "top left"; });
    await wait(pop, 300);

    const tracker = pop.locator(".trk").first();
    await say(pop, "The popup", "Tracks your pace on its own — streak, targets, a projected finish date.", 1200);
    await pointAt(pop, tracker, "Streak, targets, pace", { holdMs: 1800 });
    await unpoint(pop);
    await hideCaption(pop);

    await pop.evaluate(() => window.scrollBy(0, 520));
    await wait(pop, 500);
    const missed = pop.locator("#missedList").first();
    await say(pop, "Missed questions", "Grouped by chapter, with the ids ready to paste into your qbank's own test builder.", 1200);
    if (await missed.count()) await pointAt(pop, missed, "By chapter, with ids", { holdMs: 1800 });
    await unpoint(pop);
    await hideCaption(pop);

    await pop.evaluate(() => window.scrollBy(0, -520));
    await wait(pop, 500);
    const settingsRow = pop.locator(".row", { hasText: "Missed questions" }).first();
    await say(pop, "Every setting", "Theme, how a save behaves, shortcuts — all in one place.", 1200);
    if (await settingsRow.count()) await pointAt(pop, settingsRow, "Every setting lives here", { holdMs: 1800 });
    await unpoint(pop);
    await wait(pop, 400);
    await hideCaption(pop);
    return pop;                       // tell scene() to record THIS page, not the idle review tab
  }, { port });

  // ==========================================================================
  // 7. SHORTCUTS + OUTRO
  // ==========================================================================
  await card(`
    <div class="wrap">
      <div class="badge"><span class="dot"></span>KEYBOARD</div>
      <h1>Shortcuts, once you've answered</h1>
      <div class="kbd-row">
        <div class="kbd-pair"><kbd>F</kbd><kbd>S</kbd><kbd>P</kbd><kbd>O</kbd><kbd>E</kbd><kbd>A</kbd><span>overlays</span></div>
        <div class="kbd-pair"><kbd>G</kbd><span>make card</span></div>
        <div class="kbd-pair"><kbd>Q</kbd><span>copy for AI</span></div>
        <div class="kbd-pair"><kbd>V</kbd><span>save missed</span></div>
        <div class="kbd-pair"><kbd>D</kbd><span>open in Anki</span></div>
      </div>
      <div class="foot">Press ? on any answered question for the full list</div>
    </div>`, 5, "08-shortcuts");

  await card(`
    <div class="wrap">
      <div class="badge"><span class="dot"></span>THAT'S IT</div>
      <h1>Free, open source, <span class="accent">yours to run</span></h1>
      <p class="sub">Nothing leaves your computer. No account, no server, no telemetry.<br>
      The full written guide covers every feature in detail.</p>
      <div class="foot">github.com/KhaledMD4321/mnestic &nbsp;·&nbsp; buymeacoffee.com/bnkhaled</div>
    </div>`, 5, "09-outro");

  await cardBrowser.close();
  bridge.close();

  // ---- concatenate ---------------------------------------------------------
  const listFile = path.join(TMP, "list.txt");
  fs.writeFileSync(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n"));
  const final = path.join(OUT, "mnestic-tutorial.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", final]);

  let dur = "?";
  try {
    dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", final], { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch (e) {}
  console.log("\nwrote " + path.relative(ROOT, final) +
    "  (" + (fs.statSync(final).size / 1024 / 1024).toFixed(1) + " MB, " + dur + "s, " + clips.length + " clips)");
}

main().catch((e) => { console.error(e); process.exit(1); });
