/* NoteFreeze — annotator shell (SPEC §9).
   Consumes window.SFPEditor (§10) and window.SFPExporter (§11); never redefines them. */
(() => {
  'use strict';

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);
  const frame = $('sfp-frame');
  const titleEl = $('sfp-title');
  const urlEl = $('sfp-url');
  const dateEl = $('sfp-date');
  const countEl = $('sfp-count');
  const themeSelect = $('sfp-theme-select');
  const autoDlBox = $('sfp-autodownload');
  const saveBtn = $('sfp-save');
  const clearBtn = $('sfp-clear');
  const errorEl = $('sfp-error');
  const errorMsgEl = $('sfp-error-msg');
  const toastEl = $('sfp-toast');

  const THEME_IDS = [
    'github-light', 'solarized-light', 'one-light', 'gruvbox-light', 'catppuccin-latte',
    'dracula', 'nord', 'solarized-dark', 'tokyo-night', 'one-dark', 'blackpink'
  ];

  // ---------- State ----------
  let captureId = null;
  let record = null;          // sfp_capture_<id> record
  let annotations = {};       // {[annId]: {id, html, createdAt, updatedAt}}
  let currentTheme = 'github-light';
  let autoDownload = true;
  let fdoc = null;            // iframe document
  let fwin = null;            // iframe window
  let frameBlobUrl = null;    // object URL backing the iframe (revoked on reload)
  let floatBtn = null;        // floating "annotate" button inside the iframe
  let uiStyle = null;         // injected <style data-sfp-ui> inside the iframe
  let pendingRange = null;    // last non-collapsed selection range (cloned)
  let editorOpen = false;
  let selDebounce = 0;
  let toastTimer = 0;

  // ---------- Small utils ----------

  function rand4() {
    return (Math.random().toString(36).slice(2) + '0000').slice(0, 4);
  }

  function newAnnId() {
    return 'a_' + Date.now() + '_' + rand4();
  }

  function cssEscape(v) {
    return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
  }

  function slugify(title) {
    let s = String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '');
    return s || 'page';
  }

  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('sfp-toast-error', !!isError);
    toastEl.hidden = false;
    void toastEl.offsetWidth; // restart the show transition after display:none
    toastEl.classList.add('sfp-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('sfp-toast-show');
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, 250);
    }, isError ? 5000 : 2600);
  }

  function errText(err) {
    return (err && err.message) ? err.message : String(err);
  }

  // ---------- Theme ----------

  function accentColor() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--sfp-accent').trim();
    return v || '#0969da';
  }

  // CSS injected into the iframe (SPEC §9.5). Highlight colors are fixed; the floating
  // button bakes in the current theme accent (no var() exists inside the captured page).
  function uiCss() {
    return [
      '.sfp-hl { background: rgba(255, 213, 0, .45); cursor: pointer; border-bottom: 2px solid rgba(230,160,0,.85); }',
      '.sfp-hl:hover { background: rgba(255, 200, 0, .65); }',
      '.sfp-hl-pending { outline: 2px dashed rgba(230,160,0,.9); }',
      '.sfp-float-btn { position: absolute; z-index: 2147483647; display: none; margin: 0; padding: 7px 14px; ' +
        'border: 0; border-radius: 999px; background: ' + accentColor() + '; color: #ffffff; ' +
        'font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; letter-spacing: .01em; ' +
        'cursor: pointer; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,.35); ' +
        'user-select: none; -webkit-user-select: none; }',
      '.sfp-float-btn:hover { filter: brightness(1.08); }',
      '.sfp-float-btn:active { transform: scale(.97); }'
    ].join('\n');
  }

  function applyTheme(id) {
    if (THEME_IDS.indexOf(id) === -1) id = 'github-light';
    currentTheme = id;
    document.documentElement.dataset.theme = id;
    if (themeSelect.value !== id) themeSelect.value = id;
    if (uiStyle) uiStyle.textContent = uiCss(); // refresh baked-in accent for the float button
  }

  // ---------- Boot ----------

  function showFatal(msg) {
    frame.hidden = true;
    errorEl.hidden = false;
    errorMsgEl.textContent = msg;
    titleEl.textContent = 'Capture not found';
    urlEl.textContent = '';
    urlEl.removeAttribute('href');
    dateEl.textContent = '';
    saveBtn.disabled = true;
    clearBtn.disabled = true;
    document.title = 'Annotate — capture not found';
  }

  async function boot() {
    const settings = await chrome.storage.local.get({ sfp_theme: 'github-light', sfp_autodownload: true });
    applyTheme(settings.sfp_theme);
    autoDownload = settings.sfp_autodownload !== false;
    autoDlBox.checked = autoDownload;

    captureId = new URLSearchParams(location.search).get('id');
    if (!captureId) {
      showFatal('The annotator was opened without a capture id.');
      return;
    }

    const key = 'sfp_capture_' + captureId;
    const got = await chrome.storage.local.get(key);
    record = got[key];
    if (!record || !record.html) {
      showFatal('This capture could not be found. It may have been deleted, or trimmed from history (only the 20 most recent captures are kept).');
      return;
    }

    annotations = (record.annotations && typeof record.annotations === 'object') ? record.annotations : {};
    record.annotations = annotations;

    const title = record.title || 'Untitled page';
    document.title = 'Annotate — ' + title;
    titleEl.textContent = title;
    titleEl.title = title;
    if (record.url) {
      urlEl.textContent = record.url;
      urlEl.href = record.url;
      urlEl.title = record.url;
    }
    const d = record.capturedAt ? new Date(record.capturedAt) : null;
    dateEl.textContent = (d && !isNaN(d.getTime())) ? 'Captured ' + d.toLocaleString() : '';
    updateCount();

    frame.addEventListener('load', onFrameLoad);
    loadIntoFrame(record.html);
  }

  // Load the captured document via a Blob URL rather than srcdoc. srcdoc forces
  // Chrome to escape and parse the ENTIRE document as one HTML attribute value,
  // which is slow and mangles/truncates layout for large captures (tens of MB).
  // A blob: URL created in this (extension) origin is same-origin, so the iframe
  // document stays reachable for annotation wiring. Falls back to srcdoc.
  function loadIntoFrame(html) {
    if (frameBlobUrl) {
      try { URL.revokeObjectURL(frameBlobUrl); } catch (_) {}
      frameBlobUrl = null;
    }
    try {
      frameBlobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      frame.removeAttribute('srcdoc');
      frame.src = frameBlobUrl;
    } catch (_) {
      frame.removeAttribute('src');
      frame.srcdoc = html; // last-resort fallback
    }
  }

  function updateCount() {
    const n = Object.keys(annotations).length;
    countEl.textContent = String(n);
    countEl.title = n + (n === 1 ? ' annotation' : ' annotations');
  }

  // ---------- Iframe wiring ----------

  function onFrameLoad() {
    fdoc = frame.contentDocument;
    fwin = frame.contentWindow;
    if (!fdoc || !fdoc.documentElement || fdoc.__sfpWired__) return;
    fdoc.__sfpWired__ = true; // double-injection guard (per document instance)

    // Defensive: drop any stale UI remnants before injecting fresh ones.
    fdoc.querySelectorAll('[data-sfp-ui]').forEach((el) => el.remove());

    // Match the iframe's own backdrop to the captured page's background so a
    // fast scroll can't flash the iframe's default white before the page's
    // (often dark) content repaints. Also pin it on <html> so the full scroll
    // height is painted, not just the body box.
    try {
      const TRANSPARENT = ['', 'transparent', 'rgba(0, 0, 0, 0)'];
      let bg = fwin.getComputedStyle(fdoc.documentElement).backgroundColor;
      if (TRANSPARENT.indexOf(bg) !== -1 && fdoc.body) {
        bg = fwin.getComputedStyle(fdoc.body).backgroundColor;
      }
      if (TRANSPARENT.indexOf(bg) === -1) {
        frame.style.backgroundColor = bg;
        if (TRANSPARENT.indexOf(fdoc.documentElement.style.backgroundColor) !== -1) {
          fdoc.documentElement.style.backgroundColor = bg;
        }
      }
    } catch (_) {}

    uiStyle = fdoc.createElement('style');
    uiStyle.setAttribute('data-sfp-ui', '');
    uiStyle.textContent = uiCss();
    (fdoc.head || fdoc.documentElement).appendChild(uiStyle);

    floatBtn = fdoc.createElement('button');
    floatBtn.type = 'button';
    floatBtn.className = 'sfp-float-btn';
    floatBtn.setAttribute('data-sfp-ui', '');
    floatBtn.textContent = '✏️ RichText Annotation here';
    // preventDefault on mousedown keeps the text selection alive through the click.
    floatBtn.addEventListener('mousedown', (e) => e.preventDefault());
    floatBtn.addEventListener('click', onFloatClick);
    (fdoc.body || fdoc.documentElement).appendChild(floatBtn);

    fdoc.addEventListener('mouseup', checkSelectionSoon);
    fdoc.addEventListener('keyup', checkSelectionSoon);
    fdoc.addEventListener('selectionchange', () => {
      clearTimeout(selDebounce);
      selDebounce = setTimeout(checkSelection, 150);
    });
    fwin.addEventListener('scroll', hideFloatBtn, { capture: true, passive: true });
    fdoc.addEventListener('click', onFrameClick);
    // Scripts are stripped from captures, but a plain <form action> could still submit.
    fdoc.addEventListener('submit', (e) => e.preventDefault(), true);

    const sx = record.scrollX || 0, sy = record.scrollY || 0;
    fwin.scrollTo(sx, sy);
    requestAnimationFrame(() => {
      try {
        fwin.scrollTo(sx, sy);
        restoreInnerScrolls(fdoc);
      } catch (_) {}
    });
  }

  // Re-apply captured scroll offsets of inner scroll containers (recorded by the
  // capture engine as data attributes — scrollTop/scrollLeft don't serialize).
  function restoreInnerScrolls(doc) {
    doc.querySelectorAll('[data-sfp-scroll-top], [data-sfp-scroll-left]').forEach((el) => {
      const st = parseInt(el.getAttribute('data-sfp-scroll-top') || '0', 10);
      const sl = parseInt(el.getAttribute('data-sfp-scroll-left') || '0', 10);
      try {
        if (st) el.scrollTop = st;
        if (sl) el.scrollLeft = sl;
      } catch (_) {}
    });
  }

  // ---------- Selection -> floating button (SPEC §9.3) ----------

  function checkSelectionSoon() {
    // mouseup/keyup: check immediately (selection is settled by then).
    checkSelection();
  }

  function checkSelection() {
    if (!fwin || !floatBtn || editorOpen) return;
    let sel = null;
    try { sel = fwin.getSelection(); } catch (_) { return; }
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !String(sel).trim()) {
      hideFloatBtn();
      return;
    }
    pendingRange = sel.getRangeAt(0).cloneRange();
    positionFloatBtn(sel.getRangeAt(sel.rangeCount - 1));
  }

  function positionFloatBtn(range) {
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hideFloatBtn(); return; }

    // Show hidden first so offsetWidth/Height are measurable for clamping.
    floatBtn.style.display = 'inline-block';
    floatBtn.style.visibility = 'hidden';
    const bw = floatBtn.offsetWidth || 220;
    const bh = floatBtn.offsetHeight || 32;
    const sx = fwin.scrollX, sy = fwin.scrollY;
    const vw = fdoc.documentElement.clientWidth || fwin.innerWidth;
    const vh = fwin.innerHeight;

    // Anchor at the selection END rect (document coords = viewport rect + scroll offsets).
    let left = sx + rect.right - bw / 2;
    let top = sy + rect.bottom + 8;

    left = Math.max(sx + 6, Math.min(left, sx + vw - bw - 6));
    if (top + bh > sy + vh - 6) top = sy + rect.top - bh - 8; // flip above if it would overflow
    top = Math.max(sy + 6, Math.min(top, sy + vh - bh - 6));

    floatBtn.style.left = Math.round(left) + 'px';
    floatBtn.style.top = Math.round(top) + 'px';
    floatBtn.style.visibility = 'visible';
  }

  function hideFloatBtn() {
    if (floatBtn) floatBtn.style.display = 'none';
    pendingRange = null;
  }

  function onFloatClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (editorOpen) return;

    // Capture the Range BEFORE opening the editor (SPEC §9.3).
    let range = null;
    try {
      const sel = fwin.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) range = sel.getRangeAt(0).cloneRange();
    } catch (_) {}
    if (!range) range = pendingRange;
    if (!range || range.collapsed || !String(range).trim()) { hideFloatBtn(); return; }

    const annId = newAnnId();
    let spans = [];
    try { spans = wrapRange(range, annId); } catch (_) { spans = []; }
    if (!spans.length) {
      hideFloatBtn();
      toast('Could not highlight that selection — try selecting plain text.', true);
      return;
    }
    spans.forEach((s) => s.classList.add('sfp-hl-pending'));

    try { fwin.getSelection().removeAllRanges(); } catch (_) {}
    hideFloatBtn();
    openEditorForCreate(annId);
  }

  // ---------- Highlight wrapping (SPEC §9.4) ----------

  function inUI(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('[data-sfp-ui]'));
  }

  // Wrapping text inside these would corrupt the page (CSS text, form controls, <title>).
  const NO_WRAP_PARENTS = /^(STYLE|SCRIPT|NOSCRIPT|TITLE|TEXTAREA|SELECT|OPTION)$/;

  function wrappable(textNode) {
    const p = textNode.parentElement;
    return !(p && NO_WRAP_PARENTS.test(p.tagName)) && !inUI(textNode);
  }

  // Wrap every text node intersecting the range in <span class="sfp-hl" data-sfp-id="annId">.
  // Returns the created spans (caller may add sfp-hl-pending).
  function wrapRange(range, annId) {
    const created = [];

    const wrapNode = (textNode) => {
      const span = fdoc.createElement('span');
      span.className = 'sfp-hl';
      span.setAttribute('data-sfp-id', annId);
      textNode.parentNode.insertBefore(span, textNode);
      span.appendChild(textNode);
      created.push(span);
    };

    const sc = range.startContainer, so = range.startOffset;
    const ec = range.endContainer, eo = range.endOffset;

    // Single-text-node case: both boundaries live in the same text node.
    if (sc === ec && sc.nodeType === Node.TEXT_NODE) {
      if (!wrappable(sc)) return created;
      let node = sc;
      if (eo < node.data.length) node.splitText(eo);      // detach the right remainder first
      if (so > 0) node = node.splitText(so);              // node is now the selected middle
      if (node.data.length) wrapNode(node);
      return created;
    }

    // Collect intersecting text nodes BEFORE mutating (splitText would corrupt the walk).
    const cac = range.commonAncestorContainer;
    const root = cac.nodeType === Node.TEXT_NODE ? cac.parentNode : cac;
    const walker = fdoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        (range.intersectsNode(n) && wrappable(n)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (let node of nodes) {
      // Trim boundary nodes: split the end node keeping its left part, then the start
      // node keeping its right part (a node is never both here — that case returned above).
      if (node === ec && eo < node.data.length) node.splitText(eo);
      if (node === sc && so > 0) node = node.splitText(so);
      if (node.data.length) wrapNode(node);
    }
    return created;
  }

  function unwrapSpan(span) {
    const parent = span.parentNode;
    if (!parent) return null;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    return parent;
  }

  function unwrapAnnotation(annId) {
    if (!fdoc) return;
    const parents = new Set();
    fdoc.querySelectorAll('.sfp-hl[data-sfp-id="' + cssEscape(annId) + '"]').forEach((span) => {
      const p = unwrapSpan(span);
      if (p) parents.add(p);
    });
    parents.forEach((p) => { try { p.normalize(); } catch (_) {} });
  }

  function clearPending(annId) {
    if (!fdoc) return;
    fdoc.querySelectorAll('.sfp-hl-pending[data-sfp-id="' + cssEscape(annId) + '"]')
      .forEach((s) => s.classList.remove('sfp-hl-pending'));
  }

  // ---------- Annotation lifecycle (SPEC §9.6) ----------

  // Editor already sanitizes; this only decides "is there anything worth keeping".
  function isEmptyAnnotationHTML(html) {
    if (!html || !html.trim()) return true;
    const t = document.createElement('template');
    t.innerHTML = html;
    if (t.content.textContent.trim()) return false;
    return !t.content.querySelector('img, table, hr');
  }

  function openEditorForCreate(annId) {
    if (!window.SFPEditor) {
      unwrapAnnotation(annId);
      toast('The annotation editor failed to load.', true);
      return;
    }
    editorOpen = true;
    try {
      window.SFPEditor.open({
        initialHTML: '',
        mode: 'create',
        theme: currentTheme,
        onSave: (html) => {
          editorOpen = false;
          if (isEmptyAnnotationHTML(html)) {
            unwrapAnnotation(annId);
            toast('Empty annotation discarded');
            return;
          }
          const now = new Date().toISOString();
          annotations[annId] = { id: annId, html: html, createdAt: now, updatedAt: now };
          clearPending(annId);
          persist();
          toast('Annotation saved ✓');
          if (autoDownload) exportAndDownload();
        },
        onCancel: () => {
          editorOpen = false;
          unwrapAnnotation(annId); // create-mode cancel must leave no trace
        }
      });
    } catch (err) {
      editorOpen = false;
      unwrapAnnotation(annId);
      toast('Could not open the editor: ' + errText(err), true);
    }
  }

  function openEditorForEdit(annId) {
    if (!window.SFPEditor) {
      toast('The annotation editor failed to load.', true);
      return;
    }
    const ann = annotations[annId];
    if (!ann) return;
    editorOpen = true;
    try {
      window.SFPEditor.open({
        initialHTML: ann.html || '',
        mode: 'edit',
        theme: currentTheme,
        onSave: (html) => {
          editorOpen = false;
          if (isEmptyAnnotationHTML(html)) {
            toast('Empty content discarded — annotation unchanged', true);
            return;
          }
          ann.html = html;
          ann.updatedAt = new Date().toISOString();
          persist();
          toast('Annotation saved ✓');
          if (autoDownload) exportAndDownload();
        },
        onCancel: () => { editorOpen = false; },
        onDelete: () => {
          editorOpen = false;
          if (!confirm('Delete this annotation?')) return;
          unwrapAnnotation(annId);
          delete annotations[annId];
          persist();
          try { window.SFPEditor.close(); } catch (_) {}
          toast('Annotation deleted');
        }
      });
    } catch (err) {
      editorOpen = false;
      toast('Could not open the editor: ' + errText(err), true);
    }
  }

  function onFrameClick(e) {
    const t = e.target;
    if (floatBtn && (t === floatBtn || floatBtn.contains(t))) return;

    const hl = (t && t.closest) ? t.closest('.sfp-hl') : null; // closest(): innermost span wins
    if (hl) {
      e.preventDefault();
      e.stopPropagation();
      if (editorOpen) return;
      const annId = hl.getAttribute('data-sfp-id');
      if (annId && annotations[annId]) {
        openEditorForEdit(annId);
      } else {
        // Orphaned highlight (no stored rich text) — clean it up instead of failing silently.
        if (annId && confirm('This highlight has no annotation attached. Remove the highlight?')) {
          unwrapAnnotation(annId);
          persist();
        }
      }
      return;
    }

    // Keep the annotator on the snapshot: navigating the iframe away would orphan the session.
    const a = (t && t.closest) ? t.closest('a[href]') : null;
    if (a) {
      const href = a.getAttribute('href') || '';
      if (href && href.charAt(0) !== '#') {
        e.preventDefault();
        toast('Links are disabled while annotating — use the URL in the toolbar.');
      }
    }
  }

  async function onClearAll() {
    if (!record || !fdoc) { toast('The capture is still loading — try again in a moment.', true); return; }
    const n = Object.keys(annotations).length;
    if (!n) { toast('No annotations to clear'); return; }
    if (!confirm('Remove all ' + n + ' annotation' + (n === 1 ? '' : 's') + ' from this capture? This cannot be undone.')) return;

    // Unwrap every highlight span, including any orphaned ones.
    const parents = new Set();
    fdoc.querySelectorAll('.sfp-hl').forEach((span) => {
      const p = unwrapSpan(span);
      if (p) parents.add(p);
    });
    parents.forEach((p) => { try { p.normalize(); } catch (_) {} });

    annotations = {};
    record.annotations = annotations;
    await persist();
    toast('All annotations cleared');
  }

  // ---------- Persistence & export ----------

  async function persist() {
    if (!record || !fdoc) return;
    try {
      if (!window.SFPExporter) throw new Error('exporter unavailable');
      record.html = window.SFPExporter.serializeDoc(fdoc);
      record.annotations = annotations;
      await chrome.storage.local.set({ ['sfp_capture_' + captureId]: record });

      const got = await chrome.storage.local.get('sfp_captures_index');
      const list = Array.isArray(got.sfp_captures_index) ? got.sfp_captures_index : [];
      const entry = list.find((e) => e && e.id === captureId);
      if (entry) {
        entry.annotationCount = Object.keys(annotations).length;
        await chrome.storage.local.set({ sfp_captures_index: list });
      }
    } catch (err) {
      toast('Could not save changes: ' + errText(err), true);
    }
    updateCount();
  }

  function exportAndDownload() {
    if (!record || !fdoc) { toast('The capture is still loading — try again in a moment.', true); return; }
    if (!window.SFPExporter) {
      toast('The exporter failed to load.', true);
      return;
    }
    try {
      const html = window.SFPExporter.buildHTML({
        doc: fdoc,
        annotations: annotations,
        meta: {
          title: record.title,
          url: record.url,
          capturedAt: record.capturedAt,
          scrollX: record.scrollX || 0,
          scrollY: record.scrollY || 0
        },
        themeId: currentTheme
      });
      const filename = slugify(record.title) + '.annotated.html';
      Promise.resolve(window.SFPExporter.download(html, filename)).then(
        () => toast('Saved ' + filename + ' ✓'),
        (err) => toast('Download failed: ' + errText(err), true)
      );
    } catch (err) {
      toast('Export failed: ' + errText(err), true);
    }
  }

  // ---------- Toolbar events ----------

  themeSelect.addEventListener('change', async () => {
    applyTheme(themeSelect.value);
    try { await chrome.storage.local.set({ sfp_theme: currentTheme }); } catch (_) {}
  });

  autoDlBox.addEventListener('change', async () => {
    autoDownload = autoDlBox.checked;
    try {
      await chrome.storage.local.set({ sfp_autodownload: autoDownload });
    } catch (err) {
      toast('Could not save setting: ' + errText(err), true);
    }
  });

  saveBtn.addEventListener('click', exportAndDownload);
  clearBtn.addEventListener('click', onClearAll);

  // Ctrl/Cmd+S on the annotator page exports (the editor handles its own Ctrl+S while open).
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && !editorOpen) {
      e.preventDefault();
      exportAndDownload();
    }
  });

  window.addEventListener('resize', hideFloatBtn);

  // Stay in sync when the popup (or another annotator tab) changes settings.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sfp_theme && typeof changes.sfp_theme.newValue === 'string') {
      applyTheme(changes.sfp_theme.newValue);
    }
    if (changes.sfp_autodownload) {
      autoDownload = changes.sfp_autodownload.newValue !== false;
      autoDlBox.checked = autoDownload;
    }
  });

  boot().catch((err) => {
    showFatal('Failed to load this capture: ' + errText(err));
  });
})();
