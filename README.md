# NoteFreeze

A local, personal Chrome extension (Manifest V3) that captures the page you are looking at
as **one self-contained HTML file** — all CSS inlined, images embedded as base64 `data:` URIs,
scripts stripped, form state preserved — and then lets you **annotate** it with rich text in a
Word-style editor. The exported file works fully offline: click any highlight and a popup panel
shows your embedded annotation. Zero network requests, zero servers, zero build tools.

Vanilla JS/CSS/HTML only. No npm, no build step, no CDNs, no frameworks.

**Compact mode** (on by default; toggle in the popup) skips embedding web fonts, which are
usually the bulk of a captured file — text falls back to system fonts. On font-heavy sites this
routinely cuts the file by 70–90% (e.g. a 65 MB capture → ~4 MB). Turn it off when a page relies
on an icon font or a typeface you specifically want preserved.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome (version 110 or newer).
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select this `notefreeze` folder.
5. (Optional) Pin the toolbar icon: puzzle-piece menu → pin **NoteFreeze**.

If the icons are missing (fresh checkout), regenerate them first:

```sh
python3 icons/make_icons.py
```

## Keyboard shortcut

- **Ctrl+Shift+Y** captures the current page and opens the annotator.
- On macOS the default is **⌃⇧Y** (Control+Shift+Y, not Command).
- If the shortcut conflicts with another extension or does nothing, reassign it at
  `chrome://extensions/shortcuts` under "NoteFreeze".

## Usage walkthrough

1. **Capture** — On any normal web page, click the toolbar icon and press
   **📸 Capture & Annotate this page** (or hit Ctrl+Shift+Y). The page freezes under a
   progress overlay while every stylesheet, image and font is inlined. When done, a new
   **Annotator** tab opens with the snapshot.
2. **Annotate** — In the annotator, select any text in the snapshot. A floating
   **"✏️ RichText Annotation here"** button appears; click it. The selection is highlighted
   and a full-screen rich-text editor opens (Word-style ribbon: fonts, colors, lists,
   tables, images, links, symbols…). Write or paste your formatted notes — pasted images
   are converted to base64 automatically — then click **Save**.
3. **Export** — Saving an annotation auto-downloads the standalone
   `<title>.annotated.html` file (toggle "Auto-download on save" in the annotator toolbar,
   or use the **💾 Save HTML** button at any time). Click an existing highlight to edit or
   delete its annotation.
4. **View offline** — Open the exported file anywhere, even with networking disabled.
   Highlighted text is clickable: a popup panel (10% margin, themed) shows the embedded
   rich-text annotation. Everything is inside that one HTML file.

Recent captures (up to 20 are kept) are listed in the popup, where you can reopen or
delete them.

## Themes

Pick a theme from the swatches in the popup (also selectable in the annotator toolbar):

- **Light:** GitHub Light, Solarized Light, One Light, Gruvbox Light, Catppuccin Latte
- **Dark:** Dracula, Nord, Solarized Dark, Tokyo Night, One Dark
- **Special:** Neon Noir

## Privacy

**Everything stays on this device.** Captures live in `chrome.storage.local`, exports are
plain files in your Downloads folder, and the extension makes network requests only to
fetch the page's own resources during capture (so they can be embedded). Nothing is ever
sent to any server. No analytics, no accounts, no telemetry.

## Limitations

- **Cross-origin iframes** can't be read and become labeled placeholder boxes
  (same-origin frames are captured inline).
- **Closed shadow DOM** is not reachable by design and is skipped
  (open shadow roots are captured via `<template shadowrootmode>`).
- **Video/audio** are not embedded: videos become their poster image (or a "▶ Video"
  placeholder), audio becomes a small placeholder.
- **DRM-protected media and tainted canvases** can't be exported and become placeholders.
- **`chrome://` pages, other extension pages and the Chrome Web Store** can't be captured
  (Chrome blocks script injection there) — you'll get a notification instead.
- **`file://` pages** require enabling "Allow access to file URLs" for NoteFreeze on
  `chrome://extensions`.
- External SVG `<use>` references are left as-is and may not render offline.
- Resources larger than 32 MB are skipped (the original URL is kept, so they still load
  when online).

## Compiling

You can use Chrome's native ```Pack extension``` in ```chrome://extensions/``` to compile to CRX file.  

## License

[MIT](LICENSE) © 2026 Zi1chs. Independently built — not affiliated with, or derived from, any
other project of a similar name.
