# Mnestic — Privacy Policy

_Last updated: 2026-08-30_

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

## What it stores

Only **locally, in your browser** (`chrome.storage.local`): your settings, your
study-pace log, and the pairing code that links the extension to your Anki. This
never leaves your device and is not transmitted anywhere.

## What it does NOT do

- No accounts, sign-in, tracking, analytics, or advertising.
- No data sent to the developer or any third party — there is no server to send
  it to.

## Permissions, explained

- **storage** — save your settings and study log in your browser.
- **clipboardWrite** — the "Copy for AI" and "Copy explanation" buttons write to
  your clipboard.
- **Access to your question-bank site** — read the current question so it can be
  matched to your Anki cards.
- **Access to `127.0.0.1:8790`** — talk to your local Mnestic Bridge Anki add-on.

## Contact

Questions or concerns: open an issue at
<https://github.com/KhaledMD4321/mnestic>. Mnestic is open source (MIT).
