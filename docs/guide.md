# Mnestic — the complete guide

**[Get the extension](https://chromewebstore.google.com/detail/mnestic/mdjekpfeinjdgkjbeaffbpfhodofhfhd)** ·
**[get the add-on](https://ankiweb.net/shared/info/199262916)** ·
**[the add-on's own guide](addon-guide.md)** ·
**[source](https://github.com/KhaledMD4321/mnestic)**

Everything Mnestic does, in the order you'll meet it.

**Just curious?** The [1:46 promo](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/mnestic-promo.mp4)
shows the whole idea.

**New here?** [▶️ Watch the 7-minute walkthrough](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/mnestic-real-walkthrough.mp4)
first — it's faster than reading, it's recorded on a real qbank, and every click
and key is highlighted so you can see exactly what's being pressed. Each section
below also has its own short clip. Then do [Setup](#1-setup) and
[Check your ids match](#2-check-your-ids-match), which takes 30 seconds and
tells you whether this will work for your deck at all.

---

## Everything it does, at a glance

If you only read one table, read this one.

### On a question you've answered

| | What it does | Key |
|---|---|:---:|
| **Resource panel** | The resources your own card links to — First Aid, Sketchy, Physeo, OME, B&B, Picmonic — one collapsed line each, with the topics covered | |
| **Image overlays** | That resource's images, over the question — press its key or click the key badge on its row. Multi-page topics page with the arrows | **F S P O E A** |
| **Card readiness** | How the matching cards stand: mature, young, learning, suspended — with one-click **Unsuspend** | |
| **Preview** | Read the matched card as Anki renders it, clozes revealed, images inline | |
| **Open in Anki** | This question's cards in Anki's Browse window | **D** |
| **Copy for AI** | A focused prompt + the question, your answer and the correct one, on the clipboard; **▾** picks the prompt | **Q** |
| **Copy the explanation only** | Just the explanation text — in the **▾** menu next to Copy for AI | |
| **Save to Missed Qs** | Keep it in a chapter subdeck with your note — move, tag, or copy | **V** |
| **Remove from Missed Qs** | Undo that save. Untags, moves the card home, deletes the copy | |
| **Make a card** | Select explanation text → a new Cloze or Basic card in Anki | **G** |
| **How did that go?** | Optional: how sure you were, or why you missed it — with the one next step | |
| **🧠 Test me** | This question's cards as a quick flashcard run, in the panel (practice only) | |

### When the block is finished

| | What it does |
|---|---|
| **Anki: Missed / All / Marked / High-Yield** | Opens those questions' cards in Anki — or unsuspends them, with Easy mode on |
| **Weak areas** | Per System / Subject / Topic accuracy, weakest first |
| **Open N missed** | Sends just that group to Anki |
| **Drill weakest 3** | Sends the three worst groups at once |

### In the popup, over the weeks

| | What it does |
|---|---|
| **Study tracker** | Today and this week vs targets, daily streak, 16-week heatmap, 7-day accuracy, projected finish date |
| **Missed questions** | Your saved questions grouped by chapter, with **Copy ids** for your qbank's test builder |
| **Study them in Anki** | Builds a filtered deck of everything you missed |
| **Find a topic in Anki** | Opens Browse on any topic, for drilling outside the qbank |
| **Copy for AI** | Which prompt one click uses, and your own prompt (optional) |
| **Check my deck / this page** | Diagnostics when something isn't matching |

### Settings

**Step** · **Panel theme** (match the site / light / dark) · **Missed questions
mode** and deck · **Expected score** · **Easy mode** · **High-yield only** ·
**Keyboard shortcuts** · **Bridge port**

---

## Contents

| | |
|---|---|
| **[1. Setup](#1-setup)** | Install the add-on and extension, pair them |
| **[2. Check your ids match](#2-check-your-ids-match)** | The one assumption everything rests on |
| **[3. On a question](#3-on-a-question)** | Resource panel, image overlays, card readiness |
| **[4. The buttons](#4-the-buttons)** | Copy for AI, Copy explanation, Preview, Test me, Save |
| **[5. Missed questions](#5-missed-questions)** | Three ways to keep one, chapter subdecks, undo |
| **[6. Make a card](#6-make-a-card)** | Turn any explanation text into a new card |
| **[7. After a block](#7-after-a-block)** | Results buttons and the weak-area breakdown |
| **[8. The popup](#8-the-popup)** | Tracker, missed list, settings, topic search |
| **[9. Keyboard shortcuts](#9-keyboard-shortcuts)** | All of them |
| **[10. In Anki](#10-in-anki)** | The Tools menu, and what the add-on will not do |
| **[11. Troubleshooting](#11-troubleshooting)** | When something doesn't match |

---

## 1. Setup

You need **Anki open**, an **AnKing deck with UWorld tags**, and Chrome (or Brave
/ Edge).

*Prefer it spelled out click by click?* → [**INSTALL.md**](../INSTALL.md)

### Step 1 — the Anki add-on

**Tools → Add-ons → Get Add-ons…** and paste:

```
199262916
```

Then **restart Anki**. The add-on runs a small server on `127.0.0.1:8790` that
only the extension talks to. ([AnkiWeb page](https://ankiweb.net/shared/info/199262916) ·
[what the add-on does](addon-guide.md))

### Step 2 — the extension

[**Add Mnestic to Chrome**](https://chromewebstore.google.com/detail/mnestic/mdjekpfeinjdgkjbeaffbpfhodofhfhd) — that's the whole step.

<details><summary>Or load it unpacked</summary>

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick the `extension/` folder

</details>

### Step 3 — pair them

The bridge needs a private **pairing code**, so nothing else on your computer can
reach your collection through it.

1. In Anki: **Tools → Mnestic Bridge → Pairing code…** (it copies to your clipboard)
2. Open the Mnestic popup → paste it into **Pairing code** → **Save**
3. The pill turns **● Ready**

> **The popup tells you what's missing.** A first-run checklist at the top shows
> three ticks — Anki running, paired, and a Missed Qs deck — and each links to the
> thing that fixes it. The deck it can create for you.

---

## 2. Check your ids match

Everything rests on one assumption: **your qbank's question id is the same number
UWorld used**, and your AnKing cards carry it. Check one question before relying
on it.

1. On a question, note the header: **Question Id: 1633**
2. In Anki's **Browse**, search:

   ```
   tag:#AK_Step1_v*::#UWorld::*::1633
   ```

3. **Same topic comes back?** The ids line up — everything will work.
   **Nothing, or an unrelated card?** Your qbank renumbered its questions, and the
   tag approach won't work as-is.

The popup's **Advanced → Check my deck** does the same count for you across all
three steps.

---

## 3. On a question

Answer it first. **Mnestic shows nothing until the explanation is visible** — it
will never spoil an unanswered question.

### The resource panel

![The Mnestic panel under the explanation: the matched cards, every resource, and the chapters they cover](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/01-mnestic-panel.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/01-mnestic-panel.mp4)</sub>

The resources your AnKing card links to — Sketchy, Boards & Beyond, First Aid,
Physeo, OME, Picmonic and others — appear beside the explanation, **collapsed to
one line each**, showing the topics covered, the overlay key, and how many
chapters. Open the ones you use; it remembers, and floats what you open most to
the top.

Step 2 and Step 3 resources show alongside the Step 1 ones.

### Image overlays — the one you'll use every question

With the explanation open, press a key — or click the little key badge on that
resource's row — and its images appear **over the question**:

| Key | Resource |
|:---:|---|
| **F** | First Aid |
| **S** | Sketchy |
| **P** | Physeo |
| **O** | OME |
| **E** | Extra |
| **A** | Additional Resources |

![Press F: the question's First Aid pages open over the question and flip with the arrow keys](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/02a-first-aid-images.gif)

Multi-page resources page with **← →**, show *2 / 5*, and carry a filmstrip of
every page — click a thumbnail to jump to it. The arrows only move the pages,
never the question behind. Images are fetched while you read, so the first
keypress is instant. **Esc** closes.

Every key badge is also a button, so the images are one click away without the
keyboard. **E** and **A** show the images in your cards' *Extra* and *Additional
Resources* fields — often the explanation's own figures:

![Click the S badge for Sketchy, jump by thumbnail, then E for Extra and A for Additional Resources](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/02b-sketchy-extra-additional.gif)

<sub>▶ MP4: [First Aid](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/02a-first-aid-images.mp4) · [Sketchy, Extra, Additional](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/02b-sketchy-extra-additional.mp4)</sub>

### The readiness strip

A line under the buttons says how the matching cards actually stand —
*9 cards · 3 mature · 2 suspended* — with one-click **Unsuspend**.

### Quick open in Anki

Once you've answered, a small **Anki** button appears beside the question id and
opens that question's cards in Anki's Browser. (Shortcut: **D**.) It stays hidden
while a question is unanswered — those cards are the answer.

Preview, Unsuspend and Open in Anki, on a real question:

![Preview a card, unsuspend the question's cards, then open them in Anki's Browse window](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/03-cards-preview-unsuspend.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/03-cards-preview-unsuspend.mp4)</sub>

---

## 4. The buttons

At the top of the resource panel.

### 🤖 Copy for AI — **Q**

Copies a prompt and the question **in parts** — the stem, the lettered choices
with *your answer* and *the correct answer* marked, the result, how it went (if
you said), and the explanation. It leaves out the block's question list, "Item 20
of 40", timers, the answer percentages, the qbank's name and the link. If your
answer can't be read on the page, the text says so and tells the AI not to guess.

The **▾** next to the button:

| Prompt | What you get |
|---|---|
| **Full review** (default) | What it tests, the key clues, how to solve it, why the answer is right, *why yours was wrong* (or what should have made you sure), every other choice in a line, what to remember |
| **Why I got it wrong** | Why your answer was tempting, the clue that rules it out, your error type, one rule for next time, the same trap again |
| **Compare the choices** | Every option: what it is, the deciding clue, "it would be correct if…", and a table of the correct answer vs. yours |
| **High-yield points** | The topic's high-yield points, grouped and ordered from most to least tested |
| **Quiz me** | Five questions, one at a time, getting harder, ending with a new vignette |
| **My own prompt** | The one you wrote in the popup |

Each prompt adapts to the Step (Step 1: mechanisms; Step 2 CK / 3: diagnosis and
the next best step) and to whether you were right, wrong or unsure. **★** makes a
prompt the one-click default. Nothing is sent anywhere — you paste it.

![Copy for AI, pasted: your prompt, then the question id, link and full question](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/06-copy-for-ai.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/06-copy-for-ai.mp4)</sub>

### Copy the explanation only

Just the qbank's explanation text, for your own notes.

### 👁 Preview

Reads the matched card(s) without opening Anki — clozes revealed, images inline,
with **‹ Prev / Next ›** across every card matched to the question.

### 🧠 Test me

The cards tagged with this question are already the flashcards for it — AnKing
wrote them, the question id links them — so **Test me** runs them as a quick
test in a focus window over the page — the question and the explanation (which
state the answer) are dimmed behind it, so recalling the card is real — without
leaving the question. **T** opens it; **Esc** or **✕** brings you back:

1. One cloze at a time, like Anki: the blank hidden (or its hint shown).
2. **Show answer** — the answer, with the card's **Extra** open and **Additional
   Resources** one click away.
3. **Got it** or **Missed**.

At the end you see what you missed, and — only if you tap them — **Unsuspend the
ones you missed** (exactly those cards, so Anki starts scheduling them), **Save
to Missed Qs**, or **Test the missed again**.

It's practice only: **nothing is graded in Anki**. Remembering a card a minute
after reading the explanation is short-term memory; grading it "Good" would push
it weeks out on a false signal. Your last score stays in your browser.

### How did that go?

Optional, one tap, never in the way of the next question. It follows the result
on the page:

| You were | It asks | The choices |
|---|---|---|
| Right | How sure were you? | Knew it · Narrowed to 2 · Guessed |
| Wrong | Why did you miss it? | Didn't know it · Misread / missed a clue · Knew it, reasoned wrong · Torn between 2 |
| Omitted | What happened? | Didn't know it · Ran out of time |

Each answer comes with the one next step that helps — a guess → **Test me**; a
misread or a reasoning slip → **Copy for AI: Why I got it wrong**; torn between
two → **Copy for AI: Compare the choices**. In the block breakdown a guess counts
as missed, *Narrowed to 2* as half, and once you've rated 3 or more wrong answers
it shows **why you missed** them.

### ★ Save to Missed Qs — **V**

The big one — see below.

---

## 5. Missed questions

Worth understanding properly, because it writes to your collection.

### Three ways to keep one

Choose in the popup under **Missed questions**. Change it whenever you like — it
is not a one-time decision, and each save uses whatever is selected at the time.

| Mode | What happens | Keeps AnKing updates? |
|---|---|:---:|
| **Move the card** *(default)* | The real card moves into a chapter subdeck, keeping its review history. | ✅ |
| **Tag only** | Nothing moves. The note is tagged `Mnestic::Missed::<chapter>`. | ✅ |
| **Make a copy** | A duplicate note in the subdeck — a separate card from then on. | ❌ |

**Move** is the default because it gives you a real, studiable subdeck without
duplicating anything, and the note keeps its `ankihub_id`, so AnKing updates keep
arriving.

### Chapter subdecks

![Save a question to its chapter subdeck with a note, then take it back out](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/04-save-to-missed-with-note-and-undo.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/04-save-to-missed-with-note-and-undo.mp4) — the whole flow: card, chapter, note, save, and undo</sub>

The dialog offers chapters read from the card's **own AnKing tags** — organ
systems on Step 1, rotations on Step 2 — so your missed pile stays studiable by
topic instead of becoming one undifferentiated heap.

It **reuses a subdeck you already have**. If your decks are named
`01_Cardiology, 02_Renal, 03_Respiratory`, a respiratory question lands in
`03_Respiratory` — not a second, parallel `Respiratory` beside it.

You can also choose *no subdeck*, or type your own.

> A newly created subdeck **inherits the options preset** of the deck the card
> came from, rather than silently landing on Default and changing your daily
> limits.

### Your notes

Whatever you type goes into the card's **Missed Questions** field, appended — so
a second save on the same question adds to your note rather than replacing it or
duplicating anything.

Because Mnestic writes there, it also tags the note
`AnkiHub_Protect::Missed_Questions`. Without that, a routine AnkiHub deck update
can overwrite the field and take a term of notes with it.

### Images

Three ways to attach:

- **Paste** a screenshot straight into the dialog
- **Click to add** files
- **📎 From this question** — thumbnails of the question's own images; click only
  the ones worth keeping

*(The last is unavailable on MedPark — see [Supported banks](#supported-banks).)*

### Undoing a save

![The dialog on a saved question: Already in Missed Qs, with Remove from Missed Qs on offer](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/still-undo.png)

Reopen the dialog on a saved question. It says **"Already in Missed Qs"** and
offers **Remove from Missed Qs**, which undoes whichever save actually happened:

- **tag** — removes `Mnestic::Missed` and its chapter child
- **move** — that, **and moves the card back to the deck it came from**
- **copy** — that, **and deletes the copy**

**It never touches your notes.** The *Missed Questions* field and the
`AnkiHub_Protect` tag guarding it are left exactly as they are.

If you've since refiled the card somewhere of your own, **your filing wins** —
undo unties it from Missed Qs and leaves it where you put it.

> Copies made before v1.3.0 carry no marker tag, so undo will refuse to delete
> them and say so. Those need Anki's Browse window.

### Studying them

In the popup: your missed questions grouped by chapter, with **Copy ids** per
group (paste straight into your qbank's test builder) and **Study them in Anki**,
which builds a filtered deck — cards return to their home decks afterwards, so
studying them costs nothing permanent.

---

## 6. Make a card — **G**

Select any text in the explanation and a floating **✚ Make card** chip appears.

- **Cloze** or **Basic**
- For a cloze, highlight the word to hide and click **Make cloze** — it becomes
  `{{c1::…}}`
- Picks a matching note type from your own collection
- Created with the question id + link as the source
- Paste screenshots into it too

For the fact a question taught you that no existing card covers.

> **Known issue:** in store version **1.3.1**, *Create card* does nothing.
> It's fixed in **1.5.0**.

![Select explanation text, click Make card, make a cloze, and attach the question as its source](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/05-make-a-card.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/05-make-a-card.mp4)</sub>

---

## 7. After a block

On the results / score table.

### The buttons

| Button | What it opens |
|---|---|
| **Anki: Missed** | Cards for every question you got wrong or omitted |
| **Anki: All** | Every question in the block |
| **Anki: Marked** | The ones you flagged |
| **Anki: High-Yield** | Only the high-yield cards among them |
| **📊 Weak areas** | The breakdown below |

> **Open the "Question List" popup once per test.** That's where *Marked* and an
> un-paginated *All / Missed* come from — and it's the only source that can tell
> **omitted** from **correct**, which the score table cannot.

With **Easy mode** on (popup), these unsuspend the cards instead of just opening
them.

### Weak-area breakdown

Per **System / Subject / Topic** accuracy for the block, **weakest first**, with:

- **Open N missed** — sends just that group to Anki
- **Drill weakest 3** — sends the three worst groups at once

A block that's all one system shows a single bar under *System* — switch to
*Subject* or *Topic* to see where the points actually went:

![The results toolbar, the weak-area breakdown by subject, and Open 6 missed opening exactly those cards in Anki](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/07-results-and-weak-areas.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/07-results-and-weak-areas.mp4)</sub>

---

## 8. The popup

Click the Mnestic icon.

### Study tracker

![The popup: study tracker, pace and settings](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/08a-popup-tracker-and-settings.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/08a-popup-tracker-and-settings.mp4)</sub>

- **Today** and **this week** against your targets
- 🔥 **Daily streak**
- **16-week heatmap**
- **Remaining** vs the qbank total — *visit your qbank's dashboard once* so it can
  read Used / Unused / Total
- **Projected finish date** at your current pace
- **7-day accuracy**

It keeps two signals separate: the **qbank's own counter** says how many
questions you did, and **Mnestic's log** says which ones and how they went. So it
credits blocks it never watched, and re-baselines instead of going negative when a
qbank resets.

### Settings

| Setting | What it does |
|---|---|
| **Step** | Which AnKing step to search. Auto-detected from the URL; this is the fallback. |
| **Dark panel** | Match the site / Light / Dark |
| **Missed questions** | Move / Tag only / Make a copy, plus the deck name |
| **Expected score (beta)** | Estimates a score from your cards' maturity |
| **Easy mode** | Results buttons unsuspend instead of just opening |
| **High-yield only** | Results buttons open only high-yield cards |
| **Keyboard shortcuts** | Turn them off |

Further down: the Missed Qs deck, the switches, and your missed questions by
chapter, each with **Copy ids**:

![The popup: Missed Qs deck, switches and the missed questions by chapter](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/08b-popup-missed-list-and-switches.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/08b-popup-missed-list-and-switches.mp4)</sub>

### Find a topic in Anki

Type a topic → opens Anki's Browser with the matching AnKing Step cards. For
drilling something tough outside the qbank.

### Copy for AI

**One click uses** picks the prompt the button uses (the **▾** next to it on the
panel picks any other for a single copy). **My own prompt** is optional: write one
and it becomes a sixth choice. If you'd written your own prompt before 1.5, it
stays the one-click default.

### Advanced

- **Port** — if `8790` clashes with something else
- **Check my deck** — how many notes carry UWorld tags, per step
- **Check this page** — what the extension can see on the current tab. Reports
  **structure only** (tag names, ids, class names) — never question text, answers,
  or account details — and **Copy report** puts it on the clipboard for a bug
  report

---

## 9. Keyboard shortcuts

They only work once you've **answered** and the panel is showing. Before that,
every key goes straight to your qbank untouched — so a letter key still picks an
answer, and nothing can open Anki on a question you haven't answered yet.

When a shortcut does fire, it's ours alone: the qbank doesn't also react to it.
Ignored while you're typing in a field.

**Turn them all off** in the popup (*Keyboard shortcuts*). The images stay one
click away on each row's key badge.

| Key | Action |
|:---:|---|
| **F S P O E A** | Overlay First Aid / Sketchy / Physeo / OME / Extra / Additional |
| **← →** | Page through a multi-page overlay |
| **G** | Make a card |
| **Q** | Copy for AI |
| **V** | Save to Missed Qs |
| **T** | Test yourself on this question's cards (then **Space** shows the answer, **Space** = Got it, **1** = Missed) |
| **D** | Open this question in Anki |
| **?** | Shortcut cheatsheet |
| **Esc** | Close the overlay or dialog |

![Press ? for every shortcut](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/09-keyboard-shortcuts.gif)

<sub>▶ [MP4 version](https://github.com/KhaledMD4321/mnestic/releases/download/tutorial-media/09-keyboard-shortcuts.mp4)</sub>

---

## 10. In Anki

The add-on has its own guide — what it can do, what it refuses to do, its
settings and its troubleshooting: **[Mnestic Bridge guide](addon-guide.md)**.
The short version:

**Tools → Mnestic Bridge**

| Item | What it does |
|---|---|
| **Pairing code…** | Shows and copies your code |
| **Issue a new pairing code…** | Rotates it. Do this if it ever leaks — then re-paste it into the popup. |
| **Status and deck check…** | Version, profile, and how many notes carry UWorld tags per step |

### What the add-on will not do

- **It cannot delete your cards.** Its one delete operation exists to undo a
  *Make a copy* save, and refuses any note that is not a copy Mnestic itself
  created — the note must carry Mnestic's marker tag and must not be
  AnkiHub-managed.
- **It only removes its own tags.** Nothing can strip `marked`, `leech`, an AnKing
  tag, or the `AnkiHub_Protect` tag guarding notes you typed.
- **Nothing leaves your machine.** No server, no account, no telemetry. It binds to
  loopback, requires the pairing code on every request, and refuses requests whose
  origin is a website.

---

## 11. Troubleshooting

### "Anki isn't running"

Anki must be **open**, with the add-on installed and Anki **restarted** since. If
it still says this, check **Tools → Add-ons** for a startup error.

### A question isn't matching

1. Check the id lines up — [section 2](#2-check-your-ids-match).
2. Wrong step? The popup's **Step** selector overrides URL detection.
3. Still nothing? The panel shows the exact Anki search it tried. Paste that into
   Browse and see what your deck actually has.

### Nothing appears on the question

Mnestic waits for the explanation to be visible, so it cannot spoil an unanswered
question. If you have answered and still see nothing, use **Advanced → Check this
page** and include the report in a bug report.

### The pairing code stopped working

A new one was issued. **Tools → Mnestic Bridge → Pairing code…**, then paste it
into the popup again.

### Port 8790 is in use

Change it in **Tools → Add-ons → Mnestic Bridge → Config**, restart Anki, then set
the same port in the popup's **Advanced**.

---

## Supported banks

| Bank | Status |
|---|---|
| **Coursology** (`coursology-qbank.com`) | ✅ verified against the live site |
| **MedPark** (`medpark.io`) | ✅ verified against the live site |
| **UWorld** (`uworld.com`) | 🧪 beta — built against fixtures, not a live account |

All three label questions with the **same UWorld question ids**, which is what
makes one AnKing tag search work everywhere.

**Two things do not work on MedPark**, for reasons on its side: the results-page
buttons and Weak areas (its Test Summary reports totals only — there is no
per-question id table to read), and **📎 From this question** (it serves question
figures from a third-party storage domain, and granting fetch access to a host
neither you nor MedPark controls is not a trade worth making). Paste and
file-picker attach still work.

---

## About the images in this guide — content & copyright

The clips and screenshots here were recorded on a **real qbank**, with the real
extension and a real Anki — none of it is a mock-up. All of them, plus a full
walkthrough video, are on the
[tutorial media release](https://github.com/KhaledMD4321/mnestic/releases/tag/tutorial-media).

**Mnestic does not include, host or own any qbank question or study resource.**
It only links the sources *you* already have — your qbank subscription and your
own AnKing deck — so you can use them together, on your own computer. The
recordings were made the same way, on the author's own subscription and deck. The
question text, images and resource names in them belong to their respective
owners and appear only to show how the extension works; Mnestic is not affiliated
with any of them. If you own content shown here and want it removed,
[open an issue](https://github.com/KhaledMD4321/mnestic/issues).

---

*Found something that doesn't behave like this?*
[Open an issue](https://github.com/KhaledMD4321/mnestic/issues).
