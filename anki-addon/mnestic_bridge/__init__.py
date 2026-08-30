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
# question bank. Released under the MIT License (see the repository).

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

import aqt
from aqt import gui_hooks, mw
from aqt.qt import QAction
from aqt.utils import showText, tooltip

ADDON_NAME = "Mnestic Bridge"
ADDON_VERSION = "1.0.0"
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


# ------------------------------- read ops -------------------------------
def op_search_notes(args):
    query = args.get("query")
    if not query:
        return []
    return [int(nid) for nid in _col().find_notes(query)]


def op_note_info(args):
    ids = args.get("notes")
    if args.get("query"):
        ids = op_search_notes({"query": args["query"]})
    col = _col()
    out = []
    for nid in ids or []:
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
    if not filename:
        return False
    filename = unicodedata.normalize("NFC", os.path.basename(filename))
    path = os.path.join(_col().media.dir(), filename)
    if os.path.exists(path):
        with open(path, "rb") as fh:
            return base64.b64encode(fh.read()).decode("ascii")
    return False


def op_write_media(args):
    filename, data = args.get("filename"), args.get("data")
    if not filename or not data:
        raise Exception("filename and data are required")
    raw = base64.b64decode(data)
    name = os.path.basename(filename)
    col = _col()
    try:
        return col.media.write_data(name, raw)
    except AttributeError:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "file"
        dest = os.path.join(col.media.dir(), safe)
        with open(dest, "wb") as fh:
            fh.write(raw)
        return safe


def op_open_browser(args):
    query = args.get("query")
    browser = aqt.dialogs.open("Browser", mw)
    browser.activateWindow()
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
    """Per query, unsuspend matching cards (optionally only at given yield levels)."""
    col = _col()
    want = set(args.get("yields") or []) or None
    out = []
    for q in args.get("queries") or []:
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
        if locked:
            try:
                col.sched.unsuspend_cards(locked)
            except AttributeError:
                col.sched.unsuspendCards(locked)
        out.append({"matched": matched, "unlocked": len(locked)})
    return out


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
def _apply_fields(note, sets, appends):
    keys = set(note.keys())
    for name, val in (sets or {}).items():
        if name in keys and val is not None:
            note[name] = val
    for name, val in (appends or {}).items():
        if name in keys and val:
            cur = note[name] or ""
            note[name] = cur + ("<br><br>" if cur.strip() else "") + val


def op_copy_note(args):
    """Duplicate a note into `deck` (created if missing), append to fields / add
    tags, and unsuspend the copy. The original note is never modified."""
    note_id, deck = args.get("noteId"), args.get("deck")
    if not note_id or not deck:
        raise Exception("noteId and deck are required")
    col = _col()
    src = col.get_note(int(note_id))
    new = col.new_note(src.note_type())
    for name in src.keys():
        try:
            new[name] = src[name]
        except Exception:
            pass
    _apply_fields(new, args.get("fieldSets"), args.get("fieldAppends"))
    new.tags = list(src.tags)
    for t in args.get("addTags") or []:
        if t and t not in new.tags:
            new.tags.append(t)
    did = col.decks.id(deck)
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
    note_id = args.get("noteId")
    if not note_id:
        raise Exception("noteId is required")
    col = _col()
    note = col.get_note(int(note_id))
    _apply_fields(note, args.get("fieldSets"), args.get("fieldAppends"))
    for t in args.get("addTags") or []:
        if t and t not in note.tags:
            note.tags.append(t)
    col.update_note(note)
    return {"noteId": note.id}


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


def op_new_note(args):
    """Create a brand-new Basic or Cloze note (not a copy of an existing card)."""
    deck = args.get("deck")
    if not deck:
        raise Exception("deck is required")
    col = _col()
    kind = args.get("kind", "basic")
    if kind == "cloze":
        text = args.get("text", "")
        if "{{c" not in (text or ""):
            raise Exception("cloze text needs at least one {{c1::...}} deletion")
        m = _pick_model(col, ["Text"], "cloze", True)
        note = col.new_note(m)
        _set_field(note, "Text", text)
        extra = args.get("extra", "")
        if extra:
            for cand in ("Back Extra", "Extra", "Back"):
                if _set_field(note, cand, extra):
                    break
    else:
        m = _pick_model(col, ["Front", "Back"], "basic", False)
        note = col.new_note(m)
        _set_field(note, "Front", args.get("front", ""))
        _set_field(note, "Back", args.get("back", ""))
    note.tags = [t for t in (args.get("addTags") or args.get("tags") or []) if t]
    did = col.decks.id(deck)
    col.add_note(note, did)
    return {"noteId": note.id, "cards": [c.id for c in note.cards()], "model": m["name"], "deck": deck}


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
    "copyNote": op_copy_note,
    "updateNote": op_update_note,
    "newNote": op_new_note,
}


def dispatch(op, args):
    fn = _OPS.get(op)
    if fn is None:
        raise Exception("%s: unknown op %r" % (ADDON_NAME, op))
    return fn(args or {})


# ------------------------------- HTTP layer -------------------------------
class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _origin_ok(self, origin):
        if not origin:
            return True
        return (origin.startswith("chrome-extension://")
                or origin.startswith("http://localhost")
                or origin.startswith("http://127.0.0.1"))

    def _send(self, code, payload=None, origin="*"):
        body = json.dumps(payload).encode("utf-8") if payload is not None else b""
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Mnestic-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin") or "*"
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Mnestic-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        origin = self.headers.get("Origin")
        echo = origin if origin else "*"
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""

        if not self._origin_ok(origin):
            self._send(403, {"ok": False, "error": "origin not allowed"}, echo)
            return
        try:
            req = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as exc:
            self._send(200, {"ok": False, "error": "bad JSON: %s" % exc}, echo)
            return

        op = req.get("op", "")
        # Health check: no collection access, no token — a fast "are you there?".
        if op == "ping":
            self._send(200, {"ok": True, "data": {"name": ADDON_NAME, "version": ADDON_VERSION}}, echo)
            return

        token = self.headers.get("X-Mnestic-Token") or req.get("token")
        if not _token_ok(token):
            self._send(403, {"ok": False, "error": "invalid or missing pairing code"}, echo)
            return

        # Pairing check: the token is valid — say so without touching the
        # collection, so the extension can show a green "Ready".
        if op == "auth":
            self._send(200, {"ok": True, "data": {"paired": True}}, echo)
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
        "Keep it private. To rotate it, clear \"token\" in the add-on config and "
        "restart Anki." % (copied, tok),
        title="Mnestic Bridge",
    )


def _add_menu():
    action = QAction("Mnestic: pairing code…", mw)
    action.triggered.connect(show_pairing_code)
    mw.form.menuTools.addAction(action)


def on_ready():
    start_server()
    _add_menu()


gui_hooks.main_window_did_init.append(on_ready)
