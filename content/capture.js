/*
 * NoteFreeze — capture engine (content script).
 * Injected on demand via chrome.scripting.executeScript. Serializes the live page
 * (including form state, canvas bitmaps, open shadow DOM, same-origin iframes) into
 * ONE self-contained HTML string with every resource inlined as a data: URI.
 * Never lets a single failed resource abort the capture.
 */
if (!window.__SFP_LOADED__) {
  window.__SFP_LOADED__ = true;

  (function () {
    'use strict';

    const HTML_NS = 'http://www.w3.org/1999/xhtml';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const MAX_RESOURCE_BYTES = 32 * 1024 * 1024; // skip resources larger than 32 MB
    const MAX_CONCURRENT_FETCHES = 8;
    const MAX_IFRAME_DEPTH = 5;
    const PAGE_FETCH_TIMEOUT_MS = 20000; // abort page-context fetches that hang
    const BG_FETCH_TIMEOUT_MS = 30000; // give up on a silent background fetch

    const DROP_TAGS = new Set(['script', 'noscript', 'base', 'object', 'embed', 'source']);
    const DROP_LINK_RELS = new Set(['preload', 'modulepreload', 'prefetch', 'dns-prefetch', 'preconnect', 'manifest']);
    const DROP_ATTRS = new Set(['nonce', 'integrity', 'crossorigin', 'ping', 'srcset', 'sizes', 'loading', 'fetchpriority']);
    const URI_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'background'];

    // Compact mode: don't inline web fonts. On sites that ship many font files
    // (e.g. per-language fonts) these dominate the file — HTB captures were ~70%
    // fonts. Skipped fonts fall back to system fonts; the URL is left intact so
    // they still load when viewed online.
    const FONT_EXT_RE = /\.(?:woff2?|otf|ttf|eot)(?:$|[?#])/i;
    let skipFonts = true; // set from the sfp_compact setting at capture start

    // Compact mode also recompresses raster images to WebP and caps their size.
    // Screenshots dominate a captured file once fonts are gone; WebP q82 + a
    // 1600px cap cut them ~85% with no layout change (display size is unchanged).
    let optimizeImages = true;
    const IMG_REENCODE_MIN_BYTES = 12 * 1024; // leave tiny icons alone
    const IMG_MAX_DIM = 1600;                  // downscale retina/oversized screenshots
    const IMG_WEBP_QUALITY = 0.82;
    const RASTER_DATA_RE = /^data:image\/(?:png|jpe?g|webp|bmp)[;,]/i; // NOT svg/gif (svg=vector, gif=maybe animated)

    // Re-encode a raster-image data: URI to WebP if that comes out smaller.
    // Always resolves (to the original on any failure) so it can't break a capture.
    function recompressImageDataURI(dataUri) {
      return new Promise((resolve) => {
        try {
          if (!optimizeImages || typeof dataUri !== 'string') { resolve(dataUri); return; }
          if (!RASTER_DATA_RE.test(dataUri) || dataUri.length < IMG_REENCODE_MIN_BYTES) { resolve(dataUri); return; }
          const img = new Image();
          img.onload = () => {
            try {
              const w = img.naturalWidth, h = img.naturalHeight;
              if (!w || !h) { resolve(dataUri); return; }
              const scale = Math.min(1, IMG_MAX_DIM / Math.max(w, h));
              const cw = Math.max(1, Math.round(w * scale));
              const ch = Math.max(1, Math.round(h * scale));
              const canvas = document.createElement('canvas');
              canvas.width = cw;
              canvas.height = ch;
              const cx = canvas.getContext('2d');
              if (!cx) { resolve(dataUri); return; }
              cx.drawImage(img, 0, 0, cw, ch);
              const webp = canvas.toDataURL('image/webp', IMG_WEBP_QUALITY);
              resolve(webp && webp.indexOf('data:image/webp') === 0 && webp.length < dataUri.length ? webp : dataUri);
            } catch (_) {
              resolve(dataUri);
            }
          };
          img.onerror = () => resolve(dataUri);
          img.src = dataUri;
        } catch (_) {
          resolve(dataUri);
        }
      });
    }

    /* ---------------------------------------------------------------- *
     *  Small utilities                                                  *
     * ---------------------------------------------------------------- */

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Resolves null on timeout or rejection — a stuck resource must never
    // stall the capture (it holds one of the 8 fetch slots until it settles).
    function withTimeout(promise, ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          () => {
            clearTimeout(timer);
            resolve(null);
          }
        );
      });
    }

    function resolveURL(url, base) {
      if (!url) return null;
      try {
        return new URL(url, base).href;
      } catch (_) {
        return null;
      }
    }

    // "</" inside a <style> would terminate the tag when re-parsed; "\/" is a valid
    // CSS escape for "/" so this is safe inside strings/urls and inert elsewhere.
    function safeCSSText(css) {
      return String(css == null ? '' : css).replace(/<\//g, '<\\/');
    }

    function cssURLEscape(url) {
      return String(url).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function blobToDataURI(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      });
    }

    function dataURIToText(uri) {
      try {
        const comma = uri.indexOf(',');
        if (comma < 0) return null;
        const meta = uri.slice(0, comma);
        const data = uri.slice(comma + 1);
        if (/;base64$/i.test(meta)) {
          const bin = atob(data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder('utf-8').decode(bytes);
        }
        try {
          return decodeURIComponent(data);
        } catch (_) {
          return data;
        }
      } catch (_) {
        return null;
      }
    }

    function sheetToCSSText(sheet) {
      try {
        const rules = sheet.cssRules;
        const parts = [];
        for (let i = 0; i < rules.length; i++) parts.push(rules[i].cssText);
        return parts.join('\n');
      } catch (_) {
        return null; // cross-origin sheets throw on cssRules access
      }
    }

    // XHR fallback for file:// subresources (fetch() rejects the file: scheme).
    function xhrBlob(url) {
      return new Promise((resolve) => {
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = 'blob';
          xhr.timeout = PAGE_FETCH_TIMEOUT_MS;
          xhr.onload = () => {
            if ((xhr.status === 200 || xhr.status === 0) && xhr.response) resolve(xhr.response);
            else resolve(null);
          };
          xhr.onerror = () => resolve(null);
          xhr.ontimeout = () => resolve(null);
          xhr.send();
        } catch (_) {
          resolve(null);
        }
      });
    }

    /* ---------------------------------------------------------------- *
     *  Fetch machinery: ~8-way semaphore + progress + caches            *
     * ---------------------------------------------------------------- */

    let activeFetches = 0;
    const fetchWaiters = [];

    function acquireFetchSlot() {
      if (activeFetches < MAX_CONCURRENT_FETCHES) {
        activeFetches++;
        return Promise.resolve();
      }
      return new Promise((resolve) => fetchWaiters.push(resolve));
    }

    function releaseFetchSlot() {
      const next = fetchWaiters.shift();
      if (next) next(); // hand the slot over; activeFetches unchanged
      else activeFetches--;
    }

    let progressTotal = 0;
    let progressDone = 0;

    function trackProgress(promise) {
      progressTotal++;
      updateProgressLine();
      const bump = () => {
        progressDone++;
        updateProgressLine();
      };
      promise.then(bump, bump);
      return promise;
    }

    const dataURICache = new Map(); // absolute URL -> Promise<string|null>
    const textCache = new Map(); // absolute URL -> Promise<string|null>

    // Spec 5.4 — resolve any resource URL to a data: URI, or null on failure.
    function fetchAsDataURI(url) {
      if (!url || typeof url !== 'string') return Promise.resolve(null);
      // Already a data: URI (inline image) — still worth recompressing in compact mode.
      if (/^data:/i.test(url)) return optimizeImages ? recompressImageDataURI(url) : Promise.resolve(url);
      if (/^(about|chrome|chrome-extension|moz-extension|edge|view-source|javascript|ws|wss|filesystem):/i.test(url)) {
        return Promise.resolve(null);
      }
      let entry = dataURICache.get(url);
      if (entry) return entry;
      // Recompress raster images once here so both <img> and CSS url() backgrounds
      // benefit, and the (optimized) result is cached/deduped.
      entry = trackProgress(fetchDataURIUncached(url).then((d) => (d ? recompressImageDataURI(d) : d)));
      dataURICache.set(url, entry);
      return entry;
    }

    async function fetchDataURIUncached(url) {
      await acquireFetchSlot();
      try {
        // 1) Page-context fetch: same-origin + CORS-enabled resources, hits the HTTP cache.
        try {
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
          try {
            const resp = await fetch(url, { credentials: 'include', signal: controller.signal });
            if (resp.ok) {
              const len = Number(resp.headers.get('content-length') || 0);
              if (len > MAX_RESOURCE_BYTES) return null; // too big — do not bother the background either
              const blob = await resp.blob();
              if (blob.size > MAX_RESOURCE_BYTES) return null;
              return await blobToDataURI(blob);
            }
          } finally {
            clearTimeout(abortTimer);
          }
        } catch (_) {
          /* CORS / CSP / network failure / timeout — try alternatives below */
        }
        // file:// pages: fetch() cannot read file:, XHR can (when file access is granted).
        if (/^file:/i.test(url)) {
          const blob = await xhrBlob(url);
          if (blob && blob.size <= MAX_RESOURCE_BYTES) {
            try {
              return await blobToDataURI(blob);
            } catch (_) {
              return null;
            }
          }
          return null;
        }
        // 2) Background fetch — bypasses CORS via host permissions.
        if (/^https?:/i.test(url)) {
          try {
            const resp = await withTimeout(
              chrome.runtime.sendMessage({ type: 'SFP_FETCH_RESOURCE', url: url }),
              BG_FETCH_TIMEOUT_MS
            );
            if (
              resp &&
              resp.ok &&
              typeof resp.dataUri === 'string' &&
              resp.dataUri.length <= MAX_RESOURCE_BYTES * 1.4 // base64 expansion ≈ 4/3
            ) {
              return resp.dataUri;
            }
          } catch (_) {
            /* extension context gone or messaging failed */
          }
        }
        return null;
      } finally {
        releaseFetchSlot();
      }
    }

    // Same pipeline but yielding text (for stylesheets / @import).
    function fetchTextResource(url) {
      if (!url || typeof url !== 'string') return Promise.resolve(null);
      if (/^data:/i.test(url)) return Promise.resolve(dataURIToText(url));
      if (/^(about|chrome|chrome-extension|moz-extension|edge|view-source|javascript|ws|wss|filesystem):/i.test(url)) {
        return Promise.resolve(null);
      }
      let entry = textCache.get(url);
      if (entry) return entry;
      entry = trackProgress(fetchTextUncached(url));
      textCache.set(url, entry);
      return entry;
    }

    async function fetchTextUncached(url) {
      await acquireFetchSlot();
      try {
        try {
          const controller = new AbortController();
          const abortTimer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
          try {
            const resp = await fetch(url, { credentials: 'include', signal: controller.signal });
            if (resp.ok) {
              const len = Number(resp.headers.get('content-length') || 0);
              if (len > MAX_RESOURCE_BYTES) return null;
              return await resp.text();
            }
          } finally {
            clearTimeout(abortTimer);
          }
        } catch (_) {
          /* fall through */
        }
        if (/^file:/i.test(url)) {
          const blob = await xhrBlob(url);
          if (blob && blob.size <= MAX_RESOURCE_BYTES) {
            try {
              return await blob.text();
            } catch (_) {
              return null;
            }
          }
          return null;
        }
        if (/^https?:/i.test(url)) {
          try {
            const resp = await withTimeout(
              chrome.runtime.sendMessage({ type: 'SFP_FETCH_RESOURCE', url: url }),
              BG_FETCH_TIMEOUT_MS
            );
            if (resp && resp.ok && typeof resp.dataUri === 'string') return dataURIToText(resp.dataUri);
          } catch (_) {
            /* ignore */
          }
        }
        return null;
      } finally {
        releaseFetchSlot();
      }
    }

    /* ---------------------------------------------------------------- *
     *  CSS processing (spec 5.3)                                        *
     * ---------------------------------------------------------------- */

    // Inline @import chains recursively, then rewrite every url(...) token.
    async function processCSS(cssText, baseURL, seenImports) {
      if (cssText == null || cssText === '') return '';
      try {
        const withImports = await inlineImports(String(cssText), baseURL, seenImports || new Set());
        return await inlineCSSUrls(withImports, baseURL);
      } catch (err) {
        console.warn('[NoteFreeze] processCSS failed for', baseURL, err);
        return String(cssText);
      }
    }

    async function inlineImports(cssText, baseURL, seen) {
      const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]*)\3)\s*([^;]*);/gi;
      const matches = Array.from(cssText.matchAll(importRe));
      if (!matches.length) return cssText;

      const replacements = await Promise.all(
        matches.map(async (m) => {
          const rawURL = m[2] !== undefined ? m[2] : m[4];
          const condition = (m[5] || '').trim();
          const abs = resolveURL(rawURL && rawURL.trim(), baseURL);
          if (!abs || seen.has(abs)) return ''; // unresolvable or cyclic — drop
          const nextSeen = new Set(seen);
          nextSeen.add(abs);
          const text = await fetchTextResource(abs);
          if (text == null) {
            // Keep an absolutized @import so the page still works online.
            return '@import url("' + cssURLEscape(abs) + '")' + (condition ? ' ' + condition : '') + ';';
          }
          const inner = await processCSS(text, abs, nextSeen);
          // layer()/supports() conditions cannot be expressed with @media — strip them,
          // keep any trailing media query part.
          const mediaOnly = condition
            .replace(/^layer(\([^)]*\))?\s*/i, '')
            .replace(/^supports\([^)]*\)\s*/i, '')
            .trim();
          if (!mediaOnly) return inner;
          return '@media ' + mediaOnly + ' {\n' + inner + '\n}';
        })
      );

      let i = 0;
      return cssText.replace(importRe, () => replacements[i++]);
    }

    // Rewrite url(...) tokens: data:/#fragment untouched; others resolved against the
    // STYLESHEET's URL, inlined to data: URIs, or left as the absolute URL on failure.
    async function inlineCSSUrls(cssText, baseURL) {
      const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      const matches = Array.from(cssText.matchAll(urlRe));
      if (!matches.length) return cssText;

      const resolved = new Map(); // raw token -> replacement URL string
      for (const m of matches) {
        const raw = m[2].trim();
        if (!raw || /^data:/i.test(raw) || raw.charAt(0) === '#' || resolved.has(raw)) continue;
        resolved.set(raw, null);
      }
      await Promise.all(
        Array.from(resolved.keys()).map(async (raw) => {
          const abs = resolveURL(raw, baseURL);
          if (!abs) {
            resolved.set(raw, raw);
            return;
          }
          // Compact mode: leave font URLs un-inlined (fall back to system fonts).
          if (skipFonts && (FONT_EXT_RE.test(raw) || FONT_EXT_RE.test(abs))) {
            resolved.set(raw, abs);
            return;
          }
          const dataUri = await fetchAsDataURI(abs);
          resolved.set(raw, dataUri || abs);
        })
      );

      return cssText.replace(urlRe, (full, quote, rawInner) => {
        const raw = rawInner.trim();
        if (!raw || /^data:/i.test(raw) || raw.charAt(0) === '#') return full;
        const replacement = resolved.get(raw);
        return 'url("' + cssURLEscape(replacement || raw) + '")';
      });
    }

    /* ---------------------------------------------------------------- *
     *  Freeze / progress overlay (spec 5.1)                             *
     * ---------------------------------------------------------------- */

    let overlayEl = null;
    let statusEl = null;
    let progressEl = null;
    let spinnerEl = null;
    let spinnerTimer = 0;

    const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    // Overlay styling goes through the CSSOM (el.style.cssText) instead of
    // style attributes / an injected <style> tag: content-script DOM inherits the
    // PAGE's CSP, and a strict style-src (no 'unsafe-inline') would blank both.
    // The spinner is JS-driven for the same reason (no @keyframes needed).
    function showOverlay() {
      removeOverlay();
      const overlay = document.createElement('div');
      overlay.setAttribute('data-sfp-exclude', '');
      overlay.style.cssText =
        'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;' +
        'align-items:center;justify-content:center;background:rgba(9,11,17,0.78);' +
        'pointer-events:auto;cursor:progress;user-select:none;' +
        'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;';

      const card = document.createElement('div');
      card.style.cssText =
        'background:#16161a;color:#f5f6fa;border:1px solid rgba(255,255,255,0.12);' +
        'border-radius:14px;padding:28px 36px;min-width:320px;max-width:80vw;' +
        'box-shadow:0 18px 60px rgba(0,0,0,0.5);display:flex;flex-direction:column;' +
        'align-items:center;gap:12px;text-align:center;';

      spinnerEl = document.createElement('div');
      spinnerEl.textContent = SPINNER_FRAMES[0];
      spinnerEl.style.cssText = 'font-size:30px;line-height:1;color:#ff2e88;';
      let frame = 0;
      spinnerTimer = setInterval(() => {
        frame = (frame + 1) % SPINNER_FRAMES.length;
        if (spinnerEl) spinnerEl.textContent = SPINNER_FRAMES[frame];
      }, 90);

      const title = document.createElement('div');
      title.textContent = 'NoteFreeze — capturing page…';
      title.style.cssText = 'font-size:16px;font-weight:600;letter-spacing:.2px;';

      statusEl = document.createElement('div');
      statusEl.textContent = 'Preparing…';
      statusEl.style.cssText = 'font-size:13px;color:#b9bec9;';

      progressEl = document.createElement('div');
      progressEl.textContent = '';
      progressEl.style.cssText = 'font-size:13px;color:#b9bec9;min-height:16px;';

      card.appendChild(spinnerEl);
      card.appendChild(title);
      card.appendChild(statusEl);
      card.appendChild(progressEl);
      overlay.appendChild(card);

      // Freeze the page: swallow pointer and scroll input while capturing.
      const block = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      const BLOCKED_EVENTS = [
        'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
        'contextmenu', 'wheel', 'touchstart', 'touchmove', 'dragstart', 'selectstart'
      ];
      for (const type of BLOCKED_EVENTS) overlay.addEventListener(type, block, { passive: false });

      (document.body || document.documentElement).appendChild(overlay);
      overlayEl = overlay;
    }

    function setOverlayStatus(text, state) {
      if (statusEl) {
        statusEl.textContent = text;
        if (state === 'error') statusEl.style.color = '#ff6b81';
        else if (state === 'done') statusEl.style.color = '#7ee2a8';
      }
      if (spinnerEl && (state === 'error' || state === 'done')) {
        clearInterval(spinnerTimer);
        spinnerEl.textContent = state === 'done' ? '✓' : '✕';
        spinnerEl.style.color = state === 'done' ? '#7ee2a8' : '#ff6b81';
      }
    }

    function updateProgressLine() {
      if (progressEl && progressTotal > 0) {
        progressEl.textContent = 'Inlining resources… ' + progressDone + '/' + progressTotal;
      }
    }

    function removeOverlay() {
      clearInterval(spinnerTimer);
      if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
      overlayEl = statusEl = progressEl = spinnerEl = null;
    }

    /* ---------------------------------------------------------------- *
     *  Serializer (spec 5.2) — walks the ORIGINAL DOM into a detached   *
     *  document. Resource work is scheduled onto ctx.pending so the DOM *
     *  walk never blocks on the network (fetches run 8-wide).           *
     * ---------------------------------------------------------------- */

    let elementCount = 0;

    async function maybeYield() {
      elementCount++;
      if (elementCount % 400 === 0) await sleep(0); // let the overlay repaint
    }

    function schedule(ctx, task) {
      ctx.pending.push(
        Promise.resolve()
          .then(task)
          .catch((err) => console.warn('[NoteFreeze] resource task failed:', err))
      );
    }

    async function drainPending(ctx) {
      while (ctx.pending.length) {
        const batch = ctx.pending.splice(0, ctx.pending.length);
        await Promise.all(batch); // tasks may enqueue more (nested iframes)
      }
    }

    async function serializeDocument(srcDoc, docURL, depth) {
      const outDoc = document.implementation.createHTMLDocument('');
      const ctx = {
        srcDoc: srcDoc,
        docURL: docURL || srcDoc.baseURI || location.href,
        depth: depth,
        pending: []
      };
      const outRoot = outDoc.documentElement;
      while (outRoot.firstChild) outRoot.removeChild(outRoot.firstChild);

      const srcRoot = srcDoc.documentElement;
      if (srcRoot && srcRoot.localName === 'html') {
        copyAttributesInto(srcRoot, outRoot, ctx);
        const children = Array.from(srcRoot.childNodes);
        for (const child of children) {
          const node = await serializeNode(child, outDoc, ctx);
          if (node) outRoot.appendChild(node);
        }
      } else if (srcRoot) {
        // Non-HTML root (e.g. an SVG document in a frame): wrap it in a body.
        const node = await serializeNode(srcRoot, outDoc, ctx);
        const body = outDoc.createElement('body');
        if (node) body.appendChild(node);
        outRoot.appendChild(body);
      }

      let head = null;
      for (const child of Array.from(outRoot.children)) {
        if (child.localName === 'head') {
          head = child;
          break;
        }
      }
      if (!head) {
        head = outDoc.createElement('head');
        outRoot.insertBefore(head, outRoot.firstChild);
      }

      // <meta charset="utf-8"> must be the very first thing in <head>.
      const charset = outDoc.createElement('meta');
      charset.setAttribute('charset', 'utf-8');
      head.insertBefore(charset, head.firstChild);

      // Bake the page's effective background onto <html> so neither the
      // annotator iframe nor the exported file flashes a white/transparent gap
      // on fast scroll (browsers fall back to the body background when <html>
      // is transparent — once serialized standalone there is no such fallback).
      try {
        const win = srcDoc.defaultView || window;
        const TRANSPARENT = ['', 'transparent', 'rgba(0, 0, 0, 0)'];
        let bg = win.getComputedStyle(srcDoc.documentElement).backgroundColor;
        if (TRANSPARENT.indexOf(bg) !== -1 && srcDoc.body) {
          bg = win.getComputedStyle(srcDoc.body).backgroundColor;
        }
        if (TRANSPARENT.indexOf(bg) === -1 && !/background/i.test(outRoot.getAttribute('style') || '')) {
          appendStyleDecls(outRoot, 'background-color:' + bg + ';');
        }
      } catch (_) {}

      // Document-level adoptedStyleSheets → <style> elements at the end of <head>.
      let adopted = [];
      try {
        adopted = srcDoc.adoptedStyleSheets || [];
      } catch (_) {
        adopted = [];
      }
      for (const sheet of adopted) {
        const styleEl = outDoc.createElement('style');
        head.appendChild(styleEl);
        schedule(ctx, async () => {
          const css = sheetToCSSText(sheet);
          styleEl.textContent = safeCSSText(await processCSS(css || '', ctx.docURL, new Set()));
        });
      }

      if (depth === 0) setOverlayStatus('Inlining resources…');
      await drainPending(ctx);
      if (depth === 0) setOverlayStatus('Building the HTML file…');

      let html = '<!DOCTYPE html>\n';
      if (depth === 0) {
        html +=
          '<!-- Saved with NoteFreeze | url: ' +
          location.href +
          ' | date: ' +
          new Date().toISOString() +
          ' -->\n';
      }
      return html + outRoot.outerHTML;
    }

    async function serializeNode(node, outDoc, ctx) {
      switch (node.nodeType) {
        case Node.ELEMENT_NODE:
          return serializeElement(node, outDoc, ctx);
        case Node.TEXT_NODE:
        case Node.CDATA_SECTION_NODE:
          return outDoc.createTextNode(node.data);
        case Node.COMMENT_NODE:
          return outDoc.createComment(node.data);
        default:
          return null; // processing instructions, doctypes, etc.
      }
    }

    async function serializeElement(el, outDoc, ctx) {
      await maybeYield();
      const tag = el.localName;
      if (!tag) return null;
      if (el.hasAttribute('data-sfp-exclude')) return null;
      if (DROP_TAGS.has(tag)) return null;

      if (tag === 'link' && el.namespaceURI === HTML_NS) return serializeLink(el, outDoc, ctx);
      if (tag === 'meta' && el.namespaceURI === HTML_NS) return serializeMeta(el, outDoc, ctx);
      if (tag === 'style') return serializeStyle(el, outDoc, ctx);
      if (tag === 'img' && el.namespaceURI === HTML_NS) return serializeImg(el, outDoc, ctx);
      if (tag === 'canvas' && el.namespaceURI === HTML_NS) return serializeCanvas(el, outDoc, ctx);
      if (tag === 'video' && el.namespaceURI === HTML_NS) return serializeVideo(el, outDoc, ctx);
      if (tag === 'audio' && el.namespaceURI === HTML_NS) return serializeAudio(el, outDoc, ctx);
      if ((tag === 'iframe' || tag === 'frame') && el.namespaceURI === HTML_NS) return serializeFrame(el, outDoc, ctx);
      if (tag === 'textarea' && el.namespaceURI === HTML_NS) return serializeTextarea(el, outDoc, ctx);
      if (tag === 'image' && el.namespaceURI === SVG_NS) return serializeSVGImage(el, outDoc, ctx);

      // ----- generic element path -----
      const out = createOutElement(el, outDoc);
      copyAttributesInto(el, out, ctx);

      if (tag === 'input' && el.namespaceURI === HTML_NS) applyInputState(el, out, ctx);
      if (tag === 'option') {
        if (el.selected) out.setAttribute('selected', '');
        else out.removeAttribute('selected');
      }
      if (tag === 'details' || tag === 'dialog') {
        if (el.open) out.setAttribute('open', '');
        else out.removeAttribute('open');
      }

      // Inner scroll containers: scrollTop/scrollLeft are live DOM properties,
      // not attributes — without this, every scrolled pane (SPA content areas,
      // code blocks, sidebars) snaps back to offset 0 and the layout no longer
      // matches what the user saw. The annotator and the exported viewer restore
      // these from the data attributes after load.
      try {
        if (el.scrollTop || el.scrollLeft) {
          if (el.scrollTop) out.setAttribute('data-sfp-scroll-top', String(Math.round(el.scrollTop)));
          if (el.scrollLeft) out.setAttribute('data-sfp-scroll-left', String(Math.round(el.scrollLeft)));
        }
      } catch (_) { /* ignore */ }

      // Top-layer state (open popovers, showModal dialogs) is not serializable:
      // re-parsed popovers are hidden by UA rules and modal dialogs render
      // in-flow. Bake the on-screen rect as fixed positioning so the frozen
      // copy shows them where the user saw them.
      try {
        const inTopLayer =
          (el.popover != null && el.matches(':popover-open')) ||
          (tag === 'dialog' && el.matches(':modal'));
        if (inTopLayer) {
          const r = el.getBoundingClientRect();
          out.removeAttribute('popover');
          appendStyleDecls(
            out,
            'position:fixed;left:' + Math.round(r.left) + 'px;top:' + Math.round(r.top) +
              'px;width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) +
              'px;margin:0;z-index:2147483000;'
          );
        }
      } catch (_) { /* :popover-open unsupported on older Chrome — ignore */ }

      // Open shadow DOM → declarative <template shadowrootmode="open"> as first child.
      if (el.shadowRoot) {
        const tpl = outDoc.createElement('template');
        tpl.setAttribute('shadowrootmode', 'open');
        for (const child of Array.from(el.shadowRoot.childNodes)) {
          const n = await serializeNode(child, outDoc, ctx);
          if (n) tpl.content.appendChild(n);
        }
        let shadowAdopted = [];
        try {
          shadowAdopted = el.shadowRoot.adoptedStyleSheets || [];
        } catch (_) {
          shadowAdopted = [];
        }
        for (const sheet of shadowAdopted) {
          const styleEl = outDoc.createElement('style');
          tpl.content.appendChild(styleEl); // appended last, matching adopted-sheet cascade order
          schedule(ctx, async () => {
            const css = sheetToCSSText(sheet);
            styleEl.textContent = safeCSSText(await processCSS(css || '', ctx.docURL, new Set()));
          });
        }
        out.appendChild(tpl);
      }

      if (tag === 'template' && el.content) {
        for (const child of Array.from(el.content.childNodes)) {
          const n = await serializeNode(child, outDoc, ctx);
          if (n) out.content.appendChild(n);
        }
      } else {
        for (const child of Array.from(el.childNodes)) {
          const n = await serializeNode(child, outDoc, ctx);
          if (n) out.appendChild(n);
        }
      }
      return out;
    }

    function createOutElement(el, outDoc) {
      const ns = el.namespaceURI;
      if (ns && ns !== HTML_NS) {
        try {
          return outDoc.createElementNS(ns, el.localName);
        } catch (_) {
          /* fall through */
        }
      }
      return outDoc.createElement(el.localName);
    }

    function copyAttributesInto(el, out, ctx) {
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length; i++) {
        const name = attrs[i].name;
        const lower = name.toLowerCase();
        if (lower.indexOf('on') === 0) continue; // all inline event handlers
        if (DROP_ATTRS.has(lower)) continue;
        const value = attrs[i].value;
        if (
          (lower === 'href' || lower === 'src' || lower === 'action' || lower === 'formaction' || lower === 'xlink:href') &&
          /^\s*javascript:/i.test(value)
        ) {
          continue;
        }
        try {
          out.setAttribute(name, value); // plain names keep serialization identical (xlink: etc.)
        } catch (_) {
          /* framework attrs like "@click" fail name validation — drop them */
        }
      }

      // Absolutize URL-carrying attributes so anchors/refs keep working online.
      // Fragment-only refs stay relative so in-page navigation works offline.
      if (el.localName !== 'use') {
        for (const name of URI_ATTRS) {
          const v = out.getAttribute(name);
          if (!v) continue;
          const trimmed = v.trim();
          if (!trimmed || trimmed.charAt(0) === '#') continue;
          if (/^(data|blob|about|javascript|mailto|tel|magnet|ftp):/i.test(trimmed)) continue;
          const abs = resolveURL(trimmed, ctx.docURL);
          if (abs) out.setAttribute(name, abs);
        }
      }

      scheduleInlineStyleRewrite(out, ctx);
    }

    // Inline style="" attributes may contain url(...) tokens — rewrite them too.
    function scheduleInlineStyleRewrite(out, ctx) {
      const styleVal = out.getAttribute('style');
      if (styleVal && /url\s*\(/i.test(styleVal)) {
        schedule(ctx, async () => {
          try {
            out.setAttribute('style', await inlineCSSUrls(styleVal, ctx.docURL));
          } catch (_) {
            /* keep original */
          }
        });
      }
    }

    // Set attr to the absolute URL now; upgrade to a data: URI when the fetch lands.
    function inlineAttrResource(out, attrName, absURL, ctx) {
      if (!absURL) return;
      out.setAttribute(attrName, absURL);
      schedule(ctx, async () => {
        const dataUri = await fetchAsDataURI(absURL);
        if (dataUri) out.setAttribute(attrName, dataUri);
      });
    }

    function carryPresentation(el, out, ctx) {
      for (const name of ['id', 'class', 'style', 'title', 'width', 'height']) {
        const v = el.getAttribute(name);
        if (v != null) {
          try {
            out.setAttribute(name, v);
          } catch (_) {
            /* ignore */
          }
        }
      }
      scheduleInlineStyleRewrite(out, ctx);
    }

    function appendStyleDecls(out, extraCSS) {
      let style = out.getAttribute('style') || '';
      if (style && !/;\s*$/.test(style)) style += ';';
      out.setAttribute('style', style + extraCSS);
    }

    // If the replacement element has no width/height attrs, pin the rendered box size.
    function ensureBoxSize(el, out) {
      if (out.hasAttribute('width') || out.hasAttribute('height')) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let css = '';
      if (w) css += 'width:' + w + 'px;';
      if (h) css += 'height:' + h + 'px;';
      if (css) appendStyleDecls(out, css);
    }

    function makePlaceholder(el, outDoc, label, extraCSS) {
      const div = outDoc.createElement('div');
      const cls = el.getAttribute('class');
      if (cls) div.setAttribute('class', cls);
      const srcStyle = el.getAttribute('style');
      if (srcStyle) div.setAttribute('style', srcStyle);

      let css = extraCSS || '';
      if (!/display\s*:/.test(css)) css += 'display:inline-block;';
      css += 'box-sizing:border-box;overflow:hidden;';
      const attrW = parseFloat(el.getAttribute('width'));
      const attrH = parseFloat(el.getAttribute('height'));
      const w = el.offsetWidth || (Number.isFinite(attrW) ? attrW : 0);
      const h = el.offsetHeight || (Number.isFinite(attrH) ? attrH : 0);
      if (w) css += 'width:' + w + 'px;';
      if (h) css += 'height:' + h + 'px;';
      appendStyleDecls(div, css);
      if (label) div.textContent = label;
      return div;
    }

    /* ----- element-specific serializers ----- */

    function serializeLink(el, outDoc, ctx) {
      const relTokens = (el.getAttribute('rel') || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (relTokens.some((r) => DROP_LINK_RELS.has(r))) return null;

      if (relTokens.indexOf('stylesheet') !== -1) {
        // Disabled / non-selected alternate stylesheets do not affect what the user sees.
        let disabled = false;
        try {
          disabled = el.disabled || (el.sheet && el.sheet.disabled);
        } catch (_) {
          disabled = false;
        }
        if (disabled) return null;
        return serializeStylesheetLink(el, outDoc, ctx);
      }

      const out = outDoc.createElement('link');
      copyAttributesInto(el, out, ctx);
      if (
        relTokens.indexOf('icon') !== -1 ||
        relTokens.indexOf('apple-touch-icon') !== -1 ||
        relTokens.indexOf('apple-touch-icon-precomposed') !== -1
      ) {
        const href = out.getAttribute('href'); // already absolutized
        if (href && !/^data:/i.test(href)) inlineAttrResource(out, 'href', href, ctx);
      }
      return out;
    }

    function serializeStylesheetLink(el, outDoc, ctx) {
      const out = outDoc.createElement('style');
      const media = el.getAttribute('media');
      if (media) out.setAttribute('media', media);
      const hrefAbs = resolveURL(el.getAttribute('href') || '', ctx.docURL);

      // el.sheet IS the matching document.styleSheets entry (linked via ownerNode).
      // Serializing cssRules must happen synchronously here — CSSOM access can throw
      // for cross-origin sheets, in which case we fetch the href instead.
      let cssFromSheet = null;
      let sheetHref = null;
      try {
        if (el.sheet) {
          cssFromSheet = sheetToCSSText(el.sheet);
          sheetHref = el.sheet.href;
        }
      } catch (_) {
        cssFromSheet = null;
      }
      const cssBase = sheetHref || hrefAbs || ctx.docURL;

      schedule(ctx, async () => {
        let text = cssFromSheet;
        if (text == null && hrefAbs) text = await fetchTextResource(hrefAbs);
        if (text == null) {
          // Total failure: keep an online-only reference rather than losing the sheet.
          out.textContent = hrefAbs ? '@import url("' + cssURLEscape(hrefAbs) + '");' : '';
          return;
        }
        const seen = new Set();
        if (hrefAbs) seen.add(hrefAbs);
        out.textContent = safeCSSText(await processCSS(text, cssBase, seen));
      });
      return out;
    }

    function serializeMeta(el, outDoc, ctx) {
      const httpEquiv = (el.getAttribute('http-equiv') || '').toLowerCase();
      if (httpEquiv === 'content-security-policy' || httpEquiv === 'refresh') return null;
      // Drop original charset declarations — we insert our own utf-8 meta first.
      if (el.hasAttribute('charset') || httpEquiv === 'content-type') return null;
      const out = outDoc.createElement('meta');
      copyAttributesInto(el, out, ctx);
      return out;
    }

    function serializeStyle(el, outDoc, ctx) {
      const out = outDoc.createElement('style');
      copyAttributesInto(el, out, ctx);
      // Prefer the live CSSOM: styles injected via insertRule (styled-components etc.)
      // leave textContent empty, but the user sees them.
      let css = null;
      try {
        if (el.sheet) css = sheetToCSSText(el.sheet);
      } catch (_) {
        css = null;
      }
      if (css == null || (css === '' && (el.textContent || '').trim() !== '')) {
        css = el.textContent || '';
      }
      schedule(ctx, async () => {
        out.textContent = safeCSSText(await processCSS(css, ctx.docURL, new Set()));
      });
      return out;
    }

    function serializeImg(el, outDoc, ctx) {
      const out = outDoc.createElement('img');
      copyAttributesInto(el, out, ctx); // keeps class/style/width/height/alt; srcset/sizes dropped
      const src = el.currentSrc || el.src || el.getAttribute('src') || '';
      if (src) {
        const abs = /^data:/i.test(src) ? src : resolveURL(src, ctx.docURL);
        if (abs) inlineAttrResource(out, 'src', abs, ctx);
      }
      return out;
    }

    function serializeCanvas(el, outDoc, ctx) {
      let dataUri = null;
      try {
        if (el.width > 0 && el.height > 0) dataUri = el.toDataURL('image/png');
      } catch (_) {
        dataUri = null; // tainted canvas
      }
      if (dataUri && dataUri.indexOf('data:image') === 0) {
        const img = outDoc.createElement('img');
        carryPresentation(el, img, ctx);
        if (!img.hasAttribute('width')) img.setAttribute('width', String(el.width));
        if (!img.hasAttribute('height')) img.setAttribute('height', String(el.height));
        img.setAttribute('src', dataUri);
        img.setAttribute('alt', '');
        return img;
      }
      return makePlaceholder(el, outDoc, '', 'background:#9aa0a6;');
    }

    function serializeVideo(el, outDoc, ctx) {
      const poster = el.getAttribute('poster');
      if (poster) {
        const abs = resolveURL(poster, ctx.docURL);
        if (abs) {
          const img = outDoc.createElement('img');
          carryPresentation(el, img, ctx);
          ensureBoxSize(el, img);
          img.setAttribute('alt', 'Video poster');
          inlineAttrResource(img, 'src', abs, ctx);
          return img;
        }
      }
      return makePlaceholder(
        el,
        outDoc,
        '▶ Video (not captured)',
        'background:#14171c;color:#dfe3ea;display:flex;align-items:center;justify-content:center;' +
          'font:600 14px/1.4 system-ui,sans-serif;'
      );
    }

    function serializeAudio(el, outDoc, ctx) {
      return makePlaceholder(
        el,
        outDoc,
        '🔊 Audio (not captured)',
        'background:#20242b;color:#c9cfd8;display:inline-flex;align-items:center;justify-content:center;' +
          'padding:6px 14px;border-radius:18px;font:12px system-ui,sans-serif;'
      );
    }

    // A frame the user was never meant to see: hidden by CSS, zero/near-zero
    // sized, or transparent. Reading layout from the LIVE element.
    function isFrameHidden(el) {
      try {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
        if (parseFloat(cs.opacity) === 0) return true;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 && r.height <= 1) return true; // 1x1 tracking/util frames
      } catch (_) {}
      return false;
    }

    // Script-injected blank/about:blank helper frames (analytics, consent,
    // cross-tab comms) carry no visible content. Left as real <iframe>s they
    // render at the UA-default 300x150 and inject phantom layout boxes.
    function isBlankUtilityFrame(el, childDoc) {
      const src = (el.getAttribute('src') || '').trim();
      if (src && !/^about:blank/i.test(src)) return false; // has a real document
      if (!childDoc) return true;
      try {
        const body = childDoc.body;
        if (!body) return true;
        return !body.querySelector('*') && !body.textContent.replace(/\s+/g, '');
      } catch (_) {
        return true;
      }
    }

    function serializeFrame(el, outDoc, ctx) {
      let childDoc = null;
      try {
        childDoc = el.contentDocument; // null for cross-origin / sandboxed frames
      } catch (_) {
        childDoc = null;
      }
      const frameURL = resolveURL(el.getAttribute('src') || '', ctx.docURL) || '';

      // Neutralize invisible/utility frames so they occupy zero layout space —
      // otherwise a handful of blank helper iframes push real content hundreds
      // of pixels down (or off-screen) in the frozen copy.
      if (isFrameHidden(el) || isBlankUtilityFrame(el, childDoc)) {
        const stub = outDoc.createElement('iframe');
        copyAttributesInto(el, stub, ctx);
        stub.removeAttribute('src');
        stub.removeAttribute('srcdoc');
        appendStyleDecls(stub, 'display:none !important;');
        return stub;
      }

      if (childDoc && childDoc.documentElement && ctx.depth < MAX_IFRAME_DEPTH) {
        const out = outDoc.createElement('iframe');
        copyAttributesInto(el, out, ctx);
        out.removeAttribute('src');
        // Pin the real rendered box so a visible frame doesn't fall back to the
        // UA-default 300x150 when it had no width/height attributes.
        if (!out.hasAttribute('width') && !out.hasAttribute('height')) {
          try {
            const r = el.getBoundingClientRect();
            if (r.width && r.height) {
              appendStyleDecls(out, 'width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;');
            }
          } catch (_) {}
        }
        let childURL = frameURL || ctx.docURL;
        try {
          childURL = childDoc.baseURI || childURL;
        } catch (_) {
          /* keep fallback */
        }
        const childDepth = ctx.depth + 1;
        schedule(ctx, async () => {
          try {
            out.setAttribute('srcdoc', await serializeDocument(childDoc, childURL, childDepth));
          } catch (err) {
            console.warn('[NoteFreeze] iframe serialization failed:', err);
            out.setAttribute(
              'srcdoc',
              '<!DOCTYPE html><p style="font:12px system-ui;color:#666;margin:8px">Frame capture failed</p>'
            );
          }
        });
        return out;
      }

      let label = 'Embedded frame (offline unavailable): ' + (frameURL || 'unknown');
      if (label.length > 160) label = label.slice(0, 157) + '…';
      return makePlaceholder(
        el,
        outDoc,
        label,
        'background:#f2f3f5;color:#4a4f57;border:1px dashed #a9adb4;display:flex;align-items:center;' +
          'justify-content:center;text-align:center;font:12px/1.5 system-ui,sans-serif;padding:8px;'
      );
    }

    function serializeTextarea(el, outDoc, ctx) {
      const out = outDoc.createElement('textarea');
      copyAttributesInto(el, out, ctx);
      out.textContent = el.value; // live value, not the original default text
      return out;
    }

    function serializeSVGImage(el, outDoc, ctx) {
      const out = createOutElement(el, outDoc);
      copyAttributesInto(el, out, ctx);
      const attrName = el.hasAttribute('href') ? 'href' : el.hasAttribute('xlink:href') ? 'xlink:href' : null;
      if (attrName) {
        const href = el.getAttribute(attrName) || '';
        if (href && !/^data:/i.test(href) && href.charAt(0) !== '#') {
          const abs = resolveURL(href, ctx.docURL);
          if (abs) {
            out.setAttribute(attrName, abs);
            schedule(ctx, async () => {
              const dataUri = await fetchAsDataURI(abs);
              if (dataUri) out.setAttribute(attrName, dataUri);
            });
          }
        }
      }
      return out;
    }

    function applyInputState(el, out, ctx) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') {
        out.setAttribute('value', '');
        return;
      }
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) out.setAttribute('checked', '');
        else out.removeAttribute('checked');
        return;
      }
      if (type === 'file') return; // value not settable / not meaningful offline
      if (type === 'image') {
        const src = out.getAttribute('src'); // absolutized by copyAttributesInto
        if (src && !/^data:/i.test(src)) inlineAttrResource(out, 'src', src, ctx);
        return;
      }
      try {
        out.setAttribute('value', el.value);
      } catch (_) {
        /* ignore */
      }
    }

    /* ---------------------------------------------------------------- *
     *  Capture orchestration (spec 5.5)                                 *
     * ---------------------------------------------------------------- */

    async function startCapture() {
      dataURICache.clear();
      textCache.clear();
      progressTotal = 0;
      progressDone = 0;
      elementCount = 0;

      // Compact mode (skip web fonts + recompress images) — defaults on; keeps files small.
      try {
        const s = await chrome.storage.local.get({ sfp_compact: true });
        skipFonts = s.sfp_compact !== false;
      } catch (_) {
        skipFonts = true;
      }
      optimizeImages = skipFonts;

      // Snapshot the viewport position first — serialization can take a while
      // and keyboard scrolling is not blocked by the overlay.
      const scrollX = Math.round(window.scrollX || 0);
      const scrollY = Math.round(window.scrollY || 0);

      showOverlay();
      setOverlayStatus('Capturing page structure…');
      try {
        const html = await serializeDocument(document, document.baseURI || location.href, 0);

        // Chrome hard-caps a single runtime message at 64 MiB, so ship the
        // document in slices; the background reassembles them by transferId.
        // 16 MiB of chars stays under the cap even at worst-case UTF-8/escaping.
        const CHUNK_CHARS = 16 * 1024 * 1024;
        const totalChunks = Math.max(1, Math.ceil(html.length / CHUNK_CHARS));
        const transferId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        for (let seq = 0; seq < totalChunks; seq++) {
          if (totalChunks > 1) {
            setOverlayStatus('Transferring capture… (' + (seq + 1) + '/' + totalChunks + ')');
          }
          const chunkResp = await chrome.runtime.sendMessage({
            type: 'SFP_CAPTURE_CHUNK',
            transferId: transferId,
            seq: seq,
            total: totalChunks,
            data: html.slice(seq * CHUNK_CHARS, (seq + 1) * CHUNK_CHARS)
          });
          if (!chunkResp || !chunkResp.ok) {
            throw new Error((chunkResp && chunkResp.error) || 'Failed to transfer the capture');
          }
        }
        const resp = await chrome.runtime.sendMessage({
          type: 'SFP_CAPTURE_COMPLETE',
          transferId: transferId,
          title: document.title || location.href,
          url: location.href,
          scrollX: scrollX,
          scrollY: scrollY
        });
        if (!resp || !resp.ok) {
          throw new Error((resp && resp.error) || 'Failed to store the capture');
        }
        setOverlayStatus('Done ✓ Opening annotator…', 'done');
        await sleep(900);
        removeOverlay();
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        try {
          const p = chrome.runtime.sendMessage({ type: 'SFP_CAPTURE_ERROR', error: message });
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {
          /* extension context gone */
        }
        setOverlayStatus('Capture failed: ' + message, 'error');
        await sleep(3000);
        removeOverlay();
      } finally {
        window.__SFP_CAPTURING__ = false;
      }
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'SFP_START_CAPTURE') return;
      if (window.__SFP_CAPTURING__) {
        sendResponse({ ok: true }); // capture already in flight — ignore the duplicate
        return;
      }
      window.__SFP_CAPTURING__ = true;
      sendResponse({ ok: true }); // ack immediately; the capture continues async
      startCapture();
    });
  })();
}
