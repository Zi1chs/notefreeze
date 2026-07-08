# NoteFreeze — Architecture Specification (v1.0)

This is the single source of truth for all modules. Every implementer MUST follow the
contracts here exactly (names, message types, storage keys, function signatures, CSS class
names, theme ids). If something is ambiguous, choose whatever best serves the user goal and
record the decision in your completion notes.

## 1. Product overview

A local, personal, Manifest V3 Chrome extension named **NoteFreeze**.

Core flow:
1. User clicks the toolbar popup button "Capture & Annotate" (or presses **Ctrl+Shift+Y**).
2. The extension freezes the current page (interaction-blocking progress overlay), serializes
   the ENTIRE visible document into ONE self-contained HTML string: all CSS inlined (including
   `@import` chains and `@font-face`), every image/font/resource converted to base64 `data:`
   URIs, scripts stripped, form state preserved. Fully offline-viewable.
3. The capture is stored in `chrome.storage.local` and a new tab opens: the **Annotator**.
4. In the Annotator the snapshot renders in an iframe. When the user selects/highlights any
   text, a floating button appears: **"RichText Annotation here"**. Clicking it wraps the
   selection in highlight spans and opens a full-screen editor panel (10% margin on all sides,
   i.e. `position:fixed; inset:10%`) with a Microsoft-Word-style ribbon. The user writes/pastes
   rich text (formatted HTML, images auto-converted to base64) and clicks **Save**.
5. Save embeds the annotation into the document and generates/downloads a single standalone
   HTML file (auto-download toggleable; there is also a manual "Save HTML" toolbar button).
6. Opening the exported file offline: highlighted text is clickable and opens a popup panel
   (same 10% margin layout) showing the embedded rich text. Zero network requests.

Constraints: vanilla JS/CSS/HTML only. No npm, no build step, no CDN/network dependencies,
no frameworks. Loaded unpacked. Target Chrome ≥ 110.

## 2. Repository layout

```
notefreeze/
  manifest.json
  background.js              # MV3 service worker
  content/
    capture.js               # capture engine (injected on demand)
  popup/
    popup.html  popup.css  popup.js
  annotator/
    annotator.html  annotator.css  annotator.js
    editor.js  editor.css        # rich-text editor panel (ribbon)
    exporter.js                  # doc serializer + standalone HTML builder (embeds viewer)
  shared/
    themes.css               # all 11 themes as CSS custom properties
  icons/
    make_icons.py            # stdlib-only PNG generator (zlib+struct, NO PIL)
    icon16.png icon32.png icon48.png icon128.png
  README.md
  SPEC.md                    # this file
```

Ownership (each agent writes ONLY its files):
- **A (platform)**: manifest.json, background.js, icons/* (write + run make_icons.py), README.md
- **B (capture)**: content/capture.js
- **C (popup)**: popup/*, shared/themes.css
- **D (annotator)**: annotator/annotator.html, annotator.css, annotator.js
- **E (editor+exporter)**: annotator/editor.js, annotator/editor.css, annotator/exporter.js

## 3. manifest.json (exact content, adjust only if invalid)

```json
{
  "manifest_version": 3,
  "name": "NoteFreeze",
  "version": "1.0.0",
  "description": "Capture the current page as a single fully-offline HTML file and annotate it with rich text.",
  "minimum_chrome_version": "110",
  "permissions": ["activeTab", "scripting", "storage", "unlimitedStorage", "downloads", "notifications", "clipboardRead"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "NoteFreeze — Capture & Annotate (Ctrl+Shift+Y)",
    "default_icon": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
  },
  "commands": {
    "capture-annotate": {
      "suggested_key": { "default": "Ctrl+Shift+Y", "mac": "MacCtrl+Shift+Y" },
      "description": "Capture current page and start annotating"
    }
  },
  "icons": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

## 4. Message protocol & storage schema

All `chrome.runtime` messages are objects `{ type: string, ...payload }`. Handlers that
respond asynchronously MUST `return true` from the onMessage listener.

| type | direction | payload | response |
|---|---|---|---|
| `SFP_CAPTURE_TAB` | popup → background | `{}` | `{ok:boolean, error?:string}` (ack that capture started) |
| `SFP_START_CAPTURE` | background → content script | `{}` | `{ok:true}` immediately; work continues async |
| `SFP_FETCH_RESOURCE` | content/annotator → background | `{url:string}` | `{ok:true, dataUri:string}` or `{ok:false, error:string}` |
| `SFP_CAPTURE_CHUNK` | content → background | `{transferId, seq, total, data}` — ≤16 MiB slice of the serialized html (Chrome caps any single runtime message at 64 MiB, which is a hard browser limit) | `{ok:true}` or `{ok:false, error}` |
| `SFP_CAPTURE_COMPLETE` | content → background | `{transferId, title, url, scrollX, scrollY}` — background reassembles html from the chunks (legacy `{html,...}` also accepted) | `{ok:true, captureId}` |
| `SFP_CAPTURE_ERROR` | content → background | `{error:string}` | `{ok:true}` |

`chrome.storage.local` keys:
- `sfp_theme`: string theme id (default `"github-light"`).
- `sfp_autodownload`: boolean (default `true`) — auto-download exported HTML on annotation save.
- `sfp_captures_index`: `Array<{id, title, url, capturedAt, annotationCount}>`, newest first, max 20
  entries (when trimming, also delete the trimmed `sfp_capture_<id>` records).
- `sfp_capture_<id>`: `{id, title, url, capturedAt, scrollX, scrollY, html, annotations}` where
  `annotations` is `{[annId]: {id, html, createdAt, updatedAt}}`. `html` is the FULL serialized
  document string (including any `.sfp-hl` spans, excluding UI elements).

Id formats: capture id `c_<epochMs>_<4 random base36 chars>`; annotation id `a_<epochMs>_<4 random base36 chars>`.

Annotator page URL: `chrome.runtime.getURL('annotator/annotator.html') + '?id=' + captureId`.

## 5. Capture engine — `content/capture.js`

Injected on demand via `chrome.scripting.executeScript({files:['content/capture.js']})`.
The whole file is wrapped so double-injection is safe:

```js
if (!window.__SFP_LOADED__) {
  window.__SFP_LOADED__ = true;
  chrome.runtime.onMessage.addListener(...); // handles SFP_START_CAPTURE
}
```

A second `SFP_START_CAPTURE` while a capture is running is ignored (`window.__SFP_CAPTURING__` guard).

### 5.1 Freeze overlay
On start, append a full-screen fixed overlay to `document.body` (highest z-index 2147483647,
`data-sfp-exclude` attribute, blocks pointer events) showing "NoteFreeze — capturing page…"
plus a live progress line ("Inlining resources… 12/47"). The serializer MUST skip any element
bearing `data-sfp-exclude`. Remove the overlay when done (brief "Done ✓ Opening annotator…" state).

### 5.2 Serialization algorithm
Build a NEW detached document via `document.implementation.createHTMLDocument('')` and
recursively construct sanitized copies of the live DOM (walk the ORIGINAL DOM — do not rely on
`cloneNode(true)` alone, because shadow roots, canvas bitmaps and live form state don't clone).

Final output string: `'<!DOCTYPE html>\n' + outDoc.documentElement.outerHTML`, preceded inside
`<head>` by `<meta charset="utf-8">` (ensure it is first), and an HTML comment right after the
doctype: `<!-- Saved with NoteFreeze | url: <page url> | date: <ISO date> -->`.

Element handling:
- **Drop entirely**: `script`, `noscript`, `base`, `object`, `embed`,
  `link` with `rel` in {preload, modulepreload, prefetch, dns-prefetch, preconnect, manifest},
  `meta` with http-equiv in {content-security-policy, refresh}, any `[data-sfp-exclude]`.
- **Attributes dropped everywhere**: all `on*` handlers, `nonce`, `integrity`, `crossorigin`,
  `ping`, `srcset`, `sizes`, `loading`, `fetchpriority`. `href`/`src`/`action` beginning with
  `javascript:` → attribute removed.
- **`<a href>`**: resolve to absolute URL (links remain usable when online).
- **`<img>`**: use `img.currentSrc || img.src`; inline to data URI; keep class/style/width/height/alt.
- **`<picture>`**: drop the `<source>` children, keep the resolved `<img>`.
- **`<link rel=stylesheet>`**: replace IN PLACE with `<style>` (preserve `media` attribute).
  Get CSS text by locating the matching entry in `document.styleSheets` (via `ownerNode`) and
  serializing `cssRules` (try/catch — throws for cross-origin); on failure fetch the `href`.
  Then run through `processCSS`.
- **`<style>`**: `processCSS(textContent, baseURL)`.
- **`document.adoptedStyleSheets`**: serialize each and append as `<style>` at end of `<head>`.
- **Inline `style=""` attributes**: rewrite `url(...)` tokens via the same resource inliner.
- **`<canvas>`**: `try { toDataURL() }` → replace with `<img>` (copy class/style/w/h); tainted →
  gray placeholder `<div>` with same dimensions.
- **`<video>`**: replace with `<img>` of the inlined `poster` if present, else a dark placeholder
  `<div>` labeled "▶ Video (not captured)"; keep sizing/class/style. **`<audio>`** → small placeholder div.
- **`<iframe>`**: FIRST, if the live frame is hidden (`display:none`/`visibility:hidden`/
  `opacity:0`/≤1×1) OR is a blank/`about:blank` utility frame (no real `src` and an empty
  contentDocument body — analytics/consent/cross-tab helper frames), emit it as
  `display:none` so it occupies ZERO layout space. (Left visible, such script-injected blank
  frames render at the UA-default 300×150 and, stacked, shove real content hundreds of px down —
  this was the "content pushed into a void" bug.) Otherwise: if `contentDocument` readable
  (same-origin) → recursively serialize that document and set as `srcdoc` (drop `src`), and pin
  the real rendered `getBoundingClientRect()` size when no width/height attrs exist; else
  placeholder `<div>` labeled "Embedded frame (offline unavailable): <url>" preserving
  width/height/class/style.
- **Form state**: `input.setAttribute('value', input.value)` (password inputs → empty),
  checkbox/radio `checked`, `<option>` `selected`, `<textarea>` textContent = live value.
- **Inner scroll state**: for every element with non-zero `scrollTop`/`scrollLeft`, record
  `data-sfp-scroll-top` / `data-sfp-scroll-left` attributes (live scroll offsets don't
  serialize; without them SPA content panes snap to offset 0 and the layout no longer matches
  what the user saw). The annotator (§9.2) and the exported viewer (§11) restore them on load.
- **Top-layer state**: an open popover (`:popover-open`) or modal dialog (`:modal`) loses its
  top-layer rendering when re-parsed — bake its `getBoundingClientRect()` as inline
  `position:fixed` + rect + high z-index (and drop the `popover` attribute) so it stays where
  the user saw it.
- **Open shadow DOM**: if `el.shadowRoot`, prepend a `<template shadowrootmode="open">` child
  containing the serialized shadow children plus the shadow root's `adoptedStyleSheets` as
  `<style>` elements inside the template. (Closed shadow roots: skipped, accept the limitation.)
- **SVG**: keep inline SVG; inline `<image href|xlink:href>` resources. External `<use>` refs
  left as-is (documented limitation).
- **Favicon**: `link rel~="icon"` → inline href to data URI.

### 5.3 CSS processing — `processCSS(cssText, baseURL) -> Promise<string>`
- Resolve and inline `@import url(...) <media>;` recursively (fetch, recurse, wrap in
  `@media <media> { ... }` if a media list was present).
- Rewrite every `url(...)` token (regex `/url\(\s*(['"]?)([^'")]+)\1\s*\)/g`): skip `data:` and
  fragment-only `#...` refs; resolve relative to the STYLESHEET's URL (not the page); fetch to
  data URI; on failure keep the absolute URL. This covers images, `@font-face` fonts, cursors, masks.

### 5.4 Resource inliner — `fetchAsDataURI(url) -> Promise<string|null>`
- Module-level `Map<absoluteURL, Promise<string|null>>` cache (dedupe).
- `data:` URLs returned as-is. `about:`/`chrome:` → null.
- Try page-context `fetch(url, {credentials:'include'})` first (works same-origin + CORS-enabled,
  hits HTTP cache); on ANY failure fall back to `SFP_FETCH_RESOURCE` message to the background
  (which bypasses CORS via host permissions). null on total failure (caller keeps original URL).
- Skip resources whose Content-Length/blob size exceeds 32 MB (return null).
- Global concurrency limit ~8 simultaneous fetches; report progress (done/total) to the overlay.

### 5.5 Completion
Send `SFP_CAPTURE_COMPLETE` with `{html, title: document.title, url: location.href,
scrollX, scrollY}`. On any thrown error send `SFP_CAPTURE_ERROR` and remove the overlay.

## 6. Background service worker — `background.js`

- `chrome.commands.onCommand` for `"capture-annotate"` → `captureTab(activeTab)`.
- `chrome.runtime.onMessage`:
  - `SFP_CAPTURE_TAB` → `captureTab` on the sender's active tab; respond `{ok}`.
  - `SFP_FETCH_RESOURCE` → fetch (see below), respond async (`return true`).
  - `SFP_CAPTURE_COMPLETE` → generate captureId; write `sfp_capture_<id>` record with
    `annotations:{}`; unshift `sfp_captures_index` (trim >20, deleting trimmed records); clear
    badge; `chrome.tabs.create` the annotator URL; respond `{ok:true, captureId}`.
  - `SFP_CAPTURE_ERROR` → badge "!", notification with the error.
- `captureTab(tab)`: reject non-`http(s)`/`file:` URLs with a notification
  ("This page can't be captured"); else `chrome.scripting.executeScript({target:{tabId}, files:['content/capture.js']})`,
  then `chrome.tabs.sendMessage(tabId, {type:'SFP_START_CAPTURE'})`; set action badge "…" on that tab.
- Resource fetch: `fetch(url, {credentials:'include'})` → `arrayBuffer` → base64 via chunked
  `String.fromCharCode` (32KB chunks) + `btoa` (NO FileReader — not available in service workers)
  → `data:<content-type or application/octet-stream>;base64,<b64>`.
- Wrap everything in try/catch; never leave the badge stuck (clear on error).

## 7. Popup — `popup/`

`popup.html` loads `../shared/themes.css`, `popup.css`, `popup.js` (`<script src>` only — MV3
CSP forbids inline scripts in extension pages).

Layout (theme-aware via `document.documentElement.dataset.theme`):
1. Header: icon + "NoteFreeze".
2. Primary button **"📸 Capture & Annotate this page"** → send `SFP_CAPTURE_TAB`; on `{ok:true}`
   `window.close()`; on error show inline status message (e.g. restricted chrome:// page).
   Hint line underneath: "or press Ctrl+Shift+Y" (show ⌃⇧Y on Mac via `navigator.platform`).
3. **Theme picker**: three labeled rows — Light, Dark, Special — of round color swatches
   (background = theme bg, inner dot = accent), tooltip = theme name, active theme gets an
   accent ring. Clicking saves `sfp_theme` and applies live to the popup.
4. **Recent captures**: up to 8 rows from `sfp_captures_index`: favicon-less title (ellipsis),
   relative date, annotation count badge, "Open" (opens annotator tab) and "🗑" (delete record +
   index entry, with `confirm()`). Empty state: "No captures yet."
5. Footer: "100% local — your data never leaves this device."

## 8. Themes — `shared/themes.css`

CSS custom properties on `:root` (default = github-light) and `[data-theme="<id>"]` selectors.
Variables (use EXACTLY these names everywhere):
`--sfp-bg, --sfp-surface, --sfp-surface2, --sfp-text, --sfp-text-muted, --sfp-border,
--sfp-accent, --sfp-accent-text, --sfp-danger, --sfp-highlight, --sfp-shadow`.

| id | name | bg | surface | text | accent |
|---|---|---|---|---|---|
| `github-light` | GitHub Light | #ffffff | #f6f8fa | #1f2328 | #0969da |
| `solarized-light` | Solarized Light | #fdf6e3 | #eee8d5 | #586e75 | #268bd2 |
| `one-light` | One Light | #fafafa | #f0f0f1 | #383a42 | #4078f2 |
| `gruvbox-light` | Gruvbox Light | #fbf1c7 | #ebdbb2 | #3c3836 | #076678 |
| `catppuccin-latte` | Catppuccin Latte | #eff1f5 | #e6e9ef | #4c4f69 | #8839ef |
| `dracula` | Dracula | #282a36 | #44475a | #f8f8f2 | #bd93f9 |
| `nord` | Nord | #2e3440 | #3b4252 | #eceff4 | #88c0d0 |
| `solarized-dark` | Solarized Dark | #002b36 | #073642 | #93a1a1 | #268bd2 |
| `tokyo-night` | Tokyo Night | #1a1b26 | #24283b | #c0caf5 | #7aa2f7 |
| `one-dark` | One Dark | #282c34 | #21252b | #abb2bf | #61afef |
| `blackpink` | Neon Noir | #0a0a0a | #16161a | #f5e6ee | #ff2e88 |

Fill in sensible derived values for the remaining vars per theme (borders, muted text,
`--sfp-highlight` = translucent accent-tinted yellow for light themes / warm amber for dark).
`--sfp-accent-text` = readable text color on the accent (usually #ffffff, #000000 for pale accents).

Theme grouping constant (used by popup): Light = first five, Dark = next five, Special = blackpink.

## 9. Annotator — `annotator/annotator.html|css|js`

`annotator.html` includes IN ORDER: `../shared/themes.css`, `annotator.css`, `editor.css`,
then `<script src>`: `exporter.js`, `editor.js`, `annotator.js`. No inline scripts/styles.

### 9.1 Layout
- Top toolbar (theme-aware): app icon/name; capture title + original URL (clickable, opens in
  new tab) + captured date; annotation count badge (live); theme `<select>` (all 11);
  checkbox "Auto-download on save" (bound to `sfp_autodownload`); primary button
  **"💾 Save HTML"**; secondary "🗑 Clear all annotations" (confirm dialog).
- Below: full-size `<iframe id="sfp-frame">` (no sandbox attr) filling the rest of the viewport.

### 9.2 Boot
Parse `?id=`; `chrome.storage.local.get` the record; missing → friendly error screen. Set
`document.title = 'Annotate — ' + title`. Load `record.html` into the iframe via a **Blob URL**
(`URL.createObjectURL(new Blob([html], {type:'text/html'}))` — NOT `srcdoc`: srcdoc escapes and
parses the whole document as one attribute value, which mangles/truncates layout on tens-of-MB
captures; a blob URL created in the extension origin remains same-origin, keep srcdoc only as a
fallback and revoke stale object URLs). After the iframe loads: inject a `<style data-sfp-ui>`
into the iframe doc containing highlight + floating-button CSS (section 9.5); restore
`scrollTo(scrollX, scrollY)` AND the inner-container offsets from
`data-sfp-scroll-top/-left` attributes (§5.2); attach listeners.

### 9.3 Selection → floating button
On iframe `mouseup`/`keyup` (and `selectionchange` debounced ~150ms): if the iframe selection is
non-collapsed with non-whitespace text, position a floating button INSIDE the iframe body
(absolute-positioned at selection end rect + iframe scroll offsets, clamped to viewport,
`data-sfp-ui` attribute, class `sfp-float-btn`) labeled exactly **"✏️ RichText Annotation here"**.
`mousedown` on the button calls `preventDefault()` (keeps the selection). Hide on click
elsewhere/scroll/selection collapse.

Click → capture the Range BEFORE opening the editor, create `annId`, call
`wrapRange(range, annId)` (spans get extra class `sfp-hl-pending`), clear selection, hide
button, then `SFPEditor.open({ initialHTML:'', mode:'create', theme, onSave, onCancel })`.

### 9.4 Highlight wrapping — `wrapRange(range, annId)`
Wrap every text node intersecting the range in
`<span class="sfp-hl" data-sfp-id="<annId>">`:
- Use a TreeWalker over `range.commonAncestorContainer` filtered by `range.intersectsNode`,
  text nodes only; skip nodes inside `[data-sfp-ui]`.
- Split boundary text nodes with `splitText` at `startOffset`/`endOffset` (collect the node list
  BEFORE mutating; handle the single-text-node case where both boundaries are the same node).
- Nested/overlapping with an existing `.sfp-hl` is allowed (innermost span wins on click via
  `stopPropagation`).
`unwrapAnnotation(annId)`: replace each matching span with its children; `normalize()` parents.

### 9.5 Highlight & button CSS (inside iframe, `data-sfp-ui` style tag)
- `.sfp-hl { background: rgba(255, 213, 0, .45); cursor: pointer; border-bottom: 2px solid rgba(230,160,0,.85); }`
- `.sfp-hl:hover { background: rgba(255, 200, 0, .65); }`
- `.sfp-hl-pending { outline: 2px dashed rgba(230,160,0,.9); }`
- `.sfp-float-btn`: pill button, accent bg, white text, shadow, z-index 2147483647.

### 9.6 Annotation lifecycle
- **Create**: editor `onSave(html)` → sanitize is already done by the editor; store
  `annotations[annId] = {id, html, createdAt, updatedAt}`; remove `sfp-hl-pending`; `persist()`;
  toast "Annotation saved ✓"; if `sfp_autodownload` → `exportAndDownload()`.
  `onCancel` → `unwrapAnnotation(annId)` (a create-mode cancel must leave no trace).
- **Edit**: click on `.sfp-hl` inside iframe → `SFPEditor.open({initialHTML: existing.html,
  mode:'edit', theme, onSave, onCancel, onDelete})`. `onDelete` → confirm → `unwrapAnnotation` +
  delete from map + `persist()`.
- **Clear all**: confirm → unwrap all + `annotations = {}` + `persist()`.
- `persist()`: `record.html = SFPExporter.serializeDoc(iframeDoc)`; `record.annotations = map`;
  storage set; update index entry's `annotationCount`; refresh badge.
- **Save HTML button** → `exportAndDownload()`:
  `SFPExporter.buildHTML({doc: iframeDoc, annotations, meta:{title, url, capturedAt}, themeId})`
  → `SFPExporter.download(htmlString, filename)`. Filename: slugified title (lowercase,
  `[^a-z0-9]+`→`-`, trimmed, max 60 chars, fallback `page`) + `.annotated.html`.
- Toasts: small fixed-corner status pill in the annotator page for saved/exported/error events.

## 10. Rich-text editor — `annotator/editor.js` + `editor.css`

Global `window.SFPEditor` with:
- `SFPEditor.open({initialHTML, mode, theme, onSave(html), onCancel(), onDelete()?})`
- `SFPEditor.close()`
- `SFPEditor.sanitizeHTML(html) -> string` (exposed; also used by exporter defensively)

### 10.1 Panel
Rendered into the ANNOTATOR document (not the iframe). Backdrop `rgba(0,0,0,.55)` covering the
viewport; panel `position:fixed; inset:10%` (⇒ 80% × 80% — the required "10% margin around the
popup panel border"), rounded corners, theme-colored chrome, z-index 2147483000. ESC and
backdrop click behave like Cancel (if dirty, `confirm('Discard this annotation?')`). Ctrl/Cmd+S
inside the panel saves.

### 10.2 Ribbon (Microsoft-Word-like; only rich-text-applicable controls)
Structure top-to-bottom: title bar ("Rich Text Annotation" + ✖ close), quick-access row
(💾 Save primary button, Undo ↶, Redo ↷, and 🗑 Delete when `mode==='edit'`), tab strip
(**Home** | **Insert**), the active tab's ribbon groups (each group = buttons + small
caption below, Word-style), then the editing surface, then a status bar (word count ·
character count · "NoteFreeze Editor").

**Home tab groups**
- *Clipboard*: Paste (navigator.clipboard read with fallback hint "use Ctrl+V"), Cut, Copy.
- *Font*: font-family `<select>` (Arial, Helvetica, Times New Roman, Georgia, Garamond,
  Courier New, Verdana, Tahoma, Trebuchet MS, Impact, system-ui); size `<select>`
  (8,9,10,11,12,14,16,18,20,24,28,32,36,48,72 pt — implement via execCommand fontSize 7 then
  replacing `font[size="7"]` with a styled span); **B I U S̶**, x₂ x²; text-color and
  highlight-color palette dropdowns (≥ 10 swatches + custom `<input type=color>`);
  Clear Formatting (Aᵡ).
- *Paragraph*: bulleted list, numbered list, outdent, indent, align left/center/right/justify,
  line-spacing dropdown (1.0 / 1.15 / 1.5 / 2.0 — set `line-height` on selected block elements),
  blockquote.
- *Styles*: Normal, Heading 1, Heading 2, Heading 3, Code (formatBlock p/h1/h2/h3/pre).

**Insert tab groups**
- *Table*: Word-style hover grid picker (up to 8×8) inserting a bordered table.
- *Links*: Insert Link (small dialog: text + URL), Remove Link.
- *Media*: Image — `<input type=file accept="image/*">` → FileReader → `<img src="data:...">`.
- *Symbols*: dropdown with ~24 common symbols (— – … © ® ™ ° ± × ÷ ≠ ≤ ≥ ← → ↑ ↓ • § ¶ € £ ¥ ¢ α β).
- *Rules*: Horizontal Line.

NO controls for things rich text/contenteditable can't represent (no object embedding, no
comments/track-changes, no page layout, etc.).

Toggle buttons reflect state via `document.queryCommandState/queryCommandValue` on
`selectionchange`. Use `document.execCommand` with `styleWithCSS = true`. Native Ctrl+B/I/U
keep working.

### 10.3 Editing surface
White "page" (`#ffffff`, dark text `#111`, max-width ~800px, centered, padding, subtle shadow —
Word-like on every theme), contenteditable, scrollable, placeholder text
"Paste or write your rich text annotation here…". Paste handler: intercept, take
`text/html` if present else plain text, run `sanitizeHTML`, then asynchronously inline any
remaining `http(s)` images via `SFP_FETCH_RESOURCE` (best effort — leave URL on failure).
Pasted/dropped image FILES → data URIs.

### 10.4 `sanitizeHTML(html)`
Parse with `DOMParser`. Remove elements: `script, style, iframe, frame, object, embed, link,
meta, base, form, input, button, select, textarea, video, audio, source, template, svg > use`
(keep `form` CHILDREN, drop the wrapper; actually: unwrap `form`, remove the rest entirely).
Remove attributes: all `on*`, `srcdoc`, `formaction`, `nonce`, `integrity`; `href`/`src` with
`javascript:` scheme removed. Allow `style` attributes and `class`. Allowed protocols for
href: http, https, mailto, #fragment; for img src: data:, http, https. Return `body.innerHTML`.

### 10.5 Dirty tracking
`input` events mark dirty; Save resets. Cancel/ESC/backdrop with dirty content → confirm dialog.
On Save: `onSave(sanitizeHTML(surface.innerHTML))` then close. Empty content (no text AND no
img/table/hr) on Save in create mode → treat as cancel (unwrap; toast "Empty annotation discarded").

## 11. Exporter & embedded viewer — `annotator/exporter.js`

Global `window.SFPExporter`:

- `serializeDoc(iframeDoc) -> string`: deep-clone `iframeDoc.documentElement`, remove every
  `[data-sfp-ui]` element and the `sfp-hl-pending` class, remove any previously injected
  `#sfp-viewer-css/#sfp-data/#sfp-viewer-js` nodes, return `'<!DOCTYPE html>\n' + outerHTML`.
- `buildHTML({doc, annotations, meta, themeId}) -> string`: take `serializeDoc(doc)` and inject
  immediately before `</body>` (string-level injection is fine; fall back to appending before
  `</html>`):
  1. `<style id="sfp-viewer-css">` — highlight styles (same visuals as 9.5) + viewer panel CSS
     with the CHOSEN THEME's palette baked in as literal hex values (no var() dependency on the
     extension), including `#sfp-viewer-overlay` backdrop and `#sfp-viewer-panel { position:fixed;
     inset:10%; }`, header, white content card, close button, scrollbars.
  2. `<script type="application/json" id="sfp-data">` — `JSON.stringify({annotations, meta})`
     with EVERY `</` replaced by `<\/` (script-close escaping; safe inside JSON strings).
  3. `<script id="sfp-viewer-js">` — an IIFE (plain ES5-compatible enough for any modern
     browser, but data-URI/file:// safe, ZERO external requests, no chrome.* usage):
     parse `#sfp-data`; restore window scroll from `meta.scrollX/scrollY` and inner-container
     offsets from `data-sfp-scroll-top/-left` (immediately and again on window `load`);
     delegate clicks on `.sfp-hl` (`closest`, innermost); on click open the
     panel: header "📝 Annotation" + created/updated dates + ✖; body = annotation html via
     innerHTML into the white card; footer "Saved with NoteFreeze · <original URL as link> ·
     <capture date>"; close on ✖ / ESC / backdrop click; if annotation id missing → do nothing.
     Also set `title="Click to view annotation"` on `.sfp-hl` elements at load.
- `download(html, filename)`: `new Blob([html], {type:'text/html'})` → object URL →
  `chrome.downloads.download({url, filename, saveAs:false})` → revoke URL after; fall back to a
  temporary `<a download>` click if `chrome.downloads` is unavailable.

The exported file must work standalone from `file://` with the network cable unplugged.

## 12. Icons & README — agent A

`icons/make_icons.py`: Python 3 STDLIB ONLY (zlib, struct — no PIL). Render 128×128 RGBA
pixel buffer: dark navy (#1c2431) rounded-square background, hot-pink (#ff2e88) document/page
shape with a folded corner, 2–3 lighter highlight bars on the page. Downscale by box-sampling
to 48/32/16. Write valid PNGs (IHDR/IDAT/IEND, 8-bit RGBA). Run it with
`python3 icons/make_icons.py` from the `notefreeze/` directory and verify the 4 PNGs exist.

`README.md`: what it is; install (chrome://extensions → Developer mode → Load unpacked →
select folder); shortcut note (Ctrl+Shift+Y, conflicts fixable at chrome://extensions/shortcuts;
Mac = ⌃⇧Y); usage walkthrough (capture → annotate → export → view offline); themes list;
privacy ("everything stays on this device"); limitations (cross-origin iframes become
placeholders, closed shadow DOM skipped, videos become posters, DRM/tainted canvas skipped,
chrome:// and Web Store pages can't be captured, file:// needs "Allow access to file URLs").

## 13. Coding standards & platform gotchas (ALL agents)

1. **MV3 extension-page CSP**: NO inline `<script>` or inline event handler attributes in
   popup.html / annotator.html. External `<script src>` files only. (The EXPORTED html file is
   NOT an extension page — inline scripts there are required and fine.)
2. Service worker: no DOM, no FileReader, no window. Use `self`, `btoa`, `arrayBuffer`.
3. Async `onMessage` handlers must `return true` to keep `sendResponse` alive.
4. `chrome.storage.local` promise style (`await chrome.storage.local.get(...)`).
5. Guard against double script injection (5.0) and concurrent captures.
6. Every user-visible failure produces a visible message (toast/notification/status), never a
   silent console error.
7. No `innerHTML` with unsanitized remote content in EXTENSION pages, except the captured page
   inside the iframe (that is by design the page's own content, scripts stripped) and
   editor-sanitized annotation HTML.
8. JS: modern but no modules in content scripts (single IIFE file); annotator/popup files are
   classic scripts sharing globals (`SFPEditor`, `SFPExporter`) — attach to `window`.
9. Comments: brief, only where behavior is non-obvious (escaping, splitText order, CORS fallback).
10. Sizes: keep each file self-contained; no dead code or TODO stubs — everything fully implemented.

## 14. Requirements traceability (for the final audit)

| # | User requirement | Where |
|---|---|---|
| R1 | Capture what user currently sees in the tab | capture.js (form state, canvas, currentSrc, scroll pos) |
| R2 | Single HTML file viewable fully offline | capture.js inlining + exporter.js standalone build |
| R3 | Download/inline all CSS + encode images/resources base64 | capture.js §5.3–5.4 |
| R4 | Extension named "NoteFreeze" | manifest.json |
| R5 | Popup: capture button + start annotating | popup/ |
| R6 | Popup: 5 light + 5 dark + Neon Noir themes | shared/themes.css + popup picker |
| R7 | Ctrl+Shift+Y captures & annotates | manifest commands + background.js |
| R8 | Freeze page → capture → offline data → save single HTML → new annotator tab | capture.js + background.js + annotator/ |
| R9 | Hover/highlight text → floating "RichText Annotation here" button | annotator.js §9.3 |
| R10 | Button → fullscreen panel with 10% margin | editor.js §10.1 (inset:10%) |
| R11 | Word-like ribbon, rich-text-applicable controls only | editor.js §10.2 |
| R12 | Paste rich text, click Save, embed to highlighted text | editor.js + annotator.js §9.6 |
| R13 | Save generates single HTML file | exportAndDownload + autodownload default ON |
| R14 | Exported file: click highlight → popup shows embedded rich text | exporter.js viewer runtime §11 |
