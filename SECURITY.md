# Security Policy

Mnestic can read the page you're studying and can **create and modify cards in
your Anki collection**, so security matters here. This document explains the
design, and how to report a problem.

## Reporting a vulnerability

Please **do not** open a public issue for a security bug.

- Use GitHub's private reporting: **Security → Report a vulnerability** on
  <https://github.com/KhaledMD4321/mnestic>, or
- open a normal issue asking me to get in touch, without details.

I'll acknowledge as quickly as I reasonably can, and credit you in the release
notes unless you'd rather stay anonymous.

## How Mnestic is designed to fail safely

**Nothing leaves your computer.** There is no server, no account, no analytics,
and no telemetry. The extension talks to exactly two places: the question-bank
page you're already on, and a local companion add-on on `127.0.0.1`.

**The bridge is locked down.** The Anki add-on (`mnestic_bridge`):
- binds to **loopback only** (`127.0.0.1`) — it is never reachable from your
  network;
- requires a **per-machine pairing code** on every request except a bare
  liveness `ping` (which names the add-on and nothing else), compared with a
  timing-safe comparison;
- rejects any request from a web page: only `chrome-extension://` origins are
  accepted, so a page on loopback (a local dev server, or a shared deck's script
  in Anki's own webview) is refused too, and a refusal carries no CORS header, so
  a website can't read the answer. A browser without a local-network prompt can
  still tell an open port from a closed one by timing or error. A local tool that sends
  no `Origin` still needs the pairing code;
- rejects any request whose **`Host` header isn't loopback**, which blocks
  DNS-rebinding attacks, and validates the same on `OPTIONS` before answering a
  preflight or granting Private Network Access;
- decides on the **headers alone, before reading the body**: a refused request,
  a missing or negative `Content-Length`, a body over 32 MB, or over 64 KB
  without a valid code is answered at once and the connection closed, and a
  connection that goes quiet for 30 seconds is dropped;
- resolves media filenames with `basename` only, so a crafted filename can't
  escape the media folder, and stores only real images, checked by their
  content, at most 24 MB each and never SVG.

**A pairing code can only do what Mnestic does.** The code proves a request
comes from Mnestic, but anything that learned it (malware, a leaked screenshot,
clipboard history) could send the same requests. So every write is limited, in
the add-on, to exactly what the extension needs:
- the only tags it adds are its own (`Mnestic::Missed…`, `Mnestic::QID::<id>`,
  `Mnestic::Made`) and `AnkiHub_Protect::Missed_Questions`, with no HTML in them;
  the only field it writes to on an existing note is **Missed Questions**, and
  only by **appending** — it never overwrites a field, and a card without that
  field is an error rather than a silently lost note;
- text it writes into a note may hold only what the extension produces: escaped
  text, line breaks, images from your media folder, and http(s) links. Script,
  event handlers, every other tag, media and LaTeX tags, and MathJax are refused,
  because Anki acts on all of them in cards. The limit is on what the text is
  written as; it has not been tested against every note type's template;
- searches that change cards (unsuspend, filtered decks, removing its tags) may
  only select by question-id tag, by Mnestic's own tags or by explicit note/card
  ids — never `deck:*`, a negation, or an empty search — and an unsuspend may
  touch at most 3,000 cards per request, checked before anything changes. Explicit
  ids can name any card, so these limits slow a stolen code down; they don't fence
  it off from part of your collection;
- re-suspending takes at most 500 cards per request, and only cards whose note
  is saved to Missed Qs or linked to a question (a UWorld or `Mnestic::QID` tag)
  — the cards Mnestic can unsuspend in the first place, never the rest of a
  collection;
- moving cards takes at most 50 notes per request and never into a filtered
  deck; it builds and rebuilds only filtered decks named "Mnestic…";
- it **deletes only notes it created**: a note must carry the marker tag
  `copyNote` writes and must not be AnkiHub-managed, at most 100 per request —
  and no request can add that marker to any other note, or blank its
  `ankihub_id`. Removing tags is limited to tags under `Mnestic::`, so no
  request can strip `marked`, `leech`, an AnKing tag, or the `AnkiHub_Protect`
  tag guarding notes you typed.

Before 1.4 the note-update operation accepted any tag and any field, so two
requests with the code could delete an arbitrary note (tag it as a Mnestic copy,
blank its `ankihub_id`, then delete it). `scripts/bridge-test.py` replays that
attack against the add-on on every test run.

What a stolen code can still do: read your collection, add notes and copies with
plain text and images, append text to Missed Questions, store images, move notes
between decks a few at a time, re-file or untag notes Mnestic itself saved,
suspend or unsuspend cards linked to a question, and delete the copies Mnestic
made. Rotate the code from
**Tools → Mnestic Bridge → Issue a new pairing code…** whenever it may have been
seen, and paste the new one into the extension.

**Card HTML is treated as untrusted.** Note fields are HTML, and Anki users
import shared decks from strangers. Mnestic never assigns note HTML to
`innerHTML`. It parses it inertly with `DOMParser` and rebuilds it from a strict
tag/attribute allowlist, dropping every event handler, `<script>`/`<iframe>`,
`class` (which could borrow the question bank's own styles), and any
`javascript:`/non-image `data:` URL. **Images on other websites are never
loaded** in a card preview — Mnestic shows a placeholder instead, so a shared
deck can't learn your address or when you viewed a card. An image from your own
media folder is read through the add-on and never requested from the page's
server (before 1.5 the browser first asked the qbank for it by its file name).

**Every link built from a deck is scheme-checked.** Resource links (Sketchy,
First Aid, …) are resolved against the page and accepted only if they are
`http(s)`, so a deck cannot put a `javascript:`, `data:`, `vbscript:` or `file:`
URL into the panel. This is enforced both where links are harvested and again
where the anchor is built.

**Only real user input reaches your collection.** Mnestic's UI lives in the
page's DOM, which the page's own scripts can also touch. Every control that can
talk to Anki — and every way of adding an image (paste, drop, file picker) —
requires a trusted event, so a compromised page cannot drive it with synthetic
clicks, keystrokes, pastes or drops. A click must also land on a control that is
visible and on top at that point, and Enter or Space only counts on a control you
reached yourself, which stops the simple ways of tricking a real press. A page
that controls its own DOM can still relabel a button or lay a transparent overlay
over it, so this raises the bar rather than closing the gap. Every new question,
the first after a page load included, takes real input since the last one, so a
page can't walk question ids unattended, in place or by reloading. Each real press
still lets a hostile page choose the next question. An end-to-end test clicks every Mnestic control from page script and checks that nothing
reaches Anki. What a page *can* still do is read the question's panel and open
dialogs, including text in rows you've opened, and edit a dialog's fields before
you press its button; isolating them from the page is planned.

**The background worker forwards only known requests.** It checks who is
asking: the part of Mnestic running inside the question-bank page may only use
the operations its features need, and the popup only its own, smaller set. Any
other operation is refused before it reaches Anki.

**The image fetcher is not an open proxy.** The background worker will only
fetch https images from a supported question bank's own domain — the same short
list the manifest grants host permissions for, checked again on the final address
after any redirect — and only if the response declares an image type other than
SVG. Images over 15 MB are refused; without a declared size, that is checked after
the download.

**Each site adapter only reads.** Support for a new question bank adds selectors
and page heuristics, never new privileges: the extension still runs only on the
hosts listed in the manifest, still talks only to `127.0.0.1`, and still sends
nothing anywhere. The popup's **Check this page** diagnostic reports page
*structure* (tag names, ids, class names), the page's path and the question ids it
sees — never question text, answers, or account details.

## Scope

In scope: the extension (`extension/`), the add-on (`anki-addon/`), and anything
that could expose your collection, your browser session, or your machine.

Out of scope: issues that require an attacker to already have code execution or
file access on your computer (they can read the pairing code from disk either
way), and the behaviour of Anki, Chrome, or the question bank themselves.

## Good practice for users

- Only pair Mnestic with an Anki you control, and keep the pairing code private.
- Treat imported/shared Anki decks the way you'd treat any file from a stranger.
