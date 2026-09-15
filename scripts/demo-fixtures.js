// Demo fixtures — the pages and card data the demo recorder drives.
//
// Everything here is written for the demo. The clinical text is ordinary
// textbook physiology written for this repo, and the "resource" images are
// simple diagrams rendered from the HTML below — they are NOT pages from First
// Aid, Sketchy, Physeo or anyone else, and they carry a SAMPLE label so a
// screenshot can never be mistaken for the real thing. Resource NAMES appear
// because that is what the extension reads out of a user's own deck tags.

const STEM = `A 62-year-old man comes to the office because of shortness of breath
that has worsened over the past two years. He can no longer climb one flight of
stairs without stopping. He has a daily cough productive of clear sputum. He has
smoked one pack of cigarettes daily for 40 years. Vital signs are normal except
for a respiratory rate of 22/min. Examination shows a barrel-shaped chest,
distant breath sounds, and a prolonged expiratory phase.`;

const CHOICES = [
  ["A", "Decreased total lung capacity"],
  ["B", "Decreased residual volume"],
  ["C", "Increased FEV1/FVC ratio"],
  ["D", "Increased lung compliance"],
  ["E", "Increased diffusing capacity"],
];

const EXPLANATION = `
<h3>Explanation</h3>
<p><b>The correct answer is D.</b> This patient has chronic obstructive pulmonary
disease from long-standing smoking. Destruction of alveolar walls removes elastic
tissue from the lung, so the lung becomes easier to inflate — <b>compliance
rises</b> — while elastic recoil falls.</p>
<p>Loss of recoil is also what narrows the airways during expiration. Without
radial traction holding them open, small airways collapse early, air is trapped
behind them, and residual volume and total lung capacity both <i>increase</i>
rather than decrease.</p>
<h4>Why the others are wrong</h4>
<ul>
  <li><b>A.</b> Total lung capacity is increased in obstructive disease, not
      decreased; hyperinflation is what produces the barrel chest described here.</li>
  <li><b>B.</b> Residual volume increases, because air is trapped distal to
      airways that collapse during expiration.</li>
  <li><b>C.</b> FEV1 falls more than FVC, so the <b>ratio falls</b> below 0.7 —
      this is the defining measurement of an obstructive pattern.</li>
  <li><b>E.</b> Emphysema destroys alveolar surface area, so diffusing capacity
      for carbon monoxide falls. A normal or raised DLCO would point away from
      emphysema and toward chronic bronchitis or asthma.</li>
</ul>
<h4>Educational objective</h4>
<p>In emphysema, alveolar wall destruction lowers elastic recoil. Compliance
rises, airways collapse on expiration, and lung volumes increase while the
FEV1/FVC ratio and DLCO fall.</p>
`;

const shell = (body, title) => `<!doctype html>
<meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,Arial,sans-serif;
         color:#1f2430; background:#eef1f7; }
  .topbar { background:#11213f; color:#fff; padding:10px 22px; display:flex; align-items:center; gap:18px;
            font-size:13.5px; position:sticky; top:0; z-index:5; }
  .topbar b { font-size:15px; letter-spacing:.2px; }
  .topbar .sp { flex:1 }
  .topbar span { opacity:.82 }
  .question-header { background:#fff; border-bottom:1px solid #dfe4ee; padding:9px 22px;
                     display:flex; align-items:center; gap:14px; font-size:13px; color:#55607a; }
  .question-header .qid { font-weight:700; color:#1f2430; }
  .wrap { display:grid; grid-template-columns: 1fr 1fr; gap:18px; padding:18px 22px 40px; align-items:start; }
  .card { background:#fff; border:1px solid #e2e7f0; border-radius:10px; padding:20px 22px; }
  .stem { font-size:15.5px; }
  .choice { display:flex; gap:11px; padding:9px 12px; border:1px solid #e2e7f0; border-radius:8px; margin-top:8px; }
  .choice .k { font-weight:700; color:#55607a; width:16px; }
  .choice.right { border-color:#2f9e63; background:#eefaf2; }
  .choice.wrong { border-color:#d6564f; background:#fdeeed; }
  .badge { font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; margin-left:auto; }
  .badge.r { background:#2f9e63; color:#fff } .badge.w { background:#d6564f; color:#fff }
  h3 { margin:0 0 10px; font-size:17px } h4 { margin:18px 0 6px; font-size:14px; color:#11213f }
  ul { margin:6px 0; padding-left:20px } li { margin:5px 0 }
  .figure { margin:14px 0; border:1px solid #e2e7f0; border-radius:8px; overflow:hidden; }
  .figure img { display:block; width:100%; }
  .figure figcaption { font-size:12px; color:#6b7590; padding:7px 10px; background:#f6f8fc; }
  table { border-collapse:collapse; width:100%; background:#fff; font-size:14px }
  th, td { border:1px solid #e2e7f0; padding:9px 12px; text-align:left }
  th { background:#f6f8fc; font-weight:700; font-size:12.5px; letter-spacing:.3px; color:#55607a }
  .ok { color:#2f9e63; font-weight:700 } .no { color:#d6564f; font-weight:700 }
  .fa-xmark, .fa-check, .fa-flag { font-style:normal; margin-right:5px }
  .fa-flag { color:#d5891c }
  .score { display:flex; gap:26px; padding:20px 22px; }
  .score .n { font-size:30px; font-weight:800; color:#11213f }
  .score .l { font-size:12px; color:#6b7590; letter-spacing:.4px; }
</style>
<body>${body}</body>`;

// The answered/reviewing question page. #question-explanation is what the
// Coursology adapter watches to know the answer is showing.
function reviewPage(qid, figureDataUri) {
  const choices = CHOICES.map(([k, t]) => {
    const cls = k === "D" ? " right" : k === "A" ? " wrong" : "";
    const badge = k === "D" ? '<span class="badge r">Correct</span>'
      : k === "A" ? '<span class="badge w">Your answer</span>' : "";
    return `<div class="choice${cls}"><span class="k">${k}</span><span>${t}</span>${badge}</div>`;
  }).join("");
  const figure = figureDataUri ? `
    <figure class="figure"><img src="${figureDataUri}" alt="Flow-volume loops">
      <figcaption>Figure 1 — flow–volume loops. Sample image created for this demo.</figcaption></figure>` : "";
  return shell(`
    <div class="topbar"><b>Demo QBank</b><span>Block 3 · Question 14 of 40</span>
      <span class="sp"></span><span>Review mode</span></div>
    <div class="question-header"><span class="qid">Question Id: ${qid}</span>
      <span>Respiratory · Physiology</span></div>
    <div class="wrap">
      <div class="card"><div class="stem">${STEM}</div>${figure}<div style="margin-top:14px">${choices}</div></div>
      <div class="card" id="question-explanation">${EXPLANATION}</div>
    </div>`, "Demo QBank — question " + qid);
}

// The end-of-block score table. genericResultRows() reads the ID column and the
// per-row status, which is what the results toolbar and Weak areas run on.
function resultsPage(rows) {
  const body = rows.map(r => `<tr>
      <td>${r.marked ? '<i class="fa-flag" title="Flagged">⚑</i> ' : ""}${r.qid}</td>
      <td class="${r.wrong ? "no" : "ok"}">${r.wrong
        ? '<i class="fa-xmark">✗</i> Incorrect'
        : '<i class="fa-check">✓</i> Correct'}</td>
      <td>${r.subject}</td><td>${r.system}</td><td>${r.topic}</td></tr>`).join("");
  const correct = rows.filter(r => !r.wrong).length;
  return shell(`
    <div class="topbar"><b>Demo QBank</b><span>Block 3 · Test summary</span></div>
    <div class="test-performance-top-div score">
      <div><div class="n">${Math.round(correct / rows.length * 100)}%</div><div class="l">SCORE</div></div>
      <div><div class="n">${correct}/${rows.length}</div><div class="l">CORRECT</div></div>
      <div><div class="n">41:12</div><div class="l">TIME</div></div>
    </div>
    <div style="padding:0 22px 40px">
      <table><thead><tr><th>ID</th><th>Result</th><th>Subject</th><th>System</th><th>Topic</th></tr></thead>
      <tbody>${body}</tbody></table>
    </div>`, "Demo QBank — results");
}

// A block with a believable spread, so the weak-area breakdown has something to
// rank: cardiovascular weak, renal middling, endocrine strong.
const RESULT_ROWS = [
  { qid: "4211", wrong: false, subject: "Physiology", system: "Respiratory", topic: "Obstructive disease" },
  { qid: "4212", wrong: true,  subject: "Physiology", system: "Cardiovascular", topic: "Cardiac cycle" },
  { qid: "4213", wrong: true,  marked: true, subject: "Pathology",  system: "Cardiovascular", topic: "Heart failure" },
  { qid: "4214", wrong: true,  subject: "Pharmacology", system: "Cardiovascular", topic: "Antiarrhythmics" },
  { qid: "4215", wrong: false, subject: "Physiology", system: "Cardiovascular", topic: "Cardiac cycle" },
  { qid: "4216", wrong: false, subject: "Physiology", system: "Cardiovascular", topic: "Hemodynamics" },
  { qid: "4217", wrong: true,  marked: true, subject: "Physiology", system: "Renal", topic: "Acid-base" },
  { qid: "4218", wrong: false, subject: "Pathology",  system: "Renal", topic: "Glomerular disease" },
  { qid: "4219", wrong: false, subject: "Physiology", system: "Renal", topic: "Tubular transport" },
  { qid: "4220", wrong: false, subject: "Pathology",  system: "Renal", topic: "Glomerular disease" },
  { qid: "4221", wrong: false, subject: "Pathology",  system: "Endocrine", topic: "Thyroid" },
  { qid: "4222", wrong: false, subject: "Physiology", system: "Endocrine", topic: "Adrenal" },
  { qid: "4223", wrong: false, subject: "Pharmacology", system: "Endocrine", topic: "Diabetes drugs" },
  { qid: "4224", wrong: false, subject: "Pathology",  system: "Endocrine", topic: "Pituitary" },
  { qid: "4225", wrong: true,  subject: "Pathology",  system: "Respiratory", topic: "Obstructive disease" },
  { qid: "4226", wrong: false, subject: "Physiology", system: "Respiratory", topic: "Gas exchange" },
];

// ---- the "resource" images -------------------------------------------------
// Rendered to PNG by the recorder. Plain diagrams of standard physiology,
// drawn here, labelled SAMPLE.

const SAMPLE_TAG = `<div style="position:absolute;top:10px;right:12px;font:600 10px/1 system-ui;
  letter-spacing:1.4px;color:#9aa3b8;border:1px solid #d8dde8;border-radius:4px;padding:4px 7px">SAMPLE</div>`;

const artFrame = (inner, w = 760, h = 470) => `<!doctype html><meta charset="utf-8">
<style>body{margin:0}.f{position:relative;width:${w}px;height:${h}px;background:#fff;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,Arial,sans-serif;color:#1f2430;
  padding:26px 30px;border:1px solid #e2e7f0}
  h2{margin:0 0 4px;font-size:19px;color:#11213f}.sub{font-size:12.5px;color:#7b849b;margin-bottom:18px}
  .k{font-size:12.5px;color:#55607a}</style>
<body><div class="f">${SAMPLE_TAG}${inner}</div></body>`;

const RESOURCE_ART = {
  // First Aid — three "pages", so the overlay pager has something to page through
  "fa-1.png": artFrame(`
    <h2>Obstructive vs restrictive lung disease</h2>
    <div class="sub">Spirometry patterns · demo diagram</div>
    <svg width="700" height="330" viewBox="0 0 700 330">
      <line x1="60" y1="280" x2="660" y2="280" stroke="#c7cedd" stroke-width="2"/>
      <line x1="60" y1="30" x2="60" y2="280" stroke="#c7cedd" stroke-width="2"/>
      <text x="360" y="308" font-size="12" fill="#7b849b" text-anchor="middle">Volume →</text>
      <text x="26" y="160" font-size="12" fill="#7b849b" transform="rotate(-90 26 160)" text-anchor="middle">Flow →</text>
      <path d="M90 280 L200 70 L420 235 L620 280" fill="none" stroke="#2f6fd6" stroke-width="3"/>
      <path d="M120 280 L235 120 C330 205 380 250 470 280" fill="none" stroke="#d6564f" stroke-width="3"/>
      <path d="M300 280 L370 150 L470 245 L560 280" fill="none" stroke="#2f9e63" stroke-width="3"/>
      <circle cx="470" cy="46" r="5" fill="#2f6fd6"/><text x="484" y="51" font-size="13">Normal</text>
      <circle cx="470" cy="76" r="5" fill="#d6564f"/><text x="484" y="81" font-size="12.5">Obstructive — scooped expiration</text>
      <circle cx="470" cy="106" r="5" fill="#2f9e63"/><text x="484" y="111" font-size="12.5">Restrictive — narrow, shifted right</text>
    </svg>
    <div class="k">FEV1/FVC &lt; 0.7 defines obstruction. In restriction both fall together, so the ratio is preserved or high.</div>`),

  "fa-2.png": artFrame(`
    <h2>Lung volumes in emphysema</h2>
    <div class="sub">Why the chest looks barrelled · demo diagram</div>
    <svg width="700" height="320" viewBox="0 0 700 320">
      <rect x="120" y="60" width="150" height="60"  fill="#dbe7fb" stroke="#2f6fd6"/>
      <rect x="120" y="120" width="150" height="70" fill="#eaf1fd" stroke="#2f6fd6"/>
      <rect x="120" y="190" width="150" height="80" fill="#f4f8ff" stroke="#2f6fd6"/>
      <text x="195" y="96" font-size="12" text-anchor="middle">IRV</text>
      <text x="195" y="160" font-size="12" text-anchor="middle">TV + ERV</text>
      <text x="195" y="235" font-size="12" text-anchor="middle">RV</text>
      <text x="195" y="44" font-size="12.5" text-anchor="middle" fill="#55607a">Normal</text>
      <rect x="400" y="40" width="150" height="45"  fill="#fbe0de" stroke="#d6564f"/>
      <rect x="400" y="85" width="150" height="55"  fill="#fdeeed" stroke="#d6564f"/>
      <rect x="400" y="140" width="150" height="130" fill="#fef6f5" stroke="#d6564f"/>
      <text x="475" y="68" font-size="12" text-anchor="middle">IRV ↓</text>
      <text x="475" y="118" font-size="12" text-anchor="middle">TV + ERV</text>
      <text x="475" y="210" font-size="12" text-anchor="middle">RV ↑↑</text>
      <text x="475" y="26" font-size="12.5" text-anchor="middle" fill="#55607a">Emphysema</text>
      <line x1="90" y1="270" x2="600" y2="270" stroke="#c7cedd" stroke-width="2"/>
    </svg>
    <div class="k">Air trapping raises RV and FRC. TLC rises too, so hyperinflation — not a small lung — is the picture.</div>`),

  "fa-3.png": artFrame(`
    <h2>Compliance and elastic recoil</h2>
    <div class="sub">Pressure–volume curve · demo diagram</div>
    <svg width="700" height="320" viewBox="0 0 700 320">
      <line x1="70" y1="275" x2="650" y2="275" stroke="#c7cedd" stroke-width="2"/>
      <line x1="70" y1="25" x2="70" y2="275" stroke="#c7cedd" stroke-width="2"/>
      <text x="360" y="302" font-size="12" fill="#7b849b" text-anchor="middle">Transpulmonary pressure →</text>
      <path d="M70 275 C200 250 300 140 620 95" fill="none" stroke="#2f6fd6" stroke-width="3"/>
      <path d="M70 275 C150 180 200 90 430 55"  fill="none" stroke="#d6564f" stroke-width="3"/>
      <path d="M70 275 C260 262 420 215 640 190" fill="none" stroke="#2f9e63" stroke-width="3"/>
      <circle cx="430" cy="232" r="5" fill="#2f6fd6"/><text x="444" y="237" font-size="13">Normal</text>
      <circle cx="430" cy="258" r="5" fill="#d6564f"/><text x="444" y="263" font-size="12.5">Emphysema — compliance ↑</text>
      <circle cx="120" cy="60" r="5" fill="#2f9e63"/><text x="134" y="65" font-size="12.5">Fibrosis — compliance ↓</text>
    </svg>
    <div class="k">Compliance is ΔV/ΔP — the slope. Losing elastic tissue steepens it; laying down collagen flattens it.</div>`),

  "sketchy-1.png": artFrame(`
    <h2>Smoking-related lung injury</h2>
    <div class="sub">Sequence of events · demo diagram</div>
    <svg width="700" height="300" viewBox="0 0 700 300">
      ${[["Cigarette smoke", 40], ["Neutrophils &amp; macrophages", 205], ["Elastase &gt; α1-antitrypsin", 375], ["Alveolar wall loss", 550]]
        .map(([t, x]) => `<rect x="${x}" y="110" width="130" height="66" rx="9" fill="#f3f0fd" stroke="#6d40e0"/>
          <foreignObject x="${x + 8}" y="120" width="114" height="52">
            <div xmlns="http://www.w3.org/1999/xhtml" style="font:12.5px system-ui;text-align:center;color:#3b2a6b">${t}</div>
          </foreignObject>`).join("")}
      ${[175, 345, 515].map(x => `<path d="M${x} 143 l24 0 m-7 -6 l7 6 -7 6" stroke="#6d40e0" stroke-width="2" fill="none"/>`).join("")}
    </svg>
    <div class="k">Centriacinar emphysema follows smoke; panacinar follows α1-antitrypsin deficiency and spares the apices.</div>`, 760, 380),

  "physeo-1.png": artFrame(`
    <h2>Dynamic airway collapse</h2>
    <div class="sub">Why expiration is the hard part · demo diagram</div>
    <svg width="700" height="300" viewBox="0 0 700 300">
      <path d="M90 90 C200 90 240 120 240 150 C240 180 200 210 90 210" fill="#eaf1fd" stroke="#2f6fd6" stroke-width="2.5"/>
      <text x="150" y="245" font-size="12.5" fill="#55607a" text-anchor="middle">Normal — radial traction holds the airway open</text>
      <path d="M420 100 C520 100 540 140 548 150 C540 160 520 200 420 200" fill="#fdeeed" stroke="#d6564f" stroke-width="2.5"/>
      <path d="M548 150 l40 0" stroke="#d6564f" stroke-width="2.5" stroke-dasharray="4 4"/>
      <text x="500" y="245" font-size="12.5" fill="#55607a" text-anchor="middle">Emphysema — recoil lost, airway collapses</text>
      <text x="350" y="60" font-size="13" fill="#7b849b" text-anchor="middle">Expiration raises pleural pressure around the airway</text>
    </svg>
    <div class="k">Pursed-lip breathing raises airway pressure from inside and splints the airway open — hence the clinical habit.</div>`),
};

module.exports = { reviewPage, resultsPage, RESULT_ROWS, RESOURCE_ART, artFrame };
