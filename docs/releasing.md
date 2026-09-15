# Releasing Mnestic

Two packages ship together and they must be released together: the extension
gains features that call ops the add-on only has in the matching version. An
extension that is newer than someone's add-on degrades rather than breaks (it
says "update the Mnestic Bridge add-on"), but only if both are published.

```
dist/mnestic-extension.zip      -> Chrome Web Store
dist/mnestic_bridge.ankiaddon   -> AnkiWeb
```

## 0. Before you build

Bump BOTH versions, in the same commit, to the same number:

| File | Field |
|---|---|
| `extension/manifest.json` | `"version"` |
| `anki-addon/mnestic_bridge/__init__.py` | `ADDON_VERSION` |

## 1. Verify

All four must be green. None of them needs Anki running except the last.

```bash
python scripts/check-addon.py     # the add-on can actually IMPORT
python scripts/guard-test.py      # the destructive ops refuse what they should
node scripts/adapter-test.js      # every site adapter still parses its pages
node scripts/e2e-test.js          # the real extension, driven in a real browser
```

`check-addon.py` is the one that matters most before an upload: a dispatch table
referencing an op defined below it is valid Python that fails at import, and an
add-on that fails to import does not load at all — the bridge never starts and
every user sees "Anki isn't running".

Then, with Anki open, exercise the ops against a real collection. The e2e suite
runs against a mock bridge, so it cannot catch an op that is wrong about Anki's
own API.

## 2. Build

```powershell
.\scripts\build-ankiaddon.ps1
.\scripts\build-extension-zip.ps1
```

Confirm the packages are the code you tested:

```bash
unzip -p dist/mnestic_bridge.ankiaddon __init__.py | diff - anki-addon/mnestic_bridge/__init__.py
unzip -p dist/mnestic-extension.zip manifest.json | grep version
```

## 3. GitHub

```bash
git tag -a v1.3.0 -m "Mnestic 1.3.0"
git push origin v1.3.0
gh release create v1.3.0 dist/mnestic-extension.zip dist/mnestic_bridge.ankiaddon \
  --title "Mnestic 1.3.0" --notes-file docs/release-notes/v1.3.0.md
```

The release is what people install from if they'd rather not use the stores, and
it is the only place the two packages are published as a matched pair.

## 4. AnkiWeb

<https://ankiweb.net/shared/mine> → the add-on → **Update** → upload
`dist/mnestic_bridge.ankiaddon`.

- The **description** is markdown and is the add-on's whole landing page.
- Anki's shared-add-on page has no version field: the uploaded file IS the
  version. Users get it through Tools → Add-ons → Check for Updates.
- Keep the support and licence lines current (GPLv3 + the repo link).

## 5. Chrome Web Store

<https://chrome.google.com/webstore/devconsole> → Mnestic → **Package** →
**Upload new package** → `dist/mnestic-extension.zip` → **Submit for review**.

Paste-ready copy for every field is in `docs/chrome-store-listing.md`. Two things
reviewers reliably check:

- **Host permissions must match the description.** If the manifest asks for a
  site, the description has to say the extension works on it. Adding a question
  bank means updating the listing copy in the same submission.
- **A new host permission re-triggers full review**, which takes longer than a
  code-only update. Expect days, not hours.

Review times vary. The store keeps serving the previous version until the new
one is approved, so nothing breaks while you wait — but AnkiWeb publishes
immediately, which means the add-on can be ahead of the extension for a few
days. That direction is safe: the add-on simply has ops nothing calls yet.
