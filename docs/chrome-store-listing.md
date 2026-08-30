# Chrome Web Store — listing copy (paste-ready)

Everything you need for the submission form. Copy each field across.

---

## Store listing tab

**Name** (≤ 45 chars)
```
Mnestic — qbank ⇄ AnKing
```

**Summary** (≤ 132 chars)
```
Link your question bank to your AnKing Anki cards: resource overlays, one-click cards, weak-area breakdowns, and a study tracker.
```

**Category:** `Education`

**Language:** `English`

**Detailed description**
```
Mnestic connects the question you're studying to your own AnKing Anki cards — no
copy-pasting, no tab-switching.

On a question it can:
• Show the matched AnKing resources (Sketchy, Boards & Beyond, First Aid, OME,
  Physeo, Picmonic) and pop their images right over the question — press F for
  First Aid, S for Sketchy, P for Physeo, and so on.
• Make a new Cloze or Basic card, or save the exact AnKing card the question maps
  to, into a chapter deck — with your note and even the question's own images.
• Break a finished block down into your weakest System / Subject / Topic, and
  open just those missed questions in Anki.
• Track your study pace: a daily streak, a 16-week heatmap, targets, and a
  projected finish date.

How it works: your question bank reuses UWorld's question IDs, and your AnKing
deck is tagged with them, so matching is a single local Anki search. Everything
runs on your own computer.

Requires the free companion add-on "Mnestic Bridge" (AnkiWeb) and your own AnKing
deck. Open source (MIT): https://github.com/KhaledMD4321/mnestic

Not affiliated with or endorsed by Coursology, UWorld, AnKing, Anki, Sketchy,
Boards & Beyond, Physeo, or First Aid. Works with content you already own.
```

**Screenshots:** upload the 1280×800 images from `dist/store/` (store-1…store-3).

**Privacy policy URL**
```
https://github.com/KhaledMD4321/mnestic/blob/main/PRIVACY.md
```

---

## Privacy practices tab

**Single purpose**
```
Mnestic links the question bank question you're viewing to your own local Anki
(AnKing) cards, so you can see matched resources and make or review those cards
without leaving the page.
```

**Permission justifications**

- **storage**
  ```
  Saves the user's own settings and study-pace log in their browser. No data
  leaves the device.
  ```
- **clipboardWrite**
  ```
  Powers the "Copy for AI" and "Copy explanation" buttons, which copy the current
  question or explanation to the user's clipboard.
  ```
- **Host permission — `https://*.coursology-qbank.com/*`**
  ```
  The extension runs on the user's question bank to read the visible question
  (its ID and text) so it can be matched to the user's Anki cards, and to fetch a
  question's own image when the user chooses to attach it to a card.
  ```
- **Host permission — `http://127.0.0.1:8790/*`**
  ```
  Communicates with the user's local companion Anki add-on (Mnestic Bridge) over
  localhost to search their collection and create cards. This is entirely on the
  user's own machine.
  ```

**Remote code:** `No, I am not using remote code.` (all scripts are in the package)

**Data usage — declare:**
- Does your extension collect or use user data? → **We do not collect or use it.**
- Check: the extension does **not** sell data, does **not** use it for anything
  unrelated to its single purpose, and does **not** use it for creditworthiness /
  lending.
