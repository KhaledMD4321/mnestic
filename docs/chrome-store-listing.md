# Chrome Web Store — listing copy (paste-ready)

Everything you need for the submission form. Copy each field across.

> Note: keep brand names minimal in the **Name / Summary / Description**. Chrome's
> spam filter rejects long lists of third-party brand names ("keyword stuffing").
> Name a resource or two only where it's genuinely descriptive; never a pile of
> them, and no "not affiliated with A, B, C, D…" list.

---

## Store listing tab

**Name** (≤ 45 chars)
```
Mnestic
```

**Summary** (≤ 132 chars)
```
Link your question bank to your Anki cards: resource overlays on each question, one-click cards, weak-area breakdowns, and a tracker.
```

**Category:** `Education`

**Language:** `English`

**Detailed description**
```
Mnestic connects the question you're studying to your own AnKing cards — no
copy-pasting and no tab-switching.

On a question it can:
• Show the study resources your deck links to (First Aid, Sketchy, and more) and
  pop their images right over the question — one keystroke each: press F, S, P …
• Make a new Cloze or Basic card, or keep the exact card the question maps to, in
  a chapter deck — with your note and even the question's own images.
• Break a finished block into your weakest System / Subject / Topic, and open just
  those missed questions in Anki.
• Track your pace: a daily streak, a 16-week heatmap, targets, and a projected
  finish date.

Everything runs on your own computer. The extension talks only to a small local
companion add-on that searches and updates your own Anki collection — nothing is
collected or sent anywhere.

Requires the free companion add-on "Mnestic Bridge" and your own tagged deck.
Open source (MIT): https://github.com/KhaledMD4321/mnestic

An independent study tool. Use your own accounts and your own content.
```

**Screenshots:** upload the five 1280×800 images from `dist/store/` (store-1…store-5).

**Privacy policy URL**
```
https://github.com/KhaledMD4321/mnestic/blob/main/PRIVACY.md
```

---

## Privacy practices tab

**Single purpose**
```
Mnestic links the question you're viewing in your question bank to your own local
Anki cards, so you can see matched resources and make or review those cards
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

**Remote code:** `No, I am not using remote code.`

**Data usage:** leave every "what data do you collect" box **unchecked** (Mnestic
collects nothing), then tick the three certification statements (does not sell /
does not use for unrelated purposes / does not use for creditworthiness).
