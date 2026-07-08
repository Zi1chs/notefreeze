// NoteFreeze — MV3 service worker.
// Owns: keyboard command handling, capture orchestration (script injection),
// cross-origin resource fetching for content/annotator, capture persistence
// (record + index trim), the annotator tab, action badges and notifications.

'use strict';

const INDEX_KEY = 'sfp_captures_index';
const MAX_CAPTURES = 20;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024; // mirrors the capture engine's 32 MB cap

// Chrome hard-caps a single runtime message at 64 MiB, so large captures
// arrive as SFP_CAPTURE_CHUNK slices reassembled here, keyed by transferId.
const MAX_TRANSFER_CHARS = 1024 * 1024 * 1024; // 1 GB sanity cap per capture
const TRANSFER_TTL_MS = 5 * 60 * 1000;
const pendingTransfers = new Map();

function dropStaleTransfers() {
  const now = Date.now();
  for (const [id, t] of pendingTransfers) {
    if (now - t.startedAt > TRANSFER_TTL_MS) pendingTransfers.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rand4() {
  // Exactly 4 base36 chars (Math.random().toString(36) can come up short).
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

function newCaptureId() {
  return 'c_' + Date.now() + '_' + rand4();
}

function errText(e) {
  return String((e && e.message) || e || 'Unknown error');
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: title,
      message: String(message || '')
    });
  } catch (e) {
    // Notifications are best-effort; never let them break the flow.
  }
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: color || '#ff2e88' });
    await chrome.action.setBadgeText({ tabId, text });
  } catch (e) {
    // Tab may already be gone.
  }
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (e) {
    // Tab may already be gone.
  }
}

function bufferToBase64(buf) {
  // No FileReader in service workers: chunked String.fromCharCode + btoa.
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000; // 32 KB chunks keep fromCharCode within argument limits
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function isCapturableUrl(url) {
  return /^(https?|file):/i.test(url || '');
}

// ---------------------------------------------------------------------------
// Capture orchestration
// ---------------------------------------------------------------------------

async function captureTab(tab) {
  if (!tab || tab.id == null) {
    notify('NoteFreeze', 'No active tab to capture.');
    return { ok: false, error: 'No active tab to capture.' };
  }
  if (!isCapturableUrl(tab.url)) {
    notify('NoteFreeze', "This page can't be captured (browser-internal pages are restricted).");
    return { ok: false, error: "This page can't be captured" };
  }
  try {
    await setBadge(tab.id, '…');
    // capture.js is double-injection safe (window.__SFP_LOADED__ guard).
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/capture.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'SFP_START_CAPTURE' });
    return { ok: true };
  } catch (e) {
    await clearBadge(tab.id); // never leave the badge stuck
    const error = errText(e);
    notify('NoteFreeze — capture failed', error);
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handleCaptureTabRequest() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return captureTab(tabs && tabs[0]);
}

async function handleFetchResource(msg) {
  const url = msg && msg.url;
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'Missing url' };
  }
  if (url.startsWith('data:')) {
    return { ok: true, dataUri: url };
  }
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) {
      return { ok: false, error: 'HTTP ' + resp.status + ' for ' + url };
    }
    const declared = parseInt(resp.headers.get('content-length') || '0', 10);
    if (declared > MAX_RESOURCE_BYTES) {
      return { ok: false, error: 'Resource larger than 32 MB' };
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_RESOURCE_BYTES) {
      return { ok: false, error: 'Resource larger than 32 MB' };
    }
    const mime = (resp.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream';
    return { ok: true, dataUri: 'data:' + mime + ';base64,' + bufferToBase64(buf) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

function handleCaptureChunk(msg) {
  const transferId = msg && msg.transferId;
  const seq = msg && msg.seq;
  const total = msg && msg.total;
  const data = msg && msg.data;
  if (typeof transferId !== 'string' || typeof data !== 'string' ||
      !Number.isInteger(seq) || !Number.isInteger(total) ||
      seq < 0 || total < 1 || seq >= total) {
    return { ok: false, error: 'Malformed capture chunk' };
  }
  dropStaleTransfers();
  let t = pendingTransfers.get(transferId);
  if (!t) {
    t = { chunks: new Array(total), received: 0, total, size: 0, startedAt: Date.now() };
    pendingTransfers.set(transferId, t);
  }
  if (t.total !== total) {
    pendingTransfers.delete(transferId);
    return { ok: false, error: 'Inconsistent chunk count for transfer' };
  }
  if (t.chunks[seq] === undefined) t.received++;
  t.chunks[seq] = data;
  t.size += data.length;
  if (t.size > MAX_TRANSFER_CHARS) {
    pendingTransfers.delete(transferId);
    return { ok: false, error: 'Capture exceeds the 1 GB transfer cap' };
  }
  return { ok: true };
}

async function handleCaptureComplete(msg, sender) {
  let html = (msg && msg.html) || ''; // legacy single-message path
  if (msg && msg.transferId) {
    const t = pendingTransfers.get(msg.transferId);
    pendingTransfers.delete(msg.transferId);
    if (!t || t.received !== t.total) {
      throw new Error('Capture transfer incomplete (background was restarted mid-transfer) — please try again');
    }
    html = t.chunks.join('');
  }
  const id = newCaptureId();
  const capturedAt = new Date().toISOString();
  const record = {
    id,
    title: (msg && msg.title) || 'Untitled page',
    url: (msg && msg.url) || '',
    capturedAt,
    scrollX: (msg && typeof msg.scrollX === 'number') ? msg.scrollX : 0,
    scrollY: (msg && typeof msg.scrollY === 'number') ? msg.scrollY : 0,
    html,
    annotations: {}
  };
  await chrome.storage.local.set({ ['sfp_capture_' + id]: record });

  const got = await chrome.storage.local.get({ [INDEX_KEY]: [] });
  let index = Array.isArray(got[INDEX_KEY]) ? got[INDEX_KEY] : [];
  index.unshift({ id, title: record.title, url: record.url, capturedAt, annotationCount: 0 });
  if (index.length > MAX_CAPTURES) {
    const trimmed = index.slice(MAX_CAPTURES);
    index = index.slice(0, MAX_CAPTURES);
    const staleKeys = trimmed
      .filter((entry) => entry && entry.id)
      .map((entry) => 'sfp_capture_' + entry.id);
    if (staleKeys.length) {
      await chrome.storage.local.remove(staleKeys);
    }
  }
  await chrome.storage.local.set({ [INDEX_KEY]: index });

  if (sender && sender.tab && sender.tab.id != null) {
    await clearBadge(sender.tab.id);
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL('annotator/annotator.html') + '?id=' + id
  });
  return { ok: true, captureId: id };
}

async function handleCaptureError(msg, sender) {
  const error = (msg && msg.error) || 'Unknown capture error';
  if (sender && sender.tab && sender.tab.id != null) {
    const tabId = sender.tab.id;
    await setBadge(tabId, '!', '#d1242f');
    // Auto-clear so the error badge doesn't linger; tab badges also reset on
    // navigation if the worker is suspended before this fires.
    setTimeout(() => { clearBadge(tabId); }, 8000);
  }
  notify('NoteFreeze — capture failed', error);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'SFP_CAPTURE_TAB':
      handleCaptureTabRequest().then(sendResponse, (e) => {
        sendResponse({ ok: false, error: errText(e) });
      });
      return true; // async sendResponse

    case 'SFP_FETCH_RESOURCE':
      handleFetchResource(msg).then(sendResponse, (e) => {
        sendResponse({ ok: false, error: errText(e) });
      });
      return true;

    case 'SFP_CAPTURE_CHUNK':
      sendResponse(handleCaptureChunk(msg)); // synchronous
      return false;

    case 'SFP_CAPTURE_COMPLETE':
      handleCaptureComplete(msg, sender).then(sendResponse, (e) => {
        if (sender && sender.tab && sender.tab.id != null) clearBadge(sender.tab.id);
        notify('NoteFreeze — saving capture failed', errText(e));
        sendResponse({ ok: false, error: errText(e) });
      });
      return true;

    case 'SFP_CAPTURE_ERROR':
      handleCaptureError(msg, sender).then(sendResponse, () => {
        sendResponse({ ok: true });
      });
      return true;

    default:
      return false;
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'capture-annotate') return;
  if (tab && tab.id != null) {
    captureTab(tab);
  } else {
    // Older Chrome may omit the tab argument on commands.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
      if (tabs && tabs[0]) captureTab(tabs[0]);
    });
  }
});
