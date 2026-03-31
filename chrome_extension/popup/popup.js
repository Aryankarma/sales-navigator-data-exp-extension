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
// Backend enforces MAX_CSV_BYTES = 2 * 1024 * 1024 (UTF-8 bytes)
// Add more headroom and split big exports to avoid upstream request-size/timeouts
// that can surface as 503.
const MAX_CRM_CSV_BYTES = 2 * 1024 * 1024;
const MAX_CRM_CSV_BYTES_SAFE = 1 * 1024 * 1024; // ~1MB per request

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
    if (ct.includes('application/json')) return await res.json();
  } catch {
    // ignore; fallback to text
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
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
  const header = ['title', 'company', 'location', 'posted', 'link'];
  const rows = [header.join(',')];
  for (const j of (jobs || [])) {
    const row = header.map((k) => escapeCsvCell(j?.[k] || ''));
    rows.push(row.join(','));
  }
  return rows.join('\r\n');
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

async function sendCsvToBackend(csvData, importUrl = CRM_IMPORT_URL) {
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

  // Step 2: send CSV
  const csvBytes = new Blob([csvData]).size;
  const chunks = csvBytes > MAX_CRM_CSV_BYTES_SAFE
    ? splitCsvIntoChunksByByteSize(csvData, MAX_CRM_CSV_BYTES_SAFE)
    : [csvData];

  if (chunks.length > 1) {
    setCrmStatus(`CSV is large (${Math.round(csvBytes / 1024)} KB). Sending in ${chunks.length} chunks...`);
  } else {
    setCrmStatus('Sending to CRM...', { show: true });
  }

  let importedTotal = 0;

  for (let i = 0; i < chunks.length; i++) {
    const maxAttempts = 3;
    let chunkSucceeded = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      setCrmStatus(
        `Sending chunk ${i + 1}/${chunks.length}... (attempt ${attempt}/${maxAttempts})`
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
        // Expected JSON: { success: true, imported: number }
        const data = await parseResponseBodyMaybe(res);
        if (data && typeof data.imported === 'number') importedTotal += data.imported;
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

  setCrmStatus(`Success! CSV sent to CRM${importedTotal ? ` (imported ${importedTotal} leads)` : ''}.`);
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

  // Existing export UI (only enabled when authenticated).

  document.getElementById('download_csv').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:download_csv' }, () => {
      updateCount();
    });
  });

  const sendCrmBtn = document.getElementById('send_to_crm');
  if (sendCrmBtn) {
    sendCrmBtn.addEventListener('click', async () => {
      sendCrmBtn.disabled = true;
      setCrmStatus('Preparing CSV...', { show: true });

      const csvResp = await getLeadsCsvData();
      if (!csvResp || !csvResp.ok || !csvResp.csv) {
        setCrmStatus(csvResp?.error || 'No CSV data to send. Please export leads first.');
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
      await sendCsvToBackend(csv, CRM_IMPORT_JOBS_URL);
      sendJobsBtn.disabled = false;
    });
  }

  document.getElementById('clear_data').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:clear_all' }, function() {
      updateCount();
    });
  });
});
