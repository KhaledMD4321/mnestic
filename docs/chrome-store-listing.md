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

Works on UWorld, Coursology and MedPark. All three number their questions the
same way, which is what lets one AnKing tag search work on all of them.

── WHILE YOU REVIEW A QUESTION ──

• RESOURCE OVERLAYS. The resources your own card links to — First Aid, Sketchy,
  Physeo, OME and more — listed beside the explanation, one line each. Press F,
  S, P or O and that resource's images appear over the question. Multi-page
  topics page with the arrow keys.

• SEE THE CARDS. How the matching cards actually stand (mature, young, learning,
  suspended) with one-click unsuspend, and a preview of the card itself with
  clozes revealed — without opening Anki.

• KEEP THE ONES YOU MISSED. Save a question into a chapter subdeck built from
  the card's own AnKing tags, with your note added to the card. Move the real
  card, tag it, or make a copy — your choice, changeable at any time. Saved one
  by mistake? Reopen the dialog and one click takes it back out: it untags the
  card, moves it home, and keeps everything you typed.

• MAKE A CARD. Select any explanation text and turn it into a new Cloze or Basic
  card, created in Anki with the question id as its source. Paste screenshots in.

• COPY FOR AI. Your own editable prompt plus the whole question, copied in one
  click for ChatGPT, Claude or Gemini.

── WHEN THE BLOCK IS DONE ──

• WEAK AREAS. Per System / Subject / Topic accuracy, weakest first, with a
  button that opens just that group's missed questions in Anki.

• OPEN THEM IN ANKI. Missed, all, flagged, or high-yield only — straight to
  Anki's browser, or unsuspended in bulk.

── OVER THE WEEKS ──

• STUDY TRACKER. Today and this week against your targets, a daily streak, a
  16-week heatmap, 7-day accuracy, and a projected finish date from your real
  pace.

• RETEST WHAT YOU MISSED. The question ids grouped by chapter, ready to paste
  into your qbank's own test builder — and a filtered deck to study them in Anki.

── PRIVACY ──

Everything runs on your own computer. There is no server, no account and no
telemetry. The extension talks to exactly two things: the question-bank page
you're already on, and a small companion add-on on 127.0.0.1 that searches your
own Anki collection. Nothing is collected and nothing is sent anywhere.

The add-on cannot delete your cards: it has one delete operation, for undoing a
"make a copy" save, and it refuses any note it did not itself create.

── WHAT YOU NEED ──

1. Anki, running, with the free companion add-on "Mnestic Bridge":
   Tools > Add-ons > Get Add-ons, paste 199262916, restart Anki.
   https://ankiweb.net/shared/info/199262916
2. Your own AnKing deck, with the UWorld question-id tags.
3. Your own question-bank access.

Full guide: https://github.com/KhaledMD4321/mnestic/blob/main/docs/guide.md
Open source (GPLv3): https://github.com/KhaledMD4321/mnestic

Free, with no ads and no paid tier. If it helps you, you can support it:
https://buymeacoffee.com/bnkhaled

An independent study tool, not affiliated with any question bank, resource, or
with Anki or AnKing. Use your own accounts and your own content.

```

**Screenshots:** upload the five 1280×800 images from `dist/store/` (store-1…store-5).

**Privacy policy URL**
```
https://github.com/KhaledMD4321/mnestic/blob/main/PRIVACY.md
```

**Support URL** (Store listing tab — optional field, use the repo's issues)
```
https://github.com/KhaledMD4321/mnestic/issues
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
- **Host permissions — `https://*.coursology-qbank.com/*`, `https://*.medpark.io/*`, `https://*.uworld.com/*`**
  ```
  The extension runs on the user's own question bank to read the visible question
  (its ID and text) so it can be matched to the user's Anki cards, and to fetch a
  question's own image when the user chooses to attach it to a card. These are
  the only question banks it supports, and it runs on no other site.
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
