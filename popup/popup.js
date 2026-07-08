/* NoteFreeze — popup logic (SPEC §7). Classic script, no modules, no inline handlers. */
(() => {
  'use strict';

  const DEFAULT_THEME = 'github-light';
  const MAX_ROWS = 8;

  // Anchor colors from SPEC §8 — used only to paint the swatches themselves,
  // so every swatch shows its own theme regardless of the active one.
  const THEMES = [
    { id: 'github-light',     name: 'GitHub Light',     bg: '#ffffff', accent: '#0969da' },
    { id: 'solarized-light',  name: 'Solarized Light',  bg: '#fdf6e3', accent: '#268bd2' },
    { id: 'one-light',        name: 'One Light',        bg: '#fafafa', accent: '#4078f2' },
    { id: 'gruvbox-light',    name: 'Gruvbox Light',    bg: '#fbf1c7', accent: '#076678' },
    { id: 'catppuccin-latte', name: 'Catppuccin Latte', bg: '#eff1f5', accent: '#8839ef' },
    { id: 'dracula',          name: 'Dracula',          bg: '#282a36', accent: '#bd93f9' },
    { id: 'nord',             name: 'Nord',             bg: '#2e3440', accent: '#88c0d0' },
    { id: 'solarized-dark',   name: 'Solarized Dark',   bg: '#002b36', accent: '#268bd2' },
    { id: 'tokyo-night',      name: 'Tokyo Night',      bg: '#1a1b26', accent: '#7aa2f7' },
    { id: 'one-dark',         name: 'One Dark',         bg: '#282c34', accent: '#61afef' },
    { id: 'blackpink',        name: 'Neon Noir',        bg: '#0a0a0a', accent: '#ff2e88' }
  ];

  // SPEC §8: Light = first five, Dark = next five, Special = blackpink.
  const THEME_GROUPS = [
    { label: 'Light',   ids: THEMES.slice(0, 5).map((t) => t.id) },
    { label: 'Dark',    ids: THEMES.slice(5, 10).map((t) => t.id) },
    { label: 'Special', ids: ['blackpink'] }
  ];

  const $ = (id) => document.getElementById(id);
  const captureBtn = $('sfp-capture-btn');
  const statusEl = $('sfp-status');
  const pickerEl = $('sfp-theme-picker');
  const listEl = $('sfp-captures');
  const emptyEl = $('sfp-captures-empty');

  // ---------- helpers ----------

  function setStatus(message, isError) {
    if (!message) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.classList.remove('error');
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.classList.toggle('error', !!isError);
  }

  function relativeTime(value) {
    // capturedAt may be epoch ms or an ISO string — accept both.
    const t = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(t)) return '';
    const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (secs < 45) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.round(hours / 24);
    if (days < 7) return days + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  function annotatorUrl(captureId) {
    return chrome.runtime.getURL('annotator/annotator.html') + '?id=' + captureId;
  }

  // ---------- theme picker ----------

  function applyTheme(themeId) {
    const id = THEMES.some((t) => t.id === themeId) ? themeId : DEFAULT_THEME;
    document.documentElement.dataset.theme = id;
    for (const btn of pickerEl.querySelectorAll('.sfp-swatch')) {
      const active = btn.dataset.themeId === id;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  async function selectTheme(themeId) {
    applyTheme(themeId);
    try {
      await chrome.storage.local.set({ sfp_theme: themeId });
    } catch (err) {
      setStatus('Could not save theme: ' + (err && err.message ? err.message : err), true);
    }
  }

  function renderThemePicker() {
    pickerEl.textContent = '';
    for (const group of THEME_GROUPS) {
      const row = document.createElement('div');
      row.className = 'sfp-theme-row';

      const label = document.createElement('span');
      label.className = 'sfp-theme-row-label';
      label.textContent = group.label;
      row.appendChild(label);

      const swatches = document.createElement('div');
      swatches.className = 'sfp-swatches';
      for (const id of group.ids) {
        const theme = THEMES.find((t) => t.id === id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sfp-swatch';
        btn.dataset.themeId = theme.id;
        btn.title = theme.name;
        btn.setAttribute('aria-label', 'Theme: ' + theme.name);
        btn.setAttribute('aria-pressed', 'false');
        btn.style.background = theme.bg;
        const dot = document.createElement('span');
        dot.className = 'sfp-swatch-dot';
        dot.style.background = theme.accent;
        btn.appendChild(dot);
        btn.addEventListener('click', () => selectTheme(theme.id));
        swatches.appendChild(btn);
      }
      row.appendChild(swatches);
      pickerEl.appendChild(row);
    }
  }

  // ---------- recent captures ----------

  function buildCaptureRow(entry) {
    const li = document.createElement('li');
    li.className = 'sfp-capture-row';

    const info = document.createElement('div');
    info.className = 'sfp-capture-info';

    const title = document.createElement('span');
    title.className = 'sfp-capture-title';
    title.textContent = entry.title || 'Untitled page';
    title.title = (entry.title || 'Untitled page') + (entry.url ? '\n' + entry.url : '');
    info.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'sfp-capture-meta';

    const when = document.createElement('span');
    when.textContent = relativeTime(entry.capturedAt);
    meta.appendChild(when);

    const count = Number(entry.annotationCount) || 0;
    const badge = document.createElement('span');
    badge.className = 'sfp-badge' + (count > 0 ? ' has-annotations' : '');
    badge.textContent = '✎ ' + count;
    badge.title = count + (count === 1 ? ' annotation' : ' annotations');
    meta.appendChild(badge);

    info.appendChild(meta);
    li.appendChild(info);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'sfp-btn-open';
    openBtn.textContent = 'Open';
    openBtn.title = 'Open in the annotator';
    openBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: annotatorUrl(entry.id) });
      window.close();
    });
    li.appendChild(openBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'sfp-btn-del';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete this capture';
    delBtn.setAttribute('aria-label', 'Delete capture: ' + (entry.title || 'Untitled page'));
    delBtn.addEventListener('click', () => deleteCapture(entry));
    li.appendChild(delBtn);

    return li;
  }

  function renderCaptures(index) {
    const entries = Array.isArray(index) ? index : [];
    listEl.textContent = '';
    emptyEl.hidden = entries.length > 0;
    for (const entry of entries.slice(0, MAX_ROWS)) {
      listEl.appendChild(buildCaptureRow(entry));
    }
    if (entries.length > MAX_ROWS) {
      const more = document.createElement('li');
      more.className = 'sfp-more';
      more.textContent = '…and ' + (entries.length - MAX_ROWS) + ' older capture' +
        (entries.length - MAX_ROWS === 1 ? '' : 's');
      listEl.appendChild(more);
    }
  }

  async function loadCaptures() {
    try {
      const data = await chrome.storage.local.get('sfp_captures_index');
      renderCaptures(data.sfp_captures_index);
    } catch (err) {
      renderCaptures([]);
      setStatus('Could not load captures: ' + (err && err.message ? err.message : err), true);
    }
  }

  async function deleteCapture(entry) {
    const name = (entry.title || 'Untitled page').slice(0, 60);
    if (!confirm('Delete capture "' + name + '"? This cannot be undone.')) return;
    try {
      const data = await chrome.storage.local.get('sfp_captures_index');
      const index = Array.isArray(data.sfp_captures_index) ? data.sfp_captures_index : [];
      await chrome.storage.local.set({
        sfp_captures_index: index.filter((e) => e && e.id !== entry.id)
      });
      await chrome.storage.local.remove('sfp_capture_' + entry.id);
      await loadCaptures();
    } catch (err) {
      setStatus('Delete failed: ' + (err && err.message ? err.message : err), true);
    }
  }

  // ---------- capture button ----------

  async function onCaptureClick() {
    setStatus('');
    captureBtn.disabled = true;
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'SFP_CAPTURE_TAB' });
      if (resp && resp.ok) {
        window.close();
        return;
      }
      setStatus(
        (resp && resp.error) ||
          "This page can't be captured (e.g. chrome:// or Web Store pages).",
        true
      );
    } catch (err) {
      setStatus(
        'Capture failed: ' + (err && err.message ? err.message : 'extension unreachable'),
        true
      );
    } finally {
      captureBtn.disabled = false;
    }
  }

  // ---------- init ----------

  async function init() {
    // Platform-aware shortcut hint.
    const isMac = /mac/i.test(navigator.platform || '');
    $('sfp-shortcut').textContent = isMac ? '⌃⇧Y' : 'Ctrl+Shift+Y';

    renderThemePicker();

    let themeId = DEFAULT_THEME;
    try {
      const data = await chrome.storage.local.get('sfp_theme');
      if (typeof data.sfp_theme === 'string') themeId = data.sfp_theme;
    } catch (err) {
      // storage unavailable — fall back to default theme, still usable
    }
    applyTheme(themeId);

    await loadCaptures();

    // Compact (skip fonts) toggle — persisted, default on.
    const compactBox = $('sfp-compact');
    if (compactBox) {
      try {
        const c = await chrome.storage.local.get({ sfp_compact: true });
        compactBox.checked = c.sfp_compact !== false;
      } catch (_) { compactBox.checked = true; }
      compactBox.addEventListener('change', async () => {
        try { await chrome.storage.local.set({ sfp_compact: compactBox.checked }); } catch (_) {}
      });
    }

    captureBtn.addEventListener('click', onCaptureClick);

    // Live-refresh if another surface (annotator/background) changes state while open.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.sfp_captures_index) renderCaptures(changes.sfp_captures_index.newValue);
      if (changes.sfp_theme && typeof changes.sfp_theme.newValue === 'string') {
        applyTheme(changes.sfp_theme.newValue);
      }
    });
  }

  init();
})();
