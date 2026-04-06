function updateCount() {
  chrome.runtime.sendMessage({ type: 'popup:get_counts' }, function(response) {
    if (response) {
      document.getElementById('user_count').textContent = response.users || 0;
    }
  });
}

function extractDisplayName(user) {
  if (!user) return '';
  return (
    user.name ||
    user.email ||
    user.user?.name ||
    user.user?.email ||
    ''
  );
}

function setAuthedButtonsEnabled(enabled) {
  const downloadBtn = document.getElementById('download_csv');
  const exportJobsBtn = document.getElementById('export_all_jobs');
  const sendJobsBtn = document.getElementById('send_jobs_to_crm');
  const clearDataBtn = document.getElementById('clear_data');
  const sendCrmBtn = document.getElementById('send_to_crm');

  if (downloadBtn) downloadBtn.disabled = !enabled;
  if (exportJobsBtn) exportJobsBtn.disabled = !enabled;
  if (sendJobsBtn) sendJobsBtn.disabled = !enabled;
  if (clearDataBtn) clearDataBtn.disabled = !enabled;
  if (sendCrmBtn) sendCrmBtn.disabled = !enabled;
}

function setAuthUI(state) {
  const authSection = document.getElementById('auth_section');
  const authedContent = document.getElementById('authed_content');
  const statusEl = document.getElementById('auth_status');
  const userInfoEl = document.getElementById('user_info');
  const errorEl = document.getElementById('auth_error');
  const loginBtn = document.getElementById('login_btn');
  const logoutBtn = document.getElementById('logout_btn');

  if (!state) return;

  // Default: only show auth section when not authenticated.
  const isAuthed = !!state.authenticated || state.status === 'authenticated';
  const isPending = state.status === 'pending';

  if (authSection) {
    if (isPending) statusEl.textContent = 'Checking session...';
    else if (isAuthed) statusEl.textContent = 'Authenticated';
    else if (state.status === 'unauthenticated') statusEl.textContent = 'Not logged in';
    else statusEl.textContent = 'Checking session...';

    const name = extractDisplayName(state.user);
    userInfoEl.textContent = isAuthed
      ? `Signed in as ${name || 'user'}`
      : '';

    errorEl.textContent = !isPending && !isAuthed && state.lastError ? state.lastError : '';

    if (loginBtn) {
      loginBtn.disabled = isPending || isAuthed;
      loginBtn.style.display = isAuthed ? 'none' : 'inline-block';
      loginBtn.textContent = isPending ? 'Waiting for login...' : 'Login with Google';
    }
    if (logoutBtn) logoutBtn.style.display = isAuthed ? 'inline-block' : 'none';
  }

  if (authedContent) {
    authedContent.style.display = isAuthed ? 'block' : 'none';
  }

  setAuthedButtonsEnabled(isAuthed);

  if (isAuthed) {
    updateCount();
  }
}

const API_BASE_URL = 'https://alpha-foundry.alphanext.tech';
const CRM_IMPORT_URL = `${API_BASE_URL}/api/crm/import`;
const CRM_IMPORT_JOBS_URL = `${API_BASE_URL}/api/crm/import/jobs`;
const SENT_INVITATIONS_URL_FRAGMENT = '/mynetwork/invitation-manager/sent';
// Backend enforces MAX_CSV_BYTES = 2 * 1024 * 1024 (UTF-8 bytes)
// Add more headroom and split big exports to avoid upstream request-size/timeouts
// that can surface as 503.
const MAX_CRM_CSV_BYTES = 2 * 1024 * 1024;
const MAX_CRM_CSV_BYTES_SAFE = 1 * 1024 * 1024; // ~1MB per request
/** Leads `/api/crm/import` only: cap data rows per request (smaller payloads, easier retries). */
const CRM_LEADS_MAX_ROWS_PER_REQUEST = 100;

async function fetchWithAuth(url, options = {}) {
  return fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

function setCrmStatus(message, { show = true } = {}) {
  const el = document.getElementById('crm_status');
  if (!el) return;
  el.style.display = show ? 'block' : 'none';
  el.textContent = message || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponseBodyMaybe(res) {
  const ct = res.headers.get('content-type') || '';
  try {
    const text = await res.text();
    const t = text.trim();
    if (!t) return null;
    if (/json/i.test(ct) || t.startsWith('{') || t.startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  } catch {
    return null;
  }
}

/** CRM import POST returns { imported, alreadyExistsSkipped?, duplicateRowsInBatchSkipped?, incomingRowCount?, uniqueRowsAttempted? }; legacy: skippedProfileUrl. */
function accumulateCrmImportStats(data, totals) {
  if (!data || typeof data !== 'object') return false;
  const imp = Number(data.imported);
  if (!Number.isFinite(imp)) return false;
  totals.importedTotal += imp;
  const rawSkip = data.alreadyExistsSkipped ?? data.skippedProfileUrl;
  if (rawSkip !== undefined && rawSkip !== null && rawSkip !== '') {
    const skipped = Number(rawSkip);
    if (Number.isFinite(skipped)) totals.alreadyExistsSkippedTotal += skipped;
  }
  const rawDup = data.duplicateRowsInBatchSkipped;
  if (rawDup !== undefined && rawDup !== null && rawDup !== '') {
    const dup = Number(rawDup);
    if (Number.isFinite(dup)) totals.duplicateRowsInBatchSkippedTotal += dup;
  }
  const inc = Number(data.incomingRowCount);
  if (Number.isFinite(inc) && inc > 0) totals.incomingRowCountTotal += inc;
  const uq = Number(data.uniqueRowsAttempted);
  if (Number.isFinite(uq) && uq >= 0) totals.uniqueRowsAttemptedTotal += uq;
  return true;
}

function splitCsvIntoChunksByByteSize(csvData, maxBytes) {
  // Assumes no newlines inside fields (our CSV generator replaces CR/LF with spaces).
  const normalized = String(csvData).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').filter((l, idx) => !(idx > 0 && l.trim() === ''));
  if (lines.length <= 1) return [csvData];

  const headerLine = lines[0];
  const rowLines = lines.slice(1);

  const chunks = [];
  let current = [headerLine];

  for (const rowLine of rowLines) {
    const candidate = current.concat([rowLine]).join('\r\n');
    const candidateBytes = new Blob([candidate]).size;

    if (candidateBytes > maxBytes && current.length > 1) {
      chunks.push(current.join('\r\n'));
      current = [headerLine, rowLine];
    } else {
      current.push(rowLine);
    }
  }

  if (current.length > 1) chunks.push(current.join('\r\n'));
  return chunks.length ? chunks : [csvData];
}

/**
 * Split leads CSV into multiple files with the same header, each with at most `maxDataRows` data rows.
 * Assumes no newlines inside fields (same as byte splitter).
 */
function splitCsvIntoChunksByDataRowCount(csvData, maxDataRows) {
  if (!maxDataRows || maxDataRows < 1) return [csvData];
  const normalized = String(csvData).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n').filter((l, idx) => !(idx > 0 && l.trim() === ''));
  if (lines.length <= 1) return [csvData];

  const headerLine = lines[0];
  const rowLines = lines.slice(1);
  if (rowLines.length <= maxDataRows) return [csvData];

  const chunks = [];
  for (let i = 0; i < rowLines.length; i += maxDataRows) {
    chunks.push([headerLine, ...rowLines.slice(i, i + maxDataRows)].join('\r\n'));
  }
  return chunks.length ? chunks : [csvData];
}

/** Build POST bodies: leads = row cap then optional byte split; jobs/other = byte split only. */
function buildCrmImportChunks(csvData, importUrl) {
  let parts = [csvData];
  if (importUrl === CRM_IMPORT_URL) {
    parts = splitCsvIntoChunksByDataRowCount(csvData, CRM_LEADS_MAX_ROWS_PER_REQUEST);
  }
  const out = [];
  for (const p of parts) {
    const bytes = new Blob([p]).size;
    if (bytes > MAX_CRM_CSV_BYTES_SAFE) {
      out.push(...splitCsvIntoChunksByByteSize(p, MAX_CRM_CSV_BYTES_SAFE));
    } else {
      out.push(p);
    }
  }
  return out;
}

async function getLeadsCsvData() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'popup:export_leads_csv_data' }, (resp) => {
      if (!resp) {
        resolve({ ok: false, error: 'Failed to build CSV data' });
        return;
      }
      resolve(resp);
    });
  });
}

function escapeCsvCell(value) {
  const v = value === null || value === undefined ? '' : String(value);
  return '"' + v.replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
}

function jobsToCsv(jobs) {
  const cols = [
    { key: 'title', header: 'title' },
    { key: 'company', header: 'company' },
    { key: 'location', header: 'location' },
    { key: 'posted', header: 'posted' },
    { key: 'link', header: 'link' },
    { key: 'jobUrl', header: 'Job URL' },
  ];
  const rows = [cols.map((c) => c.header).join(',')];
  for (const j of jobs || []) {
    rows.push(cols.map((c) => escapeCsvCell(j?.[c.key] || '')).join(','));
  }
  return rows.join('\r\n');
}

/**
 * Warn when Job URL column looks broken: mostly empty or mostly the same URL.
 */
function getJobsJobUrlScrapeWarning(jobs) {
  if (!jobs || jobs.length < 2) return '';
  const n = jobs.length;
  const raw = jobs.map((j) => String(j.jobUrl || '').trim());

  function normalizeUrl(u) {
    if (!u) return '';
    try {
      const x = new URL(u.replace(/\/+$/, ''));
      return (x.origin + x.pathname + x.search).toLowerCase();
    } catch {
      return u.replace(/\/+$/, '').toLowerCase();
    }
  }

  const normalized = raw.map(normalizeUrl);
  const emptyCount = normalized.filter((u) => !u).length;

  if (emptyCount >= 2 && emptyCount / n >= 0.5) {
    return `Could not scrape Job URLs properly for ${emptyCount} of ${n} jobs (Job URL column is empty). Open each listing so the address bar shows ?currentJobId=..., then tap Extract on that row.`;
  }

  const freq = {};
  for (const u of normalized) {
    if (!u) continue;
    freq[u] = (freq[u] || 0) + 1;
  }
  const entries = Object.entries(freq);
  if (!entries.length) {
    return `Could not scrape Job URLs properly for all ${n} jobs (no Job URLs captured). Focus each job so LinkedIn updates the URL, then Extract.`;
  }
  entries.sort((a, b) => b[1] - a[1]);
  const [, dominantCount] = entries[0];
  if (dominantCount >= 2 && dominantCount / n >= 0.5) {
    const dupJobs = dominantCount;
    return `Could not scrape Job URLs properly for ${dupJobs} of ${n} jobs - they share the same Job URL. Click each job so ?currentJobId=... matches that listing, then Extract (do not rely on Select All without opening each job).`;
  }
  return '';
}

async function getJobsDataFromActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].id) {
        resolve({ ok: false, error: 'No active tab found' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'popup:get_jobs_data' }, (resp) => {
        if (!resp) {
          resolve({ ok: false, error: 'Failed to scrape jobs (no response). Open a LinkedIn Jobs page.' });
          return;
        }
        resolve(resp);
      });
    });
  });
}

async function getSentInvitationsDataFromActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].id) {
        resolve({ ok: false, error: 'No active tab found' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'popup:get_sent_invitations_data' }, (resp) => {
        if (!resp) {
          resolve({ ok: false, error: 'Failed to scrape sent invitations (no response).' });
          return;
        }
        resolve(resp);
      });
    });
  });
}

async function getMessagingThreadFromActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].id) {
        resolve({ ok: false, error: 'No active tab found' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'popup:get_messaging_thread_data' }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error:
              chrome.runtime.lastError.message ||
              'No response from page. Reload the thread tab and try again.',
          });
          return;
        }
        if (!resp) {
          resolve({ ok: false, error: 'Failed to read messaging thread (no response).' });
          return;
        }
        resolve(resp);
      });
    });
  });
}

function sentInvitationsToCsv(leads) {
  const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_url', 'lead_source'];
  const rows = [header.join(',')];
  for (const l of (leads || [])) {
    const row = header.map((k) => escapeCsvCell(l?.[k] || ''));
    rows.push(row.join(','));
  }
  return rows.join('\r\n');
}

async function getActiveTabUrl() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0].url || '' : '');
    });
  });
}

async function sendLeadsJsonToBackend(leads) {
  if (!Array.isArray(leads) || leads.length === 0) {
    setCrmStatus('No lead payload to send.');
    return;
  }

  let meRes;
  try {
    meRes = await fetchWithAuth(`${API_BASE_URL}/api/me`, { method: 'GET' });
  } catch (err) {
    console.error('Failed to check /api/me:', err);
    setCrmStatus('Auth check failed. Please try again.');
    return;
  }

  if (!meRes.ok) {
    if (meRes.status === 401) {
      chrome.tabs.create({ url: `${API_BASE_URL}/login` });
      setCrmStatus('Login required. Redirecting to login...');
      chrome.runtime.sendMessage({ type: 'auth:get_state', data: { force: true } }, (state) => {
        setAuthUI(state);
      });
      return;
    }
    setCrmStatus('Auth check failed. Please try again.');
    return;
  }

  setCrmStatus('Sending conversation to CRM...', { show: true });

  let res;
  try {
    res = await fetchWithAuth(CRM_IMPORT_URL, {
      method: 'POST',
      body: JSON.stringify({ leads }),
    });
  } catch (err) {
    console.error('Failed to POST /api/crm/import (JSON leads):', err);
    setCrmStatus('Network error while sending lead.');
    return;
  }

  const body = await parseResponseBodyMaybe(res);

  if (res.ok) {
    const totals = { importedTotal: 0, alreadyExistsSkippedTotal: 0 };
    if (accumulateCrmImportStats(body, totals)) {
      const { importedTotal, alreadyExistsSkippedTotal } = totals;
      let msg;
      if (importedTotal > 0 && alreadyExistsSkippedTotal > 0) {
        msg = `Success! ${importedTotal} imported, ${alreadyExistsSkippedTotal} already existed (same profile URL).`;
      } else if (importedTotal > 0) {
        msg = `Success! Conversation saved as ${importedTotal} lead.`;
      } else if (alreadyExistsSkippedTotal > 0) {
        msg = `Already in CRM - this profile URL exists (${alreadyExistsSkippedTotal}). Open CRM to view transcript.`;
      } else {
        msg = 'Request OK - nothing new imported.';
      }
      setCrmStatus(msg);
    } else {
      setCrmStatus('Success! Lead payload sent to CRM.');
    }
    return;
  }

  if (res.status === 401) {
    chrome.tabs.create({ url: `${API_BASE_URL}/login` });
    setCrmStatus('Login required. Redirecting...');
    return;
  }

  const msg =
    body && typeof body === 'object' && body.error
      ? body.error
      : `Import failed (${res.status}).`;
  setCrmStatus(typeof msg === 'string' ? msg : 'Import failed.');
}

function normalizeCsvPayloadForImport(csvData) {
  if (csvData == null) return '';
  if (typeof csvData === 'string') return csvData;
  if (Array.isArray(csvData) && csvData.every((x) => typeof x === 'string')) {
    return csvData.join('\r\n');
  }
  return String(csvData);
}

async function sendCsvToBackend(csvData, importUrl = CRM_IMPORT_URL, options = {}) {
  const csvNormalized = normalizeCsvPayloadForImport(csvData);
  if (!csvNormalized.trim()) {
    setCrmStatus('No CSV data to send.');
    return;
  }

  // Step 1: check auth
  let meRes;
  try {
    meRes = await fetchWithAuth(`${API_BASE_URL}/api/me`, { method: 'GET' });
  } catch (err) {
    console.error('Failed to check /api/me:', err);
    setCrmStatus('Auth check failed. Please try again.');
    return;
  }

  if (!meRes.ok) {
    if (meRes.status === 401) {
      chrome.tabs.create({ url: `${API_BASE_URL}/login` });
      setCrmStatus('Login required. Redirecting to login...');
      chrome.runtime.sendMessage({ type: 'auth:get_state', data: { force: true } }, (state) => {
        setAuthUI(state);
      });
      return;
    }

    setCrmStatus('Auth check failed. Please try again.');
    return;
  }

  // Step 2: send CSV (leads: ≤100 rows per request, then byte cap if needed)
  const csvBytes = new Blob([csvNormalized]).size;
  const chunks = buildCrmImportChunks(csvNormalized, importUrl);

  if (chunks.length > 1) {
    if (importUrl === CRM_IMPORT_URL) {
      setCrmStatus(
        `Sending ${chunks.length} batches (up to ${CRM_LEADS_MAX_ROWS_PER_REQUEST} leads each)...`
      );
    } else {
      setCrmStatus(
        `CSV is large (${Math.round(csvBytes / 1024)} KB). Sending in ${chunks.length} parts...`
      );
    }
  } else {
    setCrmStatus('Sending to CRM...', { show: true });
  }

  const totals = {
    importedTotal: 0,
    alreadyExistsSkippedTotal: 0,
    duplicateRowsInBatchSkippedTotal: 0,
    incomingRowCountTotal: 0,
    uniqueRowsAttemptedTotal: 0,
  };
  let gotImportStats = false;

  for (let i = 0; i < chunks.length; i++) {
    const maxAttempts = 3;
    let chunkSucceeded = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      setCrmStatus(
        `Sending batch ${i + 1}/${chunks.length}... (attempt ${attempt}/${maxAttempts})`
      );

      let res;
      try {
        res = await fetchWithAuth(importUrl, {
          method: 'POST',
          body: JSON.stringify({ csv: chunks[i] })
        });
      } catch (err) {
        console.error('Failed to POST /api/crm/import:', err);
        if (attempt < maxAttempts) {
          await sleep(1000 * attempt);
          continue;
        }
        setCrmStatus('Network error while sending CSV.');
        return;
      }

      if (res.ok) {
        const data = await parseResponseBodyMaybe(res);
        if (accumulateCrmImportStats(data, totals)) gotImportStats = true;
        chunkSucceeded = true;
        break;
      }

      const body = await parseResponseBodyMaybe(res);
      console.error('CRM import failed:', res.status, body);

      if (res.status === 503) {
        if (attempt < maxAttempts) {
          setCrmStatus(
            `CRM temporarily unavailable (503). Retrying... (${attempt + 1}/${maxAttempts})`
          );
          await sleep(1500 * attempt);
          continue;
        }

        const msg = body && typeof body === 'object' && body.error
          ? body.error
          : typeof body === 'string'
            ? body.trim()
            : null;
        setCrmStatus(
          msg
            ? `CRM import temporarily unavailable (503): ${msg}`
            : 'CRM import temporarily unavailable (503). Please try again in a minute.'
        );
        return;
      }

      if (res.status === 401) {
        chrome.tabs.create({ url: `${API_BASE_URL}/login` });
        setCrmStatus('Login required. Redirecting...');
        chrome.runtime.sendMessage({ type: 'auth:get_state', data: { force: true } }, (state) => {
          setAuthUI(state);
        });
        return;
      }

      if (res.status === 400) {
        const msg = body && typeof body === 'object' && body.error
          ? body.error
          : 'CSV rejected by the backend';
        setCrmStatus(`Import failed: ${msg}`);
        return;
      }

      if (res.status === 500) {
        const msg = body && typeof body === 'object' && body.error
          ? body.error
          : `Server error (${res.status}). Please try again.`;
        setCrmStatus(msg);
        return;
      }

      if (res.status === 413) {
        const msg = body && typeof body === 'object' && body.error
          ? body.error
          : 'CSV payload too large';
        setCrmStatus(`Import failed: ${msg}`);
        return;
      }

      setCrmStatus(`Import failed (${res.status}). Please try again.`);
      return;
    }

    if (!chunkSucceeded) {
      setCrmStatus('Import failed. Please try again.');
      return;
    }
  }

  if (gotImportStats) {
    const {
      importedTotal,
      alreadyExistsSkippedTotal,
      duplicateRowsInBatchSkippedTotal = 0,
      incomingRowCountTotal = 0,
      uniqueRowsAttemptedTotal = 0,
    } = totals;
    const isJobsImport = importUrl === CRM_IMPORT_JOBS_URL;
    let msg;
    if (importedTotal > 0 && alreadyExistsSkippedTotal > 0) {
      msg = `Success! ${importedTotal} imported, ${alreadyExistsSkippedTotal} already existed and skipped.`;
    } else if (importedTotal > 0) {
      msg = `Success! ${importedTotal} imported.`;
    } else if (alreadyExistsSkippedTotal > 0) {
      msg = isJobsImport
        ? duplicateRowsInBatchSkippedTotal > 0 &&
            incomingRowCountTotal > 0 &&
            uniqueRowsAttemptedTotal > 0
          ? `No new jobs. CRM got ${incomingRowCountTotal} row${
              incomingRowCountTotal === 1 ? '' : 's'
            } from your selection but only ${uniqueRowsAttemptedTotal} distinct job URL${
              uniqueRowsAttemptedTotal === 1 ? '' : 's'
            }; ${duplicateRowsInBatchSkippedTotal} row${
              duplicateRowsInBatchSkippedTotal === 1 ? '' : 's'
            } repeated the same link. ${
              alreadyExistsSkippedTotal === uniqueRowsAttemptedTotal
                ? 'All of those are already in CRM.'
                : `${alreadyExistsSkippedTotal} already in CRM.`
            }`
          : duplicateRowsInBatchSkippedTotal > 0
            ? `No new jobs: ${alreadyExistsSkippedTotal} unique job link${
                alreadyExistsSkippedTotal === 1 ? '' : 's'
              } already in CRM. ${duplicateRowsInBatchSkippedTotal} duplicate row${
                duplicateRowsInBatchSkippedTotal === 1 ? '' : 's'
              } in your selection used the same link(s) again.`
            : `Success! No new jobs - ${alreadyExistsSkippedTotal} job link${
                alreadyExistsSkippedTotal === 1 ? '' : 's'
              } already existed and skipped.`
        : `Success! No new leads - ${alreadyExistsSkippedTotal} profile${alreadyExistsSkippedTotal === 1 ? '' : 's'} already existed and skipped.`;
    } else {
      msg = isJobsImport
        ? "Success! Jobs import finished. If you don't see them in CRM, refresh the Jobs tab."
        : "Success! Nothing new to import (no rows or all missing profile URLs).";
    }
    let finalMsg = msg;
    if (isJobsImport && options.jobs && options.jobs.length) {
      const urlWarn = getJobsJobUrlScrapeWarning(options.jobs);
      if (urlWarn) finalMsg = `${finalMsg}\n\n${urlWarn}`;
    }
    setCrmStatus(finalMsg);
  } else {
    let finalMsg = 'Success! CSV sent to CRM.';
    if (importUrl === CRM_IMPORT_JOBS_URL && options.jobs && options.jobs.length) {
      const urlWarn = getJobsJobUrlScrapeWarning(options.jobs);
      if (urlWarn) finalMsg = `${finalMsg}\n\n${urlWarn}`;
    }
    setCrmStatus(finalMsg);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'auth:state_changed') {
    setAuthUI(request.state);
    return;
  }

  if (request.type === 'users:number') {
    document.getElementById('user_count').textContent = request.response.value;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  // Initial auth state check every time the popup opens.
  chrome.runtime.sendMessage({ type: 'auth:get_state' }, (state) => {
    setAuthUI(state);
  });

  const loginBtn = document.getElementById('login_btn');
  const logoutBtn = document.getElementById('logout_btn');

  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      loginBtn.disabled = true;
      loginBtn.textContent = 'Opening login...';
      chrome.runtime.sendMessage({ type: 'auth:login' }, () => {});
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      logoutBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'auth:logout' }, (resp) => {
        if (resp && resp.state) setAuthUI(resp.state);
      });
    });
  }

  document.getElementById('download_csv').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:download_csv' }, () => {
      updateCount();
    });
  });

  const sendCrmBtn = document.getElementById('send_to_crm');
  if (sendCrmBtn) {
    sendCrmBtn.addEventListener('click', async () => {
      sendCrmBtn.disabled = true;
      setCrmStatus('Checking page...', { show: true });

      const activeUrl = await getActiveTabUrl();

      let messagingUrl;
      try {
        messagingUrl = new URL(activeUrl);
      } catch {
        messagingUrl = null;
      }
      if (
        messagingUrl &&
        messagingUrl.hostname.includes('linkedin.com') &&
        messagingUrl.pathname.includes('/messaging/thread/')
      ) {
        setCrmStatus('Reading conversation...', { show: true });
        const msgResp = await getMessagingThreadFromActiveTab();
        if (!msgResp || !msgResp.ok) {
          setCrmStatus(
            msgResp?.error ||
              'Could not read this thread. Open a 1:1 LinkedIn message and try again.',
          );
          sendCrmBtn.disabled = false;
          return;
        }
        if (!msgResp.lead) {
          setCrmStatus('No lead extracted from this page.');
          sendCrmBtn.disabled = false;
          return;
        }
        await sendLeadsJsonToBackend([msgResp.lead]);
        sendCrmBtn.disabled = false;
        return;
      }

      // If user is on the sent invitations page, scrape directly from DOM
      if (activeUrl.includes(SENT_INVITATIONS_URL_FRAGMENT)) {
        setCrmStatus('Scraping selected invitations...', { show: true });
        const resp = await getSentInvitationsDataFromActiveTab();
        if (!resp || !resp.ok) {
          setCrmStatus(resp?.error || 'Failed to scrape sent invitations. Make sure you are on the LinkedIn Sent Invitations page.');
          sendCrmBtn.disabled = false;
          return;
        }
        if (!resp.leads || !resp.leads.length) {
          setCrmStatus('No invitations selected. Click Extract on invitation rows, then try again.');
          sendCrmBtn.disabled = false;
          return;
        }
        const csv = sentInvitationsToCsv(resp.leads);
        setCrmStatus(`Preparing CSV (${resp.leads.length} leads)...`, { show: true });
        await sendCsvToBackend(csv, CRM_IMPORT_URL);
        sendCrmBtn.disabled = false;
        return;
      }

      setCrmStatus('Preparing CSV...', { show: true });
      const csvResp = await getLeadsCsvData();
      if (!csvResp || !csvResp.ok || !csvResp.csv) {
        setCrmStatus(
          csvResp?.error ||
            'No saved leads to send. Extract profiles on Sales Navigator first, then try again.',
        );
        sendCrmBtn.disabled = false;
        return;
      }

      await sendCsvToBackend(csvResp.csv);
      sendCrmBtn.disabled = false;
    });
  }

  document.getElementById('export_all_jobs').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        const btn = document.getElementById('export_all_jobs');
        const originalText = btn.textContent;
        btn.textContent = 'Scraping...';
        btn.disabled = true;

        chrome.tabs.sendMessage(tabs[0].id, { type: 'popup:export_jobs' }, (response) => {
          if (response && response.ok) {
            btn.textContent = `Scraped ${response.count} jobs!`;
          } else {
            btn.textContent = 'Failed or No jobs found';
          }
          setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
          }, 3000);
        });
      }
    });
  });

  const sendJobsBtn = document.getElementById('send_jobs_to_crm');
  if (sendJobsBtn) {
    sendJobsBtn.addEventListener('click', async () => {
      sendJobsBtn.disabled = true;
      setCrmStatus('Scraping selected jobs...', { show: true });

      const resp = await getJobsDataFromActiveTab();
      if (!resp || !resp.ok) {
        setCrmStatus(resp?.error || 'Failed to scrape jobs. Open a LinkedIn Jobs page and select jobs.');
        sendJobsBtn.disabled = false;
        return;
      }

      if (!resp.jobs || !resp.jobs.length) {
        setCrmStatus(
          'No jobs selected. On each job row, click Extract, or use LinkedIn checkboxes, then try again.',
        );
        sendJobsBtn.disabled = false;
        return;
      }

      const csv = jobsToCsv(resp.jobs);
      setCrmStatus(`Preparing CSV (${resp.jobs.length} jobs)...`, { show: true });
      await sendCsvToBackend(csv, CRM_IMPORT_JOBS_URL, { jobs: resp.jobs });
      sendJobsBtn.disabled = false;
    });
  }

  document.getElementById('clear_data').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:clear_all' }, function() {
      updateCount();
    });
  });
});
