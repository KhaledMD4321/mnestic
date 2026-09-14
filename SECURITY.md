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
  liveness `ping`, compared with a timing-safe comparison;
- rejects any request whose `Origin` is a website — the origin's **host is
  compared exactly** (a prefix test would accept look-alikes such as
  `http://127.0.0.1.attacker.tld`), and only `chrome-extension://` and loopback
  are accepted;
- rejects any request whose **`Host` header isn't loopback**, which blocks
  DNS-rebinding attacks, and validates the same on `OPTIONS` before answering a
  preflight or granting Private Network Access;
- resolves media filenames with `basename` only, so a crafted filename can't
  escape the media folder.

**Card HTML is treated as untrusted.** Note fields are HTML, and Anki users
import shared decks from strangers. Mnestic never assigns note HTML to
`innerHTML`. It parses it inertly with `DOMParser` and rebuilds it from a strict
tag/attribute allowlist, dropping every event handler, `<script>`/`<iframe>`,
and `javascript:`/non-image `data:` URL.

**Every link built from a deck is scheme-checked.** Resource links (Sketchy,
First Aid, …) are resolved against the page and accepted only if they are
`http(s)`, so a deck cannot put a `javascript:`, `data:`, `vbscript:` or `file:`
URL into the panel. This is enforced both where links are harvested and again
where the anchor is built.

**Only real user input reaches your collection.** Mnestic's UI lives in the
page's DOM, which the page's own scripts can also touch. Every control that can
talk to Anki requires a trusted event, so a compromised page cannot drive it
with synthetic clicks or keystrokes.

**The image fetcher is not an open proxy.** The background worker will only
fetch https images from a supported question bank's own domain — the same short
list the manifest grants host permissions for — and only if the response is an
image.

**Each site adapter only reads.** Support for a new question bank adds selectors
and page heuristics, never new privileges: the extension still runs only on the
hosts listed in the manifest, still talks only to `127.0.0.1`, and still sends
nothing anywhere. The popup's **Check this page** diagnostic reports page
*structure* only (tag names, ids, class names) — never question text, answers,
or account details.

## Scope

In scope: the extension (`extension/`), the add-on (`anki-addon/`), and anything
that could expose your collection, your browser session, or your machine.

Out of scope: issues that require an attacker to already have code execution or
file access on your computer (they can read the pairing code from disk either
way), and the behaviour of Anki, Chrome, or the question bank themselves.

## Good practice for users

- Only pair Mnestic with an Anki you control, and keep the pairing code private.
- Treat imported/shared Anki decks the way you'd treat any file from a stranger.
