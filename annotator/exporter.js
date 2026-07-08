/*
 * NoteFreeze — annotator/exporter.js
 * window.SFPExporter: document serializer + standalone HTML builder (embeds an
 * offline viewer runtime) + download helper. Classic script per SPEC §13.8.
 */
(function () {
  'use strict';
  if (window.SFPExporter) return;

  /* Baked palettes for the exported viewer: the exported file must not depend on
     extension CSS vars. [bg, surface, surface2, text, muted, border, accent, accentText] */
  const THEMES = {
    'github-light':     { bg: '#ffffff', surface: '#f6f8fa', surface2: '#eaeef2', text: '#1f2328', muted: '#57606a', border: '#d0d7de', accent: '#0969da', accentText: '#ffffff' },
    'solarized-light':  { bg: '#fdf6e3', surface: '#eee8d5', surface2: '#e4ddc8', text: '#586e75', muted: '#839496', border: '#d9d2bc', accent: '#268bd2', accentText: '#ffffff' },
    'one-light':        { bg: '#fafafa', surface: '#f0f0f1', surface2: '#e5e5e6', text: '#383a42', muted: '#696c77', border: '#d4d4d6', accent: '#4078f2', accentText: '#ffffff' },
    'gruvbox-light':    { bg: '#fbf1c7', surface: '#ebdbb2', surface2: '#e0cfa3', text: '#3c3836', muted: '#7c6f64', border: '#d5c4a1', accent: '#076678', accentText: '#ffffff' },
    'catppuccin-latte': { bg: '#eff1f5', surface: '#e6e9ef', surface2: '#dce0e8', text: '#4c4f69', muted: '#6c6f85', border: '#ccd0da', accent: '#8839ef', accentText: '#ffffff' },
    'dracula':          { bg: '#282a36', surface: '#44475a', surface2: '#3a3d4d', text: '#f8f8f2', muted: '#9ea0b0', border: '#5a5d72', accent: '#bd93f9', accentText: '#1e1f29' },
    'nord':             { bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', text: '#eceff4', muted: '#aeb6c3', border: '#4c566a', accent: '#88c0d0', accentText: '#2e3440' },
    'solarized-dark':   { bg: '#002b36', surface: '#073642', surface2: '#0a4250', text: '#93a1a1', muted: '#657b83', border: '#0e4a59', accent: '#268bd2', accentText: '#ffffff' },
    'tokyo-night':      { bg: '#1a1b26', surface: '#24283b', surface2: '#2f3450', text: '#c0caf5', muted: '#787fa3', border: '#3b4160', accent: '#7aa2f7', accentText: '#1a1b26' },
    'one-dark':         { bg: '#282c34', surface: '#21252b', surface2: '#323842', text: '#abb2bf', muted: '#7f848e', border: '#3e4451', accent: '#61afef', accentText: '#1e222a' },
    'blackpink':        { bg: '#0a0a0a', surface: '#16161a', surface2: '#221f26', text: '#f5e6ee', muted: '#b8a3af', border: '#3a2a33', accent: '#ff2e88', accentText: '#ffffff' }
  };

  /* ------------------------------------------------------------------ */
  /* serializeDoc                                                        */
  /* ------------------------------------------------------------------ */

  function serializeDoc(iframeDoc) {
    const src = iframeDoc && iframeDoc.documentElement;
    if (!src) return '<!DOCTYPE html>\n<html></html>';
    const root = src.cloneNode(true);
    root.querySelectorAll('[data-sfp-ui]').forEach((n) => n.remove());
    root.querySelectorAll('.sfp-hl-pending').forEach((n) => {
      n.classList.remove('sfp-hl-pending');
      if (!n.getAttribute('class')) n.removeAttribute('class');
    });
    // Strip anything a previous export injected so re-exports stay idempotent.
    root.querySelectorAll('#sfp-viewer-css, #sfp-data, #sfp-viewer-js, #sfp-viewer-overlay')
      .forEach((n) => n.remove());
    return '<!DOCTYPE html>\n' + root.outerHTML;
  }

  /* ------------------------------------------------------------------ */
  /* Viewer CSS (baked literal hex — zero var() dependency)              */
  /* ------------------------------------------------------------------ */

  function viewerCSS(p) {
    return '' +
      '.sfp-hl{background:rgba(255,213,0,.45);cursor:pointer;border-bottom:2px solid rgba(230,160,0,.85);}' +
      '.sfp-hl:hover{background:rgba(255,200,0,.65);}' +
      '#sfp-viewer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000;}' +
      '#sfp-viewer-panel{position:fixed;inset:10%;display:flex;flex-direction:column;overflow:hidden;' +
        'background:' + p.surface + ';color:' + p.text + ';border:1px solid ' + p.border + ';' +
        'border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.5);' +
        'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;box-sizing:border-box;}' +
      '#sfp-viewer-panel *{box-sizing:border-box;}' +
      '#sfp-viewer-header{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:11px 16px;' +
        'background:' + p.accent + ';color:' + p.accentText + ';}' +
      '#sfp-viewer-title{font-weight:600;font-size:15px;white-space:nowrap;}' +
      '#sfp-viewer-dates{flex:1 1 auto;text-align:right;font-size:12px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '#sfp-viewer-close{flex:0 0 auto;background:rgba(0,0,0,.18);border:none;color:inherit;font:inherit;' +
        'font-size:14px;line-height:1;cursor:pointer;padding:6px 10px;border-radius:6px;}' +
      '#sfp-viewer-close:hover{background:rgba(0,0,0,.32);}' +
      '#sfp-viewer-body{flex:1 1 auto;overflow:auto;padding:26px 22px;background:' + p.bg + ';}' +
      '#sfp-viewer-body::-webkit-scrollbar{width:12px;height:12px;}' +
      '#sfp-viewer-body::-webkit-scrollbar-thumb{background:' + p.border + ';border-radius:6px;border:3px solid ' + p.bg + ';}' +
      '#sfp-viewer-body::-webkit-scrollbar-track{background:transparent;}' +
      // Card follows the chosen theme (dark on dark themes) instead of forced white.
      '#sfp-viewer-card{background:' + p.surface + ';color:' + p.text + ';max-width:800px;margin:0 auto;padding:30px 36px;' +
        'border-radius:8px;box-shadow:0 3px 16px rgba(0,0,0,.3);overflow-wrap:break-word;}' +
      '#sfp-viewer-card img{max-width:100%;height:auto;}' +
      '#sfp-viewer-card table{border-collapse:collapse;max-width:100%;}' +
      '#sfp-viewer-card td,#sfp-viewer-card th{border:1px solid ' + p.border + ';padding:6px 8px;vertical-align:top;}' +
      '#sfp-viewer-card blockquote{border-left:4px solid ' + p.border + ';margin:8px 0;padding:4px 14px;color:' + p.muted + ';}' +
      '#sfp-viewer-card pre{background:' + p.surface2 + ';border:1px solid ' + p.border + ';border-radius:6px;padding:10px 12px;' +
        'font-family:ui-monospace,Consolas,monospace;font-size:13px;overflow:auto;white-space:pre-wrap;}' +
      '#sfp-viewer-card a{color:' + p.accent + ';}' +
      '#sfp-viewer-card hr{border:none;border-top:2px solid ' + p.border + ';margin:14px 0;}' +
      '#sfp-viewer-footer{flex:0 0 auto;padding:9px 16px;border-top:1px solid ' + p.border + ';' +
        'background:' + p.surface2 + ';color:' + p.muted + ';font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '#sfp-viewer-footer a{color:' + p.accent + ';text-decoration:none;}' +
      '#sfp-viewer-footer a:hover{text-decoration:underline;}';
  }

  /* ------------------------------------------------------------------ */
  /* Viewer runtime (self-contained IIFE, no chrome.*, no network)       */
  /* ------------------------------------------------------------------ */

  const VIEWER_JS = '(function(){' + '\n' +
    '"use strict";' + '\n' +
    'var dataEl=document.getElementById("sfp-data");' + '\n' +
    'if(!dataEl)return;' + '\n' +
    'var payload;' + '\n' +
    'try{payload=JSON.parse(dataEl.textContent||"{}");}catch(e){return;}' + '\n' +
    'var annotations=payload.annotations||{};' + '\n' +
    'var meta=payload.meta||{};' + '\n' +
    'var hls=document.querySelectorAll(".sfp-hl");' + '\n' +
    'for(var i=0;i<hls.length;i++)hls[i].setAttribute("title","Click to view annotation");' + '\n' +
    'function restoreScroll(){' + '\n' +
    '  try{' + '\n' +
    '    var els=document.querySelectorAll("[data-sfp-scroll-top],[data-sfp-scroll-left]");' + '\n' +
    '    for(var j=0;j<els.length;j++){' + '\n' +
    '      var st=parseInt(els[j].getAttribute("data-sfp-scroll-top")||"0",10);' + '\n' +
    '      var sl=parseInt(els[j].getAttribute("data-sfp-scroll-left")||"0",10);' + '\n' +
    '      if(st)els[j].scrollTop=st;' + '\n' +
    '      if(sl)els[j].scrollLeft=sl;' + '\n' +
    '    }' + '\n' +
    '    if(meta.scrollX||meta.scrollY)window.scrollTo(meta.scrollX||0,meta.scrollY||0);' + '\n' +
    '  }catch(e){}' + '\n' +
    '}' + '\n' +
    'restoreScroll();' + '\n' +
    'window.addEventListener("load",restoreScroll);' + '\n' +
    'var overlay=null;' + '\n' +
    'function fmt(ts){if(!ts)return"";try{return new Date(ts).toLocaleString();}catch(e){return String(ts);}}' + '\n' +
    'function closePanel(){' + '\n' +
    '  if(overlay&&overlay.parentNode)overlay.parentNode.removeChild(overlay);' + '\n' +
    '  overlay=null;' + '\n' +
    '  document.removeEventListener("keydown",onKey,true);' + '\n' +
    '}' + '\n' +
    'function onKey(e){if(e.key==="Escape"||e.keyCode===27){e.preventDefault();closePanel();}}' + '\n' +
    'function openPanel(ann){' + '\n' +
    '  closePanel();' + '\n' +
    '  overlay=document.createElement("div");' + '\n' +
    '  overlay.id="sfp-viewer-overlay";' + '\n' +
    '  var panel=document.createElement("div");' + '\n' +
    '  panel.id="sfp-viewer-panel";' + '\n' +
    '  var header=document.createElement("div");' + '\n' +
    '  header.id="sfp-viewer-header";' + '\n' +
    '  var title=document.createElement("div");' + '\n' +
    '  title.id="sfp-viewer-title";' + '\n' +
    '  title.textContent="\\uD83D\\uDCDD Annotation";' + '\n' +
    '  var dates=document.createElement("div");' + '\n' +
    '  dates.id="sfp-viewer-dates";' + '\n' +
    '  var d="Created "+fmt(ann.createdAt);' + '\n' +
    '  if(ann.updatedAt&&ann.updatedAt!==ann.createdAt)d+=" \\u00B7 Updated "+fmt(ann.updatedAt);' + '\n' +
    '  dates.textContent=d;' + '\n' +
    '  var close=document.createElement("button");' + '\n' +
    '  close.id="sfp-viewer-close";' + '\n' +
    '  close.type="button";' + '\n' +
    '  close.title="Close";' + '\n' +
    '  close.textContent="\\u2716";' + '\n' +
    '  close.addEventListener("click",closePanel);' + '\n' +
    '  header.appendChild(title);header.appendChild(dates);header.appendChild(close);' + '\n' +
    '  var body=document.createElement("div");' + '\n' +
    '  body.id="sfp-viewer-body";' + '\n' +
    '  var card=document.createElement("div");' + '\n' +
    '  card.id="sfp-viewer-card";' + '\n' +
    '  card.innerHTML=ann.html||\'<p style="color:#888888">(empty annotation)<\\/p>\';' + '\n' +
    '  body.appendChild(card);' + '\n' +
    '  var footer=document.createElement("div");' + '\n' +
    '  footer.id="sfp-viewer-footer";' + '\n' +
    '  footer.appendChild(document.createTextNode("Saved with NoteFreeze"));' + '\n' +
    '  if(meta.url){' + '\n' +
    '    footer.appendChild(document.createTextNode(" \\u00B7 "));' + '\n' +
    '    if(/^(https?|file):/i.test(meta.url)){' + '\n' +
    '      var a=document.createElement("a");' + '\n' +
    '      a.href=meta.url;a.target="_blank";a.rel="noopener";' + '\n' +
    '      a.textContent=meta.url;' + '\n' +
    '      footer.appendChild(a);' + '\n' +
    '    }else{footer.appendChild(document.createTextNode(String(meta.url)));}' + '\n' +
    '  }' + '\n' +
    '  if(meta.capturedAt)footer.appendChild(document.createTextNode(" \\u00B7 "+fmt(meta.capturedAt)));' + '\n' +
    '  panel.appendChild(header);panel.appendChild(body);panel.appendChild(footer);' + '\n' +
    '  overlay.addEventListener("click",function(e){if(e.target===overlay)closePanel();});' + '\n' +
    '  overlay.appendChild(panel);' + '\n' +
    '  (document.body||document.documentElement).appendChild(overlay);' + '\n' +
    '  document.addEventListener("keydown",onKey,true);' + '\n' +
    '}' + '\n' +
    'document.addEventListener("click",function(e){' + '\n' +
    '  var t=e.target;' + '\n' +
    '  if(!t||!t.closest)return;' + '\n' +
    '  var hl=t.closest(".sfp-hl");' + '\n' +   // closest() from target => innermost span wins
    '  if(!hl)return;' + '\n' +
    '  var id=hl.getAttribute("data-sfp-id");' + '\n' +
    '  if(!id||!Object.prototype.hasOwnProperty.call(annotations,id))return;' + '\n' +
    '  e.preventDefault();' + '\n' +
    '  e.stopPropagation();' + '\n' +
    '  openPanel(annotations[id]);' + '\n' +
    '},true);' + '\n' +
    '})();';

  /* ------------------------------------------------------------------ */
  /* buildHTML                                                           */
  /* ------------------------------------------------------------------ */

  function buildHTML(opts) {
    opts = opts || {};
    const annotations = opts.annotations || {};
    const meta = opts.meta || {};
    const palette = THEMES[opts.themeId] || THEMES['github-light'];
    const html = serializeDoc(opts.doc);

    // Defensively re-sanitize annotation HTML if the editor is available.
    const cleanAnns = {};
    Object.keys(annotations).forEach((key) => {
      const a = annotations[key] || {};
      const copy = {};
      for (const k in a) copy[k] = a[k];
      if (window.SFPEditor && typeof window.SFPEditor.sanitizeHTML === 'function') {
        try { copy.html = window.SFPEditor.sanitizeHTML(copy.html || ''); } catch (e) { /* keep as-is */ }
      }
      cleanAnns[key] = copy;
    });

    // Escape "</" so the JSON can never close its own <script> block; also
    // neutralize "<!--" which can trip the HTML script-data escaped state.
    const json = JSON.stringify({ annotations: cleanAnns, meta: meta })
      .replace(/<\//g, '<\\/')
      .replace(/<!--/g, '<\\u0021--');

    const block =
      '\n<style id="sfp-viewer-css">' + viewerCSS(palette) + '</style>' +
      '\n<script type="application/json" id="sfp-data">' + json + '</scr' + 'ipt>' +
      '\n<script id="sfp-viewer-js">' + VIEWER_JS + '</scr' + 'ipt>\n';

    let idx = html.lastIndexOf('</body>');
    if (idx === -1) idx = html.lastIndexOf('</html>');
    if (idx === -1) return html + block;
    return html.slice(0, idx) + block + html.slice(idx);
  }

  /* ------------------------------------------------------------------ */
  /* download                                                            */
  /* ------------------------------------------------------------------ */

  function download(html, filename) {
    const name = filename || 'page.annotated.html';
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    // Revoke later so Chrome has time to start reading the blob.
    const revokeLater = () => setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (e) { /* already revoked */ }
    }, 15000);
    const fallbackAnchor = () => {
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) { /* nothing left to try */ }
      revokeLater();
    };
    try {
      if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
        Promise.resolve(chrome.downloads.download({ url: url, filename: name, saveAs: false }))
          .then(revokeLater)
          .catch(fallbackAnchor);
      } else {
        fallbackAnchor();
      }
    } catch (e) {
      fallbackAnchor();
    }
  }

  window.SFPExporter = { serializeDoc, buildHTML, download };
})();
