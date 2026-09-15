"""Prove the add-on's destructive ops refuse what they should, without Anki.

deleteNotes and removeTags are the only operations that can take something
away, so their guards are the ones worth testing directly rather than through
the extension. Anki is stubbed: these tests are about the guards, not the API.
"""

import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ADDON = os.path.join(HERE, "..", "anki-addon")


def _stub_anki():
    """Enough of aqt/anki for the module to import."""
    for name in ("aqt", "aqt.qt", "aqt.utils", "anki", "anki.decks", "anki.utils"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["anki.decks"].DeckId = lambda x: x
    sys.modules["anki.utils"].ids2str = lambda ids: "(" + ",".join(str(i) for i in ids) + ")"
    sys.modules["aqt"].mw = None
    sys.modules["aqt"].gui_hooks = types.SimpleNamespace(
        profile_did_open=types.SimpleNamespace(append=lambda f: None),
        profile_will_close=types.SimpleNamespace(append=lambda f: None),
        main_window_did_init=types.SimpleNamespace(append=lambda f: None),
    )
    sys.modules["aqt.qt"].QAction = object
    for f in ("askUser", "showText", "tooltip"):
        setattr(sys.modules["aqt.utils"], f, lambda *a, **k: None)


class Note(object):
    def __init__(self, nid, tags, fields=None):
        self.id = nid
        self.tags = list(tags)
        self._fields = dict(fields or {})

    def keys(self):
        return list(self._fields.keys())

    def __getitem__(self, k):
        return self._fields[k]

    def __setitem__(self, k, v):
        self._fields[k] = v


class Col(object):
    def __init__(self, notes):
        self.notes = {n.id: n for n in notes}
        self.removed = []
        self.updated = []

    def get_note(self, nid):
        if nid not in self.notes:
            raise Exception("no such note")
        return self.notes[nid]

    def update_note(self, note):
        self.updated.append(note.id)

    def remove_notes(self, ids):
        self.removed.extend(ids)
        for i in ids:
            self.notes.pop(i, None)
        return types.SimpleNamespace(count=len(ids))

    def find_notes(self, q):
        return list(self.notes.keys())


PASS, FAIL = [], []


def check(label, ok, detail=""):
    (PASS if ok else FAIL).append(label)
    print(("ok    " if ok else "FAIL  ") + label + (("   " + str(detail)) if detail and not ok else ""))


def main():
    _stub_anki()
    sys.path.insert(0, os.path.normpath(ADDON))
    import mnestic_bridge as M

    real = Note(1, ["Mnestic::Missed::Cardio", "AnkiHub_Protect::Missed_Questions",
                    "marked", "#AK_Step1_v12::#UWorld::Step::1633"],
                {"Missed Questions": "my notes", "ankihub_id": "abc-123"})
    copy = Note(2, ["Mnestic::Missed::Cardio", "Mnestic::Copy"],
                {"Missed Questions": "", "ankihub_id": ""})
    forged = Note(3, ["Mnestic::Copy"], {"ankihub_id": "ah-999"})
    col = Col([real, copy, forged])
    M._col = lambda: col

    # ---- removeTags ----------------------------------------------------
    for bad in ("marked", "AnkiHub_Protect::Missed_Questions", "leech",
                "#AK_Step1_v12::#UWorld::Step::1633", ""):
        try:
            M.op_remove_tags({"notes": [1], "tags": [bad] if bad else []})
            check("removeTags refuses %r" % bad, False, "it did NOT refuse")
        except Exception as exc:
            check("removeTags refuses %r" % bad, True, exc)
    check("removeTags left the note alone after refusing",
          real.tags.count("marked") == 1 and
          "AnkiHub_Protect::Missed_Questions" in real.tags, real.tags)

    out = M.op_remove_tags({"notes": [1], "tags": ["Mnestic::Missed"]})
    check("removeTags removes the tag and its child", out["updated"] == 1 and
          out["removed"] == ["Mnestic::Missed::Cardio"], out)
    check("the protect tag survived", "AnkiHub_Protect::Missed_Questions" in real.tags, real.tags)
    check("'marked' survived", "marked" in real.tags, real.tags)
    check("the UWorld id tag survived",
          any("#UWorld" in t for t in real.tags), real.tags)
    check("the typed notes were never touched", real["Missed Questions"] == "my notes")

    # a tag that only LOOKS like ours must not slip past the prefix test
    try:
        M.op_remove_tags({"notes": [1], "tags": ["NotMnestic::Missed"]})
        check("removeTags refuses a look-alike namespace", False, "it did NOT refuse")
    except Exception as exc:
        check("removeTags refuses a look-alike namespace", True, exc)

    # ---- deleteNotes ---------------------------------------------------
    out = M.op_delete_notes({"notes": [1]})
    check("deleteNotes refuses a note without the copy marker",
          out["deleted"] == 0 and out["refused"] == [1], out)
    check("that note is still in the collection", 1 in col.notes)

    out = M.op_delete_notes({"notes": [3]})
    check("deleteNotes refuses an AnkiHub-managed note even WITH the marker",
          out["deleted"] == 0 and out["refused"] == [3], out)
    check("the AnkiHub note is still there", 3 in col.notes)

    try:
        M.op_delete_notes({"notes": list(range(101))})
        check("deleteNotes refuses an oversized batch", False, "it did NOT refuse")
    except Exception as exc:
        check("deleteNotes refuses an oversized batch", True, exc)

    out = M.op_delete_notes({"notes": [2]})
    check("deleteNotes removes a genuine Mnestic copy",
          out["deleted"] == 1 and out["refused"] == [], out)
    check("the copy is gone", 2 not in col.notes)

    # mixed batch: the copy goes, everything else is reported back
    col2 = Col([Note(10, ["Mnestic::Copy"], {"ankihub_id": ""}),
                Note(11, ["Mnestic::Missed"], {}),
                Note(12, [], {})])
    M._col = lambda: col2
    out = M.op_delete_notes({"notes": [10, 11, 12]})
    check("a mixed batch deletes only the copy",
          out["deleted"] == 1 and sorted(out["refused"]) == [11, 12], out)

    print("")
    if FAIL:
        print("RESULT: %d FAILING of %d" % (len(FAIL), len(PASS) + len(FAIL)))
        return 1
    print("RESULT: ALL %d PASS" % len(PASS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
