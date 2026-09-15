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

This add-on does nothing on its own. It runs a small server on `127.0.0.1` that
only the extension talks to, so the extension can search your collection, show
you the matching card, and add your notes to it. Nothing leaves your computer:
there is no server, no account, and no telemetry.

**It requires a pairing code.** After installing, restart Anki, then open
Tools → Mnestic Bridge → Pairing code and paste it into the extension. Every
request needs that code, and requests from websites are refused outright.

**What it can do:** search your notes, read a card's media, open the Browser,
create or copy a note, move a card into a deck, and build a filtered deck.

**What it cannot do:** delete your cards. Its one delete operation exists to
undo a "save a copy" and refuses any note it did not itself create — the note
must carry Mnestic's marker tag and must not be AnkiHub-managed. Removing a tag
is limited the same way: only tags under `Mnestic::`, so nothing can strip
`marked`, `leech`, an AnKing tag, or the `AnkiHub_Protect` tag that guards notes
you have typed.

Get the extension and read the source:
https://github.com/KhaledMD4321/mnestic

Open source under the GNU GPL v3. Free, no ads, no paid tier.
If it helps you: https://buymeacoffee.com/bnkhaled

An independent project. Not affiliated with Anki, AnKing, or any question bank.

**Support:** https://github.com/KhaledMD4321/mnestic/issues
```

**Supported Anki versions:** leave as-is unless you have tested a narrower range.
Tested on Anki 26.09.
