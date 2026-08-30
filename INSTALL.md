# Installing Mnestic (step by step)

Written for friends — no coding needed. Takes about 5 minutes. You'll install
two small pieces: an **Anki add-on** and a **browser extension**, then link them
with a one-time code.

---

## Before you start

- **Anki** installed on your computer (the free desktop app).
- Your **AnKing** deck loaded in Anki (the version with the UWorld tags).
- **Chrome**, **Brave**, or **Edge**.
- The Mnestic folder (this repo) downloaded — on GitHub, click the green
  **Code ▸ Download ZIP**, then unzip it somewhere you'll remember.

---

## Step 1 — Install the Anki add-on

1. Open the unzipped Mnestic folder → open `anki-addon/`.
2. Copy the whole **`mnestic_bridge`** folder.
3. Open Anki → **Tools ▸ Add-ons ▸ View Files**. A folder called `addons21`
   opens.
4. Paste **`mnestic_bridge`** into `addons21`. You should now have
   `addons21/mnestic_bridge/` with `__init__.py` inside it.
5. **Close and reopen Anki.**

That's the add-on installed. Leave Anki open.

---

## Step 2 — Install the browser extension

1. In Chrome/Brave/Edge, go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`extension`** folder inside the Mnestic folder.

The **M** icon appears in your toolbar. Pin it if you like (puzzle-piece icon →
pin).

---

## Step 3 — Link them with your pairing code

This is the one-time security step — it makes sure only *your* extension can talk
to *your* Anki.

1. In **Anki**, click **Tools ▸ “Mnestic: pairing code…”**. A code is shown and
   **copied to your clipboard**.
2. Click the **M** extension icon to open the popup.
3. Paste the code into the **Pairing code** box and click **Save**.
4. The little status pill at the bottom should turn green: **Ready**. 🎉

If it says:
- **“Anki not connected”** → make sure Anki is open, then click **Recheck**.
- **“Enter pairing code”** → you still need to paste the code from step 1.

---

## Step 4 — Check that the question IDs match (important)

Mnestic works because your qbank reuses UWorld's question numbers and your AnKing
cards are tagged with them. Confirm it once:

1. Open any question and note the **“Question Id: N”** in the header.
2. In Anki, open **Browse** and search:
   `tag:#AK_Step1_v*::#UWorld::*::N` (put your number in place of `N`).
3. If the card that comes back is the **same topic** as the question — you're all
   set. If nothing comes back, tell whoever shared this with you.

---

## You're done

Open a question and you'll see the Mnestic panel with your matched resources.
Press **F** for First Aid, **S** for Sketchy, and so on. Open the popup any time
to set your daily/weekly targets and see your streak.

**Using it on another computer later?** Repeat Steps 1–3 there. The add-on makes
a fresh pairing code per machine, so each computer pastes its own code once.
