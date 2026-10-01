# Mnestic Bridge — a small local companion for the Mnestic browser extension.
#
# It runs a tiny HTTP server on 127.0.0.1:<port> (default 8790). The extension
# talks to it to search your collection, open the Browser, read card media, and
# create/copy cards. Nothing leaves your machine — the server is bound to
# localhost and every request must carry your private pairing code.
#
# Wire protocol (ours):
#   request : POST /  {"op": "<name>", "token": "<pairing code>", "args": {...}}
#   response: {"ok": true, "data": <result>}   or   {"ok": false, "error": "..."}
#   the "ping" op needs no token; every other op is rejected (403) without it.
#
# Threading: the HTTP server runs on a daemon thread, but anything that touches
# the Anki collection is marshalled onto Anki's main thread (the collection is
# not thread-safe) via mw.taskman.run_on_main.
#
# This is an independent project. It is not affiliated with Anki, AnKing, or any
# question bank.
#
# Copyright (C) 2026 Mnestic contributors. Licensed under the GNU General Public
# License v3 or later; see LICENSE in the repository. No warranty, to the extent
# permitted by law.

import base64
import hmac
import json
import os
import re
import secrets
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import aqt
from anki.decks import DeckId
from anki.utils import ids2str
from aqt import gui_hooks, mw
from aqt.qt import QAction

try:
    from anki import buildinfo
except Exception:                                    # very old/new Anki
    buildinfo = None
from aqt.utils import askUser, showText, tooltip

# "#AK_Step1_v12::#UWorld::Step::2108" and the older bare "…::#UWorld::2108"
_MATCHED_NOTHING_RE = re.compile("no cards matched", re.I)

# Written on every copy Mnestic creates. It is the ONLY thing that makes a
# note eligible for deletion, so undoing a save can never reach a real card.
_COPY_TAG = "Mnestic::Copy"

# removeTags may only ever touch tags Mnestic itself writes. The extension
# asks for exactly one of them, but the op is what a request actually
# reaches, so the limit belongs here: no caller can strip "marked", "leech",
# an AnKing tag, or the AnkiHub_Protect tag guarding someone's notes.
_OWN_TAG_ROOT = "mnestic::"
_UW_ID_RE = re.compile(r"^#AK_Step(\d)_v[^:]*::#UWorld::(?:Step::)?(\d+)$", re.I)

# Written next to Mnestic::Missed when a question is saved, so the missed list
# can name the question you actually got wrong rather than every question id
# AnKing happens to tag on that note (one note can carry dozens).
_QID_TAG_RE = re.compile(r"^Mnestic::QID::(\d{1,12})$", re.I)

# ---------------------------------------------------------------------------
# What a valid pairing code is allowed to do.
#
# The code proves a request comes from Mnestic, but anything that learns it
# (malware, a leaked screenshot, clipboard history) could send the same
# requests. So every write is held to exactly the shape the extension needs:
# the tags it writes, the one field it appends to, question-id searches, and
# small batches. Before 1.4 updateNote accepted any tag and any field, which
# let two requests delete an arbitrary note: tag it Mnestic::Copy, blank its
# ankihub_id, then call deleteNotes.
# ---------------------------------------------------------------------------
_TAG_OK_RE = re.compile(
    r"^(?:Mnestic::(?:Missed(?:::[^\s\"]{1,200})?|Made|QID::\d{1,12})"
    r"|AnkiHub_Protect::Missed_Questions)$",
    re.I,
)
_APPEND_FIELDS = ("missed questions",)
MAX_BODY = 32 * 1024 * 1024           # a pasted screenshot, base64'd, fits easily
MAX_MEDIA = 24 * 1024 * 1024          # one media file, decoded
MAX_FIELD = 256 * 1024                # one field's worth of HTML
MAX_NOTES_PER_WRITE = 50              # a question matches a handful of notes
MAX_CARDS_PER_UNSUSPEND = 3000        # a 100-question block, with room to spare
MAX_QUERY_TERMS = 400
MAX_QUERY_LEN = 100000
_MEDIA_EXT = ("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg")

# A write op's search may only SELECT cards the way Mnestic does: by question-id
# tag, by Mnestic's own tags, or by explicit note/card ids. No negations and no
# collection-wide terms, so no request can reach "every card" (deck:*, or an
# empty/negated search).
_SELECTOR_RES = (
    re.compile(r"^tag:#AK_Step[1-3]_v\*::#UWorld::(?:Step::|\*::)?\d{1,12}$", re.I),
    re.compile(r"^tag:Mnestic::(?:QID::\d{1,12}|Missed(?:::[^\s\"()]{1,200})?|Made)$", re.I),
    re.compile(r"^(?:nid|cid):\d{1,20}(?:,\d{1,20}){0,999}$", re.I),
)
# filteredDeck may also narrow with these. They never widen a search.
_MODIFIER_RES = (
    re.compile(r"^-is:suspended$", re.I),
    re.compile(r"^-tag:Mnestic::Copy$", re.I),
)

ADDON_NAME = "Mnestic Bridge"
ADDON_VERSION = "1.5.0"
HOST = "127.0.0.1"
DEFAULT_PORT = 8790

_server = None
_token = {"value": None}


# ------------------------------- config -------------------------------
def _cfg():
    try:
        return mw.addonManager.getConfig(__name__) or {}
    except Exception:
        return {}


def _write_cfg(cfg):
    try:
        mw.addonManager.writeConfig(__name__, cfg)
    except Exception:
        pass


def _port():
    try:
        return int(_cfg().get("port", DEFAULT_PORT))
    except Exception:
        return DEFAULT_PORT


def ensure_token():
    """Return the pairing code, generating and persisting one on first run."""
    cfg = _cfg()
    tok = (cfg.get("token") or "").strip()
    if not tok:
        tok = secrets.token_hex(16)
        cfg["token"] = tok
        _write_cfg(cfg)
    _token["value"] = tok
    return tok


def _token_ok(supplied):
    want = _token["value"] or ""
    if not want or not supplied:
        return False
    return hmac.compare_digest(str(supplied), want)


# --------------------- run work on Anki's main thread ---------------------
def _on_main(func):
    box = {}
    done = threading.Event()

    def run():
        try:
            box["value"] = func()
        except Exception as exc:
            box["error"] = exc
        finally:
            done.set()

    mw.taskman.run_on_main(run)
    if not done.wait(timeout=20):
        raise Exception("timed out waiting for Anki's main thread")
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _col():
    if mw.col is None:
        raise Exception("no Anki collection is open")
    return mw.col


# ------------------------------ validation ------------------------------
def _ids(value, what, limit):
    """A list of positive integer ids, at most `limit` of them."""
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise Exception("%s must be a list of ids" % what)
    if len(value) > limit:
        raise Exception("%s takes at most %d at a time" % (what, limit))
    out = []
    for v in value:
        try:
            n = int(v)
        except Exception:
            raise Exception("%s must be numbers" % what)
        if n <= 0:
            raise Exception("%s must be positive" % what)
        out.append(n)
    return out


def _one_id(value, what):
    if value is None or value == "":
        raise Exception("%s is required" % what)
    return _ids([value], what, 1)[0]


def _deck_name(value, what="deck"):
    name = (value if isinstance(value, str) else "").strip()
    if not name:
        raise Exception("%s is required" % what)
    if len(name) > 300 or any(ord(c) < 32 for c in name):
        raise Exception("%s name is not valid" % what)
    if any(not part.strip() for part in name.split("::")):
        raise Exception("%s name has an empty level" % what)
    return name


def _tags(value):
    """Only the tags Mnestic itself writes. Mnestic::Copy is NOT one of them:
    copyNote adds it to the copies it makes, and nothing else may, because it
    is what makes a note deletable."""
    if value is None:
        return []
    if not isinstance(value, (list, tuple)) or len(value) > 20:
        raise Exception("addTags must be a short list")
    out = []
    for t in value:
        t = t.strip() if isinstance(t, str) else ""
        if not t:
            continue
        if not _TAG_OK_RE.match(t):
            raise Exception("Mnestic can only add its own tags, not %r" % t[:80])
        out.append(t)
    return out


def _appends(value):
    """Appends to the Missed Questions field -- the only field Mnestic writes
    into on an existing note."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise Exception("fieldAppends must be an object")
    out = {}
    for name, val in value.items():
        if not isinstance(name, str) or name.strip().lower() not in _APPEND_FIELDS:
            raise Exception("Mnestic only appends to the Missed Questions field, not %r" % str(name)[:60])
        if not isinstance(val, str) or len(val) > MAX_FIELD:
            raise Exception("the note to append is too long")
        out[name] = val
    return out


def _no_field_sets(args):
    # Overwriting a field is how a note could be emptied or stripped of its
    # ankihub_id. The extension has never needed it.
    if args.get("fieldSets"):
        raise Exception("fieldSets is not supported: Mnestic never overwrites a field")


def _text(value, what):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise Exception("%s must be text" % what)
    if len(value) > MAX_FIELD:
        raise Exception("%s is too long" % what)
    return value


def _scoped_query(query, allow_modifiers=False):
    """Refuse any search a write op should not run: only question-id tags,
    Mnestic's own tags and explicit ids, joined with OR and parentheses."""
    if not isinstance(query, str) or not query.strip():
        raise Exception("a search is required")
    if len(query) > MAX_QUERY_LEN:
        raise Exception("the search is too long")
    tokens = query.replace("(", " ( ").replace(")", " ) ").split()
    depth, selectors = 0, 0
    for tok in tokens:
        if tok == "(":
            depth += 1
            continue
        if tok == ")":
            depth -= 1
            if depth < 0:
                raise Exception("unbalanced parentheses in the search")
            continue
        if tok.upper() == "OR":
            continue
        if any(r.match(tok) for r in _SELECTOR_RES):
            selectors += 1
            continue
        if allow_modifiers and any(r.match(tok) for r in _MODIFIER_RES):
            continue
        raise Exception("this search is outside what Mnestic may change: %r" % tok[:60])
    if depth != 0:
        raise Exception("unbalanced parentheses in the search")
    if not selectors:
        raise Exception("the search does not select any question")
    if selectors > MAX_QUERY_TERMS:
        raise Exception("the search names too many questions at once")
    return query


# ------------------------------- read ops -------------------------------
def op_search_notes(args):
    query = args.get("query")
    if not query:
        return []
    return [int(nid) for nid in _col().find_notes(query)]


def op_note_info(args):
    ids = args.get("notes")
    if args.get("query"):
        ids = op_search_notes({"query": args["query"]})[:500]
    ids = _ids(ids, "notes", 500)
    col = _col()
    out = []
    for nid in ids:
        try:
            note = col.get_note(int(nid))
        except Exception:
            continue
        nt = note.note_type()
        fields = {}
        for fld in nt["flds"]:
            fields[fld["name"]] = {"value": note.fields[fld["ord"]], "order": fld["ord"]}
        out.append({
            "noteId": note.id,
            "tags": note.tags,
            "fields": fields,
            "modelName": nt["name"],
            "mod": note.mod,
        })
    return out


def op_read_media(args):
    filename = args.get("filename")
    if not filename or not isinstance(filename, str):
        return False
    # basename: a request can only ever name a file IN the media folder.
    filename = unicodedata.normalize("NFC", os.path.basename(filename.replace("\\", "/")))
    if not filename or filename in (".", ".."):
        return False
    path = os.path.join(_col().media.dir(), filename)
    if os.path.isfile(path):
        if os.path.getsize(path) > MAX_MEDIA:
            raise Exception("that media file is too large to show")
        with open(path, "rb") as fh:
            return base64.b64encode(fh.read()).decode("ascii")
    return False


def op_write_media(args):
    filename, data = args.get("filename"), args.get("data")
    if not filename or not data or not isinstance(filename, str) or not isinstance(data, str):
        raise Exception("filename and data are required")
    name = os.path.basename(filename.replace("\\", "/")).strip()
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if not name or name.startswith((".", "_")) or ext not in _MEDIA_EXT or len(name) > 200:
        raise Exception("Mnestic only stores images in your media folder")
    if len(data) > MAX_MEDIA * 4 // 3 + 8:
        raise Exception("that image is too large (the limit is %d MB)" % (MAX_MEDIA // (1024 * 1024)))
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception:
        raise Exception("the image data is not valid")
    col = _col()
    try:
        return col.media.write_data(name, raw)
    except AttributeError:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "file"
        dest = os.path.join(col.media.dir(), safe)
        with open(dest, "wb") as fh:
            fh.write(raw)
        return safe


def _win32_to_front(hwnd):
    """Windows only gives the foreground to the app you last used -- here, the
    web browser you clicked in -- so a plain activateWindow() just flashes
    Anki in the taskbar. Joining the foreground window's input queue for a
    moment is the documented way to be allowed to take it. If Windows still
    says no, the window is at least put on top of the others (topmost, then
    straight back to normal) so it's in front of you."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    SW_RESTORE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW = 9, 0x0002, 0x0001, 0x0040
    HWND_TOPMOST, HWND_NOTOPMOST = wintypes.HWND(-1), wintypes.HWND(-2)

    hwnd = wintypes.HWND(hwnd)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    fg = user32.GetForegroundWindow()
    if fg == hwnd.value:
        return
    fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    me = kernel32.GetCurrentThreadId()
    attached = bool(fg_thread and fg_thread != me and user32.AttachThreadInput(me, fg_thread, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(me, fg_thread, False)
    if user32.GetForegroundWindow() != hwnd.value:
        flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags)
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags)


def _bring_to_front(win):
    """Show an Anki window in front of you: restored if minimised, raised, and
    focused where the system allows it. Never fails the request over it."""
    try:
        from aqt.qt import Qt

        state = win.windowState()
        if state & Qt.WindowState.WindowMinimized:
            win.setWindowState(state & ~Qt.WindowState.WindowMinimized)
        win.show()
        win.raise_()
        win.activateWindow()
    except Exception:
        pass
    if os.name == "nt":
        try:
            _win32_to_front(int(win.winId()))
        except Exception:
            pass


def op_open_browser(args):
    # Read-only: it fills Anki's own search box. The popup's topic search sends
    # free text here, so this is capped rather than scoped.
    query = args.get("query")
    if query is not None and (not isinstance(query, str) or len(query) > MAX_QUERY_LEN):
        raise Exception("the search is too long")
    browser = aqt.dialogs.open("Browser", mw)
    _bring_to_front(browser)
    if query:
        try:
            browser.form.searchEdit.lineEdit().setText(query)
            (getattr(browser, "onSearch", None) or browser.onSearchActivated)()
        except Exception:
            for name in ("search_for", "search"):
                fn = getattr(browser, name, None)
                if fn:
                    try:
                        fn(query)
                    except Exception:
                        pass
                    break
    return True


def op_list_tags(args):
    return list(_col().tags.all())


def op_list_decks(args):
    col = _col()
    try:
        return [d.name for d in col.decks.all_names_and_ids()]
    except Exception:
        try:
            return list(col.decks.all_names())
        except Exception:
            return [d.get("name") for d in col.decks.all()]


# --- AnKing "yield" level, read from a note's tags (facts about the tagging) ---
_YIELD_MARKERS = ("low/highyield", "^highyield")
_YIELD_NAMES = {
    "highyield": "HighYield",
    "relativelyhighyield": "RelativelyHighYield",
    "highyield-temporary": "HighYield-temporary",
    "loweryield": "LowerYield",
    "lowyield": "LowYield",
}


def _yield_of(tags):
    for t in tags or []:
        if not any(m in t.lower() for m in _YIELD_MARKERS):
            continue
        leaf = re.sub(r"^\d+-", "", t.split("::")[-1]).strip().lower()
        if leaf in _YIELD_NAMES:
            return _YIELD_NAMES[leaf]
    return None


def op_card_stats(args):
    """Per query, one row per card with the fields the readiness estimate uses."""
    col = _col()
    out = []
    for q in args.get("queries") or []:
        rows = []
        for cid in _find_cards(col, q):
            c = _get_card(col, cid)
            if c is None:
                continue
            rows.append({
                "cid": cid,
                "nid": c.nid,
                "ord": c.ord,             # which cloze (c1 = 0): the flashcard test's card
                "type": c.type,
                "ivl": c.ivl,
                "lapses": c.lapses,
                "suspended": c.queue == -1,
                "yield": _yield_safe(c),
            })
        out.append(rows)
    return out


def op_card_maturity(args):
    """Per query, bucket the linked cards: new / learning / young / mature / suspended."""
    col = _col()
    out = []
    for q in args.get("queries") or []:
        b = {"new": 0, "learning": 0, "young": 0, "mature": 0, "suspended": 0, "total": 0}
        for cid in _find_cards(col, q):
            c = _get_card(col, cid)
            if c is None:
                continue
            b["total"] += 1
            if c.queue == -1:
                b["suspended"] += 1
            elif c.type == 0:
                b["new"] += 1
            elif c.type in (1, 3):
                b["learning"] += 1
            elif c.type == 2:
                b["mature" if c.ivl >= 21 else "young"] += 1
            else:
                b["new"] += 1
        out.append(b)
    return out


def op_unsuspend(args):
    """Per query, unsuspend matching cards (optionally only at given yield levels).

    Each result lists the cards it actually unlocked, so undoing a save can put
    back exactly those and nothing that was already in your reviews."""
    col = _col()
    want = set(args.get("yields") or []) or None
    queries = args.get("queries") or []
    if not isinstance(queries, (list, tuple)) or len(queries) > 50:
        raise Exception("queries must be a short list")
    queries = [_scoped_query(q) for q in queries]
    plan, total = [], 0
    for q in queries:
        matched, locked = 0, []
        for cid in _find_cards(col, q):
            c = _get_card(col, cid)
            if c is None:
                continue
            if want is not None and _yield_safe(c) not in want:
                continue
            matched += 1
            if c.queue == -1:
                locked.append(cid)
        total += len(locked)
        plan.append((matched, locked))
    # Checked before anything changes, so an oversized request does nothing.
    if total > MAX_CARDS_PER_UNSUSPEND:
        raise Exception("that would unsuspend %d cards at once; the limit is %d" % (total, MAX_CARDS_PER_UNSUSPEND))
    out = []
    for matched, locked in plan:
        if locked:
            try:
                col.sched.unsuspend_cards(locked)
            except AttributeError:
                col.sched.unsuspendCards(locked)
        out.append({"matched": matched, "unlocked": len(locked), "cids": locked})
    return out


def op_suspend(args):
    """Suspend cards again -- the undo for the unsuspend a save does.

    Only cards whose note is still tagged Mnestic::Missed qualify, and the undo
    runs this BEFORE it removes that tag. So it can put back what a save
    unlocked, and cannot be used to hide the rest of a collection."""
    col = _col()
    cids = _ids(args.get("cards"), "cards", 500)
    ok, refused = [], []
    for cid in cids:
        c = _get_card(col, cid)
        if c is None:
            continue
        try:
            tags = [t.lower() for t in c.note().tags]
        except Exception:
            tags = []
        if not any(t == "mnestic::missed" or t.startswith("mnestic::missed::") for t in tags):
            refused.append(cid)
            continue
        if c.queue != -1:
            ok.append(cid)
    if ok:
        try:
            col.sched.suspend_cards(ok)
        except AttributeError:
            col.sched.suspendCards(ok)
    return {"suspended": len(ok), "refused": refused}


def _find_cards(col, query):
    try:
        return list(col.find_cards(query))
    except Exception:
        return []


def _get_card(col, cid):
    try:
        return col.get_card(cid)
    except Exception:
        return None


def _yield_safe(card):
    try:
        return _yield_of(card.note().tags)
    except Exception:
        return None


# ------------------------------- write ops -------------------------------
def _apply_appends(note, appends):
    """Append to a field, never replace it: what someone already wrote stays."""
    by_lower = {k.lower(): k for k in note.keys()}
    for name, val in (appends or {}).items():
        key = by_lower.get(name.strip().lower())
        if key and val:
            cur = note[key] or ""
            note[key] = cur + ("<br><br>" if cur.strip() else "") + val


def op_create_deck(args):
    """Create a deck (and its parents), optionally taking another deck's options."""
    deck = _deck_name(args.get("deck"))
    col = _col()
    existed = True
    try:
        existed = col.decks.by_name(deck) is not None
    except Exception:
        existed = False
    did = col.decks.id(deck)
    src = (args.get("optionsFrom") or "") if isinstance(args.get("optionsFrom"), str) else ""
    src = src.strip()
    if src:
        try:
            sd = col.decks.by_name(src)
            if sd:
                _inherit_deck_options(col, did, sd["id"])
        except Exception:
            pass
    return {"deck": deck, "created": not existed}


def op_copy_note(args):
    """Duplicate a note into `deck` (created if missing), append to fields / add
    tags, and unsuspend the copy. The original note is never modified."""
    _no_field_sets(args)
    note_id = _one_id(args.get("noteId"), "noteId")
    deck = _deck_name(args.get("deck"))
    appends = _appends(args.get("fieldAppends"))
    add_tags = _tags(args.get("addTags"))
    col = _col()
    src = col.get_note(note_id)
    new = col.new_note(src.note_type())
    for name in src.keys():
        try:
            new[name] = src[name]
        except Exception:
            pass
    _apply_appends(new, appends)
    # A copy is a local note, not the AnkiHub one: carrying the original's
    # ankihub_id would leave two notes claiming the same AnkiHub identity.
    for key in list(new.keys()):
        if key.lower() == "ankihub_id":
            try:
                new[key] = ""
            except Exception:
                pass
    new.tags = list(src.tags)
    if _COPY_TAG not in new.tags:
        new.tags.append(_COPY_TAG)
    for t in add_tags:
        if t not in new.tags:
            new.tags.append(t)
    did = _normal_deck_id(col, deck)
    col.add_note(new, did)
    cids = [c.id for c in new.cards()]
    if args.get("unsuspend", True) and cids:
        try:
            col.sched.unsuspend_cards(cids)
        except AttributeError:
            try:
                col.sched.unsuspendCards(cids)
            except Exception:
                pass
    return {"noteId": new.id, "cards": cids, "deck": deck}


def op_update_note(args):
    """Append your note to Missed Questions and add Mnestic's tags -- the only
    two changes Mnestic makes to a note it did not create."""
    _no_field_sets(args)
    note_id = _one_id(args.get("noteId"), "noteId")
    appends = _appends(args.get("fieldAppends"))
    add_tags = _tags(args.get("addTags"))
    col = _col()
    note = col.get_note(note_id)
    _apply_appends(note, appends)
    for t in add_tags:
        if t not in note.tags:
            note.tags.append(t)
    col.update_note(note)
    return {"noteId": note.id}


def _normal_deck_id(col, deck):
    """The id of `deck`, created if missing -- but never a filtered deck, which
    only borrows cards and would hand them back somewhere unexpected."""
    try:
        existing = col.decks.by_name(deck)
    except Exception:
        existing = None
    if existing and existing.get("dyn"):
        raise Exception("%r is a filtered deck; pick a normal deck" % deck)
    return col.decks.id(deck)


def _set_field(note, name, val):
    for k in note.keys():
        if k.lower() == name.lower():
            note[k] = val
            return True
    return False


def _pick_model(col, required, prefer, cloze):
    def field_names(m):
        return [f["name"] for f in m["flds"]]

    cands = []
    for m in col.models.all():
        if cloze and m.get("type") != 1:
            continue
        if not cloze and m.get("type") == 1:
            continue
        low = [f.lower() for f in field_names(m)]
        if all(r.lower() in low for r in required):
            cands.append(m)
    if not cands:
        raise Exception("no suitable %s note type found in your collection" % prefer)
    cands.sort(key=lambda m: (prefer.lower() not in m["name"].lower(), len(field_names(m))))
    return cands[0]


def _is_duplicate(note):
    """Anki's own first-field duplicate check. None when this Anki can't say."""
    try:
        from anki.notes import NoteFieldsCheckResult
        return note.fields_check() == NoteFieldsCheckResult.DUPLICATE
    except Exception:
        pass
    try:
        return note.dupeOrEmpty() == 2                   # older Anki
    except Exception:
        return None


def op_new_note(args):
    """Create a brand-new Basic or Cloze note (not a copy of an existing card).

    With checkDuplicate, a note whose first field already exists is NOT added;
    the caller is told, and can ask again with allowDuplicate."""
    deck = _deck_name(args.get("deck"))
    kind = args.get("kind", "basic")
    if kind not in ("basic", "cloze"):
        raise Exception("kind must be basic or cloze")
    tags = _tags(args.get("addTags") or args.get("tags"))
    col = _col()
    if kind == "cloze":
        text = _text(args.get("text"), "text")
        if "{{c" not in text:
            raise Exception("cloze text needs at least one {{c1::...}} deletion")
        m = _pick_model(col, ["Text"], "cloze", True)
        note = col.new_note(m)
        _set_field(note, "Text", text)
        extra = _text(args.get("extra"), "extra")
        if extra:
            for cand in ("Back Extra", "Extra", "Back"):
                if _set_field(note, cand, extra):
                    break
    else:
        m = _pick_model(col, ["Front", "Back"], "basic", False)
        note = col.new_note(m)
        _set_field(note, "Front", _text(args.get("front"), "front"))
        _set_field(note, "Back", _text(args.get("back"), "back"))
    note.tags = tags
    if args.get("checkDuplicate") and not args.get("allowDuplicate") and _is_duplicate(note):
        return {"duplicate": True, "model": m["name"], "deck": deck}
    did = _normal_deck_id(col, deck)
    col.add_note(note, did)
    return {"noteId": note.id, "cards": [c.id for c in note.cards()], "model": m["name"], "deck": deck}


def _search_literal(text):
    """Quote a deck name for use inside an Anki search term.

    Deck names come from the extension and can contain a quote or a
    backslash, which would otherwise break out of the quoted term.
    """
    out = str(text or "")
    out = out.replace(chr(92), chr(92) + chr(92))
    out = out.replace(chr(34), chr(92) + chr(34))
    return out


def op_set_deck(args):
    """Move every card of `notes` into `deck`, creating the deck if needed.

    This is how "Save to Missed Qs" can give you a real subdeck per chapter
    WITHOUT duplicating the note: the card moves, the note is untouched, so it
    keeps its ankihub_id and goes on receiving AnKing updates.

    A freshly created deck would otherwise land on the Default options preset
    and quietly change your daily limits, so it inherits the preset of the deck
    the first card came from.

    Capped per request: saving moves one note, and undoing one question moves
    back the few it saved. Nothing Mnestic does moves a whole deck.
    """
    deck = _deck_name(args.get("deck"))
    ids = _ids(args.get("notes"), "notes", MAX_NOTES_PER_WRITE)
    col = _col()
    try:
        target = col.decks.by_name(deck)
    except Exception:
        target = None
    if target and target.get("dyn"):
        raise Exception("%r is a filtered deck; pick a normal deck" % deck)
    cids = []
    src_did = None
    for nid in ids:
        try:
            note = col.get_note(nid)
        except Exception:
            continue
        for card in note.cards():
            if src_did is None:
                # A card sitting in a filtered deck has did = the FILTERED deck
                # and odid = its real home, so "did or odid" picks the wrong one
                # and the new deck inherits nothing. Prefer the home deck.
                src_did = card.odid or card.did
            cids.append(card.id)
    if not cids:
        return {"moved": 0, "deck": deck}

    existed = False
    try:
        existed = col.decks.by_name(deck) is not None
    except Exception:
        try:
            existed = col.decks.id_for_name(deck) is not None
        except Exception:
            existed = False

    did = col.decks.id(deck)
    empty = True
    try:
        q = _search_literal(deck)
        empty = not col.find_cards('deck:"%s" -deck:"%s::*"' % (q, q))
    except Exception:
        empty = not existed
    if empty and src_did:
        _inherit_deck_options(col, did, src_did)

    try:
        col.set_deck(cids, did)
    except AttributeError:
        try:
            col.decks.set_deck(cids, did)
        except AttributeError:
            col.db.execute(
                "update cards set did = ?, mod = ?, usn = ? where id in %s"
                % ids2str(cids), did, int(time.time()), -1
            )
    src_name = ""
    if src_did:
        try:
            src_name = (col.decks.get(src_did) or {}).get("name", "") or ""
        except Exception:
            src_name = ""
    # Where the cards came FROM. Without it there is no way back: the undo would
    # have to guess a home deck, and guessing wrong scatters someone's cards.
    return {"moved": len(cids), "deck": deck, "created": not existed, "from": src_name}


def _inherit_deck_options(col, did, src_did):
    """Give a newly created deck the same options preset as the source deck."""
    try:
        src = col.decks.get(src_did)
        dst = col.decks.get(did)
        if not src or not dst or src.get("dyn") or dst.get("dyn"):
            return
        conf = src.get("conf")
        if conf is None:
            return
        dst["conf"] = conf
        col.decks.save(dst)
    except Exception:
        pass


def op_filtered_deck(args):
    """Build (or rebuild) a filtered deck from a search — "study my missed".

    A filtered deck gathers cards for a session and returns them to their home
    deck afterwards, so studying a chapter costs nothing permanent.
    """
    name = _deck_name(args.get("name") or "Mnestic — Missed", "filtered deck")
    # Only Mnestic's own filtered decks: rebuilding one empties it first, and a
    # request must not be able to rebuild (and so empty) one of yours.
    if not name.lower().startswith("mnestic"):
        raise Exception("Mnestic only builds filtered decks whose name starts with Mnestic")
    search = _scoped_query((args.get("search") or "").strip(), allow_modifiers=True)
    try:
        limit = int(args.get("limit") or 100)
    except Exception:
        limit = 100
    limit = max(1, min(limit, 1000))
    col = _col()

    # Ask first. Anki raises when a filtered deck would gather nothing, and the
    # only way to tell that apart from a real failure is to read its English
    # prose -- which is wrong on a localised Anki. Counting the search ourselves
    # answers the common case in every language.
    try:
        if not col.find_cards(search):
            return {"deck": name, "cards": 0, "empty": True}
    except Exception:
        pass                                 # a malformed search: let Anki say so

    existing = None
    try:
        existing = col.decks.by_name(name)
    except Exception:
        existing = None
    if existing and not existing.get("dyn"):
        raise Exception("a normal deck named %r already exists" % name)

    try:
        deck = col.sched.get_or_create_filtered_deck(deck_id=DeckId(existing["id"]) if existing else DeckId(0))
        deck.name = name
        del deck.config.search_terms[:]
        term = deck.config.search_terms.add()
        term.search = search
        term.limit = limit
        term.order = 0                                   # oldest seen first
        deck.config.reschedule = True
        try:
            out = col.sched.add_or_update_filtered_deck(deck)
        except Exception as exc:
            # Anki refuses to build a filtered deck that gathers nothing, and
            # says so in backend prose about "a different filtered deck, or
            # suspended". Having nothing missed yet is the normal state for a
            # new user, not an error, so report an empty deck instead. An
            # existing deck has already returned its cards home by this point.
            # Cards can match the search yet still be excluded, for already
            # sitting in another filtered deck. Anki only says so in prose.
            if _MATCHED_NOTHING_RE.search(str(exc)):
                return {"deck": name, "cards": 0, "empty": True}
            raise
        did = getattr(out, "id", None) or (existing and existing["id"])
    except AttributeError:
        # older scheduler API
        did = col.decks.new_filtered(name)
        d = col.decks.get(did)
        d["terms"] = [[search, limit, 0]]
        d["resched"] = True
        col.decks.save(d)
        col.sched.rebuild_filtered_deck(did)

    count = 0
    try:
        count = len(col.find_cards('deck:"%s"' % _search_literal(name)))
    except Exception:
        pass
    return {"deck": name, "cards": count}


def op_missed_ids(args):
    """Question ids of everything tagged missed, newest first, with chapters.

    This is what makes "retest exactly what you got wrong" possible: the qbank's
    own test builder can take the ids straight back.

    Since 1.4 a save also tags the question itself (Mnestic::QID::<id>), and
    those are the ids returned, marked exact. A note saved before that carries
    no such tag; for it the list falls back to every UWorld id AnKing tagged on
    the note -- which can include questions you never saw, so those rows are
    marked exact=False and the popup says so.
    """
    col = _col()
    tag = "Mnestic::Missed"
    try:
        step = int(args.get("step") or 0)
    except Exception:
        step = 0
    chapter = args.get("chapter") if isinstance(args.get("chapter"), str) else ""
    chapter = chapter.strip().replace(" ", "_")
    if chapter and not re.match(r'^[^\s"()]{1,200}$', chapter):
        raise Exception("chapter is not valid")
    search = '(tag:%s OR tag:%s::*)' % (tag, tag) if not chapter else 'tag:%s::%s' % (tag, chapter)
    out = []
    seen = set()
    for nid in col.find_notes(search):
        try:
            note = col.get_note(nid)
        except Exception:
            continue
        chap = ""
        for t in note.tags:
            if t.lower().startswith((tag + "::").lower()):
                chap = t[len(tag) + 2:]
                break
        uw = {}                                          # qid -> steps AnKing tags it in
        for t in note.tags:
            m = _UW_ID_RE.match(t)
            if m:
                uw.setdefault(m.group(2), set()).add(int(m.group(1)))
        exact = []
        for t in note.tags:
            m = _QID_TAG_RE.match(t)
            if m:
                exact.append(str(int(m.group(1))))
        if exact:
            rows = [(q, True) for q in exact
                    if not step or q not in uw or step in uw[q]]
        else:
            rows = [(q, False) for q, steps in uw.items() if not step or step in steps]
        for qid, is_exact in rows:
            if qid in seen:
                continue
            seen.add(qid)
            out.append({"qid": qid, "chapter": chap, "mod": note.mod, "exact": is_exact})
    out.sort(key=lambda r: -r["mod"])
    return out


def op_count_notes(args):
    """How many notes match each query — just the numbers.

    The extension's deck check used to call searchNotes three times and receive
    every matching note id: roughly 26,000 integers for a full AnKing deck, to
    display three counts. This returns the counts.
    """
    queries = args.get("queries") or []
    if not isinstance(queries, (list, tuple)) or len(queries) > 10:
        raise Exception("countNotes takes a few queries at a time")
    col = _col()
    return [len(col.find_notes(q)) for q in queries if isinstance(q, str)]


def op_status(args):
    """Everything the extension needs to tell a user what is and isn't set up."""
    col = _col()
    steps = {}
    for step in (1, 2, 3):
        try:
            steps[str(step)] = len(col.find_notes("tag:#AK_Step%d_v*::#UWorld::*" % step))
        except Exception:
            steps[str(step)] = -1
    return {
        "name": ADDON_NAME,
        "version": ADDON_VERSION,
        "ankiVersion": getattr(buildinfo, "version", "?") if buildinfo else "?",
        "profile": bool(col),
        "taggedByStep": steps,
        "mediaDir": bool(col.media.dir()),
    }


def op_remove_tags(args):
    """Take tags off notes -- the undo for "save to missed".

    Removes each named tag AND its children, so "Mnestic::Missed" also takes
    "Mnestic::Missed::03_Respiratory". It removes nothing else: whatever the
    user typed into Missed Questions stays, and so does the AnkiHub_Protect tag
    that stops AnkiHub overwriting it. Un-marking a question by mistake must
    never cost someone their notes.
    """
    col = _col()
    ids = _ids(args.get("notes"), "notes", 500)
    if args.get("query"):
        ids = list(col.find_notes(_scoped_query(args["query"])))
    wanted = [str(t).strip().lower() for t in (args.get("tags") or []) if str(t).strip()]
    if not wanted:
        raise Exception("tags is required")
    outside = [t for t in wanted if not t.startswith(_OWN_TAG_ROOT)]
    if outside:
        raise Exception("removeTags only removes Mnestic's own tags, not %s" % ", ".join(outside))
    updated, removed = 0, []
    for nid in ids:
        try:
            note = col.get_note(int(nid))
        except Exception:
            continue
        keep, drop = [], []
        for t in note.tags:
            tl = t.lower()
            if any(tl == w or tl.startswith(w + "::") for w in wanted):
                drop.append(t)
            else:
                keep.append(t)
        if not drop:
            continue
        note.tags = keep
        col.update_note(note)
        removed.extend(drop)
        updated += 1
    return {"updated": updated, "removed": sorted(set(removed))}


def op_delete_notes(args):
    """Delete notes Mnestic created, and refuse every other note.

    Undoing "save a copy" has to remove the copy. But a bridge that deletes any
    note it is handed is one bad request away from emptying a collection, so
    the guard lives HERE rather than in the caller that happens to be trusted
    today: a note must carry the marker copyNote writes, and must not be
    AnkiHub-managed. Anything else is reported back as refused, not deleted.
    """
    # Undoing one question touches one or two notes. A request for hundreds is a
    # bug or an abuse, and either way is not something to carry out.
    ids = _ids(args.get("notes"), "deleteNotes", 100)
    col = _col()
    ok_ids, refused = [], []
    for nid in ids:
        try:
            note = col.get_note(nid)
        except Exception:
            continue
        if _COPY_TAG.lower() not in [t.lower() for t in note.tags]:
            refused.append(note.id)
            continue
        managed = False
        for key in note.keys():
            if key.lower() == "ankihub_id" and (note[key] or "").strip():
                managed = True
                break
        if managed:
            refused.append(note.id)
            continue
        ok_ids.append(note.id)
    # Report NOTES deleted. Anki's remove_notes() counts the CARDS it removed,
    # so a three-cloze copy was announced as "deleted 3 copies".
    if ok_ids:
        try:
            col.remove_notes(ok_ids)
        except AttributeError:
            col.rem_notes(ok_ids)
    return {"deleted": len(ok_ids), "refused": refused}


# ------------------------------- dispatch -------------------------------
_OPS = {
    "searchNotes": op_search_notes,
    "noteInfo": op_note_info,
    "readMedia": op_read_media,
    "writeMedia": op_write_media,
    "openBrowser": op_open_browser,
    "listTags": op_list_tags,
    "listDecks": op_list_decks,
    "cardStats": op_card_stats,
    "cardMaturity": op_card_maturity,
    "unsuspend": op_unsuspend,
    "suspend": op_suspend,
    "copyNote": op_copy_note,
    "updateNote": op_update_note,
    "newNote": op_new_note,
    "countNotes": op_count_notes,
    "setDeck": op_set_deck,
    "createDeck": op_create_deck,
    "filteredDeck": op_filtered_deck,
    "missedIds": op_missed_ids,
    "status": op_status,
    "removeTags": op_remove_tags,
    "deleteNotes": op_delete_notes,
}


def dispatch(op, args):
    fn = _OPS.get(op)
    if fn is None:
        raise Exception("%s: unknown op %r" % (ADDON_NAME, op))
    return fn(args or {})


# ------------------------------- HTTP layer -------------------------------
class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # A client that opens a connection and then goes quiet would otherwise hold
    # a thread forever. StreamRequestHandler applies this to the socket.
    timeout = 30

    def log_message(self, *a):
        pass

    def _origin_ok(self, origin):
        """Compare the origin's HOST exactly. A prefix test would accept
        hostile look-alikes such as http://127.0.0.1.attacker.tld."""
        if not origin:
            return True
        parts = urlsplit(origin)
        if parts.scheme == "chrome-extension":
            return bool(parts.hostname)
        if parts.scheme in ("http", "https"):
            return parts.hostname in ("localhost", "127.0.0.1", "::1")
        return False

    def _host_ok(self):
        """Defence against DNS rebinding. An attacker can point evil.com at
        127.0.0.1, but the browser still sends `Host: evil.com` — so we only
        accept requests actually addressed to loopback."""
        host = (self.headers.get("Host") or "").strip().lower()
        if not host:
            return False
        if host.startswith("["):                      # IPv6 form: [::1]:8790
            name = host.split("]")[0] + "]"
        else:
            name = host.rsplit(":", 1)[0] if ":" in host else host
        return name in ("127.0.0.1", "localhost", "[::1]", "::1")

    def _send(self, code, payload=None, origin="*", close=False):
        body = json.dumps(payload).encode("utf-8") if payload is not None else b""
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Mnestic-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            # The request body was never read, so this connection cannot carry
            # another request: its next bytes would be parsed as one.
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        # Validate before answering: an unconditional preflight (especially the
        # Private Network Access grant) would hand every internet origin a way
        # into loopback.
        origin = self.headers.get("Origin")
        if not self._host_ok() or not self._origin_ok(origin):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Mnestic-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        origin = self.headers.get("Origin")
        echo = origin if origin else "*"

        # Decide on the headers alone, BEFORE reading a byte of the body. Reading
        # first meant a request from a refused origin could still make Anki
        # buffer whatever size it claimed -- or wait forever for bytes that were
        # never coming.
        if not self._host_ok():
            self._send(403, {"ok": False, "error": "bad Host header"}, echo, close=True)
            return
        if not self._origin_ok(origin):
            self._send(403, {"ok": False, "error": "origin not allowed"}, echo, close=True)
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except (TypeError, ValueError):
            length = -1
        if length < 0:
            self._send(411, {"ok": False, "error": "Content-Length is required"}, echo, close=True)
            return
        if length > MAX_BODY:
            self._send(413, {"ok": False, "error": "request too large"}, echo, close=True)
            return
        raw = self.rfile.read(length) if length else b""
        if len(raw) != length:
            self._send(400, {"ok": False, "error": "incomplete request"}, echo, close=True)
            return
        try:
            req = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            self._send(200, {"ok": False, "error": "bad JSON"}, echo)
            return
        if not isinstance(req, dict) or not isinstance(req.get("args") or {}, dict):
            self._send(200, {"ok": False, "error": "bad request"}, echo)
            return

        op = req.get("op", "")
        # Health check: no collection access, no token — a fast "are you there?".
        # It names the add-on and nothing more; the version is for paired callers.
        if op == "ping":
            self._send(200, {"ok": True, "data": {"name": ADDON_NAME}}, echo)
            return

        token = self.headers.get("X-Mnestic-Token") or req.get("token")
        if not _token_ok(token):
            self._send(403, {"ok": False, "error": "invalid or missing pairing code"}, echo)
            return

        # Pairing check: the token is valid — say so without touching the
        # collection, so the extension can show a green "Ready".
        if op == "auth":
            self._send(200, {"ok": True, "data": {"paired": True, "version": ADDON_VERSION}}, echo)
            return

        try:
            data = _on_main(lambda: dispatch(op, req.get("args") or {}))
            self._send(200, {"ok": True, "data": data}, echo)
        except Exception as exc:
            self._send(200, {"ok": False, "error": str(exc)}, echo)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_server():
    global _server
    if _server is not None:
        return
    ensure_token()
    port = _port()
    try:
        _server = _Server((HOST, port), _Handler)
    except OSError:
        _server = None
        tooltip(
            '%s: port %d is in use. Change "port" in the add-on config '
            "(Tools → Add-ons → %s → Config) and restart Anki." % (ADDON_NAME, port, ADDON_NAME),
            period=6000,
        )
        return
    threading.Thread(target=_server.serve_forever, daemon=True).start()


# ------------------------- pairing-code menu item -------------------------
def show_pairing_code():
    tok = _token["value"] or ensure_token()
    try:
        aqt.mw.app.clipboard().setText(tok)
        copied = " (copied to clipboard)"
    except Exception:
        copied = ""
    showText(
        "Mnestic pairing code%s:\n\n    %s\n\n"
        "Open the Mnestic extension, paste this into the “Pairing code” box, and "
        "click Save. It links the extension to this Anki — nothing else on your "
        "computer can use the bridge without it.\n\n"
        "Keep it private. If it may have been seen (a screenshot, a shared "
        "screen), replace it: Tools → Mnestic Bridge → Issue a new pairing code…"
        % (copied, tok),
        title="Mnestic Bridge",
    )


def rotate_pairing_code():
    """Issue a new pairing code and forget the old one."""
    if not askUser(
        "Issue a new Mnestic pairing code?\n\n"
        "The current code stops working immediately. You'll need to paste the "
        "new one into the extension once.",
        title=ADDON_NAME,
    ):
        return
    conf = mw.addonManager.getConfig(__name__) or {}
    conf["token"] = ""
    mw.addonManager.writeConfig(__name__, conf)
    _token["value"] = ""
    ensure_token()
    show_pairing_code()


def show_status():
    try:
        st = op_status({})
    except Exception as exc:
        showText("%s: couldn't read the collection (%s)" % (ADDON_NAME, exc), title=ADDON_NAME)
        return
    by = st["taggedByStep"]
    lines = [
        "%s %s" % (ADDON_NAME, st["version"]),
        "Listening on 127.0.0.1:%d" % _port(),
        "Pairing code: %s" % ("set" if (_token["value"] or "") else "not set yet"),
        "",
        "AnKing cards tagged with question ids:",
    ]
    for step in ("1", "2", "3"):
        n = by.get(step, -1)
        lines.append("    Step %s: %s" % (step, "couldn't check" if n < 0 else "{:,} cards".format(n)))
    if all(by.get(k, 0) <= 0 for k in ("1", "2", "3")):
        lines += [
            "",
            "No #UWorld tags found. Mnestic matches questions to cards through tags",
            "like #AK_Step1_v12::#UWorld::Step::2108 — without them there is nothing",
            "to match. Check you have the AnKing deck with its tags intact.",
        ]
    else:
        lines += ["", "Looks right — the extension can match questions to these cards."]
    showText("\n".join(lines), title=ADDON_NAME)


def _add_menu():
    menu = mw.form.menuTools.addMenu(ADDON_NAME)
    for label, fn in (
        ("Pairing code…", show_pairing_code),
        ("Issue a new pairing code…", rotate_pairing_code),
        ("Status and deck check…", show_status),
    ):
        action = QAction(label, mw)
        action.triggered.connect(fn)
        menu.addAction(action)


def on_ready():
    start_server()
    _add_menu()


gui_hooks.main_window_did_init.append(on_ready)
