# Adding another question bank

Mnestic's matching logic is the same everywhere: read the question's id off the
page, search Anki for `tag:#AK_Step<n>_v*::#UWorld::*::<qid>`. Only the DOM
differs. So supporting a new bank means writing **one adapter object** — no
feature code changes.

Prerequisite: the bank must expose the **same question ids the AnKing deck is
tagged with**. If it renumbers questions, none of this works; check that first
with the three-step test in the README ("Verify the IDs line up").

## 1. Look at the live page

Install the extension, open a question on the new site, then use the popup →
**Advanced → Check this page**. It runs the current adapter and reports what it
found. On an unsupported host it falls back to the Coursology adapter, so most
lines will say "not found" — that's the point: the report tells you where the
id-looking labels actually live.

The report is **structure only** (tag names, ids, class names). No question text,
no answers, no account details — it's safe to paste into an issue.

## 2. Write the adapter

Add one object in `extension/content.js`, next to `COURSO` and `UWORLD`, then
list it in `SITES`. The full contract is in the comment above `SITES`:

| Member | Notes |
|---|---|
| `id`, `label`, `hostRe` | `label` is what appears in copied text and card sources |
| `qidRe: [RegExp]` | capture group 1 is the id; list every spelling the site uses |
| `headerSel: [sel]` | tried in order, cheapest first; end with `"body"` |
| `isReviewing()` | **the spoiler gate** — must be false until the answer is revealed |
| `explanationRoot()` | the explanation element, or `null` |
| `panelAnchor()` | where the resource panel mounts; `null` floats it |
| `contentRoot()` | stem + choices + explanation, for "Copy for AI" |
| `toolbar()` | results-page button host; `null` floats it |
| `resultRows()` | usually just `return genericResultRows();` |
| `stepFromUrl()` | `1`/`2`/`3`, or `null` to use the popup's Step selector |
| `blockSlug()` | key for the tracker's per-qbank totals |
| `inTest()`, `isResultsPage()` | which view we're on |

**Prefer shape over class names.** Sites that ship generated class names
(`css-1x2y3z`) break fixed selectors on every release. Look for a visible
*Explanation* heading, a table with an `ID` column, a label matching a regex —
see `findExplanationRegion()` for the pattern.

**Get `isReviewing()` right.** It is the only thing stopping the panel from
revealing a resource — and the answer — on a question the user hasn't answered
yet. When in doubt, return `false`.

> Worked example — MedPark. Its explanation pane is **in the DOM before you
> answer**; it just lacks a `.visible` class and has zero height. Checking only
> "does `section.explanation-area` exist?" would have spoiled every question.
> The adapter requires the modifier class **and** a non-zero box, and the test
> suite pins both states. Always open an unanswered question and look, rather
> than assuming the pane is absent.

## 3. Grant the host, in both places

- `extension/manifest.json` → `host_permissions` **and** `content_scripts.matches`
- `extension/background.js` → `QBANK_DOMAINS` (this one is the security boundary
  for the image fetcher)

## 4. Test before shipping

`scripts/adapter-test.js` drives the real `content.js` against fixture pages
served under the real hostnames and asserts on the diagnose report:

```bash
npm install playwright-core && npx playwright install chromium
node scripts/adapter-test.js
```

Add fixtures for the new bank. Cover at minimum:

1. a reviewing question (id found, `reviewing: true`),
2. an **unanswered** question (`reviewing: false` — the spoiler gate),
3. an end-of-block results table (`resultRows` > 0),
4. a Coursology fixture, unchanged, so the refactor didn't regress it.

Then bump `version` in the manifest, update the README's *Supported question
banks* table, `PRIVACY.md`, and the permission justification in
`docs/chrome-store-listing.md`.

> A new host permission means the Chrome Web Store review starts over and
> existing users see a permission prompt. Batch bank additions where you can.
