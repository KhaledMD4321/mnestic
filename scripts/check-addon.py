"""Static checks for the Anki add-on that a syntax check does not catch.

An add-on that raises at import time simply does not load — Anki shows
"Add-on Startup Failed" and the bridge never starts, so the extension behaves as
though Anki were closed. `ast.parse` is happy with such a file, because the
problem is name-resolution ORDER, not syntax. That is exactly how the dispatch
table came to reference five ops defined below it.

Run:  python scripts/check-addon.py
"""

import ast
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "..", "anki-addon", "mnestic_bridge", "__init__.py")


def module_level_defs(tree):
    """name -> line number, for every function/class defined at module level."""
    out = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out[node.name] = node.lineno
    return out


def check(path):
    src = io.open(path, encoding="utf-8").read()
    tree = ast.parse(src, filename=path)
    defs = module_level_defs(tree)
    problems = []

    # Every name referenced by a module-level assignment must already exist at
    # that point — this is what runs at import time.
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for ref in ast.walk(node.value):
            if not isinstance(ref, ast.Name) or not isinstance(ref.ctx, ast.Load):
                continue
            if ref.id not in defs:
                continue                       # a builtin, an import, or a local
            if defs[ref.id] > node.lineno:
                target = getattr(node.targets[0], "id", "<assignment>")
                problems.append(
                    "%s:%d  %s references %s, which is not defined until line %d"
                    % (os.path.basename(path), node.lineno, target, ref.id, defs[ref.id])
                )

    # Every op in the dispatch table must be a real function.
    ops = set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "_OPS":
            for value in node.value.values:
                if isinstance(value, ast.Name):
                    ops.add(value.id)
                    if value.id not in defs:
                        problems.append("_OPS references %s, which is not defined" % value.id)
    if not ops:
        problems.append("no _OPS dispatch table found")

    # Anything named op_* but not wired up is dead code or a missed registration.
    orphans = sorted(n for n in defs if n.startswith("op_") and n not in ops)
    for o in orphans:
        problems.append("%s is defined but not in _OPS" % o)

    return sorted(ops), problems


if __name__ == "__main__":
    ops, problems = check(os.path.normpath(TARGET))
    print("ops registered: %d" % len(ops))
    print("  " + ", ".join(ops))
    if problems:
        print("\nPROBLEMS (%d):" % len(problems))
        for p in problems:
            print("  " + p)
        sys.exit(1)
    print("\nRESULT: import order OK")
