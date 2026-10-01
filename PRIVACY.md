# Mnestic — Privacy Policy

_Last updated: 2026-10-01_

**Mnestic does not collect, transmit, sell, or share any personal data.** It has
no backend server, no analytics, no accounts, and no ads.

Mnestic links the question you're viewing in your question bank to your own local
Anki collection, entirely on your own computer.

## What it accesses, and why

- **The question-bank page you're on.** The extension reads the visible question
  — its ID and text — to find and show your matching Anki cards. This is
  processed in your browser and is not sent to us.
- **Your local Anki (`127.0.0.1:8790`).** The extension talks only to the
  **Mnestic Bridge** add-on running on your own machine, over localhost, to
  search your collection and create cards. Nothing leaves your computer.
- **Question-bank images.** When you choose to attach a question's own image to a
  card, the extension fetches that image from the question bank's image server so
  it can be saved into your card. The image is used only to build your card.
- **Images inside your cards.** A card preview shows images from your own Anki
  media folder only. If a card's HTML points at an image on another website,
  Mnestic does **not** load it (it shows a placeholder), so that website can't
  learn your address or that you viewed the card.

## What it stores

Only **locally, in your browser** (`chrome.storage.local`). Nothing here ever
leaves your device, and there is nowhere for it to be sent.

| What | Why |
|---|---|
| Your settings | Step, theme, how to save missed questions, deck names, toggles, your AI prompt and which one Copy for AI uses |
| Your study-pace log | Which questions you answered and when, how they went (and why, if you said), your last **Test me** score, and the qbank totals it read — this is what draws the tracker |
| Which resource rows you open | So the panel can put the ones you use at the top |
| Which cards Mnestic unsuspended, per question | So **Suspend again** puts back exactly those cards and nothing that was already in your reviews (kept 60 days) |
| What each save did | For each card you save to Missed Qs: which question it came from, the deck it lived in, and which of its cards the save unsuspended — this is what lets **Remove from Missed Qs** undo exactly that save |
| Chapters you pick | So the next save suggests the chapter you'd choose |
| The question bank's subject/system for questions you've reviewed | Read off the results page, to suggest the matching chapter when you save |
| Your pairing code | The code that lets the extension talk to your own Anki |

Uninstalling the extension removes all of it.

## What it writes into your Anki collection

Only what you ask for: the notes you type into a card's **Missed Questions**
field, images you attach, cards you make, and Mnestic's own tags —
`Mnestic::Missed…`, `Mnestic::QID::<question id>` (which question a card was
saved from or made for), `Mnestic::Made`, `Mnestic::Copy`, and
`AnkiHub_Protect::Missed_Questions`. Your collection is yours: if you use Anki's
own sync (AnkiWeb), these are synced like any other change you make in Anki.
Mnestic itself sends nothing anywhere.

## What it does NOT do

- No accounts, sign-in, tracking, analytics, or advertising.
- No data sent to the developer or any third party — there is no server to send
  it to.

## Permissions, explained

- **storage** — save your settings and study log in your browser.
- **clipboardWrite** — "Copy for AI" (and its "Copy the explanation only") writes to
  your clipboard.
- **Access to your question-bank sites** (Coursology, MedPark, UWorld) — read the current
  question so it can be matched to your Anki cards. The extension runs only on
  those sites.
- **Access to `127.0.0.1:8790`** — talk to your local Mnestic Bridge Anki add-on.

## The Anki add-on

The companion add-on (**Mnestic Bridge**) binds to `127.0.0.1` only, so it is
never reachable from your network. Every request must carry your pairing code,
and requests whose origin is a website are refused. It has no network access of
its own: it does not phone home, check for updates, or report anything.

## Contact

Questions or concerns: open an issue at
<https://github.com/KhaledMD4321/mnestic>. Mnestic is open source (GPLv3).
