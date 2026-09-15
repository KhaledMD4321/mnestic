# Mnestic Bridge — the Anki add-on

**[AnkiWeb page](https://ankiweb.net/shared/info/199262916)** ·
**[the extension it serves](https://chromewebstore.google.com/detail/mnestic/mdjekpfeinjdgkjbeaffbpfhodofhfhd)** ·
**[the extension's guide](guide.md)**

---

## What it is

The browser extension cannot reach your Anki collection on its own — nothing in a
web page can. This add-on is the piece that lets it: a small server on
`127.0.0.1:8790` that the extension talks to, and nothing else can.

**It has no interface of its own and does nothing on its own.** Install it,
restart Anki, pair it once, and forget it. Everything you actually *do* happens
in the browser.

```
  your qbank tab                      your computer
 ┌────────────────────┐              ┌─────────────────────────┐
 │  Mnestic extension │ ──── POST ──►│  Mnestic Bridge  :8790  │──► your
 │  reads the question│   127.0.0.1  │  (this add-on)          │    collection
 │  id off the page   │◄── cards ────│                         │
 └────────────────────┘              └─────────────────────────┘
        nothing leaves this machine
```

---

## Install

**Tools → Add-ons → Get Add-ons…** and paste:

```
199262916
```

Then **restart Anki** — an add-on only loads at startup.

<details><summary>Install manually instead</summary>

Copy `anki-addon/mnestic_bridge/` from the repo into your add-ons folder, then
restart Anki:

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Anki2\addons21\mnestic_bridge\` |
| macOS | `~/Library/Application Support/Anki2/addons21/mnestic_bridge/` |
| Linux | `~/.local/share/Anki2/addons21/mnestic_bridge/` |

</details>

---

## The Tools menu

Everything the add-on offers is under **Tools → Mnestic Bridge**.

| Item | What it does |
|---|---|
| **Pairing code…** | Shows your code and copies it to the clipboard. Paste it into the extension's popup once. |
| **Issue a new pairing code…** | Replaces it. The old one stops working immediately, so re-paste the new one into the popup. |
| **Status and deck check…** | Version, whether a profile is open, and how many notes carry UWorld tags per step — the fastest way to tell whether your deck is the problem. |

### The pairing code

It is a random 32-character value generated the first time the add-on runs, and
**every request except a bare liveness `ping` is rejected without it**. It lives
in the add-on's config, so it stays put across restarts.

Rotate it (**Issue a new pairing code…**) if it ever ends up somewhere it
shouldn't — a screenshot, a shared screen, a pasted log.

---

## What it can do

These are the operations the extension can ask for. Nothing else is reachable.

| | |
|---|---|
| **Read** | search notes, read a note's fields and tags, count matches, read card stats and maturity, list decks and tags, read a media file |
| **Write** | add tags, append to a field, create a note, copy a note, move cards to a deck, create a deck, unsuspend, write a media file |
| **Open** | raise Anki's Browse window on a search |
| **Build** | a filtered deck from a search, for studying what you missed |

## What it will not do

The limits live **in the add-on**, not in the extension that calls it — because
the add-on is what a request actually reaches, and a limit in the caller is only
a limit while the caller behaves.

- **It will not delete your cards.** There is exactly one delete operation. It
  exists to undo a *Make a copy* save, and it refuses any note that is not a copy
  Mnestic itself created: the note must carry Mnestic's own marker tag, and must
  not be AnkiHub-managed. Anything else comes back as *refused*, and the
  extension says so rather than reporting a clean undo. It also refuses batches
  over 100 notes.
- **It will not remove tags that aren't its own.** Only tags under `Mnestic::`.
  Nothing can strip `marked`, `leech`, an AnKing tag, or the
  `AnkiHub_Protect::Missed_Questions` tag that stops a deck update overwriting
  notes you typed.
- **It will not talk to the internet.** It binds to loopback only. There is no
  server, no account, and no telemetry.
- **It will not answer a website.** Requests whose `Origin` is a web page are
  refused, and the origin's host is compared *exactly* — a prefix test would
  accept look-alikes like `http://127.0.0.1.attacker.tld`. It also checks the
  `Host` header, which is what blocks DNS-rebinding.

---

## Settings

**Tools → Add-ons → Mnestic Bridge → Config**

| Key | Meaning |
|---|---|
| `port` | The local port to listen on. Default `8790`. |
| `token` | Your pairing code. Leave blank on a fresh install and one is generated. |

**Restart Anki after changing either.** If you change the port, set the same one
in the extension's popup under **Advanced**.

---

## Troubleshooting

### The extension says Anki isn't running

In order:

1. **Is Anki actually open, with a profile loaded?** The bridge needs a
   collection; it does not run on the profile chooser.
2. **Did you restart Anki after installing?** Add-ons load at startup only.
3. **Check Tools → Add-ons for a red error.** If the add-on failed to start, Anki
   says so there, and the bridge never started.
4. **Check the port.** If something else has `8790`, Anki shows a tooltip at
   startup telling you to change it in the config.

### The pairing code stopped working

Someone issued a new one — including you, if you used *Issue a new pairing
code…*. Open **Tools → Mnestic Bridge → Pairing code…** and paste the current one
into the popup again.

### Nothing matches, but Anki is connected

That is a deck question, not a bridge question. **Tools → Mnestic Bridge →
Status and deck check…** shows how many notes carry UWorld tags per step. If a
step reads 0, your deck does not tag that step's questions the way Mnestic
searches for — see [checking your ids](guide.md#2-check-your-ids-match).

### Port 8790 is taken

Change `port` in the config, restart Anki, and set the same number in the
popup's **Advanced** section.

---

## Updating

AnkiWeb updates arrive through **Tools → Add-ons → Check for Updates**.

**Update the add-on and the extension together.** The extension gains features
that call operations only newer add-ons have. A new extension against an old
add-on degrades with a message telling you to update rather than failing
silently — but you want the pair.

---

## For the curious

The whole add-on is one Python file, about 1,000 lines, and it is meant to be
readable: [`anki-addon/mnestic_bridge/__init__.py`](../anki-addon/mnestic_bridge/__init__.py).

The wire protocol is deliberately boring:

```
POST /  {"op": "<name>", "token": "<pairing code>", "args": {…}}
     →  {"ok": true,  "data": …}
     →  {"ok": false, "error": "…"}
```

Anything touching the collection is marshalled onto Anki's main thread, because
the collection is not thread-safe and the HTTP server runs on its own.

Security design and how to report a problem: [SECURITY.md](../SECURITY.md).

---

*Free and open source under the [GNU GPL v3](../LICENSE). No ads, no account, no
paid tier. If it helps: [☕](https://buymeacoffee.com/bnkhaled)*
