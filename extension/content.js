// Mnestic — content script.
//
// Runs on coursology-qbank.com and links each question to your AnKing cards by
// building a local Anki tag search (#AK_Step<n>_v*::#UWorld::*::<qid>) and
// sending it to the Mnestic Bridge add-on (via background.js).
//
// Layout of this file:
//   • COURSO adapter — all Coursology-specific DOM selectors live in one object.
//   • FEATURE 1  — results-page buttons (Missed / All / Marked / High-Yield).
//   • FEATURE 2  — review-page resource panel + F/S/P/E/A image overlay.
//   • FEATURE 2b — review-page note-taking (Copy Q, Preview, Save to Missed Qs).
//   • FEATURE 3  — study logging (per-question; the tracker UI is in the popup).
//   • Expected Score (beta) — preparedness estimate from card maturity.
//   • main loop — a 1s interval that injects/updates the UI as the SPA changes.
//
// All injected DOM uses ids/classes prefixed "mnx-" so it's easy to exclude.
(() => {
  "use strict";
  const BTN_HOST_ID = "mnx-buttons";
  const PANEL_ID = "mnx-resources";
  const OVERLAY_ID = "mnx-overlay";
  const SUMMARY_ID = "mnx-summary";
  const ANKING_VER = "v*"; // matches any AnKing version

  // ---------- talk to Anki via the background worker (the Mnestic Bridge) ----------
  function bridge(op, args) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "bridge", op, args: args || {} }, resp => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        if (!resp || !resp.ok) return reject((resp && resp.error) || "unknown error");
        resolve(resp.data);
      });
    });
  }
  // Step (1/2/3) for the AnKing tag. Prefer the step baked into the Coursology
  // URL (/qbanks/usmle2/...) so it follows you across Step 1/2/3 automatically;
  // fall back to the popup's Step selector when the URL doesn't say.
  function detectStepFromUrl() {
    const path = location.pathname + " " + location.href;
    const m = path.match(/\/qbanks\/[^/]*?(\d)/i)   // /qbanks/usmle2/...
           || path.match(/step[\s_-]*(\d)/i)         // ...step2... / step-3
           || path.match(/usmle[\s_-]*(\d)/i);       // usmle 1
    if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 3) return n; }
    return null;
  }
  function getSv() {
    const urlStep = detectStepFromUrl();
    if (urlStep) return Promise.resolve(urlStep);
    return new Promise(r => chrome.storage.local.get({ sv: 1 }, c => r(c.sv)));
  }

  // ============================================================
  // COURSOLOGY ADAPTER — all site-specific DOM selectors live here, so porting
  // to another qbank (or surviving a Coursology redesign) only touches this one
  // object. Coursology reuses UWorld's question IDs, so the AnKing tag query is
  // all the matching logic there is — any source of that question ID works.
  // Verified against the live DOM on 2026-06-14/15: the results-table parser,
  // the Question List modal parser, the review-page QID read, the spoiler-safe
  // gate (#question-explanation), and the panel anchor.
  // ============================================================
  const DEBUG = false; // set true to log what the results parser finds
  function dlog() { if (DEBUG) { try { console.log("[mnestic]", ...arguments); } catch (e) {} } }

  const COURSO = {
    // ---- REVIEW PAGE (per question) ----
    // The player header renders "Question Id: 2"; findQid() reads it. Confirmed
    // present in document.body on the live review page. Listed scopes are tried
    // first (narrower = cheaper); body is the reliable fallback.
    headerSel: [".question-header", "header", "body"],
    // Only reveal resources once the answer/explanation is visible, so we never
    // spoil an unanswered question. Confirmed: the right-hand explanation column
    // is <div id="question-explanation">, which only has height once shown
    // (the footer's "REVIEW" text is CSS-uppercased, so we don't rely on it).
    isReviewing() {
      const ex = document.querySelector("#question-explanation");
      return !!(ex && ex.offsetHeight > 1);
    },
    // Anchor the resource panel inside the explanation column (confirmed id);
    // null -> it floats bottom-right.
    panelAnchor() {
      return document.querySelector("#question-explanation, #questionInformation");
    },
    // The central content column holding the question stem, the answer choices,
    // and the explanation - used by "Copy full Q". Best-effort: a real <main> if
    // the SPA exposes one, else climb from #question-explanation to the ancestor
    // that also picks up the stem/choices without ballooning to the whole shell.
    contentRoot() {
      const explicit = document.querySelector("main, [role='main']");
      if (explicit) return explicit;
      const ex = document.querySelector("#question-explanation");
      if (!ex) return null;
      const exLen = (ex.innerText || "").length || 1;
      let node = ex.parentElement, chosen = ex;
      for (let i = 0; i < 10 && node && node !== document.body; i++) {
        const len = (node.innerText || "").length;
        if (len > exLen * 8) break;       // too big (app shell) - keep previous
        chosen = node;
        if (len > exLen * 1.4) break;      // now includes the stem + choices
        node = node.parentElement;
      }
      return chosen;
    },

    // ---- RESULTS PAGE (the score table) ----
    // Container for the "Anki: Missed / All / Marked" buttons. Coursology has no
    // obvious inline anchor, so this returns null and a floating bar is used.
    toolbar() {
      return document.querySelector(".test-performance-top-div, .results-actions, .test-results-header");
    },
    // Parse the results table into [{qid, wrong, marked}]. Confirmed on live DOM:
    // a real <table> with an "ID" header column (index 1); the row's status icon
    // is svg.fa-xmark.text-red-500 (wrong) / svg.fa-check.text-lime-500 (right).
    // Marked questions aren't flagged in the results table (only in the player),
    // so "Anki: Marked" stays empty here. Falls back to scanning status+number rows.
    resultRows() {
      const rows = [];
      const seen = new Set();
      const push = (qid, wrong, marked) => {
        if (!qid || seen.has(qid)) return;
        seen.add(qid); rows.push({ qid, wrong, marked });
      };
      const loc = findIdColumn();
      if (loc) {
        loc.bodyRows.forEach(tr => {
          const cell = tr.children[loc.index];
          if (!cell) return;
          const m = (cell.textContent || "").match(/\d+/);
          if (!m) return;
          push(m[0], rowIsWrong(tr, cell), rowIsMarked(tr));
        });
      }
      if (rows.length) { dlog("resultRows via table", rows.length); return rows; }
      document.querySelectorAll('[role="row"], tr, mat-row, li').forEach(tr => {
        const m = ((tr.textContent || "").trim()).match(/^[✓✔✗✕×x]?\s*(\d{1,6})\b/);
        if (m) push(m[1], rowIsWrong(tr, tr), rowIsMarked(tr));
      });
      dlog("resultRows via fallback", rows.length);
      return rows;
    }
  };

  // status helpers shared by the results parser
  const WRONG_CLASS_RE = /incorrect|wrong|text-danger|text-red/i;
  function rowIsWrong(row, cell) {
    if (row && row.querySelector(".fa-times, .fa-xmark, .fa-circle-xmark, i.text-danger, [class*='incorrect']")) return true;
    if (/^\s*[✗✕×]/.test(((cell || row).textContent || ""))) return true;
    return WRONG_CLASS_RE.test((row && row.className) || "");
  }
  function rowIsMarked(row) {
    return !!(row && row.querySelector(".fa-bookmark, .fas.fa-bookmark, .fa-flag, [class*='marked'], [class*='flag']"));
  }
  // Find a <table> whose header has a cell reading exactly "ID"; return that
  // column index plus the body rows.
  function findIdColumn() {
    for (const table of document.querySelectorAll("table")) {
      const heads = table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td");
      let index = -1;
      heads.forEach((h, i) => { if (index < 0 && /^\s*id\s*$/i.test(h.textContent || "")) index = i; });
      if (index < 0) continue;
      const body = Array.from(table.querySelectorAll("tbody tr"));
      return { index, bodyRows: body.length ? body : Array.from(table.querySelectorAll("tr")).slice(1) };
    }
    return null;
  }
  // Floating host for the results buttons when no native toolbar is found.
  function ensureFloatingToolbar() {
    let bar = document.getElementById("mnx-float-toolbar");
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = "mnx-float-toolbar";
    bar.style.cssText = "position:fixed;top:74px;right:16px;z-index:2147483646;display:flex;gap:8px;background:rgba(255,255,255,.94);padding:6px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.18)";
    document.body.appendChild(bar);
    return bar;
  }

  // ---------- styles (tuned to blend with the qbank UI) ----------
  const style = document.createElement("style");
  style.textContent = `
    /* ---- design tokens (one source of truth; dark flips via <html class=mnx-dark>) ---- */
    :root{
      --mnx-accent:#2f6fed; --mnx-accent-600:#2559d0; --mnx-accent-soft:#eaf1ff;
      --mnx-good:#16a34a; --mnx-good-600:#15803d; --mnx-warn:#e0901f; --mnx-bad:#e2483d;
      --mnx-surface:#ffffff; --mnx-surface-2:#f4f6f9; --mnx-elev:#ffffff;
      --mnx-border:#e3e8ef; --mnx-text:#18283a; --mnx-muted:#64748b; --mnx-ink:#14304f;
      --mnx-r:12px; --mnx-r-sm:8px; --mnx-r-xs:6px;
      --mnx-shadow:0 14px 44px rgba(15,23,42,.22); --mnx-shadow-sm:0 2px 8px rgba(15,23,42,.10);
      --mnx-font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,Arial,sans-serif;
    }
    :root.mnx-dark{
      --mnx-accent:#5a8bf7; --mnx-accent-600:#4f86f7; --mnx-accent-soft:#1f2a3d;
      --mnx-good:#3fbf6a; --mnx-good-600:#35a95c; --mnx-warn:#e0a94a; --mnx-bad:#ef6a5f;
      --mnx-surface:#1f2430; --mnx-surface-2:#262c38; --mnx-elev:#232a37;
      --mnx-border:#3a4150; --mnx-text:#e6ebf4; --mnx-muted:#9aa3b2; --mnx-ink:#e6ebf4;
      --mnx-shadow:0 16px 48px rgba(0,0,0,.5); --mnx-shadow-sm:0 2px 10px rgba(0,0,0,.4);
    }
    #${BTN_HOST_ID}{display:inline-flex;gap:8px;margin-left:8px;vertical-align:middle}
    .mnx-btn{background:var(--mnx-accent);color:#fff;border:none;border-radius:var(--mnx-r-sm);padding:8px 15px;font-size:13.5px;font-weight:600;font-family:var(--mnx-font);cursor:pointer;line-height:1.2;box-shadow:var(--mnx-shadow-sm);transition:filter .12s,transform .06s}
    .mnx-btn:hover{filter:brightness(1.06)}
    .mnx-btn:active{transform:translateY(1px)}
    .mnx-hy{background:var(--mnx-warn)}
    .mnx-brkbtn{background:#7c5cf6}
    .mnx-qid-open{display:inline-flex;align-items:center;margin-left:8px;vertical-align:middle;background:var(--mnx-accent);color:#fff;border:none;border-radius:var(--mnx-r-sm);padding:3px 10px;font-size:12px;font-weight:700;font-family:var(--mnx-font);cursor:pointer;line-height:1.4;white-space:nowrap;box-shadow:var(--mnx-shadow-sm)}
    .mnx-qid-open:hover{filter:brightness(1.08)}
    .mnx-qid-open.mnx-qid-float{position:fixed;top:8px;left:210px;z-index:2147483646}
    .mnx-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;z-index:2147483647;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:80vw;text-align:center}
    #mnx-confirm{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,Arial,sans-serif}
    #mnx-confirm .mnx-cf-box{background:#fff;color:#243240;width:min(380px,90vw);border-radius:10px;padding:18px 18px 16px;box-shadow:0 12px 40px rgba(0,0,0,.4)}
    #mnx-confirm .mnx-cf-title{font-size:15px;font-weight:700;color:#16395b;margin-bottom:8px}
    #mnx-confirm .mnx-cf-body{font-size:13px;color:#556;line-height:1.5;margin-bottom:16px}
    #mnx-confirm .mnx-cf-btns{display:flex;justify-content:flex-end;gap:8px}
    #mnx-confirm .mnx-cf-btn{border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
    #mnx-confirm .mnx-cf-cancel{background:#e9edf1;color:#3a4250}
    #mnx-confirm .mnx-cf-cancel:hover{background:#dfe4ea}
    #mnx-confirm .mnx-cf-ok{background:#2f7bd6;color:#fff}
    #mnx-confirm .mnx-cf-ok:hover{filter:brightness(1.08)}
    #mnx-confirm.mnx-dark .mnx-cf-box{background:#1f2430;color:#e6ebf4}
    #mnx-confirm.mnx-dark .mnx-cf-title{color:#e6ebf4}
    #mnx-confirm.mnx-dark .mnx-cf-body{color:#9aa3b2}
    #mnx-confirm.mnx-dark .mnx-cf-cancel{background:#2c3340;color:#cdd6e5}
    #mnx-confirm.mnx-dark .mnx-cf-cancel:hover{background:#353d4c}

    /* resource card - blends with the qbank UI */
    #${PANEL_ID}{margin:14px 0;font-family:inherit;color:#333;background:#fff;border:1px solid #dde2e7;border-radius:8px;display:block;position:relative;z-index:1}
    #${PANEL_ID}.mnx-float{position:fixed;right:16px;bottom:16px;width:400px;max-height:60vh;overflow:auto;z-index:2147483646;box-shadow:0 6px 20px rgba(0,0,0,.18)}
    #${PANEL_ID} table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
    #${PANEL_ID} td{border:none;border-bottom:1px solid #eef1f4;padding:9px 12px;vertical-align:top;line-height:1.45}
    #${PANEL_ID} tr:last-child td{border-bottom:none}
    #${PANEL_ID} td.mnx-res{font-weight:600;white-space:nowrap;color:#16395b;border-left:3px solid #ccc;width:96px}
    #${PANEL_ID} a{color:#1b69b6;text-decoration:underline;display:block;margin:3px 0}
    #${PANEL_ID} a:hover{color:#0f4f8c}
    #${PANEL_ID} .mnx-path{display:block;margin:3px 0;color:#555}
    #${PANEL_ID} .mnx-group{margin:0 0 9px}
    #${PANEL_ID} .mnx-group:last-child{margin-bottom:0}
    #${PANEL_ID} .mnx-parent{font-size:12px;color:#8a8f98;margin-bottom:2px}
    #${PANEL_ID} .mnx-leaf-row{padding:1px 0 1px 10px}
    #${PANEL_ID} .mnx-leaf{font-weight:600;color:#243240}
    #${PANEL_ID} .mnx-watch{display:inline-block;color:#1b69b6;text-decoration:underline;font-size:12px;margin-left:8px;white-space:nowrap}
    #${PANEL_ID} .mnx-msg{font-size:13px;color:#667;padding:11px 12px}
    #${PANEL_ID} .mnx-note{font-size:12px;color:#778;padding:8px 12px;border-top:1px solid #eef1f4;background:#fafbfc}

    /* fullscreen image overlay (modal) */
    #${OVERLAY_ID}{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;align-items:flex-start;justify-content:center;padding:4vh 0}
    #${OVERLAY_ID} .mnx-dialog{background:#fff;width:90vw;max-height:92vh;overflow:auto;border-radius:10px;padding:14px 16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.4);font-family:inherit;color:#333}
    #${OVERLAY_ID} .mnx-ovl-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e6e9ec;padding-bottom:8px;margin-bottom:12px}
    #${OVERLAY_ID} .mnx-ovl-head b{font-size:16px;color:#16395b}
    #${OVERLAY_ID} .mnx-ovl-hint{font-size:12px;color:#999;margin-left:8px}
    #${OVERLAY_ID} .mnx-x{border:none;background:transparent;font-size:28px;line-height:1;cursor:pointer;color:#666;padding:0 6px;border-radius:6px}
    #${OVERLAY_ID} .mnx-x:hover{color:#000;background:#f0f0f0}
    #${OVERLAY_ID} .mnx-ovl-img{display:block;width:100%;height:auto;margin:0 0 12px}

    /* dark mode */
    #${PANEL_ID}.mnx-dark{background:#1f2430;border-color:#3a4150;color:#d8dce4}
    #${PANEL_ID}.mnx-dark table{background:transparent}
    #${PANEL_ID}.mnx-dark td{border-bottom-color:#2c3340}
    #${PANEL_ID}.mnx-dark tr:last-child td{border-bottom:none}
    #${PANEL_ID}.mnx-dark td.mnx-res{color:#e6ebf4}
    #${PANEL_ID}.mnx-dark a{color:#5aa9f0}
    #${PANEL_ID}.mnx-dark a:hover{color:#8cc4f7}
    #${PANEL_ID}.mnx-dark .mnx-path{color:#9aa3b2}
    #${PANEL_ID}.mnx-dark .mnx-parent{color:#8b94a3}
    #${PANEL_ID}.mnx-dark .mnx-leaf{color:#e6ebf4}
    #${PANEL_ID}.mnx-dark .mnx-msg{color:#9aa3b2}
    #${PANEL_ID}.mnx-dark .mnx-note{color:#8b94a3;border-top-color:#2c3340;background:#181c26}
    #${OVERLAY_ID}.mnx-dark .mnx-dialog{background:#1f2430;color:#d8dce4}
    #${OVERLAY_ID}.mnx-dark .mnx-ovl-head{border-bottom-color:#3a4150}
    #${OVERLAY_ID}.mnx-dark .mnx-ovl-head b{color:#e6ebf4}
    #${OVERLAY_ID}.mnx-dark .mnx-ovl-hint{color:#8b94a3}
    #${OVERLAY_ID}.mnx-dark .mnx-x{color:#aab2c0}
    #${OVERLAY_ID}.mnx-dark .mnx-x:hover{color:#fff;background:#2c3340}

    .mnx-es{background:#2a9d8f}
    #${PANEL_ID} .mnx-expected{font-size:12.5px;padding:7px 10px;border-radius:6px;margin-bottom:10px;border-left:3px solid #b9bdc4;background:#f4f6f8;color:#333}
    #${PANEL_ID} .mnx-expected.good{border-left-color:#2e9e4f;background:#eef7f0}
    #${PANEL_ID} .mnx-expected.warn{border-left-color:#e0901f;background:#fdf4e6}
    #${PANEL_ID}.mnx-dark .mnx-expected{background:#262c38;color:#cdd6e5;border-left-color:#5a6472}
    #${PANEL_ID}.mnx-dark .mnx-expected.good{background:#1f2e25;border-left-color:#3fa05f}
    #${PANEL_ID}.mnx-dark .mnx-expected.warn{background:#322a1c;border-left-color:#c8881f}

    #${SUMMARY_ID}{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;align-items:flex-start;justify-content:center;padding:6vh 0;font-family:system-ui,Arial,sans-serif}
    #${SUMMARY_ID} .mnx-sum-dialog{background:#fff;width:min(560px,92vw);max-height:86vh;overflow:auto;border-radius:10px;padding:16px 18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.4);color:#333}
    #${SUMMARY_ID} .mnx-sum-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e6e9ec;padding-bottom:8px;margin-bottom:12px}
    #${SUMMARY_ID} .mnx-sum-head span{font-weight:600;font-size:16px;color:#16395b}
    #${SUMMARY_ID} .mnx-sum-row{display:flex;gap:10px;margin-bottom:10px}
    #${SUMMARY_ID} .mnx-metric{flex:1;background:#f4f6f8;border-radius:8px;padding:10px 12px;text-align:center}
    #${SUMMARY_ID} .mnx-metric-v{font-size:22px;font-weight:600;color:#16395b}
    #${SUMMARY_ID} .mnx-metric-l{font-size:12px;color:#667;margin-top:2px}
    #${SUMMARY_ID} .mnx-sum-note{font-size:12.5px;color:#667;margin-bottom:12px;line-height:1.5}
    #${SUMMARY_ID} .mnx-sum-lbl{font-size:13px;font-weight:600;color:#243240;margin:6px 0}
    #${SUMMARY_ID} .mnx-sum-item{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid #eef1f4;font-size:13px}
    #${SUMMARY_ID} a{color:#1b69b6;text-decoration:underline;font-size:12px;white-space:nowrap}
    #${SUMMARY_ID} .mnx-sum-score{text-align:center;margin:2px 0 14px}
    #${SUMMARY_ID} .mnx-score-v{font-size:34px;font-weight:700;color:#16395b;line-height:1.1}
    #${SUMMARY_ID} .mnx-score-l{display:block;font-size:12px;color:#778;margin-top:3px}
    #${SUMMARY_ID} .mnx-cov{margin:0 0 14px}
    #${SUMMARY_ID} .mnx-cov-bar{height:8px;border-radius:5px;background:#e6e9ec;overflow:hidden}
    #${SUMMARY_ID} .mnx-cov-fill{height:100%;background:#2a9d8f;border-radius:5px;min-width:2px}
    #${SUMMARY_ID} .mnx-cov-lbl{font-size:12px;color:#778;margin-top:5px}
    #${SUMMARY_ID} .mnx-conf{display:inline-block;font-size:12px;font-weight:600;padding:4px 11px;border-radius:12px;margin:0 0 11px}
    #${SUMMARY_ID} .mnx-conf-high{background:#e3f4e8;color:#1f7a3d}
    #${SUMMARY_ID} .mnx-conf-medium{background:#e7f0fb;color:#1b5fae}
    #${SUMMARY_ID} .mnx-conf-low{background:#fdf0dd;color:#a86412}
    #${SUMMARY_ID} .mnx-conf-insufficient{background:#eceef0;color:#6a727c}
    #${SUMMARY_ID} .mnx-x{border:none;background:transparent;font-size:26px;line-height:1;cursor:pointer;color:#666;padding:0 4px}
    #${SUMMARY_ID} .mnx-x:hover{color:#000}
    #${SUMMARY_ID}.mnx-dark .mnx-sum-dialog{background:#1f2430;color:#d8dce4}
    #${SUMMARY_ID}.mnx-dark .mnx-sum-head{border-bottom-color:#3a4150}
    #${SUMMARY_ID}.mnx-dark .mnx-sum-head span{color:#e6ebf4}
    #${SUMMARY_ID}.mnx-dark .mnx-metric{background:#262c38}
    #${SUMMARY_ID}.mnx-dark .mnx-metric-v{color:#e6ebf4}
    #${SUMMARY_ID}.mnx-dark .mnx-metric-l{color:#9aa3b2}
    #${SUMMARY_ID}.mnx-dark .mnx-sum-note{color:#9aa3b2}
    #${SUMMARY_ID}.mnx-dark .mnx-sum-lbl{color:#e6ebf4}
    #${SUMMARY_ID}.mnx-dark .mnx-sum-item{border-top-color:#2c3340}
    #${SUMMARY_ID}.mnx-dark a{color:#5aa9f0}
    #${SUMMARY_ID}.mnx-dark .mnx-score-v{color:#e6ebf4}
    #${SUMMARY_ID}.mnx-dark .mnx-score-l{color:#9aa3b2}
    #${SUMMARY_ID}.mnx-dark .mnx-cov-bar{background:#2c3340}
    #${SUMMARY_ID}.mnx-dark .mnx-cov-lbl{color:#9aa3b2}
    #${SUMMARY_ID}.mnx-dark .mnx-conf-high{background:#1f2e25;color:#5fd17a}
    #${SUMMARY_ID}.mnx-dark .mnx-conf-medium{background:#1d2a3a;color:#6ab0f0}
    #${SUMMARY_ID}.mnx-dark .mnx-conf-low{background:#322a1c;color:#e0a94a}
    #${SUMMARY_ID}.mnx-dark .mnx-conf-insufficient{background:#262c38;color:#9aa3b2}

    /* review-panel header actions */
    #${PANEL_ID} .mnx-phead{display:flex;gap:6px;flex-wrap:wrap;padding:9px 11px;border-bottom:1px solid var(--mnx-border);background:var(--mnx-surface-2)}
    #${PANEL_ID} .mnx-pbtn{border:none;border-radius:var(--mnx-r-xs);padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--mnx-font);background:var(--mnx-elev);color:var(--mnx-ink);box-shadow:var(--mnx-shadow-sm)}
    #${PANEL_ID} .mnx-pbtn:hover{filter:brightness(.97)}
    #${PANEL_ID} .mnx-pbtn.mnx-save{background:var(--mnx-good);color:#fff}
    #${PANEL_ID} .mnx-pbtn.mnx-save:hover{filter:brightness(1.06)}

    /* modal system (preview / save / make card / breakdown) */
    #mnx-md-overlay{position:fixed;inset:0;background:rgba(15,23,42,.46);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:6vh 0;font-family:var(--mnx-font)}
    #mnx-md-overlay .mnx-md{background:var(--mnx-surface);color:var(--mnx-text);width:min(560px,92vw);max-height:84vh;overflow:auto;border-radius:var(--mnx-r);box-shadow:var(--mnx-shadow);border:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-md-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-md-head b{font-size:15px;font-weight:700;color:var(--mnx-ink)}
    #mnx-md-overlay .mnx-md-x{border:none;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--mnx-muted);width:28px;height:28px;border-radius:var(--mnx-r-xs)}
    #mnx-md-overlay .mnx-md-x:hover{color:var(--mnx-text);background:var(--mnx-surface-2)}
    #mnx-md-overlay .mnx-md-body{padding:16px 18px}
    #mnx-md-overlay .mnx-md-foot{display:flex;justify-content:flex-end;gap:8px;padding:13px 18px;border-top:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-md-btn{border:none;border-radius:var(--mnx-r-sm);padding:9px 17px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--mnx-font);transition:filter .12s,transform .06s}
    #mnx-md-overlay .mnx-md-btn:active{transform:translateY(1px)}
    #mnx-md-overlay .mnx-md-ok{background:var(--mnx-accent);color:#fff}
    #mnx-md-overlay .mnx-md-ok:hover{background:var(--mnx-accent-600)}
    #mnx-md-overlay .mnx-md-ok:disabled{opacity:.55;cursor:default}
    #mnx-md-overlay .mnx-md-cancel{background:var(--mnx-surface-2);color:var(--mnx-text)}
    #mnx-md-overlay .mnx-md-cancel:hover{filter:brightness(.97)}
    #mnx-md-overlay .mnx-md-lbl{display:block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--mnx-muted);margin:14px 0 6px}
    #mnx-md-overlay .mnx-md-body select,#mnx-md-overlay .mnx-md-body textarea,#mnx-md-overlay .mnx-md-body input[type=text]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);font-size:13px;font-family:var(--mnx-font);color:var(--mnx-text);background:var(--mnx-surface-2);outline:none;transition:border-color .12s,box-shadow .12s}
    #mnx-md-overlay .mnx-md-body select:focus,#mnx-md-overlay .mnx-md-body textarea:focus,#mnx-md-overlay .mnx-md-body input[type=text]:focus{border-color:var(--mnx-accent);box-shadow:0 0 0 3px var(--mnx-accent-soft)}
    #mnx-md-overlay .mnx-md-body textarea{min-height:84px;resize:vertical;line-height:1.5}
    #mnx-md-overlay .mnx-pick{border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);max-height:150px;overflow:auto;background:var(--mnx-surface-2)}
    #mnx-md-overlay .mnx-pick label{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid var(--mnx-border);font-size:12.5px;cursor:pointer}
    #mnx-md-overlay .mnx-pick label:last-child{border-bottom:none}
    #mnx-md-overlay .mnx-md-prev{font-size:13.5px;line-height:1.55}
    #mnx-md-overlay .mnx-md-prev img{max-width:100%;height:auto;display:block;margin:8px 0;border-radius:var(--mnx-r-xs)}
    #mnx-md-overlay .mnx-md-prev .cloze{color:var(--mnx-accent);font-weight:700}
    #mnx-md-overlay .mnx-prev-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
    #mnx-md-overlay .mnx-prev-count{font-size:12.5px;font-weight:700;color:var(--mnx-ink)}
    #mnx-md-overlay .mnx-img-drop{border:1.5px dashed var(--mnx-border);border-radius:var(--mnx-r-sm);padding:13px;text-align:center;font-size:12px;color:var(--mnx-muted);cursor:pointer;background:var(--mnx-surface-2);transition:border-color .12s,color .12s}
    #mnx-md-overlay .mnx-img-drop:hover,#mnx-md-overlay .mnx-img-drop.mnx-img-over{border-color:var(--mnx-accent);color:var(--mnx-accent)}
    #mnx-md-overlay .mnx-img-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
    #mnx-md-overlay .mnx-img-thumb{position:relative;width:64px;height:64px;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-xs);overflow:hidden;background:var(--mnx-surface)}
    #mnx-md-overlay .mnx-img-thumb img{width:100%;height:100%;object-fit:cover;display:block}
    #mnx-md-overlay .mnx-img-x{position:absolute;top:2px;right:2px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:13px;line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
    #mnx-md-overlay .mnx-img-x:hover{background:rgba(0,0,0,.85)}
    #mnx-md-overlay .mnx-qthumb{position:relative;width:54px;height:54px;border:1px solid var(--mnx-border);border-radius:var(--mnx-r-xs);overflow:hidden;background:var(--mnx-surface);cursor:pointer}
    #mnx-md-overlay .mnx-qthumb img{width:100%;height:100%;object-fit:cover;display:block}
    #mnx-md-overlay .mnx-qthumb::after{content:"＋";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.34);color:#fff;font-size:18px;font-weight:700;opacity:0;transition:opacity .12s}
    #mnx-md-overlay .mnx-qthumb:hover::after{opacity:1}
    #mnx-md-overlay .mnx-qthumb.loading::after{content:"…";opacity:1}
    #mnx-md-overlay .mnx-qthumb.added::after{content:"✓";opacity:1;background:rgba(22,163,74,.6)}
    #mnx-md-overlay .mnx-seg{display:inline-flex;background:var(--mnx-surface-2);border:1px solid var(--mnx-border);border-radius:var(--mnx-r-sm);padding:3px;gap:2px}
    #mnx-md-overlay .mnx-seg button{border:none;background:transparent;font:inherit;font-family:var(--mnx-font);font-size:13px;font-weight:600;color:var(--mnx-muted);padding:6px 18px;border-radius:var(--mnx-r-xs);cursor:pointer}
    #mnx-md-overlay .mnx-seg button.on{background:var(--mnx-surface);color:var(--mnx-ink);box-shadow:var(--mnx-shadow-sm)}
    #mnx-md-overlay .mnx-inline{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
    #mnx-md-overlay .mnx-inline .mnx-md-btn{padding:6px 12px;font-size:12.5px}
    #mnx-md-overlay .mnx-md-hint{font-size:11.5px;color:var(--mnx-muted)}
    #mnx-md-overlay .mnx-md-check{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px;color:var(--mnx-text);cursor:pointer}
    /* block breakdown (weak areas) */
    #mnx-md-overlay .mnx-brk-sub{font-size:12.5px;color:var(--mnx-muted);margin:-4px 0 14px}
    #mnx-md-overlay .mnx-brk-row{display:grid;grid-template-columns:1fr auto;gap:5px 12px;align-items:center;padding:10px 0;border-top:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-brk-row:first-of-type{border-top:none}
    #mnx-md-overlay .mnx-brk-name{font-size:13px;font-weight:600;color:var(--mnx-text)}
    #mnx-md-overlay .mnx-brk-pct{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
    #mnx-md-overlay .mnx-brk-bar{grid-column:1/2;height:8px;border-radius:5px;background:var(--mnx-surface-2);overflow:hidden}
    #mnx-md-overlay .mnx-brk-fill{height:100%;border-radius:5px}
    #mnx-md-overlay .mnx-brk-meta{grid-column:2/3;display:flex;align-items:center;gap:12px;justify-self:end}
    #mnx-md-overlay .mnx-brk-count{font-size:11.5px;color:var(--mnx-muted);font-variant-numeric:tabular-nums}
    #mnx-md-overlay .mnx-brk-open{font-size:12px;font-weight:600;color:var(--mnx-accent);background:none;border:none;cursor:pointer;padding:0;white-space:nowrap}
    #mnx-md-overlay .mnx-brk-open:hover{text-decoration:underline}
    #mnx-md-overlay .mnx-kb{display:flex;flex-direction:column}
    #mnx-md-overlay .mnx-kb-row{display:grid;grid-template-columns:158px 1fr;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--mnx-border)}
    #mnx-md-overlay .mnx-kb-row:first-child{border-top:none}
    #mnx-md-overlay .mnx-kb-keys{display:flex;gap:4px;flex-wrap:wrap}
    #mnx-md-overlay .mnx-kb kbd{font:700 11px var(--mnx-font);background:var(--mnx-surface-2);border:1px solid var(--mnx-border);border-bottom-width:2px;border-radius:5px;padding:2px 7px;color:var(--mnx-ink);min-width:14px;text-align:center}
    #mnx-md-overlay .mnx-kb-desc{font-size:12.5px;color:var(--mnx-text)}
    #mnx-selchip{position:fixed;z-index:2147483647;display:none;align-items:center;gap:6px;background:var(--mnx-accent);color:#fff;border:none;border-radius:var(--mnx-r-sm);padding:8px 13px;font-family:var(--mnx-font);font-size:12.5px;font-weight:700;cursor:pointer;box-shadow:var(--mnx-shadow)}
    #mnx-selchip:hover{background:var(--mnx-accent-600)}
  `;
  document.documentElement.appendChild(style);

  // ---------- dark mode + expected score ----------
  let darkMode = false;
  let esOn = false;
  let easyOn = false;
  let hyOn = false;
  const DEFAULT_AI_PROMPT = "I'm studying for the USMLE. Below is a question with its answer choices and explanation. Explain the correct answer and why each other option is wrong, then give me the single highest-yield fact to remember. Be concise.";
  let aiPrompt = DEFAULT_AI_PROMPT;   // prepended to "Copy for AI"
  let kbShortcuts = true;             // review-page action hotkeys
  function applyTheme() {
    document.documentElement.classList.toggle("mnx-dark", darkMode);   // flips design tokens
    const p = document.getElementById(PANEL_ID); if (p) p.classList.toggle("mnx-dark", darkMode);
    const o = document.getElementById(OVERLAY_ID); if (o) o.classList.toggle("mnx-dark", darkMode);
  }
  chrome.storage.local.get({ dark: false, expectedScore: false, easy: false, highYield: false, aiPrompt: DEFAULT_AI_PROMPT, kbShortcuts: true }, c => { darkMode = !!c.dark; esOn = !!c.expectedScore; easyOn = !!c.easy; hyOn = !!c.highYield; aiPrompt = c.aiPrompt == null ? DEFAULT_AI_PROMPT : c.aiPrompt; kbShortcuts = c.kbShortcuts !== false; applyTheme(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.dark) { darkMode = !!changes.dark.newValue; applyTheme(); }
    if (changes.expectedScore) { esOn = !!changes.expectedScore.newValue; }
    if (changes.easy) { easyOn = !!changes.easy.newValue; }
    if (changes.highYield) { hyOn = !!changes.highYield.newValue; }
    if ("aiPrompt" in changes) { aiPrompt = changes.aiPrompt.newValue == null ? "" : changes.aiPrompt.newValue; }
    if (changes.kbShortcuts) { kbShortcuts = changes.kbShortcuts.newValue !== false; }
  });

  function toast(text) {
    const t = document.createElement("div");
    t.className = "mnx-toast";
    t.textContent = text;
    (document.body || document.documentElement).appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  // ============================================================
  // FEATURE 1 - buttons on the test RESULTS page
  // ============================================================
  // The "Question List" modal lists every QID with colour (green=correct,
  // red=incorrect, blue=omitted) and a flag icon on marked ones - it's both
  // complete (no 10-row pagination) and the only place marked status shows. So
  // prefer it when open; fall back to the paginated results table otherwise.
  function questionListRoot() {
    let best = null;
    for (const el of document.querySelectorAll("div, section, [role=dialog]")) {
      const t = el.textContent || "";
      if (t.length > 8000) continue;
      if (/correct/i.test(t) && /incorrect/i.test(t) && /marked/i.test(t) && /omitted/i.test(t)) {
        if (!best || t.length < best.textContent.length) best = el;
      }
    }
    return best;
  }
  // Status is carried by Coursology's Tailwind text-colour class on each QID span
  // (verified on the live modal); fall back to the computed colour just in case.
  function elColorStatus(el) {
    const cls = (el.className && el.className.baseVal != null) ? el.className.baseVal : (el.className || "");
    if (/text-red/i.test(cls)) return "wrong";
    if (/text-lime|text-green/i.test(cls)) return "correct";
    if (/text-sky|text-blue/i.test(cls)) return "omitted";
    let c; try { c = getComputedStyle(el).color; } catch (e) { return ""; }
    const m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return "";
    const r = +m[1], g = +m[2], b = +m[3];
    if (r > 130 && r > g + 40 && r > b + 40) return "wrong";
    if (g > 110 && g > r + 25 && g > b + 5) return "correct";
    if (b > 130 && b > r + 30 && b > g + 20) return "omitted";
    return "";
  }
  // Marked QIDs carry an inline flag icon INSIDE the span (e.g. <svg data-icon="flag">).
  function elHasFlag(el) {
    return !!(el.querySelector && el.querySelector("svg, [data-icon='flag'], [class*='fa-flag'], [class*='flag']"));
  }
  function ownNumber(el) {                       // the element's own text, if it's just a QID
    let s = "";
    el.childNodes.forEach(n => { if (n.nodeType === 3) s += n.nodeValue; });
    const m = s.trim().match(/^(\d{1,7})\s*,?\s*$/);
    return m ? m[1] : null;
  }
  function parseQuestionList() {
    const root = questionListRoot();
    if (!root) return null;
    const rows = []; const seen = new Set();
    root.querySelectorAll("*").forEach(el => {
      const qid = ownNumber(el);
      if (!qid || seen.has(qid)) return;
      seen.add(qid);
      const st = elColorStatus(el);
      rows.push({ qid, wrong: st === "wrong", correct: st === "correct", omitted: st === "omitted", marked: elHasFlag(el) });
    });
    return rows.length ? rows : null;
  }
  // The Question List popup is a Radix element with NO role=dialog that closes
  // the instant you click a button outside it - so at click-time it's gone. We
  // cache its contents while it's on screen (captureQuestionList, each tick) and
  // read the cache at click-time. Keyed by path so it never leaks across tests.
  let qlistCache = null;   // { path, rows }
  function captureQuestionList() {
    let present = false;                                   // cheap gate: a radix popover showing the legend
    for (const el of document.querySelectorAll("[id^='radix-']")) {
      if (/Omitted/i.test(el.textContent || "")) { present = true; break; }
    }
    if (!present) return;
    const rows = parseQuestionList();
    if (rows && rows.length) qlistCache = { path: location.pathname, rows };
  }
  function questionListData() {
    const live = parseQuestionList();
    if (live && live.length) { qlistCache = { path: location.pathname, rows: live }; return live; }
    if (qlistCache && qlistCache.path === location.pathname) return qlistCache.rows;
    return null;
  }
  function resultData() { return questionListData() || COURSO.resultRows(); }
  function collectAll() { return resultData().map(r => r.qid); }
  function collectMissed() { return resultData().filter(r => r.wrong).map(r => r.qid); }

  // ---- block breakdown: read the results table's Subject/System/Topic columns ----
  function findResultColumns() {
    for (const table of document.querySelectorAll("table")) {
      const heads = Array.from(table.querySelectorAll("thead th, thead td, tr:first-child th, tr:first-child td"));
      const idx = {};
      heads.forEach((h, i) => {
        const t = (h.textContent || "").trim().toLowerCase();
        if (t === "id" && idx.id == null) idx.id = i;
        else if (/^subject/.test(t) && idx.subject == null) idx.subject = i;
        else if (/^system/.test(t) && idx.system == null) idx.system = i;
        else if (/^topic/.test(t) && idx.topic == null) idx.topic = i;
      });
      if (idx.id == null) continue;
      const body = Array.from(table.querySelectorAll("tbody tr"));
      const rows = body.length ? body : Array.from(table.querySelectorAll("tr")).slice(1);
      return { idx, rows };
    }
    return null;
  }
  function blockRows() {
    const loc = findResultColumns();
    if (!loc) return [];
    const cell = (tr, i) => { const c = i != null ? tr.children[i] : null; return c ? (c.textContent || "").trim() : ""; };
    const out = []; const seen = new Set();
    loc.rows.forEach(tr => {
      const idCell = tr.children[loc.idx.id]; if (!idCell) return;
      const m = (idCell.textContent || "").match(/\d+/); if (!m || seen.has(m[0])) return; seen.add(m[0]);
      out.push({ qid: m[0], wrong: rowIsWrong(tr, idCell), subject: cell(tr, loc.idx.subject), system: cell(tr, loc.idx.system), topic: cell(tr, loc.idx.topic) });
    });
    return out;
  }
  function aggregateBy(rows, key) {
    const map = new Map();
    rows.forEach(r => {
      const name = (r[key] || "").trim() || "—";
      let g = map.get(name); if (!g) { g = { name, total: 0, wrong: 0, wrongQids: [] }; map.set(name, g); }
      g.total++; if (r.wrong) { g.wrong++; g.wrongQids.push(r.qid); }
    });
    const arr = Array.from(map.values());
    arr.forEach(g => { g.correct = g.total - g.wrong; g.acc = g.total ? g.correct / g.total : 0; });
    arr.sort((a, b) => a.acc - b.acc || b.total - a.total);   // weakest first
    return arr;
  }
  function accColor(a) { return a >= 0.75 ? "var(--mnx-good)" : a >= 0.5 ? "var(--mnx-warn)" : "var(--mnx-bad)"; }
  function openBreakdown() {
    const rows = blockRows();
    if (!rows.length) { toast("Couldn't read the results table — open the test results (and set the page size to All)."); return; }
    const dims = [["system", "System"], ["subject", "Subject"], ["topic", "Topic"]].filter(([k]) => rows.some(r => r[k]));
    if (!dims.length) { toast("No Subject/System/Topic columns found on this results table."); return; }
    let key = dims[0][0];
    const m = buildModal("Block breakdown — weakest first");
    let seg;
    if (dims.length > 1) {
      seg = document.createElement("div"); seg.className = "mnx-seg"; seg.style.marginBottom = "8px";
      dims.forEach(([k, label]) => {
        const b = document.createElement("button"); b.type = "button"; b.textContent = label; if (k === key) b.className = "on";
        b.addEventListener("click", () => { key = k; Array.from(seg.children).forEach(c => c.classList.remove("on")); b.classList.add("on"); render(); });
        seg.appendChild(b);
      });
      m.body.appendChild(seg);
    }
    const sub = document.createElement("div"); sub.className = "mnx-brk-sub";
    const list = document.createElement("div");
    m.body.appendChild(sub); m.body.appendChild(list);
    function render() {
      const groups = aggregateBy(rows, key);
      const total = rows.length, correct = rows.filter(r => !r.wrong).length;
      const pag = (total === 10 || total === 20 || total === 25) ? " · set page size to All for the whole block" : "";
      sub.textContent = total + " questions · " + correct + " correct (" + Math.round(100 * correct / total) + "%)" + pag;
      list.replaceChildren();
      groups.forEach(g => {
        const row = document.createElement("div"); row.className = "mnx-brk-row";
        const name = document.createElement("div"); name.className = "mnx-brk-name"; name.textContent = g.name;
        const pct = document.createElement("div"); pct.className = "mnx-brk-pct"; pct.textContent = Math.round(g.acc * 100) + "%"; pct.style.color = accColor(g.acc);
        const bar = document.createElement("div"); bar.className = "mnx-brk-bar";
        const fill = document.createElement("div"); fill.className = "mnx-brk-fill"; fill.style.width = Math.round(g.acc * 100) + "%"; fill.style.background = accColor(g.acc); bar.appendChild(fill);
        const meta = document.createElement("div"); meta.className = "mnx-brk-meta";
        const cnt = document.createElement("span"); cnt.className = "mnx-brk-count"; cnt.textContent = g.correct + "/" + g.total; meta.appendChild(cnt);
        if (g.wrongQids.length) {
          const open = document.createElement("button"); open.type = "button"; open.className = "mnx-brk-open";
          open.textContent = "Open " + g.wrongQids.length + " missed";
          open.addEventListener("click", () => runBrowse(g.wrongQids));
          meta.appendChild(open);
        }
        row.appendChild(name); row.appendChild(pct); row.appendChild(bar); row.appendChild(meta);
        list.appendChild(row);
      });
    }
    render();
    m.foot.appendChild(mdButton("Open all missed", "mnx-md-cancel", () => runBrowse(rows.filter(r => r.wrong).map(r => r.qid))));
    m.foot.appendChild(mdButton("Close", "mnx-md-ok", m.close));
  }
  // Marked status only exists in the Question List popup - so require it (cached
  // is fine); the results table can't tell us which questions were flagged.
  function runMarked() {
    const d = questionListData();
    if (!d) { toast("Open the test's “Question List” once so I can read your flagged questions, then click Anki: Marked again."); return; }
    const qids = d.filter(r => r.marked).map(r => r.qid);
    if (!qids.length) { toast("No marked questions in this test."); return; }
    runBrowse(qids);
  }
  function buildTagQuery(qids, sv) {
    return qids.map(q => "tag:#AK_Step" + sv + "_" + ANKING_VER + "::#UWorld::*::" + q).join(" OR ");
  }
  const ANKI_DOWN = "Couldn't reach Anki. Make sure it's open and the Mnestic Bridge add-on is installed.";
  const HY_LEVELS = ["HighYield", "RelativelyHighYield"];
  function runBrowse(qids) {
    if (!qids.length) { toast("No matching questions found on this page."); return; }
    getSv().then(sv => {
      const query = buildTagQuery(qids, sv);
      if (easyOn) { easyUnsuspend(query); return; }
      if (hyOn) { browseHighYield(query); return; }
      bridge("openBrowser", { query }).catch(e => toast(ANKI_DOWN + " (" + e + ")"));
    });
  }
  // High Yield Only (Browse): resolve the exact high-yield card ids, then open
  // the Browser scoped to just those cards. Yield comes from the parsed level,
  // not a tag-text match, so the parent #Low/HighYield tag can't leak in.
  function browseHighYield(query) {
    bridge("cardStats", { queries: [query] }).then(r => {
      const cards = (r && r[0]) || [];
      if (!cards.length) { toast("None of these matched a card in your deck yet."); return; }
      const cids = cards.filter(c => HY_LEVELS.includes(c.yield)).map(c => c.cid).filter(x => x != null);
      if (!cids.length) { toast("No high-yield cards among these questions."); return; }
      bridge("openBrowser", { query: "cid:" + cids.join(",") }).catch(e => toast(ANKI_DOWN + " (" + e + ")"));
    }).catch(e => toast(ANKI_DOWN + " (" + e + ")"));
  }
  // Easy mode: count matches, confirm with the locked number, then unsuspend.
  function easyUnsuspend(query) {
    bridge("cardStats", { queries: [query] }).then(r => {
      let cards = (r && r[0]) || [];
      if (hyOn) cards = cards.filter(c => HY_LEVELS.includes(c.yield));
      const matched = cards.length;
      const locked = cards.filter(c => c.suspended).length;
      if (!matched) { toast(hyOn ? "No high-yield cards among these questions." : "None of these matched a card in your deck yet."); return; }
      if (!locked) { toast("All " + matched + " matching card" + (matched === 1 ? " is" : "s are") + " already in your reviews."); return; }
      showConfirm(matched, locked, () => {
        const params = { queries: [query] };
        if (hyOn) params.yields = HY_LEVELS;
        bridge("unsuspend", params).then(r2 => {
          const n = (r2 && r2[0] && r2[0].unlocked) || 0;
          toast("Added " + n + " card" + (n === 1 ? "" : "s") + " to your reviews.");
        }).catch(e => toast(ANKI_DOWN + " (" + e + ")"));
      });
    }).catch(e => toast(ANKI_DOWN + " (" + e + ")"));
  }
  function showConfirm(matched, locked, onYes) {
    const old = document.getElementById("mnx-confirm"); if (old) old.remove();
    const o = document.createElement("div");
    o.id = "mnx-confirm";
    o.classList.toggle("mnx-dark", darkMode);
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    function close() { document.removeEventListener("keydown", onKey, true); o.remove(); }
    o.addEventListener("click", e => { if (e.target === o) close(); });
    const box = document.createElement("div"); box.className = "mnx-cf-box";
    const h = document.createElement("div"); h.className = "mnx-cf-title"; h.textContent = "Add cards to your reviews?";
    const body = document.createElement("div"); body.className = "mnx-cf-body";
    const subj = matched === locked
      ? ("All " + locked + " matching card" + (locked === 1 ? "" : "s"))
      : (locked + " of " + matched + " matching cards");
    body.textContent = subj + " " + (locked === 1 ? "is" : "are") + " locked. Unlock " + (locked === 1 ? "it" : "them")
      + " so " + (locked === 1 ? "it shows" : "they show") + " up when you study?";
    const btns = document.createElement("div"); btns.className = "mnx-cf-btns";
    const cancel = document.createElement("button"); cancel.className = "mnx-cf-btn mnx-cf-cancel"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    const ok = document.createElement("button"); ok.className = "mnx-cf-btn mnx-cf-ok"; ok.textContent = "Unlock " + locked;
    ok.addEventListener("click", () => { close(); onYes(); });
    btns.appendChild(cancel); btns.appendChild(ok);
    box.appendChild(h); box.appendChild(body); box.appendChild(btns);
    o.appendChild(box);
    (document.body || document.documentElement).appendChild(o);
    document.addEventListener("keydown", onKey, true);
  }
  // High-Yield button: always restrict to high-yield cards (QID tag AND the
  // AnKing #Low/HighYield level), regardless of the popup toggle. Yield is read
  // from the parsed level so the parent tag can't leak in.
  function runBrowseHighYield(qids) {
    if (!qids.length) { toast("No matching questions found on this page."); return; }
    getSv().then(sv => browseHighYield(buildTagQuery(qids, sv)));
  }
  function makeBtn(label, getQids, runner) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "review-button mnx-btn";
    b.addEventListener("click", () => (runner || runBrowse)(getQids()));
    return b;
  }
  function addButtons(toolbar) {
    const host = document.createElement("span");
    host.id = BTN_HOST_ID;
    host.appendChild(makeBtn("Anki: Missed", () => collectMissed()));          // wrong questions
    host.appendChild(makeBtn("Anki: All", () => collectAll()));                // every question on the page
    host.appendChild(makeBtn("Anki: Marked", () => null, runMarked));          // flagged questions (from Question List)
    const hy = makeBtn("Anki: High-Yield", () => collectAll(), runBrowseHighYield);
    hy.classList.add("mnx-hy");                                              // high-yield cards only
    host.appendChild(hy);
    const brk = makeBtn("📊 Weak areas", () => [], () => openBreakdown());     // per-system accuracy breakdown
    brk.classList.add("mnx-brkbtn");
    host.appendChild(brk);
    toolbar.appendChild(host);
  }

  // ============================================================
  // FEATURE 2 - resource table + image overlay on the REVIEW page
  // ============================================================
  // Resources shown in the review panel. The panel only renders the ones that
  // actually have content for a given question, so listing Step-1 and Step-2
  // resources together is safe: OME/Picmonic light up on Step 2/3, the rest on
  // Step 1. (All fields exist on the shared AnKingOverhaul note type.)
  const RESOURCES = [
    { label: "Sketchy",         color: "#1aa7e0", fields: ["Sketchy", "Sketchy 2", "Sketchy Extra"], tag: "#Sketchy" },
    { label: "Boards & Beyond", color: "#2f9e44", fields: ["Boards & Beyond", "Boards and Beyond", "B&B"], tag: ["#B&B", "#BoardsandBeyond", "#Boards_and_Beyond"] },
    { label: "OME",             color: "#ef6c3b", fields: ["OME"], tag: "#OME" },
    { label: "Bootcamp",        color: "#8e63d6", fields: ["Bootcamp"], tag: "#Bootcamp" },
    { label: "Physeo",          color: "#27a39a", fields: ["Physeo"], tag: "#Physeo" },
    { label: "Pixorize",        color: "#ec6aa0", fields: ["Pixorize"], tag: "#Pixorize" },
    { label: "Picmonic",        color: "#7b5cf6", fields: ["Picmonic"], tag: "#Picmonic" },
    { label: "First Aid",       color: "#f0a020", fields: ["First Aid"], tag: "#FirstAid" }
  ];
  // Image overlay sources: each key is the hotkey, `fields` are the AnKing field
  // names whose <img> tags get pulled. Field names confirmed against the live
  // AnKingOverhaul note type (2026-06-15). Add a row here on any unused letter
  // to expose more (e.g. Physeo / OME also carry images).
  const IMG_SOURCES = {
    F: { label: "First Aid",            fields: ["First Aid"] },
    S: { label: "Sketchy",              fields: ["Sketchy", "Sketchy 2", "Sketchy Extra"] },
    P: { label: "Physeo",               fields: ["Physeo"] },
    O: { label: "OME",                  fields: ["OME"] },
    E: { label: "Extra",                fields: ["Extra"] },
    A: { label: "Additional Resources", fields: ["Additional Resources"] }
  };
  function emptyFiles() { const o = {}; for (const k in IMG_SOURCES) o[k] = []; return o; }
  function emptyUris() { const o = {}; for (const k in IMG_SOURCES) o[k] = null; return o; }
  let lastQid = null;
  let currentFiles = emptyFiles();
  let cachedUris = emptyUris();
  let currentNotes = [];          // AnKing notes matched to the current QID (for preview / save)
  const dedupe = a => Array.from(new Set(a));

  // The review player prints "Question Id: NNNNN" in its header. We read that to
  // key every per-question feature (resource panel, overlay, copy buttons). The
  // scopes in COURSO.headerSel are tried first (cheaper), then document.body.
  function findQid() {
    const re = /Question\s*Id:\s*(\d+)/i;
    for (const sel of COURSO.headerSel) {
      const el = document.querySelector(sel);
      if (el) { const m = (el.textContent || "").match(re); if (m) return m[1]; }
    }
    return null;
  }
  // On Coursology we show resources only while reviewing an answered question
  // (so we never spoil an unanswered one) and only once a QID is on the page.
  function isAnswered() {
    return COURSO.isReviewing() && !!findQid();
  }
  function cleanSeg(s) {
    return s
      .replace(/^[!*\s]+/, "")        // leading ! or * markers
      .replace(/^\d+[_\-.]\s*/, "")   // leading number prefix: 03_  06-  1.
      .replace(/_/g, " ")
      .trim();
  }
  function isNoiseSeg(s) {
    return /^\^/.test(s)                  // tracking tags: ^physeo_image_update, ^Missing_image
        || /retired/i.test(s)             // ##_Retired_Lessons
        || /old[\s_]*version/i.test(s)    // [OLD VERSION]
        || /\[old/i.test(s)
        || /alt[_\s]*tagging/i.test(s)    // 03_Neoplasia_Alt_Tagging
        || /^pathoma\s*20\d{2}/i.test(s)  // Pathoma2018 (old edition)
        || /^20\d{2}$/.test(s);           // a bare old-edition year
  }
  function tagPaths(tags, needles) {
    const arr = (Array.isArray(needles) ? needles : [needles]).map(s => s.toLowerCase());
    const out = [];
    for (const t of (tags || [])) {
      const tl = t.toLowerCase();
      if (!arr.some(nd => tl.includes(nd))) continue;
      const seg = t.split("::");
      const rest = seg.slice(2);                  // chapters after #AK_Step1_v12::<resource>
      if (!rest.length || rest.some(isNoiseSeg)) continue;
      let cleaned = rest.map(cleanSeg).filter(Boolean);
      if (cleaned.length > 1 && /^extra$/i.test(cleaned[cleaned.length - 1])) cleaned.pop();
      if (!cleaned.length) continue;
      out.push(cleaned.slice(-3));               // keep the last 3 segments
    }
    return out;
  }
  // Resolve a field by name, case-insensitively, so capitalization/spacing drift
  // across AnKing deck versions still matches.
  function getField(note, name) {
    if (!note || !note.fields) return null;
    if (note.fields[name]) return note.fields[name];
    const lower = name.toLowerCase();
    for (const k in note.fields) if (k.toLowerCase() === lower) return note.fields[k];
    return null;
  }
  function fieldAnchors(note, names) {
    const out = [];
    const parser = new DOMParser();
    names.forEach(n => {
      const f = getField(note, n);
      if (!f || !f.value) return;
      const doc = parser.parseFromString(f.value, "text/html");
      doc.querySelectorAll("a[href]").forEach(a => {
        const href = a.getAttribute("href");
        if (href) out.push({ href, text: a.textContent.trim() || href });
      });
    });
    return out;
  }
  function fieldImages(note, names) {
    const out = [];
    const parser = new DOMParser();
    names.forEach(n => {
      const f = getField(note, n);
      if (!f || !f.value) return;
      const doc = parser.parseFromString(f.value, "text/html");
      doc.querySelectorAll("img[src]").forEach(img => {
        const src = img.getAttribute("src");
        if (src) out.push(src);
      });
    });
    return out;
  }
  function mimeFor(fn) {
    const ext = (fn.split(".").pop() || "").toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "svg") return "image/svg+xml";
    return "image/png";
  }
  async function fetchImages(files) {
    const uris = [];
    for (const fn of files) {
      try {
        const b64 = await bridge("readMedia", { filename: fn });
        if (b64) uris.push("data:" + mimeFor(fn) + ";base64," + b64);
      } catch (e) { /* skip a file we can't fetch */ }
    }
    return uris;
  }
  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) { panel.classList.toggle("mnx-dark", darkMode); return panel; }
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    if (darkMode) panel.classList.add("mnx-dark");
    const anchor = COURSO.panelAnchor();
    if (anchor) anchor.appendChild(panel);
    else { panel.classList.add("mnx-float"); document.body.appendChild(panel); }
    return panel;
  }
  // If the qbank squashes or hides the in-flow card, pop it out as a floating card.
  function ensureVisible() {
    const p = document.getElementById(PANEL_ID);
    if (!p || p.classList.contains("mnx-float")) return;
    const r = p.getBoundingClientRect();
    if (p.offsetParent === null || r.height < 2 || r.width < 2) {
      p.classList.add("mnx-float");
      document.body.appendChild(p);
    }
  }
  function akNorm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  function akLinkTopic(text) {
    return akNorm(text)
      .replace(/^watch\s+/, "").replace(/^associated\s+/, "")
      .replace(/^(bootcamp|sketchy)\s+/, "").replace(/^video\s+/, "").trim();
  }
  function akTokens(s) { return akNorm(s).split(" ").filter(w => w.length > 2); }
  function akClose(a, b) {            // true if within ~1 character edit (typo tolerance)
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    if (i < a.length || j < b.length) edits++;
    return edits <= 1;
  }
  function akTokenFound(w, arr) {
    for (const t of arr) { if (w === t) return true; if (w.length >= 4 && akClose(w, t)) return true; }
    return false;
  }
  function makeLink(href, text, cls) {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = text; if (cls) a.className = cls;
    return a;
  }
  // grouped-by-chapter view; a leaf gets an inline "Watch" if a video link matches it
  function renderResource(td, paths, links) {
    links = links.slice();
    if (!paths.length) {
      links.forEach(l => td.appendChild(makeLink(l.href, l.text, "mnx-link")));
      return;
    }
    const leaves = paths.map(segs => ({ parent: segs.slice(0, -1).join(" \u203A "), leaf: segs[segs.length - 1] }));
    const linkTokens = links.map(l => akTokens(akLinkTopic(l.text)));
    const TH = 0.6;                 // a topic matches a video if >=60% of its words appear in it
    const pairs = [];
    leaves.forEach((lf, li) => {
      const L = akTokens(lf.leaf);
      if (!L.length) return;
      links.forEach((lk, ki) => {
        let hit = 0; for (const w of L) if (akTokenFound(w, linkTokens[ki])) hit++;
        const score = hit / L.length;
        if (score >= TH) pairs.push({ li, ki, score });
      });
    });
    pairs.sort((a, b) => b.score - a.score);   // assign strongest matches first
    const used = new Set(), usedLeaf = new Set();
    for (const p of pairs) {
      if (usedLeaf.has(p.li) || used.has(p.ki)) continue;
      leaves[p.li].watch = links[p.ki].href;
      usedLeaf.add(p.li); used.add(p.ki);
    }
    const order = []; const groups = new Map();
    for (const lf of leaves) {
      if (!groups.has(lf.parent)) { groups.set(lf.parent, []); order.push(lf.parent); }
      groups.get(lf.parent).push(lf);
    }
    for (const parent of order) {
      const g = document.createElement("div");
      g.className = "mnx-group";
      if (parent) {
        const ph = document.createElement("div");
        ph.className = "mnx-parent"; ph.textContent = parent;
        g.appendChild(ph);
      }
      for (const lf of groups.get(parent)) {
        const r = document.createElement("div");
        r.className = "mnx-leaf-row";
        const ls = document.createElement("span");
        ls.className = "mnx-leaf"; ls.textContent = lf.leaf;
        r.appendChild(ls);
        if (lf.watch) r.appendChild(makeLink(lf.watch, "Watch", "mnx-watch"));
        g.appendChild(r);
      }
      td.appendChild(g);
    }
    const leftover = links.filter((_, i) => !used.has(i));
    if (leftover.length) {
      const g = document.createElement("div");
      g.className = "mnx-group";
      leftover.forEach(l => g.appendChild(makeLink(l.href, l.text, "mnx-link")));
      td.appendChild(g);
    }
  }
  function renderRows(qid, rows, msg) {
    const panel = ensurePanel();
    panel.replaceChildren();
    addPanelHeader(qid);
    if (msg) {
      const n = document.createElement("div"); n.className = "mnx-msg"; n.textContent = msg; panel.appendChild(n); ensureVisible(); return;
    }
    if (!rows || !rows.length) {
      const n = document.createElement("div"); n.className = "mnx-msg";
      n.textContent = "No AnKing resources found for this question."; panel.appendChild(n); ensureVisible(); return;
    }
    const table = document.createElement("table");
    const tb = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.className = "mnx-res";
      td1.textContent = row.R.label;
      td1.style.borderLeftColor = row.R.color;
      const td2 = document.createElement("td");
      renderResource(td2, row.paths, row.links);
      tr.appendChild(td1); tr.appendChild(td2);
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    panel.appendChild(table);
    ensureVisible();
  }
  function addImageHint() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const bits = [];
    for (const k in IMG_SOURCES) {
      if (currentFiles[k] && currentFiles[k].length) bits.push(k + " = " + IMG_SOURCES[k].label);
    }
    let txt = bits.length ? ("Images - press " + bits.join("  /  ") + "  (press again, Esc, or X to close)") : "";
    if (kbShortcuts) txt += (txt ? "   ·   " : "") + "Press ? for shortcuts";
    if (!txt) return;
    const n = document.createElement("div");
    n.className = "mnx-note";
    n.textContent = txt;
    panel.appendChild(n);
  }
  async function buildTable(qid) {
    currentFiles = emptyFiles();
    cachedUris = emptyUris();
    currentNotes = [];
    hideOverlay();

    let sv; try { sv = await getSv(); } catch (e) { sv = 1; }
    const query = "tag:#AK_Step" + sv + "_" + ANKING_VER + "::#UWorld::*::" + qid;
    let nids;
    try { nids = await bridge("searchNotes", { query }); }
    catch (e) { renderRows(qid, null, "Couldn't reach Anki. Make sure it's open and the Mnestic Bridge add-on is installed. (" + e + ")"); return; }
    if (!nids.length) { renderRows(qid, []); return; }
    let notes;
    try { notes = await bridge("noteInfo", { notes: nids }); }
    catch (e) { renderRows(qid, null, "Anki error: " + e); return; }
    currentNotes = notes || [];

    const rows = [];
    for (const R of RESOURCES) {
      const links = []; const paths = []; const seenP = new Set();
      for (const note of notes) {
        fieldAnchors(note, R.fields).forEach(l => links.push(l));
        tagPaths(note.tags, R.tag).forEach(p => { const k = p.join(" \u203A "); if (!seenP.has(k)) { seenP.add(k); paths.push(p); } });
      }
      const seen = new Set();
      const ulinks = links.filter(l => !seen.has(l.href) && seen.add(l.href));
      if (ulinks.length || paths.length) rows.push({ R, links: ulinks, paths });
    }
    renderRows(qid, rows);

    for (const key of Object.keys(IMG_SOURCES)) {
      const fnames = [];
      for (const note of notes) fieldImages(note, IMG_SOURCES[key].fields).forEach(f => fnames.push(f));
      currentFiles[key] = dedupe(fnames);
    }
    addImageHint();
    ensureVisible();
    if (esOn) addExpectedLine(qid);
  }

  // ---------- image overlay (modal with X / backdrop / Esc) ----------
  function ensureOverlay() {
    let o = document.getElementById(OVERLAY_ID);
    if (o) { o.classList.toggle("mnx-dark", darkMode); return o; }
    o = document.createElement("div");
    o.id = OVERLAY_ID;
    if (darkMode) o.classList.add("mnx-dark");
    o.addEventListener("click", e => { if (e.target === o) hideOverlay(); }); // click backdrop closes
    document.body.appendChild(o);
    return o;
  }
  function hideOverlay() {
    const o = document.getElementById(OVERLAY_ID);
    if (o) { o.style.display = "none"; o.replaceChildren(); } // drop image data so Brave can free it
  }
  function buildHead(o, label, key) {
    const head = document.createElement("div");
    head.className = "mnx-ovl-head";
    const title = document.createElement("span");
    const b = document.createElement("b"); b.textContent = label;
    const hint = document.createElement("span"); hint.className = "mnx-ovl-hint";
    hint.textContent = "press " + key + " or Esc to close";
    title.appendChild(b); title.appendChild(hint);
    const x = document.createElement("button");
    x.className = "mnx-x"; x.textContent = "\u00d7"; x.title = "Close";
    x.addEventListener("click", () => hideOverlay());
    head.appendChild(title); head.appendChild(x);
    return head;
  }
  function renderOverlayMessage(o, label, key, msg) {
    o.dataset.key = key; o.style.display = "flex"; o.replaceChildren();
    const dlg = document.createElement("div"); dlg.className = "mnx-dialog";
    dlg.appendChild(buildHead(o, label, key));
    const n = document.createElement("div"); n.textContent = msg; dlg.appendChild(n);
    o.appendChild(dlg);
  }
  function renderOverlay(o, key, label) {
    o.dataset.key = key; o.style.display = "flex"; o.replaceChildren();
    const dlg = document.createElement("div"); dlg.className = "mnx-dialog";
    dlg.appendChild(buildHead(o, label, key));
    const uris = cachedUris[key] || [];
    if (!uris.length) {
      const n = document.createElement("div"); n.textContent = "(couldn't load images)"; dlg.appendChild(n);
    } else {
      uris.forEach(u => { const img = document.createElement("img"); img.src = u; img.className = "mnx-ovl-img"; dlg.appendChild(img); });
    }
    o.appendChild(dlg);
  }
  async function showImages(key) {
    const src = IMG_SOURCES[key];
    const existing = document.getElementById(OVERLAY_ID);
    if (existing && existing.style.display === "flex" && existing.dataset.key === key) {
      hideOverlay(); return; // same key hides it
    }
    if (!lastQid) return;
    const files = currentFiles[key] || [];
    if (!files.length) { toast("No " + src.label + " image for this question."); return; }
    const o = ensureOverlay();
    if (!cachedUris[key]) {
      renderOverlayMessage(o, src.label, key, "Loading...");
      cachedUris[key] = await fetchImages(files);
    }
    renderOverlay(o, key, src.label);
  }
  document.addEventListener("keydown", e => {
    const o = document.getElementById(OVERLAY_ID);
    const k = (e.key || "").toLowerCase();
    if (k === "escape") { const su = document.getElementById(SUMMARY_ID); if (su && su.style.display === "flex") closeSummary(); if (o && o.style.display === "flex") hideOverlay(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tgt = e.target;
    const tag = ((tgt && tgt.tagName) || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || (tgt && tgt.isContentEditable)) return;
    if (document.getElementById("mnx-md-overlay")) return;   // a dialog is open — don't hijack keys
    if (e.key === "?") { showShortcutHelp(); e.preventDefault(); return; }
    if (k.length !== 1) return;
    const up = k.toUpperCase();
    if (IMG_SOURCES[up]) { showImages(up); return; }          // F/S/P/O/E/A image overlays
    if (!kbShortcuts) return;
    const qid = findQid();
    if (up === "G") { openMakeCardDialog(String((window.getSelection && window.getSelection()) || "")); e.preventDefault(); }        // make card
    else if (up === "Q" && qid) { copyFullQuestion(qid); e.preventDefault(); }                                                      // copy for AI
    else if (up === "V" && qid) { openSaveDialog(qid); e.preventDefault(); }                                                        // save to Missed Qs
    else if (up === "D" && qid) { openInAnki(qid); e.preventDefault(); }                                                            // open in Anki
  });
  // small keyboard cheatsheet (press ?)
  function showShortcutHelp() {
    const m = buildModal("Keyboard shortcuts");
    const rows = [
      ["G", "Make a card (uses your text selection)"],
      ["Q", "Copy for AI"],
      ["V", "Save to Missed Qs"],
      ["D", "Open this question's cards in Anki"],
      ["F S P O E A", "Overlay First Aid / Sketchy / Physeo / OME / Extra / Additional images"],
      ["Esc", "Close a dialog or image overlay"],
      ["?", "Show this help"]
    ];
    const tbl = document.createElement("div"); tbl.className = "mnx-kb";
    rows.forEach(([keys, desc]) => {
      const r = document.createElement("div"); r.className = "mnx-kb-row";
      const kk = document.createElement("div"); kk.className = "mnx-kb-keys";
      keys.split(" ").forEach(one => { const kb = document.createElement("kbd"); kb.textContent = one; kk.appendChild(kb); });
      const dd = document.createElement("span"); dd.className = "mnx-kb-desc"; dd.textContent = desc;
      r.appendChild(kk); r.appendChild(dd); tbl.appendChild(r);
    });
    m.body.appendChild(tbl);
    const note = document.createElement("div"); note.className = "mnx-md-hint"; note.style.marginTop = "10px";
    note.textContent = "Keys are ignored while you're typing in a field. Toggle these off in the popup.";
    m.body.appendChild(note);
    m.foot.appendChild(mdButton("Close", "mnx-md-ok", m.close));
  }

  // ============================================================
  // FEATURE 2b - card preview, copy-Q, and "Save to Missed Qs"
  // The review-page note-taking workflow: read the card, copy the question, or
  // duplicate the matched card into a chapter deck with your note appended.
  // Uses currentNotes (set by buildTable) + the bridge write actions.
  // ============================================================
  const MISSED_TAG = "Mnestic::Missed";
  let deckCache = null;                 // cached deckNames list from the bridge

  function revealCloze(html) {          // we're past the answer, so show clozes
    return (html || "").replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/gis, '<span class="cloze">$1</span>');
  }
  function stripScripts(html) {
    return (html || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ on\w+="[^"]*"/gi, "");
  }
  function noteField(note, name) { const f = getField(note, name); return (f && f.value) || ""; }
  function noteSnippet(note) {
    const div = document.createElement("div");
    div.innerHTML = revealCloze(noteField(note, "Text"));
    let t = (div.textContent || "").replace(/\s+/g, " ").trim();
    if (!t) { div.innerHTML = stripScripts(noteField(note, "Extra")); t = (div.textContent || "").replace(/\s+/g, " ").trim(); }
    return t.length > 90 ? t.slice(0, 88) + "…" : (t || ("note " + note.noteId));
  }
  // Read an element's visible text while temporarily hiding our own injected UI
  // (resource panel, modals, the QID button). innerText skips display:none, so
  // we hide → read → restore synchronously, with no visible flicker.
  function readTextWithoutAkuts(root) {
    if (!root) return "";
    const hidden = [];
    root.querySelectorAll("[id^='mnx-']").forEach(el => {
      hidden.push([el, el.style.display]);
      el.style.display = "none";
    });
    const text = root.innerText || root.textContent || "";
    hidden.forEach(([el, d]) => { el.style.display = d; });
    return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Coursology's explanation only (for pasting into a note).
  function explanationText() {
    return readTextWithoutAkuts(document.querySelector("#question-explanation"));
  }
  // The whole question: stem + answer choices + explanation (for an AI assistant).
  function fullQuestionText() {
    return readTextWithoutAkuts(COURSO.contentRoot()) || explanationText();
  }
  function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function mimeToExt(mime) {
    mime = (mime || "").toLowerCase();
    if (mime.indexOf("jpeg") >= 0 || mime.indexOf("jpg") >= 0) return "jpg";
    if (mime.indexOf("gif") >= 0) return "gif";
    if (mime.indexOf("webp") >= 0) return "webp";
    if (mime.indexOf("svg") >= 0) return "svg";
    return "png";
  }

  // ---- generic modal ----
  function buildModal(titleText, onClose) {
    const old = document.getElementById("mnx-md-overlay"); if (old) old.remove();
    const ov = document.createElement("div"); ov.id = "mnx-md-overlay";
    ov.classList.toggle("mnx-dark", darkMode);
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    function close() { document.removeEventListener("keydown", onKey, true); ov.remove(); if (onClose) { try { onClose(); } catch (e) {} } }
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    const md = document.createElement("div"); md.className = "mnx-md";
    const head = document.createElement("div"); head.className = "mnx-md-head";
    const b = document.createElement("b"); b.textContent = titleText;
    const x = document.createElement("button"); x.className = "mnx-md-x"; x.textContent = "×"; x.addEventListener("click", close);
    head.appendChild(b); head.appendChild(x);
    const body = document.createElement("div"); body.className = "mnx-md-body";
    const foot = document.createElement("div"); foot.className = "mnx-md-foot";
    md.appendChild(head); md.appendChild(body); md.appendChild(foot);
    ov.appendChild(md);
    (document.body || document.documentElement).appendChild(ov);
    document.addEventListener("keydown", onKey, true);
    return { ov, body, foot, close };
  }
  function mdButton(label, cls, onClick) {
    const b = document.createElement("button"); b.className = "mnx-md-btn " + cls; b.textContent = label;
    b.addEventListener("click", onClick); return b;
  }

  // ---- Copy to clipboard ----
  function copyText(text, msg) {
    if (!text) { toast("Nothing to copy yet."); return; }
    const done = () => toast(msg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
    } else legacyCopy(text, done);
  }
  // Full question (stem + choices + explanation) + your AI prompt - for an AI assistant.
  function copyFullQuestion(qid) {
    const p = (aiPrompt && aiPrompt.trim()) ? (aiPrompt.trim() + "\n\n") : "";
    const head = "Coursology Question Id: " + qid + "\n" + location.href + "\n\n";
    copyText(p + head + fullQuestionText(), p ? "Copied with your AI prompt — paste to your assistant." : "Full question copied — paste to your assistant.");
  }
  // Explanation only - for adding to your notes.
  function copyExplanation() {
    copyText(explanationText(), "Explanation copied — paste into your note.");
  }
  function legacyCopy(text, done) {
    const ta = document.createElement("textarea"); ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Couldn't copy."); }
    ta.remove();
  }

  // ---- Preview matched cards inline (text only; images live in the F/S/P/E/A overlay).
  // Navigates the whole match list, not just the most relevant card. ----
  // Substantial images on the current question page (vignette + explanation
  // figures), excluding our own UI and small icons. Used by the "From this
  // question" picker to attach an image without snipping.
  function collectQuestionImages() {
    const out = []; const seen = new Set();
    document.querySelectorAll("img").forEach(im => {
      if (im.closest("[id^='mnx-']")) return;               // skip our own UI
      const r = im.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return;               // skip icons / avatars
      const src = im.currentSrc || im.src || "";
      if (!src || /^data:/.test(src) || seen.has(src)) return;
      seen.add(src);
      out.push({ src, inExpl: !!im.closest("#question-explanation") });
    });
    return out;
  }
  // Coursology CDN images are cross-origin and block page reads, so the
  // background worker fetches the bytes (it has the host permission).
  function fetchImageViaBg(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "fetchImage", url }, resp => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError.message);
        if (!resp || !resp.ok) return reject((resp && resp.error) || "fetch failed");
        resolve(resp.dataUrl);
      });
    });
  }

  // Reusable image picker (paste / drop / choose / from-question) shared by
  // Save + Make card. Returns { el, images, handlePaste, upload }. Register
  // handlePaste on the document while the dialog is open (a plain <div> can't
  // receive paste).
  function makeImagePicker(labelText) {
    const images = [];                                   // { dataUrl, mime }
    const wrap = document.createElement("div");
    const lbl = document.createElement("label"); lbl.className = "mnx-md-lbl";
    lbl.textContent = labelText || "Images (paste a screenshot, or click to add)";
    const drop = document.createElement("div"); drop.className = "mnx-img-drop"; drop.tabIndex = 0;
    drop.textContent = "Press Ctrl/⌘+V to paste a screenshot — or click to choose files";
    const fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.multiple = true; fileInput.style.display = "none";
    const thumbs = document.createElement("div"); thumbs.className = "mnx-img-thumbs";
    wrap.appendChild(lbl); wrap.appendChild(drop); wrap.appendChild(fileInput); wrap.appendChild(thumbs);
    function addImageFile(file) {
      if (!file || !/^image\//.test(file.type || "")) return;
      const reader = new FileReader();
      reader.onload = () => { const rec = { dataUrl: reader.result, mime: file.type }; images.push(rec); renderThumb(rec); };
      reader.readAsDataURL(file);
    }
    function renderThumb(rec) {
      const t = document.createElement("div"); t.className = "mnx-img-thumb";
      const img = document.createElement("img"); img.src = rec.dataUrl;
      const x = document.createElement("button"); x.type = "button"; x.className = "mnx-img-x"; x.textContent = "×";
      x.addEventListener("click", () => { const i = images.indexOf(rec); if (i >= 0) images.splice(i, 1); t.remove(); });
      t.appendChild(img); t.appendChild(x); thumbs.appendChild(t);
    }
    function handlePaste(e) {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let used = false;
      for (const it of items) { if (it.type && it.type.indexOf("image") === 0) { const f = it.getAsFile(); if (f) { addImageFile(f); used = true; } } }
      if (used) e.preventDefault();                       // don't also paste the filename as text
    }
    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("mnx-img-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("mnx-img-over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("mnx-img-over"); for (const f of (e.dataTransfer && e.dataTransfer.files) || []) addImageFile(f); });
    fileInput.addEventListener("change", () => { for (const f of fileInput.files) addImageFile(f); fileInput.value = ""; });
    // "From this question" — click a page image's thumbnail to attach it.
    const qImgs = collectQuestionImages();
    if (qImgs.length) {
      const qlbl = document.createElement("div"); qlbl.className = "mnx-md-hint"; qlbl.style.margin = "9px 0 4px";
      qlbl.textContent = "From this question — click to add:";
      const strip = document.createElement("div"); strip.className = "mnx-img-thumbs";
      qImgs.forEach(qi => {
        const t = document.createElement("div"); t.className = "mnx-qthumb";
        t.title = qi.inExpl ? "explanation figure" : "question image";
        const im = document.createElement("img"); im.src = qi.src; im.referrerPolicy = "no-referrer";
        t.appendChild(im);
        t.addEventListener("click", async () => {
          if (t.dataset.added || t.classList.contains("loading")) return;
          t.classList.add("loading");
          try {
            const dataUrl = await fetchImageViaBg(qi.src);
            const rec = { dataUrl, mime: (String(dataUrl).match(/^data:([^;]+)/) || [])[1] || "image/png" };
            images.push(rec); renderThumb(rec);
            t.classList.add("added"); t.dataset.added = "1";
          } catch (e) { toast("Couldn't fetch that image (" + e + ")"); }
          t.classList.remove("loading");
        });
        strip.appendChild(t);
      });
      wrap.appendChild(qlbl); wrap.appendChild(strip);
    }
    async function upload(prefix) {
      const tags = [];
      for (const rec of images) {
        const b64 = String(rec.dataUrl).split(",")[1] || "";
        const fname = (prefix || "coursology") + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + "." + mimeToExt(rec.mime);
        const stored = await bridge("writeMedia", { filename: fname, data: b64 });
        if (stored) tags.push('<img src="' + String(stored).replace(/"/g, "&quot;") + '">');
      }
      return tags;
    }
    return { el: wrap, images, handlePaste, upload };
  }

  // Resolve Anki media filenames in a preview to inline data URIs (lazy + cached),
  // so card images show without a media server. Cheap: a few small fetches/card.
  const mediaCache = {};
  async function resolveMediaImages(container, stillCurrent) {
    for (const img of Array.from(container.querySelectorAll("img"))) {
      const src = img.getAttribute("src") || "";
      if (/^(https?:|data:)/i.test(src)) continue;
      const fn = decodeURIComponent((src.split(/[\\/]/).pop() || "").split("?")[0]);
      if (!fn) { continue; }
      let uri = mediaCache[fn];
      if (uri === undefined) {
        try { const b64 = await bridge("readMedia", { filename: fn }); uri = b64 ? ("data:" + mimeFor(fn) + ";base64," + b64) : null; }
        catch (e) { uri = null; }
        mediaCache[fn] = uri;
      }
      if (stillCurrent && !stillCurrent()) return;        // user navigated away
      if (uri) img.src = uri; else img.remove();
    }
  }

  function openPreview(list, startIdx) {
    list = (list && list.length) ? list : currentNotes;
    if (!list.length) { toast("No card to preview."); return; }
    let idx = Math.min(Math.max(0, startIdx || 0), list.length - 1);
    const m = buildModal("Card preview");
    const nav = document.createElement("div"); nav.className = "mnx-prev-nav";
    const prev = mdButton("‹ Prev", "mnx-md-cancel", () => { idx = (idx - 1 + list.length) % list.length; render(); });
    const counter = document.createElement("span"); counter.className = "mnx-prev-count";
    const next = mdButton("Next ›", "mnx-md-cancel", () => { idx = (idx + 1) % list.length; render(); });
    nav.appendChild(prev); nav.appendChild(counter); nav.appendChild(next);
    if (list.length > 1) m.body.appendChild(nav);
    const content = document.createElement("div"); m.body.appendChild(content);
    function render() {
      counter.textContent = "Card " + (idx + 1) + " of " + list.length;
      const myIdx = idx;
      const note = list[idx];
      content.replaceChildren();
      const text = document.createElement("div"); text.className = "mnx-md-prev";
      text.innerHTML = stripScripts(revealCloze(noteField(note, "Text")));
      content.appendChild(text);
      const extra = stripScripts(noteField(note, "Extra"));
      if (extra.replace(/<[^>]*>/g, "").trim()) {
        const hr = document.createElement("div"); hr.className = "mnx-md-prev";
        hr.style.cssText = "margin-top:12px;padding-top:12px;border-top:1px solid var(--mnx-border)";
        hr.innerHTML = extra; content.appendChild(hr);
      }
      resolveMediaImages(content, () => idx === myIdx);   // inline the card's images
    }
    render();
    m.foot.appendChild(mdButton("Open in Anki", "mnx-md-cancel", () => openInAnki(lastQid)));
    m.foot.appendChild(mdButton("Close", "mnx-md-ok", m.close));
  }

  // ---- Save to Missed Qs (duplicate card into a chapter deck + append note) ----
  function deckLeaf(name) { const p = name.split("::"); return p[p.length - 1]; }
  function akNormDeck(s) { return (s || "").toLowerCase().replace(/^\d+[_\-.\s]*/, "").replace(/[^a-z0-9]+/g, ""); }
  function guessDeck(candidates, note) {
    const tnorm = ((note && note.tags) || []).map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    for (const d of candidates) {
      const leaf = akNormDeck(deckLeaf(d));
      if (leaf.length >= 4 && tnorm.some(t => t.includes(leaf))) return d;
    }
    return null;
  }
  function openSaveDialog(qid) {
    if (!currentNotes.length) { toast("No AnKing card matched this question to save."); return; }
    const m = buildModal("Save to Missed Qs — QID " + qid, () => document.removeEventListener("paste", pics.handlePaste));
    let chosenNote = currentNotes[0];
    const NEW_OPT = "➕ New deck…";
    let candidates = [];

    // 1) card picker (only if several notes matched)
    if (currentNotes.length > 1) {
      const lbl = document.createElement("label"); lbl.className = "mnx-md-lbl";
      lbl.textContent = "Card (" + currentNotes.length + " matched)"; m.body.appendChild(lbl);
      const pick = document.createElement("div"); pick.className = "mnx-pick";
      currentNotes.forEach((note, i) => {
        const row = document.createElement("label");
        const r = document.createElement("input"); r.type = "radio"; r.name = "mnx-note"; r.checked = i === 0;
        r.addEventListener("change", () => { chosenNote = note; refreshDeckGuess(); });
        const span = document.createElement("span"); span.textContent = noteSnippet(note);
        row.appendChild(r); row.appendChild(span); pick.appendChild(row);
      });
      m.body.appendChild(pick);
    }

    // 2) chapter deck
    const dlbl = document.createElement("label"); dlbl.className = "mnx-md-lbl"; dlbl.textContent = "Chapter deck";
    m.body.appendChild(dlbl);
    const sel = document.createElement("select"); m.body.appendChild(sel);
    const newWrap = document.createElement("div"); newWrap.style.cssText = "margin-top:6px;display:none";
    const newInput = document.createElement("input"); newInput.type = "text";
    newInput.placeholder = "e.g. 000001.Missed Qs::02_Respiratory";
    newWrap.appendChild(newInput); m.body.appendChild(newWrap);
    function refreshDeckGuess() { const g = guessDeck(candidates, chosenNote); if (g) sel.value = g; }
    function fillDecks(all) {
      const missed = all.filter(d => /missed/i.test(d));
      candidates = (missed.length ? missed : all).slice().sort();
      sel.replaceChildren();
      candidates.forEach(d => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
      const o = document.createElement("option"); o.value = NEW_OPT; o.textContent = NEW_OPT; sel.appendChild(o);
      chrome.storage.local.get({ akMissedDeck: null }, c => {
        if (c.akMissedDeck && candidates.includes(c.akMissedDeck)) sel.value = c.akMissedDeck;
        else refreshDeckGuess();
      });
    }
    sel.addEventListener("change", () => { newWrap.style.display = sel.value === NEW_OPT ? "block" : "none"; });
    if (deckCache) fillDecks(deckCache);
    else {
      const o = document.createElement("option"); o.textContent = "Loading decks…"; sel.appendChild(o);
      bridge("listDecks").then(d => { deckCache = d || []; fillDecks(deckCache); })
        .catch(e => { deckCache = deckCache || []; sel.replaceChildren();
          const oo = document.createElement("option"); oo.value = NEW_OPT; oo.textContent = NEW_OPT; sel.appendChild(oo);
          newWrap.style.display = "block"; toast("Couldn't list decks (" + e + ")"); });
    }

    // 3) your note (pre-filled with any text you've selected on the page)
    const nlbl = document.createElement("label"); nlbl.className = "mnx-md-lbl";
    nlbl.textContent = "Your note (appended to “Missed Questions”)"; m.body.appendChild(nlbl);
    const ta = document.createElement("textarea");
    ta.value = ((window.getSelection && String(window.getSelection())) || "").trim();
    ta.placeholder = "What you want to remember from this question…"; m.body.appendChild(ta);

    // 3b) images — paste a screenshot straight into the note, or add files
    const pics = makeImagePicker("Images (paste a screenshot, or click to add)");
    m.body.appendChild(pics.el);
    document.addEventListener("paste", pics.handlePaste);   // removed on close (see buildModal onClose)

    // 4) save — upload pasted images to Anki media, then copy the card
    const saveBtn = mdButton("Save copy", "mnx-md-ok", async () => {
      const deck = sel.value === NEW_OPT ? newInput.value.trim() : sel.value;
      if (!deck) { toast("Pick or type a deck."); return; }
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        const imgTags = await pics.upload("coursology-" + qid);
        let noteHtml = ta.value.trim() ? escapeHtml(ta.value.trim()).replace(/\n/g, "<br>") : "";
        if (imgTags.length) noteHtml += (noteHtml ? "<br>" : "") + imgTags.join("<br>");
        const params = { noteId: chosenNote.noteId, deck, addTags: [MISSED_TAG] };
        if (noteHtml) params.fieldAppends = { "Missed Questions": noteHtml };
        await bridge("copyNote", params);
        chrome.storage.local.set({ akMissedDeck: deck });
        if (deckCache && !deckCache.includes(deck)) deckCache.push(deck);
        m.close();
        const extra = imgTags.length ? (" + " + imgTags.length + " image" + (imgTags.length === 1 ? "" : "s")) : "";
        toast("Saved a copy to " + deckLeaf(deck) + (noteHtml ? " with your note" + extra + "." : "."));
      } catch (e) {
        saveBtn.disabled = false; saveBtn.textContent = "Save copy"; toast("Couldn't save (" + e + ")");
      }
    });
    m.foot.appendChild(mdButton("Cancel", "mnx-md-cancel", m.close));
    m.foot.appendChild(saveBtn);
  }

  // ---- panel header (sits atop the resource panel on the review page) ----
  function pbtn(label, cls, onClick) {
    const b = document.createElement("button"); b.className = "mnx-pbtn " + (cls || ""); b.textContent = label;
    b.addEventListener("click", onClick); return b;
  }
  function addPanelHeader(qid) {
    const panel = document.getElementById(PANEL_ID); if (!panel) return;
    const head = document.createElement("div"); head.className = "mnx-phead";
    head.appendChild(pbtn("🤖 Copy for AI", "", () => copyFullQuestion(qid)));   // full Q + your AI prompt
    head.appendChild(pbtn("📝 Copy explanation", "", () => copyExplanation()));  // for your notes
    head.appendChild(pbtn("✚ Make card", "", () => openMakeCardDialog(String((window.getSelection && window.getSelection()) || ""))));
    if (currentNotes.length) {
      head.appendChild(pbtn("👁 Preview", "", () => openPreview(currentNotes, 0)));
      head.appendChild(pbtn("★ Save to Missed Qs", "mnx-save", () => openSaveDialog(qid)));
    }
    panel.appendChild(head);
  }

  // ============================================================
  // FEATURE 2c - make a NEW card (Cloze/Basic) from selected text
  // ============================================================
  function nextClozeNum(s) { let n = 0, m; const re = /\{\{c(\d+)::/g; while ((m = re.exec(s))) n = Math.max(n, +m[1]); return n + 1; }
  function clozeWrap(ta) {
    const s = ta.value; let a = ta.selectionStart, b = ta.selectionEnd;
    if (a === b) { a = 0; b = s.length; }                 // nothing selected -> cloze the whole line
    if (a === b) return;
    const n = nextClozeNum(s);
    ta.value = s.slice(0, a) + "{{c" + n + "::" + s.slice(a, b) + "}}" + s.slice(b);
    ta.focus();
  }
  function sourceHtml(qid) {
    const link = '<a href="' + location.href.replace(/"/g, "&quot;") + '">Coursology</a>';
    return (qid ? "Coursology QID " + qid + " · " : "") + link;
  }
  function openMakeCardDialog(prefill) {
    hideSelChip();
    prefill = (prefill || "").replace(/\s+/g, " ").trim();
    const qid = findQid();
    const m = buildModal("Make a card", () => document.removeEventListener("paste", pics.handlePaste));
    let kind = "cloze";

    const seg = document.createElement("div"); seg.className = "mnx-seg";
    const segCloze = document.createElement("button"); segCloze.type = "button"; segCloze.textContent = "Cloze"; segCloze.className = "on";
    const segBasic = document.createElement("button"); segBasic.type = "button"; segBasic.textContent = "Basic";
    seg.appendChild(segCloze); seg.appendChild(segBasic); m.body.appendChild(seg);

    const clozeView = document.createElement("div");
    const clLbl = document.createElement("label"); clLbl.className = "mnx-md-lbl"; clLbl.textContent = "Text";
    const clozeTa = document.createElement("textarea"); clozeTa.value = prefill;
    clozeTa.placeholder = "Highlight a word below, then “Make cloze”…";
    const clRow = document.createElement("div"); clRow.className = "mnx-inline";
    const clozeBtn = document.createElement("button"); clozeBtn.type = "button"; clozeBtn.className = "mnx-md-btn mnx-md-cancel"; clozeBtn.textContent = "Make cloze {{c}}";
    clozeBtn.addEventListener("click", () => clozeWrap(clozeTa));
    const clHint = document.createElement("span"); clHint.className = "mnx-md-hint"; clHint.textContent = "Highlight the word to hide, then click.";
    clRow.appendChild(clozeBtn); clRow.appendChild(clHint);
    const exLbl = document.createElement("label"); exLbl.className = "mnx-md-lbl"; exLbl.textContent = "Extra (optional — hint / why)";
    const extraTa = document.createElement("textarea");
    clozeView.appendChild(clLbl); clozeView.appendChild(clozeTa); clozeView.appendChild(clRow); clozeView.appendChild(exLbl); clozeView.appendChild(extraTa);

    const basicView = document.createElement("div"); basicView.style.display = "none";
    const fLbl = document.createElement("label"); fLbl.className = "mnx-md-lbl"; fLbl.textContent = "Front (your prompt)";
    const frontTa = document.createElement("textarea"); frontTa.placeholder = "Ask yourself a question…";
    const bLbl = document.createElement("label"); bLbl.className = "mnx-md-lbl"; bLbl.textContent = "Back (answer)";
    const backTa = document.createElement("textarea"); backTa.value = prefill;
    basicView.appendChild(fLbl); basicView.appendChild(frontTa); basicView.appendChild(bLbl); basicView.appendChild(backTa);
    m.body.appendChild(clozeView); m.body.appendChild(basicView);

    function setKind(k) {
      kind = k; const c = k === "cloze";
      segCloze.classList.toggle("on", c); segBasic.classList.toggle("on", !c);
      clozeView.style.display = c ? "block" : "none"; basicView.style.display = c ? "none" : "block";
    }
    segCloze.addEventListener("click", () => setKind("cloze"));
    segBasic.addEventListener("click", () => setKind("basic"));

    const dlbl = document.createElement("label"); dlbl.className = "mnx-md-lbl"; dlbl.textContent = "Deck"; m.body.appendChild(dlbl);
    const sel = document.createElement("select"); m.body.appendChild(sel);
    const newWrap = document.createElement("div"); newWrap.style.cssText = "margin-top:6px;display:none";
    const newInput = document.createElement("input"); newInput.type = "text"; newInput.placeholder = "e.g. 000001.Missed Qs::My cards";
    newWrap.appendChild(newInput); m.body.appendChild(newWrap);
    const NEW_OPT = "➕ New deck…";
    function fillDecks(all) {
      const list = (all || []).slice().sort();
      sel.replaceChildren();
      list.forEach(d => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
      const o = document.createElement("option"); o.value = NEW_OPT; o.textContent = NEW_OPT; sel.appendChild(o);
      chrome.storage.local.get({ akMakeDeck: null, akMissedDeck: null }, c => {
        const want = c.akMakeDeck || c.akMissedDeck;
        if (want && list.includes(want)) sel.value = want;
      });
    }
    sel.addEventListener("change", () => { newWrap.style.display = sel.value === NEW_OPT ? "block" : "none"; });
    if (deckCache) fillDecks(deckCache);
    else {
      const o = document.createElement("option"); o.textContent = "Loading decks…"; sel.appendChild(o);
      bridge("listDecks").then(d => { deckCache = d || []; fillDecks(deckCache); })
        .catch(e => { sel.replaceChildren(); const oo = document.createElement("option"); oo.value = NEW_OPT; oo.textContent = NEW_OPT; sel.appendChild(oo); newWrap.style.display = "block"; toast("Couldn't list decks (" + e + ")"); });
    }

    const pics = makeImagePicker("Images (optional — paste a screenshot or add files)");
    m.body.appendChild(pics.el);
    document.addEventListener("paste", pics.handlePaste);   // removed on close (buildModal onClose)

    const srcWrap = document.createElement("label"); srcWrap.className = "mnx-md-check";
    const srcCb = document.createElement("input"); srcCb.type = "checkbox"; srcCb.checked = true;
    const srcTxt = document.createElement("span"); srcTxt.textContent = qid ? ("Add source (QID " + qid + " + link)") : "Add page link as source";
    srcWrap.appendChild(srcCb); srcWrap.appendChild(srcTxt); m.body.appendChild(srcWrap);

    const saveBtn = mdButton("Create card", "mnx-md-ok", async () => {
      const deck = sel.value === NEW_OPT ? newInput.value.trim() : sel.value;
      if (!deck) { toast("Pick or type a deck."); return; }
      let rawCloze;
      if (kind === "cloze") {
        rawCloze = clozeTa.value.trim();
        if (!rawCloze) { toast("Add some text."); return; }
        if (rawCloze.indexOf("{{c") < 0) { toast("Make at least one cloze first (highlight a word → Make cloze)."); return; }
      } else if (!frontTa.value.trim() && !backTa.value.trim() && !pics.images.length) {
        toast("Add a front, back, or image."); return;
      }
      saveBtn.disabled = true; saveBtn.textContent = "Creating…";
      try {
        const imgTags = await pics.upload("card-" + (qid || "x"));
        const imgs = imgTags.join("<br>");
        const src = srcCb.checked ? ('<div style="font-size:12px;opacity:.7;margin-top:8px">' + sourceHtml(qid) + '</div>') : "";
        const params = { deck, kind, addTags: ["Mnestic::Made"] };
        if (kind === "cloze") {
          params.text = escapeHtml(rawCloze).replace(/\n/g, "<br>");
          const parts = [extraTa.value.trim() ? escapeHtml(extraTa.value.trim()).replace(/\n/g, "<br>") : "", imgs].filter(Boolean);
          const extra = parts.join("<br><br>") + src;
          if (extra) params.extra = extra;
        } else {
          params.front = escapeHtml(frontTa.value.trim()).replace(/\n/g, "<br>");
          const parts = [escapeHtml(backTa.value.trim()).replace(/\n/g, "<br>"), imgs].filter(Boolean);
          params.back = parts.join("<br><br>") + src;
        }
        await bridge("newNote", params);
        chrome.storage.local.set({ akMakeDeck: deck });
        if (deckCache && !deckCache.includes(deck)) deckCache.push(deck);
        m.close();
        const extraMsg = imgTags.length ? (" (+" + imgTags.length + " image" + (imgTags.length === 1 ? "" : "s") + ")") : "";
        toast("Created a " + kind + " card in " + deckLeaf(deck) + extraMsg + ".");
      } catch (e) { saveBtn.disabled = false; saveBtn.textContent = "Create card"; toast("Couldn't create (" + e + ")"); }
    });
    m.foot.appendChild(mdButton("Cancel", "mnx-md-cancel", m.close));
    m.foot.appendChild(saveBtn);
    setTimeout(() => (kind === "cloze" ? clozeTa : frontTa).focus(), 30);
  }

  // floating "✚ Make card" chip that appears when you select text on the page
  let selChipEl = null;
  function ensureSelChip() {
    if (selChipEl && document.body.contains(selChipEl)) return selChipEl;
    const b = document.createElement("button"); b.id = "mnx-selchip"; b.type = "button"; b.textContent = "✚ Make card";
    b.addEventListener("mousedown", e => e.preventDefault());           // keep the text selection
    b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openMakeCardDialog(b.dataset.text || ""); });
    document.body.appendChild(b); selChipEl = b; return b;
  }
  function hideSelChip() { if (selChipEl) selChipEl.style.display = "none"; }
  function selInsideAkuts(node) { while (node) { if (node.nodeType === 1 && (node.id || "").indexOf("mnx-") === 0) return true; node = node.parentNode; } return false; }
  function maybeShowSelChip() {
    if (!/\/qbanks\//i.test(location.pathname)) { hideSelChip(); return; }
    const s = window.getSelection && window.getSelection();
    const text = s ? String(s).trim() : "";
    if (!text || text.length < 6 || text.length > 4000 || !s.rangeCount) { hideSelChip(); return; }
    if (s.anchorNode && selInsideAkuts(s.anchorNode)) { hideSelChip(); return; }
    let rect; try { rect = s.getRangeAt(0).getBoundingClientRect(); } catch (e) { hideSelChip(); return; }
    if (!rect || (!rect.width && !rect.height)) { hideSelChip(); return; }
    const chip = ensureSelChip(); chip.dataset.text = text; chip.style.display = "flex";
    const cw = chip.offsetWidth || 120, ch = chip.offsetHeight || 34;
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(6, Math.min(window.innerWidth - cw - 6, left));
    let top = rect.top - ch - 8; if (top < 6) top = rect.bottom + 8;
    chip.style.left = left + "px"; chip.style.top = top + "px";
  }
  document.addEventListener("mouseup", () => setTimeout(maybeShowSelChip, 0));
  document.addEventListener("mousedown", e => { if (selChipEl && e.target !== selChipEl) hideSelChip(); });
  document.addEventListener("scroll", hideSelChip, true);

  // ---- one-click "Anki" button next to the Question Id in the player header ----
  const QID_BTN_ID = "mnx-qid-open";
  function qidLabelEl() {
    let best = null;
    for (const el of document.querySelectorAll("span, div, p, h1, h2, h3, h4, label, li, td")) {
      if (el.id === QID_BTN_ID) continue;
      const txt = el.textContent || "";
      if (!/Question\s*Id\s*:?\s*\d/i.test(txt)) continue;
      if (txt.length > 60) continue;                      // skip large wrappers
      if (!best || txt.length < best.textContent.length) best = el;   // smallest = most specific
    }
    return best;
  }
  function ensureQidButton() {
    const qid = findQid();
    const existing = document.getElementById(QID_BTN_ID);
    if (!qid) { if (existing) existing.remove(); return; }
    if (existing) { existing.dataset.qid = qid; return; }   // keep button, just refresh target
    const btn = document.createElement("button");
    btn.id = QID_BTN_ID; btn.type = "button"; btn.className = "mnx-qid-open";
    btn.textContent = "Anki";
    btn.title = "Open this question's AnKing cards in Anki";
    btn.dataset.qid = qid;
    btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.qid || findQid();
      if (id) openInAnki(id);
    });
    const label = qidLabelEl();
    if (label) label.insertAdjacentElement("afterend", btn);
    else { btn.classList.add("mnx-qid-float"); document.body.appendChild(btn); }
  }

  // ============================================================
  // FEATURE 3 - study logging (data only; the dashboard lives in the popup)
  // Logs each question the moment you answer it (we see it unanswered, then the
  // explanation appears), deduped by qid forever, and scrapes the qbank totals
  // off the Welcome/Performance dashboard so "remaining" is summed automatically.
  // The popup reads this storage and renders Today / This week / Remaining.
  // ============================================================
  const TRACKER_KEY = "akTrackerV2";
  let trackerLog = { answered: {}, totals: {}, targets: { weekly: 0, daily: 0 } };
  function normalizeLog(t) {
    t = t || {};
    return {
      answered: (t.answered && typeof t.answered === "object") ? t.answered : {},
      totals: (t.totals && typeof t.totals === "object") ? t.totals : {},
      targets: { weekly: (t.targets && +t.targets.weekly) || 0, daily: (t.targets && +t.targets.daily) || 0 }
    };
  }
  function saveLog() { try { chrome.storage.local.set({ [TRACKER_KEY]: trackerLog }); } catch (e) {} }
  chrome.storage.local.get({ [TRACKER_KEY]: null }, c => { if (c[TRACKER_KEY]) trackerLog = normalizeLog(c[TRACKER_KEY]); });

  function currentQbankSlug() { const m = location.pathname.match(/\/qbanks\/([^/]+)/i); return m ? m[1].toLowerCase() : "default"; }
  const seenUnanswered = new Set();        // qids seen unanswered this page session

  // Reliable correctness: backfill from the results table / Question List (both
  // mark each qid correct/incorrect), instead of scanning the player's answer
  // marks — which the left navigator's per-question ✓/✗ would falsely trip.
  function backfillCorrectness(rows) {
    if (!rows || !rows.length) return;
    const slug = currentQbankSlug();
    let changed = false;
    rows.forEach(r => {
      const e = trackerLog.answered[slug + " " + r.qid];
      if (e && e.correct !== !r.wrong) { e.correct = !r.wrong; changed = true; }
    });
    if (changed) saveLog();
  }

  // Record a question the first time it's answered (counted once, ever).
  function logAnswered(qid) {
    const slug = currentQbankSlug();
    const key = slug + " " + qid;
    if (trackerLog.answered[key]) return;
    trackerLog.answered[key] = { ts: Date.now(), slug, qid };
    saveLog();
  }

  // Read "Used / Unused / Total Questions" off the dashboard (best-effort, body text).
  let lastScrape = 0;
  function scrapeDashboardTotals() {
    if (!/welcome|dashboard|performance|home/i.test(location.pathname)) return;
    const now = Date.now(); if (now - lastScrape < 4000) return; lastScrape = now;
    const bt = document.body ? (document.body.innerText || "") : "";
    const num = re => { const m = bt.match(re); return m ? parseInt(m[1].replace(/,/g, ""), 10) : null; };
    const total = num(/Total Questions\s*([\d,]+)/i);
    const used = num(/\bUsed Questions\s*([\d,]+)/i);
    const unused = num(/Unused Questions\s*([\d,]+)/i);
    if (total == null && used == null && unused == null) return;
    const slug = currentQbankSlug();
    const prev = trackerLog.totals[slug] || {};
    if (prev.total === total && prev.used === used && prev.unused === unused) return;
    trackerLog.totals[slug] = { total, used, unused, ts: now };
    saveLog();
  }

  // Called each main-loop tick: detect a fresh answer + keep totals current +
  // backfill correctness from any results table on screen.
  function trackerTick() {
    const qid = findQid();
    if (qid) {
      if (COURSO.isReviewing()) {
        if (seenUnanswered.has(qid)) { logAnswered(qid); seenUnanswered.delete(qid); }
      } else {
        seenUnanswered.add(qid);
      }
    }
    scrapeDashboardTotals();
    if (/\/results\b/i.test(location.pathname)) backfillCorrectness(COURSO.resultRows());
  }

  // Auto-expand the results table to its largest page size (100) so the Anki
  // buttons + Weak-areas cover the whole block, not just the first 10 rows.
  let expandedResultsFor = null;
  function ensureResultsShowAll() {
    if (!/\/results\b/i.test(location.pathname)) return;
    if (expandedResultsFor === location.pathname) return;
    const btn = Array.from(document.querySelectorAll("button")).find(b => /^(10|25|50|100)$/.test((b.textContent || "").trim()));
    if (!btn) return;                                    // control not rendered yet — retry next tick
    expandedResultsFor = location.pathname;
    if ((btn.textContent || "").trim() === "100") return;
    try {
      btn.click();
      setTimeout(() => {
        const opt = Array.from(document.querySelectorAll("li,button,a,div,span")).find(el => el.children.length === 0 && (el.textContent || "").trim() === "100" && el !== btn);
        if (opt) opt.click(); else btn.click();          // close the menu if no "100"
      }, 250);
    } catch (e) {}
  }

  // ---------- main loop ----------
  setInterval(() => {
    const hasResults = COURSO.resultRows().length > 0;
    let toolbar = COURSO.toolbar();
    if (!toolbar && hasResults) toolbar = ensureFloatingToolbar();
    if (toolbar && !document.getElementById(BTN_HOST_ID)) addButtons(toolbar);
    if (!hasResults) { const fb = document.getElementById("mnx-float-toolbar"); if (fb) fb.remove(); }
    const host = document.getElementById(BTN_HOST_ID);
    if (host) syncExpectedButton(host);

    trackerTick();
    ensureQidButton();
    captureQuestionList();
    ensureResultsShowAll();

    const answered = isAnswered();
    const qid = answered ? findQid() : null;
    const ready = qid && answered;
    if (ready) {
      if (qid !== lastQid) { lastQid = qid; buildTable(qid); }
    } else {
      lastQid = null;
      currentFiles = emptyFiles();
      cachedUris = emptyUris();
      currentNotes = [];
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove();
      hideOverlay();
    }
  }, 1000);

  // ============================================================
  // Expected Score (Beta)
  // ============================================================
  const ES_GUESS = 0.2;   // 5-option MCQ guess floor
  const YIELD_W = { HighYield: 2.0, RelativelyHighYield: 1.6, "HighYield-temporary": 1.4, LowerYield: 0.8, LowYield: 0.5 };
  function qidQuery(qid, sv) { return "tag:#AK_Step" + sv + "_" + ANKING_VER + "::#UWorld::*::" + qid; }
  // probability you know one card's fact right now (0..1)
  function cardMaturity(c) {
    if (c.type === 2) {                                // review card
      const eff = Math.max((c.ivl || 0) * Math.pow(0.7, c.lapses || 0), (c.ivl || 0) * 0.4);
      return 1 / (1 + Math.exp(-0.1 * (eff - 21)));    // sigmoid: 21d -> 0.5
    }
    if (c.type === 1 || c.type === 3) return 0.15;     // learning / relearning
    return 0;                                          // new
  }
  function yieldWeight(y) { return (y && YIELD_W[y]) || 1.0; }
  // yield-weighted preparedness for one question's cards -> {prep,n,review} or null
  function prepFor(cards) {
    const usable = (cards || []).filter(c => !c.suspended);
    if (!usable.length) return null;                   // uncovered
    let sw = 0, swm = 0, review = 0;
    for (const c of usable) {
      const w = yieldWeight(c.yield);
      sw += w; swm += w * cardMaturity(c);
      if (c.type === 2) review++;
    }
    return { prep: sw > 0 ? swm / sw : 0, n: usable.length, review };
  }
  // mixture w/ guess floor: either you know it (~prep) or you guess (~20%)
  function predFrom(prep) { return ES_GUESS + (1 - ES_GUESS) * prep; }
  // reliability of the estimate (geometric mean of four factors)
  function confidence(details, nTotal) {
    const cov = details.filter(Boolean);
    const nCov = cov.length;
    if (!nCov) return { score: 0, label: "Insufficient" };
    const coverage = Math.min(1, nCov / (0.5 * nTotal));
    const sumInv = cov.reduce((s, q) => s + (q.n > 0 ? 1 / q.n : 0), 0);
    const H = sumInv > 0 ? nCov / sumInv : 0;
    const density = Math.min(1, H / 4);
    const sample = Math.min(1, nCov / 10);
    const totalCards = cov.reduce((s, q) => s + q.n, 0);
    const reviewCards = cov.reduce((s, q) => s + q.review, 0);
    const quality = totalCards > 0 ? reviewCards / totalCards : 0;
    const score = Math.pow(coverage * density * sample * quality, 0.25);
    const label = score >= 0.7 ? "High" : score >= 0.4 ? "Medium" : score >= 0.15 ? "Low" : "Insufficient";
    return { score, label };
  }
  const ES_MSG = {
    mature_wrong: ["Oof \u2014 your cards say you knew this one.", "Mature in Anki but missed \u2014 sneaky one, or a slip.", "Your reviews had this down. Go revisit it.", "This was in your wheelhouse \u2014 worth a careful look.", "You'd matured this. Don't let it slide."],
    mature_right: ["Nailed it \u2014 and your cards backed you up.", "Solid. Your reps clearly paid off.", "Matured and correct. Textbook.", "Clean hit \u2014 well-drilled.", "Your Anki grind showed here. Nice."],
    mature_unknown: ["Your cards on this are mature.", "Well-drilled in Anki.", "This one's locked in your reviews."],
    mid_wrong: ["Still bedding this one in \u2014 fair enough.", "Young card, missed it. It'll stick soon.", "Not matured yet \u2014 keep the reps up.", "This one's still settling in Anki."],
    mid_right: ["Got it while it's still young \u2014 nice.", "Correct, and it's still settling. Bonus.", "Ahead of your reviews on this one.", "Young card, right answer \u2014 good sign."],
    mid_unknown: ["Still young in your reviews.", "This one's settling in Anki.", "Halfway home on this card."],
    low_wrong: ["Barely started this in Anki \u2014 no shame.", "Fresh card, fair miss. It's coming.", "Hardly reviewed yet \u2014 expected.", "Early days for this one."],
    low_right: ["Correct on a card you've barely touched \u2014 clutch.", "Reasoned that one out before Anki caught up.", "Got it ahead of your reviews. Slick.", "Nice \u2014 that wasn't from the deck yet."],
    low_unknown: ["Barely reviewed in Anki yet.", "Fresh in your deck.", "Early days for this card."],
    none_wrong: ["Not in your deck yet \u2014 totally fair miss.", "No card for this one. Can't fault you.", "Off-deck question \u2014 not on you.", "Your deck doesn't cover this yet."],
    none_right: ["Not in your deck \u2014 pure reasoning. Respect.", "No card for this, and you still got it. Nice.", "Off-deck and correct \u2014 real understanding.", "Deck doesn't cover this \u2014 you earned that one."],
    none_unknown: ["Not in your deck yet.", "No matching card for this one.", "Your deck doesn't cover this question."]
  };
  function esPick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function phraseFor(chance, correct) {
    const band = chance === null ? "none" : chance >= 0.8 ? "mature" : chance >= 0.45 ? "mid" : "low";
    const who = correct === true ? "right" : correct === false ? "wrong" : "unknown";
    return esPick(ES_MSG[band + "_" + who] || ES_MSG[band + "_unknown"]);
  }
  function expectedStatus(chance, correct) {
    if (chance !== null && chance >= 0.8 && correct === false) return "warn";
    if (correct === true) return "good";
    return "";
  }
  function answerResult() {
    const txt = (document.body.textContent || "");
    if (/answered\s+incorrectly/i.test(txt)) return false;
    if (/answered\s+correctly/i.test(txt)) return true;
    return null;                                        // couldn't tell
  }
  async function addExpectedLine(qid) {
    let sv; try { sv = await getSv(); } catch (e) { sv = 1; }
    let cards;
    try { const r = await bridge("cardStats", { queries: [qidQuery(qid, sv)] }); cards = r && r[0]; }
    catch (e) { return; }
    if (lastQid !== qid) return;                        // moved on while waiting
    const panel = document.getElementById(PANEL_ID);
    if (!panel || document.getElementById("mnx-expected")) return;
    const d = prepFor(cards);
    const chance = d ? d.prep : null;
    const correct = answerResult();
    const line = document.createElement("div");
    line.id = "mnx-expected";
    line.className = "mnx-expected " + expectedStatus(chance, correct);
    line.textContent = phraseFor(chance, correct);
    panel.insertBefore(line, panel.firstChild);
  }
  function syncExpectedButton(host) {
    const ID = "mnx-es-btn";
    const existing = document.getElementById(ID);
    if (esOn && !existing) {
      const b = document.createElement("button");
      b.id = ID; b.textContent = "Expected Score"; b.className = "review-button mnx-btn mnx-es";
      b.addEventListener("click", () => computeSummary());
      host.appendChild(b);
    } else if (!esOn && existing) { existing.remove(); }
  }
  function openInAnki(qid) { getSv().then(sv => bridge("openBrowser", { query: qidQuery(qid, sv) }).catch(() => {})); }
  async function computeSummary() {
    const items = resultData().map(r => ({ qid: r.qid, correct: !r.wrong }));
    if (!items.length) { toast("No questions found on this page."); return; }
    let sv; try { sv = await getSv(); } catch (e) { sv = 1; }
    let byQ;
    try { byQ = await bridge("cardStats", { queries: items.map(it => qidQuery(it.qid, sv)) }); }
    catch (e) { toast("Couldn't reach Anki. Make sure it's open and the Mnestic Bridge add-on is installed. (" + e + ")"); return; }
    items.forEach((it, i) => {
      const d = prepFor(byQ[i]);
      it.detail = d;
      it.prep = d ? d.prep : null;
      it.pred = d ? predFrom(d.prep) : null;
    });
    renderSummary(items);
  }
  function metric(label, value) {
    const d = document.createElement("div"); d.className = "mnx-metric";
    const v = document.createElement("div"); v.className = "mnx-metric-v"; v.textContent = value;
    const l = document.createElement("div"); l.className = "mnx-metric-l"; l.textContent = label;
    d.appendChild(v); d.appendChild(l); return d;
  }
  function closeSummary() { const o = document.getElementById(SUMMARY_ID); if (o) { o.style.display = "none"; o.replaceChildren(); } }
  function renderSummary(items) {
    const total = items.length;
    const overallCorrect = items.filter(it => it.correct).length;
    const overallPct = total ? Math.round(100 * overallCorrect / total) : 0;
    const covered = items.filter(it => it.pred !== null);
    const nCov = covered.length;
    const correctCov = covered.filter(it => it.correct).length;
    const expectedPct = nCov ? Math.round(100 * covered.reduce((s, it) => s + it.pred, 0) / nCov) : null;
    const actualPct = nCov ? Math.round(100 * correctCov / nCov) : null;
    const conf = confidence(covered.map(it => it.detail), total);
    const covPct = total ? Math.round(100 * nCov / total) : 0;
    const missed = covered.filter(it => !it.correct).sort((a, b) => b.prep - a.prep);

    let o = document.getElementById(SUMMARY_ID);
    if (!o) {
      o = document.createElement("div"); o.id = SUMMARY_ID;
      o.addEventListener("click", e => { if (e.target === o) closeSummary(); });
      document.body.appendChild(o);
    }
    o.classList.toggle("mnx-dark", darkMode);
    o.style.display = "flex"; o.replaceChildren();

    const dlg = document.createElement("div"); dlg.className = "mnx-sum-dialog";
    const head = document.createElement("div"); head.className = "mnx-sum-head";
    const h = document.createElement("span"); h.textContent = "Expected score (beta)";
    const x = document.createElement("button"); x.className = "mnx-x"; x.textContent = "\u00d7"; x.title = "Close";
    x.addEventListener("click", closeSummary);
    head.appendChild(h); head.appendChild(x); dlg.appendChild(head);

    // A — the score you already know from the qbank
    const score = document.createElement("div"); score.className = "mnx-sum-score";
    const sval = document.createElement("span"); sval.className = "mnx-score-v"; sval.textContent = overallPct + "%";
    const slbl = document.createElement("span"); slbl.className = "mnx-score-l"; slbl.textContent = "your block score \u00b7 " + overallCorrect + " of " + total;
    score.appendChild(sval); score.appendChild(slbl); dlg.appendChild(score);

    // B — how much of the block AnKing can even evaluate
    const cov = document.createElement("div"); cov.className = "mnx-cov";
    const bar = document.createElement("div"); bar.className = "mnx-cov-bar";
    const fill = document.createElement("div"); fill.className = "mnx-cov-fill"; fill.style.width = covPct + "%";
    bar.appendChild(fill);
    const covLbl = document.createElement("div"); covLbl.className = "mnx-cov-lbl";
    covLbl.textContent = nCov + " of " + total + " questions matched to AnKing (" + covPct + "%)";
    cov.appendChild(bar); cov.appendChild(covLbl); dlg.appendChild(cov);

    if (!nCov) {
      const p = document.createElement("div"); p.className = "mnx-sum-note";
      p.textContent = "Not enough data \u2014 none of these questions matched a card in your deck yet.";
      dlg.appendChild(p); o.appendChild(dlg); return;
    }

    // C — preparedness analysis, scoped to the covered questions only
    const sub = document.createElement("div"); sub.className = "mnx-sum-lbl";
    sub.textContent = "On the " + nCov + " covered question" + (nCov === 1 ? "" : "s") + ":";
    dlg.appendChild(sub);

    const row = document.createElement("div"); row.className = "mnx-sum-row";
    const gap = actualPct - expectedPct;
    row.appendChild(metric("Expected", expectedPct + "%"));
    row.appendChild(metric("You got", actualPct + "%"));
    row.appendChild(metric("Gap", (gap >= 0 ? "+" : "") + gap + " pts"));
    dlg.appendChild(row);

    const badge = document.createElement("div");
    badge.className = "mnx-conf mnx-conf-" + conf.label.toLowerCase();
    badge.textContent = "Confidence: " + conf.label;
    dlg.appendChild(badge);

    const note = document.createElement("div"); note.className = "mnx-sum-note";
    const interp = gap > 4 ? "you beat what your reviews predicted \u2014 reasoning, outside knowledge, or luck filled the gap."
      : gap < -4 ? "you came in under \u2014 these may have tested angles your cards don't cover."
      : "right about where your Anki history predicted.";
    const trust = conf.label === "High" ? "This estimate is well-supported."
      : conf.label === "Medium" ? "Reasonable, but limited data \u2014 use with some caution."
      : conf.label === "Low" ? "Rough estimate \u2014 directionally informative only."
      : "Very thin data \u2014 treat as a loose approximation.";
    note.textContent = "Your Anki prep predicted ~" + expectedPct + "% on these; you got " + actualPct + "% \u2014 " + interp + " " + trust + " \u201cExpected\u201d weighs card maturity by yield and floors at ~20% for guessing \u2014 it's a guide, not a grade.";
    dlg.appendChild(note);

    const lbl = document.createElement("div"); lbl.className = "mnx-sum-lbl";
    lbl.textContent = missed.length ? "Missed \u2014 best-prepared first (worth a look):" : "No covered questions missed \u2014 nice.";
    dlg.appendChild(lbl);
    missed.forEach(it => {
      const r = document.createElement("div"); r.className = "mnx-sum-item";
      const left = document.createElement("span");
      left.textContent = "QID " + it.qid + "  \u00b7  " + Math.round(it.prep * 100) + "% prepared";
      const a = document.createElement("a"); a.href = "#"; a.textContent = "open in Anki";
      a.addEventListener("click", e => { e.preventDefault(); openInAnki(it.qid); });
      r.appendChild(left); r.appendChild(a);
      dlg.appendChild(r);
    });
    o.appendChild(dlg);
  }
})();