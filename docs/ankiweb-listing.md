# AnkiWeb — listing copy (paste-ready)

Add-on page: <https://ankiweb.net/shared/info/199262916>
Upload at: <https://ankiweb.net/shared/mine> → Mnestic Bridge → Update

AnkiWeb has no version field. The uploaded `.ankiaddon` IS the version, and it
goes live immediately — users receive it via Tools → Add-ons → Check for Updates.

---

**Title**
```
Mnestic Bridge
```

**Description** (markdown)
```
The companion add-on for **Mnestic**, a browser extension that links the
question you're studying in your question bank to your own AnKing cards.

**This add-on does nothing on its own.** It has no interface beyond one menu.
It runs a small server on `127.0.0.1` that only the extension talks to, so the
extension can search your collection, show you the matching card, and add your
notes to it. Everything you actually *do* happens in the browser.

Get the extension:
https://chromewebstore.google.com/detail/mnestic/mdjekpfeinjdgkjbeaffbpfhodofhfhd

## Setting it up

1. Install this add-on and **restart Anki**.
2. **Tools > Mnestic Bridge > Pairing code...** (it copies to your clipboard).
3. Paste it into the extension's popup. Done.

Every request needs that code, and requests coming from a website are refused
outright.

## The Tools menu

* **Pairing code...** - shows and copies your code.
* **Issue a new pairing code...** - replaces it, if it ever leaks.
* **Status and deck check...** - version, profile, and how many of your notes
  carry UWorld tags per step. The fastest way to tell whether a question isn't
  matching because of your deck.

## What it can do

Search your notes, read a note's fields and tags, read card stats and maturity,
list decks and tags, read and write media, open Anki's Browse window, add tags,
append to a field, create or copy a note, move cards into a deck, create a deck,
unsuspend, and build a filtered deck.

## What it will not do

* **It will not delete your cards.** There is exactly one delete operation. It
  exists so the extension can undo a "make a copy" save, and it refuses any note
  that is not a copy Mnestic itself created - the note must carry Mnestic's own
  marker tag and must not be AnkiHub-managed.
* **It will not remove tags that aren't its own.** Only tags under `Mnestic::`.
  Nothing can strip `marked`, `leech`, an AnKing tag, or the
  `AnkiHub_Protect::Missed_Questions` tag that stops a deck update overwriting
  notes you typed.
* **It will not talk to the internet.** Loopback only. No server, no account, no
  telemetry.

Those limits live in the add-on rather than in the extension that calls it,
because the add-on is what a request actually reaches.

## Notes

* Change the port under **Tools > Add-ons > Mnestic Bridge > Config** if 8790 is
  taken, and set the same port in the extension.
* Update the add-on and the extension together - the extension calls operations
  that only newer add-ons have. It degrades with a message rather than failing
  silently, but you want the pair.

**Guide:** https://github.com/KhaledMD4321/mnestic/blob/main/docs/addon-guide.md
**Source:** https://github.com/KhaledMD4321/mnestic

Open source under the GNU GPL v3. Free, no ads, no paid tier.
If it helps you: https://buymeacoffee.com/bnkhaled

An independent project. Not affiliated with Anki, AnKing, or any question bank.

**Support:** https://github.com/KhaledMD4321/mnestic/issues

```

**Supported Anki versions:** leave as-is unless you have tested a narrower range.
Tested on Anki 26.09.
