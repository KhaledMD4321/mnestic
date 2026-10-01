"""The bridge's security boundary, tested over real HTTP and through dispatch.

guard-test.py covers the two destructive ops in isolation. This covers the
rest of what a caller can and cannot do:

  * the HTTP layer -- Host/Origin/token checks happen BEFORE the body is read,
    oversized or malformed requests are refused, idle sockets time out;
  * every write op -- only Mnestic's own tags, only the Missed Questions field,
    only question-id searches, only small batches;
  * the audit's S-01 attack -- tag a real note Mnestic::Copy and blank its
    ankihub_id, then delete it -- is refused at the first step.

Anki is stubbed with a small in-memory collection. Run:
    python scripts/bridge-test.py
"""

import fnmatch
import http.client
import json
import os
import socket
import sys
import threading
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ADDON = os.environ.get("MNX_ADDON_DIR") or os.path.join(HERE, "..", "anki-addon")
TOKEN = "a" * 32                      # a test code, never a real one


def _stub_anki():
    for name in ("aqt", "aqt.qt", "aqt.utils", "anki", "anki.decks", "anki.utils"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["anki.decks"].DeckId = lambda x: x
    sys.modules["anki.utils"].ids2str = lambda ids: "(" + ",".join(str(i) for i in ids) + ")"
    sys.modules["aqt"].mw = None
    sys.modules["aqt"].gui_hooks = types.SimpleNamespace(
        main_window_did_init=types.SimpleNamespace(append=lambda f: None))
    sys.modules["aqt.qt"].QAction = object
    for f in ("askUser", "showText", "tooltip"):
        setattr(sys.modules["aqt.utils"], f, lambda *a, **k: None)


# ---------------------------------------------------------------- fake Anki
class Card(object):
    def __init__(self, cid, note, did, queue=-1):
        self.id, self._note, self.did, self.odid, self.queue = cid, note, did, 0, queue
        self.type, self.ivl, self.lapses = 0, 0, 0

    def note(self):
        return self._note


class Note(object):
    def __init__(self, col, nid, tags, fields, model="Cloze", ncards=1, did=1):
        self.col, self.id, self.tags, self._f, self.mod = col, nid, list(tags), dict(fields), 0
        self.model = model
        self._cards = [Card(nid * 10 + i, self, did) for i in range(ncards)]

    def keys(self):
        return list(self._f.keys())

    def __getitem__(self, k):
        return self._f[k]

    def __setitem__(self, k, v):
        self._f[k] = v

    def cards(self):
        return self._cards

    def note_type(self):
        return {"name": self.model, "flds": [{"name": k, "ord": i} for i, k in enumerate(self._f)]}

    def dupeOrEmpty(self):
        first = list(self._f.values())[0] if self._f else ""
        for n in self.col.notes.values():
            if n is not self and n.model == self.model and list(n._f.values())[:1] == [first]:
                return 2
        return 0


class Decks(object):
    def __init__(self):
        self.by = {"Default": {"id": 1, "name": "Default", "dyn": 0, "conf": 1},
                   "AnKing": {"id": 2, "name": "AnKing", "dyn": 0, "conf": 5},
                   "Mnestic — Missed": {"id": 3, "name": "Mnestic — Missed", "dyn": 1},
                   "My filtered": {"id": 4, "name": "My filtered", "dyn": 1}}

    def by_name(self, name):
        return self.by.get(name)

    def id(self, name):
        if name not in self.by:
            self.by[name] = {"id": 100 + len(self.by), "name": name, "dyn": 0, "conf": 1}
        return self.by[name]["id"]

    def get(self, did):
        for d in self.by.values():
            if d["id"] == did:
                return d
        return None

    def save(self, d):
        pass

    def all_names_and_ids(self):
        return [types.SimpleNamespace(name=n) for n in self.by]


class Sched(object):
    def __init__(self, col):
        self.col = col

    def unsuspend_cards(self, cids):
        for c in self.col.cards(cids):
            c.queue = 0

    def suspend_cards(self, cids):
        for c in self.col.cards(cids):
            c.queue = -1


class Media(object):
    def __init__(self):
        self.written = {}

    def dir(self):
        return os.path.join(HERE, "__nonexistent_media__")

    def write_data(self, name, raw):
        self.written[name] = raw
        return name


class Col(object):
    def __init__(self):
        self.notes = {}
        self.decks = Decks()
        self.sched = Sched(self)
        self.media = Media()
        self.models = types.SimpleNamespace(all=lambda: [
            {"name": "Cloze", "type": 1, "flds": [{"name": "Text"}, {"name": "Extra"}]},
            {"name": "Basic", "type": 0, "flds": [{"name": "Front"}, {"name": "Back"}]}])
        self.removed = []
        self._next = 900

    def add(self, nid, tags, fields, **kw):
        self.notes[nid] = Note(self, nid, tags, fields, **kw)
        return self.notes[nid]

    def cards(self, cids):
        want = set(cids)
        return [c for n in self.notes.values() for c in n.cards() if c.id in want]

    # A small search evaluator: OR of terms, each a tag:, nid: or cid: term.
    def _match(self, note, term):
        low = term.lower()
        if low.startswith("nid:"):
            return str(note.id) in low[4:].split(",")
        if low.startswith("cid:"):
            ids = low[4:].split(",")
            return any(str(c.id) in ids for c in note.cards())
        if low.startswith("tag:"):
            pat = low[4:]
            return any(fnmatch.fnmatch(t.lower(), pat) or t.lower().startswith(pat + "::") for t in note.tags)
        if low == "deck:*":
            return True
        return False

    def find_notes(self, q):
        terms = [t for t in q.replace("(", " ").replace(")", " ").split() if t.upper() != "OR"]
        return [n.id for n in self.notes.values() if any(self._match(n, t) for t in terms)]

    def find_cards(self, q):
        return [c.id for nid in self.find_notes(q) for c in self.notes[nid].cards()]

    def get_note(self, nid):
        if nid not in self.notes:
            raise Exception("no such note")
        return self.notes[nid]

    def get_card(self, cid):
        for c in self.cards([cid]):
            return c
        raise Exception("no such card")

    def update_note(self, note):
        pass

    def remove_notes(self, ids):
        self.removed.extend(ids)
        for i in ids:
            self.notes.pop(i, None)
        return types.SimpleNamespace(count=len(ids))

    def new_note(self, model):
        self._next += 1
        fields = {f["name"]: "" for f in model["flds"]} if isinstance(model, dict) and "flds" in model else {}
        n = Note(self, self._next, [], fields, model=(model.get("name") if isinstance(model, dict) else "Cloze"))
        return n

    def add_note(self, note, did):
        for c in note.cards():
            c.did = did
        self.notes[note.id] = note

    def set_deck(self, cids, did):
        for c in self.cards(cids):
            c.did = did


# ---------------------------------------------------------------- harness
PASS, FAIL = [], []


def check(label, ok, detail=""):
    (PASS if ok else FAIL).append(label)
    print(("ok    " if ok else "FAIL  ") + label + (("   " + str(detail)) if detail and not ok else ""))


def refuses(label, fn):
    try:
        fn()
        check(label, False, "it did NOT refuse")
    except Exception:
        check(label, True)


def build_col():
    col = Col()
    col.add(1, ["#AK_Step1_v12::#UWorld::Step::2128", "#AK_Step1_v12::#UWorld::Step::555",
                "#AK_Step1_v12::#FirstAid::03_Respiratory", "marked"],
            {"Text": "Omalizumab binds IgE", "Extra": "", "Missed Questions": "my old notes",
             "ankihub_id": "ah-1"}, ncards=3, did=2)
    col.add(2, ["#AK_Step1_v12::#UWorld::Step::2128"], {"Text": "Second", "ankihub_id": "ah-2"}, ncards=1, did=2)
    col.add(3, ["Mnestic::Missed::Respiratory", "Mnestic::QID::2128", "#AK_Step1_v12::#UWorld::Step::2128",
                "#AK_Step1_v12::#UWorld::Step::777"], {"Text": "Saved one"}, ncards=1, did=2)
    col.add(4, ["Mnestic::Missed", "#AK_Step1_v12::#UWorld::Step::4211", "#AK_Step1_v12::#UWorld::Step::4212",
                "#AK_Step2_v12::#UWorld::Step::9999"], {"Text": "Legacy save"}, ncards=1, did=2)
    return col


def qid_query(qid, sv=1):
    base = "tag:#AK_Step%d_v*::#UWorld::" % sv
    return "(%sStep::%s OR %s%s)" % (base, qid, base, qid)


def main():
    _stub_anki()
    sys.path.insert(0, os.path.normpath(ADDON))
    import mnestic_bridge as M

    col = build_col()
    M._col = lambda: col
    M._on_main = lambda fn: fn()
    M._token["value"] = TOKEN

    # ================================================================ HTTP
    M._Handler.timeout = 2                      # so the idle-socket test is quick
    srv = M._Server(("127.0.0.1", 0), M._Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def post(body, headers=None, raw_headers=None, wait=5):
        h = {"Host": "127.0.0.1:%d" % port, "Content-Type": "application/json"}
        h.update(headers or {})
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        if raw_headers is None:
            h["Content-Length"] = str(len(b))
        else:
            h.update(raw_headers)
        s = socket.create_connection(("127.0.0.1", port), timeout=wait)
        req = "POST / HTTP/1.1\r\n" + "".join("%s: %s\r\n" % kv for kv in h.items()) + "\r\n"
        t0 = time.time()
        s.sendall(req.encode() + b)
        data = b""
        try:
            while b"\r\n\r\n" not in data:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
            head, _, rest = data.partition(b"\r\n\r\n")
            status = int(head.split(b" ")[1]) if head else None
            m = [ln for ln in head.split(b"\r\n") if ln.lower().startswith(b"content-length")]
            want = int(m[0].split(b":")[1]) if m else 0
            while len(rest) < want:
                chunk = s.recv(65536)
                if not chunk:
                    break
                rest += chunk
            payload = json.loads(rest.decode() or "null") if rest else None
        except socket.timeout:
            status, payload = None, None
        s.close()
        return status, payload, time.time() - t0

    st, p, _ = post({"op": "ping"})
    check("ping answers with no Origin", st == 200 and p["ok"], p)
    check("ping names the add-on but not its version", p and "version" not in p["data"], p)
    st, _, _ = post({"op": "ping"}, {"Origin": "https://evil.example"})
    check("a website origin is refused", st == 403, st)
    st, _, _ = post({"op": "ping"}, {"Origin": "http://127.0.0.1.evil.example"})
    check("a look-alike loopback origin is refused", st == 403, st)
    st, _, _ = post({"op": "ping"}, {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"})
    check("an extension origin is accepted", st == 200, st)
    st, _, _ = post({"op": "ping"}, {"Host": "evil.example:%d" % port})
    check("a rebinding Host header is refused", st == 403, st)
    st, p, _ = post({"op": "searchNotes", "args": {"query": "deck:*"}})
    check("no pairing code: refused", st == 403, st)
    st, p, _ = post({"op": "searchNotes", "args": {"query": "deck:*"}}, {"X-Mnestic-Token": "b" * 32})
    check("wrong pairing code: refused", st == 403, st)
    st, p, _ = post({"op": "searchNotes", "args": {"query": qid_query(2128)}}, {"X-Mnestic-Token": TOKEN})
    check("right pairing code: answered", st == 200 and p["ok"] and 1 in p["data"], p)
    st, p, _ = post({"op": "auth"}, {"X-Mnestic-Token": TOKEN})
    check("auth reports the version to a paired caller", st == 200 and p["data"].get("version") == M.ADDON_VERSION, p)

    st, _, took = post(b"0123456789", {"Host": "evil.example", "Origin": "https://evil.example"},
                       raw_headers={"Content-Length": "50000000"})
    check("a refused request is answered at once, body unread (was a hang)", st == 403 and took < 1.5,
          "status %s after %.1fs" % (st, took))
    st, _, took = post(b"0123456789", {}, raw_headers={"Content-Length": str(getattr(M, "MAX_BODY", 32 * 1024 * 1024) + 1)})
    check("an oversized body is refused before it is read", st == 413 and took < 1.5, st)
    st, _, _ = post(b"{}", {}, raw_headers={})
    check("a missing Content-Length is refused", st == 411, st)
    st, _, _ = post(b"{}", {}, raw_headers={"Content-Length": "-5"})
    check("a negative Content-Length is refused", st == 411, st)
    st, p, _ = post(b"[1,2,3]", {"X-Mnestic-Token": TOKEN})
    check("a JSON body that is not an object is refused", st == 200 and not p["ok"], p)
    st, p, _ = post({"op": "searchNotes", "args": [1]}, {"X-Mnestic-Token": TOKEN})
    check("args that are not an object are refused", st == 200 and not p["ok"], p)

    # an idle connection is dropped instead of holding a thread forever
    s = socket.create_connection(("127.0.0.1", port), timeout=6)
    s.sendall(b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{")
    t0 = time.time()
    try:
        got = s.recv(1024)
    except socket.timeout:
        got = None
    s.close()
    check("a stalled request times out and the socket closes", got is not None and time.time() - t0 < 5,
          "waited %.1fs" % (time.time() - t0))

    # preflight
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("OPTIONS", "/", headers={"Origin": "https://evil.example",
                                          "Access-Control-Request-Private-Network": "true"})
    r = conn.getresponse(); r.read()
    check("a website's preflight is refused", r.status == 403, r.status)
    conn.request("OPTIONS", "/", headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                                          "Access-Control-Request-Private-Network": "true"})
    r = conn.getresponse(); r.read()
    check("the extension's preflight is granted", r.status == 200 and
          r.getheader("Access-Control-Allow-Private-Network") == "true", r.status)
    conn.close()
    srv.shutdown()

    # ================================================================ ops
    D = M.dispatch

    # ---- updateNote: the S-01 path ----
    refuses("updateNote refuses to add Mnestic::Copy (the delete marker)",
            lambda: D("updateNote", {"noteId": 1, "addTags": ["Mnestic::Copy"]}))
    refuses("updateNote refuses fieldSets (it could blank ankihub_id)",
            lambda: D("updateNote", {"noteId": 1, "fieldSets": {"ankihub_id": ""}}))
    refuses("updateNote refuses to append to a field other than Missed Questions",
            lambda: D("updateNote", {"noteId": 1, "fieldAppends": {"Text": "x"}}))
    for bad in ("marked", "leech", "#AK_Step1_v12::#UWorld::Step::1", "AnkiHub_Protect::Text",
                "Mnestic::Missed::has space", "Mnestic::QID::abc"):
        refuses("updateNote refuses the tag %r" % bad,
                lambda bad=bad: D("updateNote", {"noteId": 1, "addTags": [bad]}))
    out = D("deleteNotes", {"notes": [1]})
    check("...so the real note still cannot be deleted", out["deleted"] == 0 and 1 in col.notes, out)
    check("...and its ankihub_id is intact", col.notes[1]["ankihub_id"] == "ah-1")

    D("updateNote", {"noteId": 1, "fieldAppends": {"missed questions": "<b>new</b>"},
                     "addTags": ["Mnestic::Missed", "Mnestic::Missed::03_Respiratory",
                                 "AnkiHub_Protect::Missed_Questions", "Mnestic::QID::2128"]})
    check("updateNote appends to Missed Questions and keeps what was there",
          col.notes[1]["Missed Questions"] == "my old notes<br><br><b>new</b>", col.notes[1]["Missed Questions"])
    check("updateNote adds exactly Mnestic's tags", {"Mnestic::Missed", "Mnestic::QID::2128",
          "AnkiHub_Protect::Missed_Questions"} <= set(col.notes[1].tags), col.notes[1].tags)

    # ---- copyNote ----
    refuses("copyNote refuses foreign tags", lambda: D("copyNote", {"noteId": 2, "deck": "Missed", "addTags": ["marked"]}))
    refuses("copyNote refuses a filtered deck as the target",
            lambda: D("copyNote", {"noteId": 2, "deck": "My filtered", "addTags": ["Mnestic::Missed"]}))
    out = D("copyNote", {"noteId": 2, "deck": "Missed Qs::Respiratory", "addTags": ["Mnestic::Missed"]})
    copy = col.notes[out["noteId"]]
    check("a copy carries the delete marker and no ankihub_id",
          "Mnestic::Copy" in copy.tags and copy["ankihub_id"] == "", copy.tags)
    check("the original is untouched by a copy", col.notes[2].tags == ["#AK_Step1_v12::#UWorld::Step::2128"])

    # ---- unsuspend: only question-id searches ----
    for bad in ("deck:*", "", "is:suspended", "-tag:marked", "tag:marked", "*", "(deck:*)",
                qid_query(2128) + " OR deck:*", "tag:#AK_Step1_v*::#UWorld::*", "(" + qid_query(1)):
        refuses("unsuspend refuses the search %r" % bad[:50], lambda bad=bad: D("unsuspend", {"queries": [bad]}))
    before = [c.queue for c in col.notes[1].cards()]
    out = D("unsuspend", {"queries": [qid_query(2128)]})
    check("unsuspend accepts the extension's own question-id search", out[0]["matched"] >= 4, out)
    # notes 1-3 were suspended; the copy was unsuspended when it was made
    expect = sorted(c.id for n in (1, 2, 3) for c in col.notes[n].cards())
    check("...and reports exactly the cards it unlocked", sorted(out[0]["cids"]) == expect,
          (out[0]["cids"], expect))
    check("...which were suspended before", before == [-1, -1, -1])
    many = " OR ".join(qid_query(q) for q in range(1000, 1040))
    check("unsuspend accepts a whole block of question ids", isinstance(D("unsuspend", {"queries": [many]}), list))
    check("unsuspend accepts one note's cards (nid:)", D("unsuspend", {"queries": ["nid:2"]})[0]["matched"] == 1)
    refuses("unsuspend refuses too many question ids at once",
            lambda: D("unsuspend", {"queries": [" OR ".join(qid_query(q) for q in range(1, 500))]}))

    big = Col()
    for i in range(1, 3100):
        big.add(i, ["#AK_Step1_v12::#UWorld::Step::42"], {"Text": str(i)})
    M._col = lambda: big
    refuses("unsuspend refuses to unlock more than %d cards" % getattr(M, "MAX_CARDS_PER_UNSUSPEND", 3000),
            lambda: D("unsuspend", {"queries": [qid_query(42)]}))
    check("...and unlocks none of them when it refuses", all(c.queue == -1 for n in big.notes.values() for c in n.cards()))
    M._col = lambda: col

    # ---- suspend: only cards of notes still tagged missed ----
    for c in col.notes[1].cards():
        c.queue = 0
    for c in col.notes[2].cards():
        c.queue = 0
    out = D("suspend", {"cards": [c.id for c in col.notes[1].cards()] + [c.id for c in col.notes[2].cards()]})
    check("suspend re-suspends a saved note's cards", all(c.queue == -1 for c in col.notes[1].cards()), out)
    check("suspend refuses cards of a note that isn't saved",
          out["refused"] == [c.id for c in col.notes[2].cards()] and col.notes[2].cards()[0].queue == 0, out)
    refuses("suspend refuses an oversized batch", lambda: D("suspend", {"cards": list(range(1, 600))}))

    # ---- setDeck ----
    refuses("setDeck refuses more than %d notes" % getattr(M, "MAX_NOTES_PER_WRITE", 50),
            lambda: D("setDeck", {"notes": list(range(1, 60)), "deck": "X"}))
    refuses("setDeck refuses a filtered deck", lambda: D("setDeck", {"notes": [2], "deck": "My filtered"}))
    refuses("setDeck refuses an empty deck level", lambda: D("setDeck", {"notes": [2], "deck": "A::::B"}))
    refuses("setDeck refuses a control character", lambda: D("setDeck", {"notes": [2], "deck": "A\nB"}))
    out = D("setDeck", {"notes": [2], "deck": "Missed Qs::Respiratory"})
    check("setDeck moves a note and says where it came from", out["moved"] == 1 and out["from"] == "AnKing", out)

    # ---- filteredDeck ----
    refuses("filteredDeck refuses a deck not named Mnestic…",
            lambda: D("filteredDeck", {"name": "My filtered", "search": "tag:Mnestic::Missed"}))
    refuses("filteredDeck refuses a collection-wide search",
            lambda: D("filteredDeck", {"name": "Mnestic — Missed", "search": "deck:*"}))
    refuses("filteredDeck refuses a search that selects nothing specific",
            lambda: D("filteredDeck", {"name": "Mnestic — Missed", "search": "-is:suspended"}))
    for ok_search in ("tag:Mnestic::Missed::* -is:suspended", "tag:Mnestic::Missed -is:suspended"):
        try:
            M._scoped_query(ok_search, allow_modifiers=True)
            check("filteredDeck accepts %r" % ok_search, True)
        except Exception as exc:
            check("filteredDeck accepts %r" % ok_search, False, exc)

    # ---- media ----
    refuses("writeMedia refuses a non-image", lambda: D("writeMedia", {"filename": "run.exe", "data": "AAAA"}))
    refuses("writeMedia refuses a hidden/underscore file", lambda: D("writeMedia", {"filename": "_x.png", "data": "AAAA"}))
    refuses("writeMedia refuses data that isn't base64", lambda: D("writeMedia", {"filename": "a.png", "data": "!!!"}))
    refuses("writeMedia refuses an oversized image",
            lambda: D("writeMedia", {"filename": "a.png", "data": "A" * (getattr(M, "MAX_MEDIA", 24 * 1024 * 1024) * 2)}))
    name = D("writeMedia", {"filename": "../../evil/dir/shot.png", "data": "iVBORw0KGgo="})
    check("writeMedia keeps only the file's own name", name == "shot.png", name)
    check("readMedia cannot climb out of the media folder",
          D("readMedia", {"filename": "../../../Windows/win.ini"}) is False)

    # ---- newNote ----
    refuses("newNote refuses a foreign tag",
            lambda: D("newNote", {"deck": "Mine", "kind": "basic", "front": "q", "back": "a", "addTags": ["marked"]}))
    refuses("newNote refuses an unknown kind", lambda: D("newNote", {"deck": "Mine", "kind": "image"}))
    out = D("newNote", {"deck": "Mine", "kind": "cloze", "text": "The {{c1::cochlea}} hears",
                        "addTags": ["Mnestic::Made", "Mnestic::QID::2128"]})
    check("newNote creates a cloze with Mnestic's tags", out.get("noteId") in col.notes and
          "Mnestic::QID::2128" in col.notes[out["noteId"]].tags, out)
    n0 = len(col.notes)
    out = D("newNote", {"deck": "Mine", "kind": "cloze", "text": "The {{c1::cochlea}} hears",
                        "addTags": ["Mnestic::Made"], "checkDuplicate": True})
    check("newNote reports a duplicate instead of adding it", out.get("duplicate") and len(col.notes) == n0, out)
    out = D("newNote", {"deck": "Mine", "kind": "cloze", "text": "The {{c1::cochlea}} hears",
                        "addTags": ["Mnestic::Made"], "checkDuplicate": True, "allowDuplicate": True})
    check("...and adds it when asked to anyway", len(col.notes) == n0 + 1, out)

    # ---- missedIds ----
    rows = D("missedIds", {"step": 1})
    by = {r["qid"]: r for r in rows}
    check("missedIds names the question actually saved, marked exact",
          by.get("2128", {}).get("exact") is True and "777" not in by, rows)
    check("a legacy save falls back to its UWorld ids, marked not exact",
          by.get("4211", {}).get("exact") is False and "4212" in by, rows)
    check("the step filter still applies to legacy ids", "9999" not in by, rows)
    refuses("missedIds refuses a chapter that could widen the search",
            lambda: D("missedIds", {"chapter": 'x" OR deck:*'}))

    # ---- misc ----
    refuses("createDeck refuses an empty name", lambda: D("createDeck", {"deck": "  "}))
    refuses("countNotes refuses a flood of queries", lambda: D("countNotes", {"queries": ["x"] * 20}))
    refuses("noteInfo refuses an unbounded id list", lambda: D("noteInfo", {"notes": list(range(1, 700))}))
    refuses("an unknown op is refused", lambda: D("dropCollection", {}))

    print("")
    if FAIL:
        print("RESULT: %d FAILING of %d" % (len(FAIL), len(PASS) + len(FAIL)))
        return 1
    print("RESULT: ALL %d PASS" % len(PASS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
