/*
 * NoteFreeze — annotator/editor.js
 * Word-style rich-text editor panel rendered into the annotator document.
 * Exposes window.SFPEditor { open, close, sanitizeHTML }. Classic script per SPEC §13.8.
 */
(function () {
  'use strict';
  if (window.SFPEditor) return;

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const FONTS = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Garamond',
    'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact', 'system-ui'];
  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
  const TEXT_COLORS = ['#000000', '#434343', '#666666', '#999999', '#ffffff', '#e03131',
    '#f76707', '#f59f00', '#2f9e44', '#0ca678', '#1971c2', '#6741d9', '#c2255c', '#795548'];
  const HL_COLORS = ['#ffff00', '#a9f548', '#4dd0e1', '#ff8a65', '#f48fb1', '#b39ddb',
    '#ffd54f', '#80cbc4', '#e0e0e0', '#c5e1a5'];
  const SYMBOLS = ['—', '–', '…', '©', '®', '™', '°', '±', '×', '÷', '≠', '≤', '≥',
    '←', '→', '↑', '↓', '•', '§', '¶', '€', '£', '¥', '¢', 'α', 'β'];
  const BLOCK_SEL = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,pre';
  const KILL_SEL = 'script,style,iframe,frame,object,embed,link,meta,base,input,button,select,textarea,video,audio,source,template';

  let st = null; // state of the currently open editor (null when closed)

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function escHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'sfp-ed-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.classList.add('sfp-ed-toast-out');
      setTimeout(() => t.remove(), 400);
    }, 2200);
  }

  /* ------------------------------------------------------------------ */
  /* sanitizeHTML (SPEC §10.4)                                           */
  /* ------------------------------------------------------------------ */

  function sanitizeHTML(html) {
    const doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
    doc.querySelectorAll('svg use').forEach((n) => n.remove());
    // Unwrap forms (keep children), then remove disallowed elements entirely.
    doc.querySelectorAll('form').forEach((f) => {
      while (f.firstChild) f.parentNode.insertBefore(f.firstChild, f);
      f.remove();
    });
    doc.querySelectorAll(KILL_SEL).forEach((n) => n.remove());
    doc.body.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value).trim();
        if (/^on/.test(name) || name === 'srcdoc' || name === 'formaction' ||
            name === 'nonce' || name === 'integrity') {
          el.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href' || name === 'xlink:href') {
          if (!/^(https?:|mailto:|#)/i.test(value)) el.removeAttribute(attr.name);
        } else if (name === 'src') {
          if (!/^(data:|https?:)/i.test(value)) el.removeAttribute(attr.name);
        }
      }
    });
    return doc.body.innerHTML;
  }

  /* ------------------------------------------------------------------ */
  /* SVG glyphs for list / alignment / indent buttons                    */
  /* ------------------------------------------------------------------ */

  function svgLines(align) {
    const widths = align === 'full' ? [16, 16, 16, 16] : [16, 10, 16, 10];
    let out = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">';
    for (let i = 0; i < 4; i++) {
      const w = widths[i];
      let x = 0;
      if (align === 'center') x = (16 - w) / 2;
      else if (align === 'right') x = 16 - w;
      const y = 2.5 + i * 3.6;
      out += '<line x1="' + x + '" y1="' + y + '" x2="' + (x + w) + '" y2="' + y +
        '" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
    }
    return out + '</svg>';
  }

  function svgList(ordered) {
    let out = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">';
    for (let i = 0; i < 3; i++) {
      const y = 3.2 + i * 4.6;
      out += '<line x1="6" y1="' + y + '" x2="15.5" y2="' + y +
        '" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
      if (ordered) {
        out += '<text x="0" y="' + (y + 2) + '" font-size="5.4" fill="currentColor" font-family="monospace">' + (i + 1) + '.</text>';
      } else {
        out += '<circle cx="2.2" cy="' + y + '" r="1.5" fill="currentColor"/>';
      }
    }
    return out + '</svg>';
  }

  function svgIndent(isOutdent) {
    const arrow = isOutdent
      ? '<path d="M13 8 H4 M7 5 L4 8 L7 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M3 8 H12 M9 5 L12 8 L9 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
    return '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
      '<line x1="0" y1="2.5" x2="16" y2="2.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
      '<line x1="0" y1="13.5" x2="16" y2="13.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
      arrow + '</svg>';
  }

  /* ------------------------------------------------------------------ */
  /* Panel markup                                                        */
  /* ------------------------------------------------------------------ */

  function swatchesHTML(kind, colors, withNone, customDefault) {
    let s = '<div class="sfp-ed-swatches">';
    if (withNone) {
      s += '<button type="button" class="sfp-ed-swatch sfp-ed-swatch-none" data-kind="' + kind +
        '" data-swatch="transparent" title="No color"></button>';
    }
    colors.forEach((c) => {
      s += '<button type="button" class="sfp-ed-swatch" data-kind="' + kind + '" data-swatch="' + c +
        '" style="background:' + c + '" title="' + c + '"></button>';
    });
    s += '</div><label class="sfp-ed-custom">Custom ' +
      '<input type="color" data-colorkind="' + kind + '" value="' + customDefault + '"></label>';
    return s;
  }

  function buildPanelHTML(mode) {
    const fontOptions = '<option value="" hidden></option>' +
      FONTS.map((f) => '<option value="' + escHTML(f) + '">' + escHTML(f) + '</option>').join('');
    const sizeOptions = '<option value="" hidden></option>' +
      SIZES.map((s) => '<option value="' + s + '">' + s + '</option>').join('');
    const symButtons = SYMBOLS.map((s) =>
      '<button type="button" class="sfp-ed-btn sfp-ed-sym" data-sym="' + escHTML(s) + '" title="Insert ' + escHTML(s) + '">' + escHTML(s) + '</button>').join('');
    let gridCells = '';
    for (let r = 1; r <= 8; r++) {
      for (let c = 1; c <= 8; c++) {
        gridCells += '<button type="button" class="sfp-ed-cell" data-r="' + r + '" data-c="' + c + '"></button>';
      }
    }
    const deleteBtn = mode === 'edit'
      ? '<button type="button" class="sfp-ed-btn sfp-ed-delbtn" data-act="delete" title="Delete this annotation">🗑 Delete</button>'
      : '';

    return '' +
    '<div class="sfp-ed-panel" role="dialog" aria-modal="true" aria-label="Rich Text Annotation">' +
      '<div class="sfp-ed-titlebar">' +
        '<span class="sfp-ed-titletext">Rich Text Annotation</span>' +
        '<button type="button" class="sfp-ed-x" data-act="close" title="Close (Esc)">✖</button>' +
      '</div>' +

      '<div class="sfp-ed-quick">' +
        '<button type="button" class="sfp-ed-btn sfp-ed-savebtn" data-act="save" title="Save (Ctrl+S)">💾 Save</button>' +
        '<button type="button" class="sfp-ed-btn" data-cmd="undo" title="Undo (Ctrl+Z)">↶</button>' +
        '<button type="button" class="sfp-ed-btn" data-cmd="redo" title="Redo (Ctrl+Y)">↷</button>' +
        deleteBtn +
      '</div>' +

      '<div class="sfp-ed-tabstrip">' +
        '<button type="button" class="sfp-ed-tab sfp-ed-on" data-tab="home">Home</button>' +
        '<button type="button" class="sfp-ed-tab" data-tab="insert">Insert</button>' +
      '</div>' +

      '<div class="sfp-ed-ribbon">' +

        /* ---------------- HOME ---------------- */
        '<div class="sfp-ed-pane" data-pane="home">' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody">' +
              '<button type="button" class="sfp-ed-btn sfp-ed-big" data-act="paste" title="Paste clipboard contents">' +
                '<span class="sfp-ed-bigico">📋</span>Paste</button>' +
              '<div class="sfp-ed-col">' +
                '<button type="button" class="sfp-ed-btn sfp-ed-sm" data-cmd="cut" title="Cut (Ctrl+X)">✂ Cut</button>' +
                '<button type="button" class="sfp-ed-btn sfp-ed-sm" data-cmd="copy" title="Copy (Ctrl+C)">⧉ Copy</button>' +
              '</div>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Clipboard</div>' +
          '</div>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody sfp-ed-rows">' +
              '<div class="sfp-ed-row">' +
                '<select class="sfp-ed-select sfp-ed-fontsel" data-sel="fontname" title="Font family">' + fontOptions + '</select>' +
                '<select class="sfp-ed-select sfp-ed-sizesel" data-sel="fontsize" title="Font size (pt)">' + sizeOptions + '</select>' +
              '</div>' +
              '<div class="sfp-ed-row">' +
                '<button type="button" class="sfp-ed-btn" data-cmd="bold" data-state="bold" title="Bold (Ctrl+B)"><b>B</b></button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="italic" data-state="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="underline" data-state="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="strikeThrough" data-state="strikeThrough" title="Strikethrough"><s>S</s></button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="subscript" data-state="subscript" title="Subscript">x₂</button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="superscript" data-state="superscript" title="Superscript">x²</button>' +
                '<span class="sfp-ed-dd">' +
                  '<button type="button" class="sfp-ed-btn sfp-ed-colorbtn" data-dd="fore" title="Text color">' +
                    '<span class="sfp-ed-a">A</span><span class="sfp-ed-bar" data-bar="fore"></span></button>' +
                  '<div class="sfp-ed-pop" data-pop="fore">' + swatchesHTML('fore', TEXT_COLORS, false, '#e03131') + '</div>' +
                '</span>' +
                '<span class="sfp-ed-dd">' +
                  '<button type="button" class="sfp-ed-btn sfp-ed-colorbtn" data-dd="hilite" title="Text highlight color">' +
                    '<span class="sfp-ed-a">ab</span><span class="sfp-ed-bar sfp-ed-bar-hl" data-bar="hilite"></span></button>' +
                  '<div class="sfp-ed-pop" data-pop="hilite">' + swatchesHTML('hilite', HL_COLORS, true, '#ffff00') + '</div>' +
                '</span>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="removeFormat" title="Clear formatting">Aᵡ</button>' +
              '</div>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Font</div>' +
          '</div>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody sfp-ed-rows">' +
              '<div class="sfp-ed-row">' +
                '<button type="button" class="sfp-ed-btn" data-cmd="insertUnorderedList" data-state="insertUnorderedList" title="Bulleted list">' + svgList(false) + '</button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="insertOrderedList" data-state="insertOrderedList" title="Numbered list">' + svgList(true) + '</button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="outdent" title="Decrease indent">' + svgIndent(true) + '</button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="indent" title="Increase indent">' + svgIndent(false) + '</button>' +
                '<span class="sfp-ed-dd">' +
                  '<button type="button" class="sfp-ed-btn" data-dd="spacing" title="Line spacing">↕</button>' +
                  '<div class="sfp-ed-pop" data-pop="spacing"><div class="sfp-ed-menu">' +
                    '<button type="button" data-spacing="1">1.0</button>' +
                    '<button type="button" data-spacing="1.15">1.15</button>' +
                    '<button type="button" data-spacing="1.5">1.5</button>' +
                    '<button type="button" data-spacing="2">2.0</button>' +
                  '</div></div>' +
                '</span>' +
                '<button type="button" class="sfp-ed-btn" data-block="blockquote" title="Blockquote">❝</button>' +
              '</div>' +
              '<div class="sfp-ed-row">' +
                '<button type="button" class="sfp-ed-btn" data-cmd="justifyLeft" data-state="justifyLeft" title="Align left">' + svgLines('left') + '</button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="justifyCenter" data-state="justifyCenter" title="Align center">' + svgLines('center') + '</button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="justifyRight" data-state="justifyRight" title="Align right">' + svgLines('right') + '</button>' +
                '<button type="button" class="sfp-ed-btn" data-cmd="justifyFull" data-state="justifyFull" title="Justify">' + svgLines('full') + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Paragraph</div>' +
          '</div>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody">' +
              '<div class="sfp-ed-styles">' +
                '<button type="button" class="sfp-ed-btn sfp-ed-style" data-block="p" title="Normal text"><span class="sfp-ed-prev">Aa</span>Normal</button>' +
                '<button type="button" class="sfp-ed-btn sfp-ed-style" data-block="h1" title="Heading 1"><span class="sfp-ed-prev sfp-ed-prev-h1">Aa</span>Heading 1</button>' +
                '<button type="button" class="sfp-ed-btn sfp-ed-style" data-block="h2" title="Heading 2"><span class="sfp-ed-prev sfp-ed-prev-h2">Aa</span>Heading 2</button>' +
                '<button type="button" class="sfp-ed-btn sfp-ed-style" data-block="h3" title="Heading 3"><span class="sfp-ed-prev sfp-ed-prev-h3">Aa</span>Heading 3</button>' +
                '<button type="button" class="sfp-ed-btn sfp-ed-style" data-block="pre" title="Code block"><span class="sfp-ed-prev sfp-ed-prev-code">{ }</span>Code</button>' +
              '</div>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Styles</div>' +
          '</div>' +

        '</div>' +

        /* ---------------- INSERT ---------------- */
        '<div class="sfp-ed-pane" data-pane="insert" hidden>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody">' +
              '<span class="sfp-ed-dd">' +
                '<button type="button" class="sfp-ed-btn sfp-ed-big" data-dd="table" title="Insert table">' +
                  '<span class="sfp-ed-bigico">⊞</span>Table ▾</button>' +
                '<div class="sfp-ed-pop" data-pop="table">' +
                  '<div class="sfp-ed-grid">' + gridCells + '</div>' +
                  '<div class="sfp-ed-gridlabel">Insert Table</div>' +
                '</div>' +
              '</span>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Table</div>' +
          '</div>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody">' +
              '<div class="sfp-ed-col">' +
                '<button type="button" class="sfp-ed-btn sfp-ed-sm" data-act="link" title="Insert a hyperlink">🔗 Insert Link</button>' +
                '<button type="button" class="sfp-ed-btn sfp-ed-sm" data-cmd="unlink" title="Remove hyperlink">⊘ Remove Link</button>' +
              '</div>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Links</div>' +
          '</div>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody">' +
              '<button type="button" class="sfp-ed-btn sfp-ed-big" data-act="image" title="Insert image from file (embedded as data URI)">' +
                '<span class="sfp-ed-bigico">🖼</span>Image</button>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Media</div>' +
          '</div>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody">' +
              '<span class="sfp-ed-dd">' +
                '<button type="button" class="sfp-ed-btn sfp-ed-big" data-dd="symbols" title="Insert symbol">' +
                  '<span class="sfp-ed-bigico">Ω</span>Symbol ▾</button>' +
                '<div class="sfp-ed-pop" data-pop="symbols"><div class="sfp-ed-syms">' + symButtons + '</div></div>' +
              '</span>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Symbols</div>' +
          '</div>' +

          '<div class="sfp-ed-group">' +
            '<div class="sfp-ed-gbody">' +
              '<button type="button" class="sfp-ed-btn sfp-ed-big" data-cmd="insertHorizontalRule" title="Insert horizontal line">' +
                '<span class="sfp-ed-bigico">―</span>Horizontal Line</button>' +
            '</div>' +
            '<div class="sfp-ed-gcap">Rules</div>' +
          '</div>' +

        '</div>' +
      '</div>' +

      '<div class="sfp-ed-surfwrap">' +
        '<div class="sfp-ed-surface" contenteditable="true" spellcheck="true" ' +
          'data-placeholder="Paste or write your rich text annotation here…"></div>' +
      '</div>' +

      '<div class="sfp-ed-status">' +
        '<span class="sfp-ed-count">0 words · 0 characters</span>' +
        '<span class="sfp-ed-brand">NoteFreeze Editor</span>' +
      '</div>' +

      '<input type="file" accept="image/*" class="sfp-ed-file" multiple hidden>' +

      '<div class="sfp-ed-dlgback" hidden>' +
        '<div class="sfp-ed-dlg">' +
          '<div class="sfp-ed-dlgtitle">Insert Link</div>' +
          '<label>Text<input type="text" data-dlg="text" placeholder="Link text"></label>' +
          '<label>URL<input type="text" data-dlg="url" placeholder="https://example.com"></label>' +
          '<div class="sfp-ed-dlgbtns">' +
            '<button type="button" class="sfp-ed-btn" data-act="link-cancel">Cancel</button>' +
            '<button type="button" class="sfp-ed-btn sfp-ed-savebtn" data-act="link-ok">Insert</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ------------------------------------------------------------------ */
  /* Selection management                                                */
  /* ------------------------------------------------------------------ */

  function selectionInSurface() {
    const sel = document.getSelection();
    return !!(st && sel && sel.anchorNode && st.surface.contains(sel.anchorNode));
  }

  function restoreSel() {
    if (!st) return;
    st.surface.focus();
    const sel = document.getSelection();
    if (st.savedRange && st.surface.contains(st.savedRange.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(st.savedRange);
    } else if (!selectionInSurface()) {
      const r = document.createRange();
      r.selectNodeContents(st.surface);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      st.savedRange = r.cloneRange();
    }
  }

  function onSelectionChange() {
    if (!st) return;
    const sel = document.getSelection();
    if (sel && sel.rangeCount && st.surface.contains(sel.anchorNode)) {
      st.savedRange = sel.getRangeAt(0).cloneRange();
      updateStates();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Command execution                                                   */
  /* ------------------------------------------------------------------ */

  function exec(cmd, val) {
    restoreSel();
    try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }
    try { document.execCommand(cmd, false, val == null ? null : val); } catch (e) { /* ignore */ }
    afterEdit();
  }

  function afterEdit() {
    if (!st) return;
    const sel = document.getSelection();
    if (sel && sel.rangeCount && st.surface.contains(sel.anchorNode)) {
      st.savedRange = sel.getRangeAt(0).cloneRange();
    }
    updateStates();
    updateCounts();
    updateEmptyState();
  }

  function markDirty() {
    if (st) st.dirty = true;
  }

  function setBlock(tag) {
    restoreSel();
    let cur = '';
    try { cur = String(document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (e) { /* ignore */ }
    if (tag === 'blockquote' && cur === 'blockquote') tag = 'p'; // toggle off
    try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }
    try { document.execCommand('formatBlock', false, '<' + tag + '>'); } catch (e) { /* ignore */ }
    afterEdit();
  }

  function applyFontSize(pt) {
    restoreSel();
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return;
    if (sel.getRangeAt(0).collapsed) {
      // Collapsed caret: the font[size=7] trick produces nothing to replace, so
      // insert a styled span with a zero-width space and park the caret inside.
      const span = document.createElement('span');
      span.style.fontSize = pt + 'pt';
      span.appendChild(document.createTextNode('​'));
      sel.getRangeAt(0).insertNode(span);
      const r = document.createRange();
      r.setStart(span.firstChild, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      st.savedRange = r.cloneRange();
      markDirty();
      afterEdit();
      return;
    }
    // fontSize must run with styleWithCSS OFF so Chrome emits <font size="7">,
    // which we then swap for a pt-sized span.
    try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* ignore */ }
    try { document.execCommand('fontSize', false, '7'); } catch (e) { /* ignore */ }
    try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }
    st.surface.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = pt + 'pt';
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
    });
    markDirty();
    afterEdit();
  }

  function applyColor(kind, color) {
    const bar = st.panel.querySelector('[data-bar="' + kind + '"]');
    if (bar) bar.style.background = color === 'transparent' ? '#ffffff' : color;
    exec(kind === 'fore' ? 'foreColor' : 'hiliteColor', color);
  }

  function applySpacing(val) {
    restoreSel();
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const found = [];
    const walker = document.createTreeWalker(st.surface, NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        try {
          return n.matches(BLOCK_SEL) && range.intersectsNode(n)
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        } catch (e) { return NodeFilter.FILTER_SKIP; }
      }
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) found.push(n);
    if (!found.length) {
      // Bare text directly under the surface: give it a block first.
      try { document.execCommand('formatBlock', false, '<p>'); } catch (e) { /* ignore */ }
      const sel2 = document.getSelection();
      let el = sel2 && sel2.anchorNode;
      if (el && el.nodeType === 3) el = el.parentElement;
      const b = el && el.closest ? el.closest(BLOCK_SEL) : null;
      if (b && st.surface.contains(b)) found.push(b);
    }
    found.forEach((b) => { b.style.lineHeight = val; });
    markDirty();
    afterEdit();
  }

  /* ------------------------------------------------------------------ */
  /* Insertion helpers                                                   */
  /* ------------------------------------------------------------------ */

  function insertSanitizedHTML(html) {
    const clean = sanitizeHTML(html);
    restoreSel();
    try { document.execCommand('insertHTML', false, clean); } catch (e) { /* ignore */ }
    inlineRemoteImages();
    markDirty();
    afterEdit();
  }

  function inlineRemoteImages() {
    // Best-effort: convert pasted http(s) images to data URIs via the background
    // (bypasses CORS). Leave the original URL in place on any failure.
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const surface = st && st.surface;
    if (!surface) return;
    surface.querySelectorAll('img[src^="http"]').forEach((img) => {
      const url = img.getAttribute('src');
      try {
        chrome.runtime.sendMessage({ type: 'SFP_FETCH_RESOURCE', url: url }, (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.ok && res.dataUri && img.isConnected) {
            img.src = res.dataUri;
            if (st && st.surface.contains(img)) markDirty();
          }
        });
      } catch (e) { /* leave URL */ }
    });
  }

  function insertImageFile(fileOrBlob) {
    const fr = new FileReader();
    fr.onload = () => {
      if (!st) return;
      restoreSel();
      try { document.execCommand('insertImage', false, fr.result); } catch (e) { /* ignore */ }
      markDirty();
      afterEdit();
    };
    fr.readAsDataURL(fileOrBlob);
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type));
    if (!files.length) { toast('Please choose an image file'); return; }
    files.forEach(insertImageFile);
  }

  function insertTable(rows, cols) {
    let html = '<table style="border-collapse:collapse;width:100%;margin:8px 0"><tbody>';
    for (let r = 0; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) {
        html += '<td style="border:1px solid #b6b6b6;padding:6px 8px;vertical-align:top;min-width:2em"><br></td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    restoreSel();
    try { document.execCommand('insertHTML', false, html); } catch (e) { /* ignore */ }
    closeAllDd();
    markDirty();
    afterEdit();
  }

  /* ------------------------------------------------------------------ */
  /* Clipboard                                                           */
  /* ------------------------------------------------------------------ */

  function onPaste(e) {
    e.preventDefault();
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [];
    if (dt.items) {
      for (const it of dt.items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    if (html) {
      insertSanitizedHTML(html);
    } else if (text) {
      restoreSel();
      try { document.execCommand('insertText', false, text); } catch (err) { /* ignore */ }
      markDirty();
      afterEdit();
    } else if (files.length) {
      files.forEach(insertImageFile);
    }
  }

  function onDrop(e) {
    // Never let the browser insert unsanitized dropped HTML.
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files || []).filter((f) => /^image\//.test(f.type));
    if (files.length) {
      files.forEach(insertImageFile);
      return;
    }
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    if (html) {
      insertSanitizedHTML(html);
    } else if (text) {
      restoreSel();
      try { document.execCommand('insertText', false, text); } catch (err) { /* ignore */ }
      markDirty();
      afterEdit();
    }
  }

  async function doPasteButton() {
    restoreSel();
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes('text/html')) {
            const blob = await item.getType('text/html');
            insertSanitizedHTML(await blob.text());
            return;
          }
        }
        for (const item of items) {
          const imgType = item.types.find((tp) => tp.indexOf('image/') === 0);
          if (imgType) {
            insertImageFile(await item.getType(imgType));
            return;
          }
        }
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            const text = await blob.text();
            restoreSel();
            document.execCommand('insertText', false, text);
            markDirty();
            afterEdit();
            return;
          }
        }
        toast('Clipboard is empty — use Ctrl+V');
        return;
      }
      throw new Error('clipboard API unavailable');
    } catch (err) {
      // execCommand('paste') works in extension pages thanks to the
      // clipboardRead permission and routes through our sanitizing onPaste.
      restoreSel();
      let ok = false;
      try { ok = document.execCommand('paste'); } catch (e) { /* ignore */ }
      if (!ok) toast('Clipboard unavailable — use Ctrl+V');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Link dialog                                                         */
  /* ------------------------------------------------------------------ */

  function openLinkDialog() {
    if (!st) return;
    closeAllDd();
    st.linkRange = st.savedRange ? st.savedRange.cloneRange() : null;
    const selText = st.savedRange ? st.savedRange.toString() : '';
    st.dlgText.value = selText;
    st.dlgUrl.value = '';
    st.dlgBack.hidden = false;
    (selText ? st.dlgUrl : st.dlgText).focus();
  }

  function closeLinkDialog() {
    if (!st) return;
    st.dlgBack.hidden = true;
    restoreSel();
  }

  function linkOk() {
    if (!st) return;
    let url = st.dlgUrl.value.trim();
    const text = st.dlgText.value.trim();
    if (!url) { closeLinkDialog(); return; }
    if (!/^(https?:|mailto:|#)/i.test(url)) {
      if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(url)) url = 'mailto:' + url;
      else url = 'https://' + url.replace(/^\/+/, '');
    }
    const label = text || url;
    st.dlgBack.hidden = true;
    if (st.linkRange && st.surface.contains(st.linkRange.startContainer)) {
      st.savedRange = st.linkRange.cloneRange();
    }
    restoreSel();
    try {
      document.execCommand('insertHTML', false,
        '<a href="' + escHTML(url) + '">' + escHTML(label) + '</a>');
    } catch (e) { /* ignore */ }
    markDirty();
    afterEdit();
  }

  /* ------------------------------------------------------------------ */
  /* Dropdowns                                                           */
  /* ------------------------------------------------------------------ */

  function toggleDd(name, trigger) {
    if (!st) return;
    if (st.openDd === name) { closeAllDd(); return; }
    closeAllDd();
    const pop = st.panel.querySelector('[data-pop="' + name + '"]');
    if (!pop) return;
    pop.classList.add('sfp-ed-open');
    trigger.classList.add('sfp-ed-on');
    // Fixed positioning so the ribbon's overflow never clips the popup.
    pop.style.left = '0px';
    pop.style.top = '0px';
    const tr = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = Math.min(tr.left, window.innerWidth - pw - 8);
    let top = tr.bottom + 4;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, tr.top - ph - 4);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = top + 'px';
    st.openDd = name;
    st.openDdTrigger = trigger;
  }

  function closeAllDd() {
    if (!st) return;
    st.panel.querySelectorAll('.sfp-ed-pop.sfp-ed-open').forEach((p) => p.classList.remove('sfp-ed-open'));
    if (st.openDdTrigger) st.openDdTrigger.classList.remove('sfp-ed-on');
    st.openDd = null;
    st.openDdTrigger = null;
  }

  /* ------------------------------------------------------------------ */
  /* UI state                                                            */
  /* ------------------------------------------------------------------ */

  function updateStates() {
    if (!st) return;
    const inside = selectionInSurface();
    st.stateBtns.forEach((b) => {
      let on = false;
      if (inside) {
        try { on = document.queryCommandState(b.dataset.state); } catch (e) { /* ignore */ }
      }
      b.classList.toggle('sfp-ed-on', on);
    });
    let block = '';
    if (inside) {
      try { block = String(document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (e) { /* ignore */ }
    }
    st.blockBtns.forEach((b) => {
      const v = b.dataset.block;
      const on = inside && (v === block || (v === 'p' && (block === '' || block === 'div' || block === 'p')));
      b.classList.toggle('sfp-ed-on', on);
    });
    if (inside) {
      try {
        const raw = String(document.queryCommandValue('fontName') || '');
        const fn = raw.replace(/["']/g, '').split(',')[0].trim().toLowerCase();
        const hit = FONTS.find((f) => f.toLowerCase() === fn);
        st.fontSel.value = hit || '';
      } catch (e) { /* ignore */ }
      try {
        const sel = document.getSelection();
        let el = sel && sel.focusNode;
        if (el && el.nodeType === 3) el = el.parentElement;
        if (el && el.nodeType === 1 && st.surface.contains(el)) {
          const pt = Math.round(parseFloat(getComputedStyle(el).fontSize) * 0.75);
          st.sizeSel.value = SIZES.indexOf(pt) >= 0 ? String(pt) : '';
        }
      } catch (e) { /* ignore */ }
    }
  }

  function updateCounts() {
    if (!st) return;
    const text = st.surface.textContent || '';
    const words = (text.trim().match(/\S+/g) || []).length;
    st.countEl.textContent = words + ' word' + (words === 1 ? '' : 's') +
      ' · ' + text.length + ' character' + (text.length === 1 ? '' : 's');
  }

  function isEmptyContent() {
    return !!st && !st.surface.textContent.replace(/​/g, '').trim() &&
      !st.surface.querySelector('img,table,hr');
  }

  function updateEmptyState() {
    if (!st) return;
    st.surface.classList.toggle('sfp-ed-empty', isEmptyContent());
  }

  function switchTab(name) {
    if (!st) return;
    closeAllDd();
    st.panel.querySelectorAll('.sfp-ed-tab').forEach((t) => {
      t.classList.toggle('sfp-ed-on', t.dataset.tab === name);
    });
    st.panel.querySelectorAll('.sfp-ed-pane').forEach((p) => {
      p.hidden = p.dataset.pane !== name;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Save / cancel / delete                                              */
  /* ------------------------------------------------------------------ */

  // Recompress a raster-image data: URI to WebP if smaller. Pasting content into
  // an annotation (esp. from the captured page) can embed several full-size PNGs
  // — the capture engine optimizes images, so the editor must too. Always resolves.
  const ANN_RASTER_RE = /data:image\/(?:png|jpe?g|webp|bmp);base64,[A-Za-z0-9+/=]+/gi;
  function recompressAnnImage(dataUri) {
    return new Promise((resolve) => {
      try {
        if (typeof dataUri !== 'string' || dataUri.length < 12 * 1024) { resolve(dataUri); return; }
        const img = new Image();
        img.onload = () => {
          try {
            const w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) { resolve(dataUri); return; }
            const scale = Math.min(1, 1600 / Math.max(w, h));
            const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
            const c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            const cx = c.getContext('2d');
            if (!cx) { resolve(dataUri); return; }
            cx.drawImage(img, 0, 0, cw, ch);
            const webp = c.toDataURL('image/webp', 0.82);
            resolve(webp && webp.indexOf('data:image/webp') === 0 && webp.length < dataUri.length ? webp : dataUri);
          } catch (_) { resolve(dataUri); }
        };
        img.onerror = () => resolve(dataUri);
        img.src = dataUri;
      } catch (_) { resolve(dataUri); }
    });
  }

  async function optimizeAnnotationImages(html) {
    if (!html || html.indexOf('data:image/') === -1) return html;
    const uniq = Array.from(new Set(html.match(ANN_RASTER_RE) || []));
    if (!uniq.length) return html;
    const map = new Map();
    await Promise.all(uniq.map(async (d) => { map.set(d, await recompressAnnImage(d)); }));
    return html.replace(ANN_RASTER_RE, (d) => map.get(d) || d);
  }

  async function doSave() {
    if (!st) return;
    const opts = st.opts;
    if (st.mode === 'create' && isEmptyContent()) {
      close();
      toast('Empty annotation discarded');
      if (opts.onCancel) { try { opts.onCancel(); } catch (e) { /* ignore */ } }
      return;
    }
    let html = sanitizeHTML(st.surface.innerHTML);
    // Optimize embedded images (respecting the Compact setting) before saving.
    try {
      const s = await chrome.storage.local.get({ sfp_compact: true });
      if (s.sfp_compact !== false) html = await optimizeAnnotationImages(html);
    } catch (_) { /* keep sanitized html as-is */ }
    try {
      if (opts.onSave) opts.onSave(html);
    } finally {
      close();
    }
  }

  function requestCancel() {
    if (!st) return;
    if (st.dirty && !confirm('Discard this annotation?')) return;
    const opts = st.opts;
    close();
    if (opts.onCancel) { try { opts.onCancel(); } catch (e) { /* ignore */ } }
  }

  function doDelete() {
    if (!st) return;
    const cb = st.opts.onDelete;
    close();
    if (cb) { try { cb(); } catch (e) { /* ignore */ } }
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */

  function onPanelMousedown(e) {
    if (!st) return;
    if (!e.target.closest('.sfp-ed-dd')) closeAllDd();
    const btn = e.target.closest('button');
    // Keep the surface selection alive when pressing ribbon buttons
    // (dialog buttons excluded — the dialog manages its own focus).
    if (btn && !btn.closest('.sfp-ed-dlg')) e.preventDefault();
  }

  function onPanelClick(e) {
    if (!st) return;
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.tab) { switchTab(btn.dataset.tab); return; }
    if (btn.dataset.dd) { toggleDd(btn.dataset.dd, btn); return; }
    if (btn.dataset.cmd) { closeAllDd(); exec(btn.dataset.cmd); markDirtyForEditCmd(btn.dataset.cmd); return; }
    if (btn.dataset.block) { closeAllDd(); setBlock(btn.dataset.block); markDirty(); return; }
    if (btn.dataset.swatch) { applyColor(btn.dataset.kind, btn.dataset.swatch); markDirty(); closeAllDd(); return; }
    if (btn.dataset.spacing) { applySpacing(btn.dataset.spacing); closeAllDd(); return; }
    if (btn.dataset.sym) {
      restoreSel();
      try { document.execCommand('insertText', false, btn.dataset.sym); } catch (err) { /* ignore */ }
      closeAllDd();
      markDirty();
      afterEdit();
      return;
    }
    if (btn.classList.contains('sfp-ed-cell')) {
      insertTable(parseInt(btn.dataset.r, 10), parseInt(btn.dataset.c, 10));
      return;
    }
    switch (btn.dataset.act) {
      case 'save': doSave(); break;
      case 'close': requestCancel(); break;
      case 'delete': doDelete(); break;
      case 'paste': doPasteButton(); break;
      case 'image': st.fileInput.click(); break;
      case 'link': openLinkDialog(); break;
      case 'link-ok': linkOk(); break;
      case 'link-cancel': closeLinkDialog(); break;
    }
  }

  function markDirtyForEditCmd(cmd) {
    if (cmd !== 'copy') markDirty(); // copy is the only non-mutating command here
  }

  function onPanelChange(e) {
    if (!st) return;
    const t = e.target;
    if (t.matches('[data-sel="fontname"]')) {
      if (t.value) { exec('fontName', t.value); markDirty(); }
    } else if (t.matches('[data-sel="fontsize"]')) {
      if (t.value) applyFontSize(parseInt(t.value, 10));
    } else if (t.classList.contains('sfp-ed-file')) {
      handleFiles(t.files);
      t.value = '';
    }
  }

  function onPanelInput(e) {
    if (!st) return;
    const t = e.target;
    if (t.matches('input[type="color"][data-colorkind]')) {
      applyColor(t.dataset.colorkind, t.value);
      markDirty();
    }
  }

  function onSurfaceInput() {
    markDirty();
    updateCounts();
    updateEmptyState();
  }

  function onGridHover(e) {
    if (!st) return;
    const cell = e.target.closest('.sfp-ed-cell');
    if (!cell) return;
    const r = parseInt(cell.dataset.r, 10);
    const c = parseInt(cell.dataset.c, 10);
    st.panel.querySelectorAll('.sfp-ed-cell').forEach((el) => {
      el.classList.toggle('sfp-ed-sel',
        parseInt(el.dataset.r, 10) <= r && parseInt(el.dataset.c, 10) <= c);
    });
    const label = st.panel.querySelector('.sfp-ed-gridlabel');
    if (label) label.textContent = r + ' × ' + c + ' Table';
  }

  function onDocKeydown(e) {
    if (!st) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      e.stopPropagation();
      doSave();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!st.dlgBack.hidden) { closeLinkDialog(); return; }
      if (st.openDd) { closeAllDd(); return; }
      requestCancel();
      return;
    }
    if (e.key === 'Enter' && !st.dlgBack.hidden && e.target.closest && e.target.closest('.sfp-ed-dlg')) {
      e.preventDefault();
      e.stopPropagation();
      linkOk();
    }
  }

  /* ------------------------------------------------------------------ */
  /* open / close                                                        */
  /* ------------------------------------------------------------------ */

  function open(options) {
    if (st) close(); // replace any existing editor silently
    const opts = options || {};
    const mode = opts.mode === 'edit' ? 'edit' : 'create';

    const backdrop = document.createElement('div');
    backdrop.className = 'sfp-ed-backdrop';
    if (opts.theme) backdrop.dataset.theme = opts.theme;
    backdrop.innerHTML = buildPanelHTML(mode);
    document.body.appendChild(backdrop);

    const panel = backdrop.querySelector('.sfp-ed-panel');
    st = {
      opts: opts,
      mode: mode,
      dirty: false,
      savedRange: null,
      linkRange: null,
      openDd: null,
      openDdTrigger: null,
      backdrop: backdrop,
      panel: panel,
      surface: panel.querySelector('.sfp-ed-surface'),
      fileInput: panel.querySelector('.sfp-ed-file'),
      countEl: panel.querySelector('.sfp-ed-count'),
      fontSel: panel.querySelector('[data-sel="fontname"]'),
      sizeSel: panel.querySelector('[data-sel="fontsize"]'),
      dlgBack: panel.querySelector('.sfp-ed-dlgback'),
      dlgText: panel.querySelector('[data-dlg="text"]'),
      dlgUrl: panel.querySelector('[data-dlg="url"]'),
      stateBtns: Array.from(panel.querySelectorAll('[data-state]')),
      blockBtns: Array.from(panel.querySelectorAll('[data-block]'))
    };

    // Backdrop click (outside the panel) behaves like Cancel.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) requestCancel();
    });
    panel.addEventListener('mousedown', onPanelMousedown);
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('change', onPanelChange);
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('scroll', closeAllDd, true);
    panel.querySelector('.sfp-ed-grid').addEventListener('mouseover', onGridHover);
    st.surface.addEventListener('paste', onPaste);
    st.surface.addEventListener('drop', onDrop);
    st.surface.addEventListener('dragover', (e) => e.preventDefault());
    st.surface.addEventListener('input', onSurfaceInput);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onDocKeydown, true);

    try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* ignore */ }
    st.surface.innerHTML = sanitizeHTML(opts.initialHTML || '');
    updateCounts();
    updateEmptyState();

    // Focus with the caret at the end of any existing content.
    st.surface.focus();
    const r = document.createRange();
    r.selectNodeContents(st.surface);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    st.savedRange = r.cloneRange();
    updateStates();
  }

  function close() {
    if (!st) return;
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('keydown', onDocKeydown, true);
    st.backdrop.remove();
    st = null;
  }

  window.SFPEditor = { open: open, close: close, sanitizeHTML: sanitizeHTML };
})();
