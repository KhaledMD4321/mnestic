# Mnestic Bridge

A tiny local helper for the **Mnestic** browser extension. It listens only on
`127.0.0.1` and every request must carry your private **pairing code**, so
nothing else on your computer can read or change your collection through it.

**Settings**

- **`port`** — the local port the bridge listens on (default `8790`). If another
  program already uses it, change this and set the same port in the extension.
- **`token`** — your pairing code. Leave it blank and one is generated on first
  run. To see it: **Tools → Mnestic Bridge → Pairing code…** (it's copied to
  your clipboard). Paste it into the extension once. To replace it:
  **Tools → Mnestic Bridge → Issue a new pairing code…**, then paste the new one
  into the extension.

After changing anything here, **restart Anki**.

**The browser extension** — this add-on does nothing without it:
<https://chromewebstore.google.com/detail/mnestic/mdjekpfeinjdgkjbeaffbpfhodofhfhd>

**How to use it all** — <https://github.com/KhaledMD4321/mnestic/blob/main/docs/guide.md>

Free and open source (GPLv3) — <https://github.com/KhaledMD4321/mnestic>.
If it helps you, you can support it: <https://buymeacoffee.com/bnkhaled>.
