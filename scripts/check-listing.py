"""Check the store listing copy against the limits the stores enforce.

A field one character over is not caught by any test, any linter, or by reading
it -- only by a submission being rejected. The Summary was 133 characters
against a 132 limit until this file existed.

It also holds the listing Summary and the manifest's `description` to the same
string. The Chrome Web Store defaults the summary to the manifest description,
so when the two disagree, the one users see is whichever you did not look at.

Run:  python scripts/check-listing.py
"""

import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))

LIMITS = {"Name": 45, "Summary": 132}          # Chrome Web Store
DESC_LIMIT = 16000


def block(src, field):
    """The fenced code block that follows a **Field** heading."""
    pattern = r"\*\*" + re.escape(field) + r"\*\*[^\n]*\n(?:[^\n]*\n)*?```\n(.*?)\n```"
    m = re.search(pattern, src, re.S)
    return m.group(1) if m else None


def main():
    src = io.open(os.path.join(ROOT, "docs", "chrome-store-listing.md"),
                  encoding="utf-8").read()
    manifest = json.load(io.open(os.path.join(ROOT, "extension", "manifest.json"),
                                 encoding="utf-8"))
    problems = []

    for field, limit in sorted(LIMITS.items()):
        text = block(src, field)
        if text is None:
            problems.append("no %s block found in the listing copy" % field)
            continue
        print("  %-9s %5d / %d" % (field, len(text), limit))
        if len(text) > limit:
            problems.append("%s is %d characters, limit is %d"
                            % (field, len(text), limit))

    desc = block(src, "Detailed description")
    if desc:
        print("  %-9s %5d / %d" % ("Details", len(desc), DESC_LIMIT))
        if len(desc) > DESC_LIMIT:
            problems.append("Detailed description is %d, limit %d"
                            % (len(desc), DESC_LIMIT))

    summary = block(src, "Summary")
    mdesc = manifest.get("description", "")
    print("  %-9s %5d / %d" % ("manifest", len(mdesc), 132))
    if len(mdesc) > 132:
        problems.append("manifest description is %d characters, limit 132" % len(mdesc))
    if summary is not None and summary != mdesc:
        problems.append("Summary and manifest.json description differ:\n"
                        "    listing:  %r\n    manifest: %r" % (summary, mdesc))

    if problems:
        print("\nPROBLEMS (%d):" % len(problems))
        for p in problems:
            print("  " + p)
        return 1
    print("\nRESULT: listing copy fits every limit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
