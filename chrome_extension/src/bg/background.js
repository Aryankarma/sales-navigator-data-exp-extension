// -----------------------------
// Cookie-based auth (MV3)
// -----------------------------
const AUTH_BASE_URL = 'https://alpha-foundry.alphanext.tech';
const AUTH_LOGIN_URL = `${AUTH_BASE_URL}/login`;
const AUTH_ME_URL = `${AUTH_BASE_URL}/api/me`;
const AUTH_LOGOUT_URL = `${AUTH_BASE_URL}/api/logout`;

const AUTH_POLL_INTERVAL_MS = 2000;
const AUTH_POLL_TIMEOUT_MS = 120000; // 2 minutes
const AUTH_STATE_CACHE_TTL_MS = 10000;

let authState = {
  status: 'unknown', // 'unknown' | 'authenticated' | 'unauthenticated' | 'pending'
  authenticated: false,
  user: null,
  lastCheckedAt: 0,
  lastError: null
};

let loginFlowInProgress = false;
let loginFlowPromise = null;
let authCheckPromise = null;

function getCurrentAuthState() {
  return {
    status: authState.status,
    authenticated: authState.authenticated,
    user: authState.user
  };
}

function notifyPopupAuthState() {
  // Note: popup will request state on open; this is best-effort live updates.
  chrome.runtime.sendMessage({
    type: 'auth:state_changed',
    state: getCurrentAuthState()
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTrustedAuthUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === AUTH_BASE_URL;
  } catch {
    return false;
  }
}

async function parseResponseBody(resp) {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return await resp.json();
  return await resp.text();
}

// Always includes cookies (httpOnly) via credentials: 'include'
// This is the single helper the extension uses for authenticated API calls.
async function fetchWithAuth(url, options = {}, { handleUnauthorized = true } = {}) {
  if (!isTrustedAuthUrl(url)) {
    const err = new Error('Untrusted URL');
    err.code = 'UNTRUSTED_URL';
    throw err;
  }

  const resp = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (resp.status === 401) {
    if (handleUnauthorized) {
      authState = {
        status: 'unauthenticated',
        authenticated: false,
        user: null,
        lastCheckedAt: Date.now(),
        lastError: 'unauthorized'
      };
      notifyPopupAuthState();
      const err = new Error('Unauthorized');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    return resp;
  }

  return resp;
}

async function checkAuthState({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - authState.lastCheckedAt < AUTH_STATE_CACHE_TTL_MS && authState.status !== 'unknown') {
    return getCurrentAuthState();
  }

  if (authCheckPromise) return authCheckPromise;

  authCheckPromise = (async () => {
    try {
      const resp = await fetchWithAuth(AUTH_ME_URL, { method: 'GET' });
      const user = await parseResponseBody(resp);
      authState = {
        status: 'authenticated',
        authenticated: true,
        user,
        lastCheckedAt: Date.now(),
        lastError: null
      };
      return getCurrentAuthState();
    } catch (err) {
      // fetchWithAuth already marks unauthenticated on 401.
      if (err && err.code === 'UNAUTHORIZED') {
        return getCurrentAuthState();
      }

      authState = {
        status: 'unauthenticated',
        authenticated: false,
        user: null,
        lastCheckedAt: Date.now(),
        lastError: err?.message || 'auth_check_failed'
      };
      notifyPopupAuthState();
      return getCurrentAuthState();
    } finally {
      authCheckPromise = null;
    }
  })();

  return authCheckPromise;
}

async function performLoginAndWait() {
  if (loginFlowInProgress) return loginFlowPromise;
  loginFlowInProgress = true;

  authState = {
    status: 'pending',
    authenticated: false,
    user: null,
    lastCheckedAt: Date.now(),
    lastError: null
  };
  notifyPopupAuthState();

  // Open web app login page in a new tab.
  await chrome.tabs.create({ url: AUTH_LOGIN_URL });

  loginFlowPromise = (async () => {
    const start = Date.now();
    while (Date.now() - start < AUTH_POLL_TIMEOUT_MS) {
      try {
        // Polling works regardless of how Better Auth redirects.
        // During login, 401 is expected; we avoid flipping auth state away from 'pending'.
        const resp = await fetchWithAuth(AUTH_ME_URL, { method: 'GET' }, { handleUnauthorized: false });

        if (resp.status === 401) {
          await delay(AUTH_POLL_INTERVAL_MS);
          continue;
        }

        if (!resp.ok) {
          await delay(AUTH_POLL_INTERVAL_MS);
          continue;
        }

        const user = await parseResponseBody(resp);
        authState = {
          status: 'authenticated',
          authenticated: true,
          user,
          lastCheckedAt: Date.now(),
          lastError: null
        };
        notifyPopupAuthState();
        return getCurrentAuthState();
      } catch (err) {
        // Network/CORS/etc. Keep polling until timeout.
      }
    }

    authState = {
      status: 'unauthenticated',
      authenticated: false,
      user: null,
      lastCheckedAt: Date.now(),
      lastError: 'login_timeout'
    };
    notifyPopupAuthState();
    return getCurrentAuthState();
  })();

  try {
    return await loginFlowPromise;
  } finally {
    loginFlowInProgress = false;
    loginFlowPromise = null;
  }
}

async function performLogout() {
  try {
    // Prefer POST; fallback to GET if your backend expects that.
    const resp = await fetchWithAuth(AUTH_LOGOUT_URL, { method: 'POST' }).catch(async () => {
      return await fetchWithAuth(AUTH_LOGOUT_URL, { method: 'GET' });
    });

    if (resp && resp.status !== 204) {
      // We don't need response body for logout; but parse to consume stream.
      await parseResponseBody(resp);
    }
  } catch (err) {
    // 401 is fine; it just means user is already logged out.
  }

  authState = {
    status: 'unauthenticated',
    authenticated: false,
    user: null,
    lastCheckedAt: Date.now(),
    lastError: null
  };
  notifyPopupAuthState();
  return getCurrentAuthState();
}

// -----------------------------
// Persistent stores (existing)
// -----------------------------
// Persistent stores using chrome.storage.local
let usersStore = {};
let companiesStore = {};

// Initialize stores from storage on startup
chrome.storage.local.get(['usersStore', 'companiesStore'], (result) => {
  usersStore = result.usersStore || {};
  companiesStore = result.companiesStore || {};
  console.log('[Extension BG] Stores initialized. Users:', Object.keys(usersStore).length, 'Companies:', Object.keys(companiesStore).length);
});

// Helper to persist changes
async function syncToStorage() {
  await chrome.storage.local.set({ usersStore, companiesStore });
}

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  (async () => {
    if (request.type === 'auth:get_state') {
      const state = await checkAuthState({ force: request.data && request.data.force === true });
      sendResponse(state);
      return;
    }

    if (request.type === 'auth:login') {
      // Start login flow; popup will receive `auth:state_changed` updates.
      void performLoginAndWait().catch(() => {});
      sendResponse({ ok: true, state: getCurrentAuthState() });
      return;
    }

    if (request.type === 'auth:logout') {
      const state = await performLogout();
      sendResponse({ ok: true, state });
      return;
    }

    // Generic authenticated API bridge for extension pages.
    // Usage example (from popup or content scripts):
    // chrome.runtime.sendMessage({ type:'auth:fetch', data:{ path:'/api/data', method:'POST', body:{...} } })
    // For large POST bodies (e.g. LinkedIn thread JSON), pass bodyStorageKey: staging key in chrome.storage.local
    // whose value is a pre-stringified JSON body — avoids sendMessage structured-clone / size limits.
    if (request.type === 'auth:fetch') {
      const { path, url, method = 'GET', body, headers, bodyStorageKey } = request.data || {};

      const targetUrl = url || (path ? `${AUTH_BASE_URL}${path}` : null);
      if (!targetUrl || !isTrustedAuthUrl(targetUrl)) {
        sendResponse({ ok: false, status: 400, error: 'Invalid target URL' });
        return;
      }

      const fetchOptions = {
        method: method.toUpperCase(),
        headers: headers || {}
      };

      if (bodyStorageKey) {
        const store = await chrome.storage.local.get(bodyStorageKey);
        const raw = store[bodyStorageKey];
        await chrome.storage.local.remove(bodyStorageKey);
        if (raw == null || typeof raw !== 'string') {
          sendResponse({ ok: false, status: 400, error: 'Missing staged request body' });
          return;
        }
        fetchOptions.body = raw;
      } else if (body !== undefined && body !== null) {
        fetchOptions.body = JSON.stringify(body);
      }

      try {
        const resp = await fetchWithAuth(targetUrl, fetchOptions);
        const data = resp.status === 204 ? null : await parseResponseBody(resp);
        try {
          sendResponse({ ok: resp.ok, status: resp.status, data });
        } catch (cloneErr) {
          sendResponse({
            ok: false,
            status: 500,
            error: 'Response could not be delivered to the page (try popup).'
          });
        }
      } catch (err) {
        if (err && err.code === 'UNAUTHORIZED') {
          sendResponse({ ok: false, status: 401, error: 'Unauthorized', loggedOut: true });
          return;
        }
        sendResponse({ ok: false, status: 500, error: err?.message || 'auth_fetch_failed' });
      }
      return;
    }

    if (request.type === 'extension:lead:add') {
      const lead = request.data;
      console.log('[Extension BG] Lead added:', lead.name, '| Store count:', Object.keys(usersStore).length + 1);
      usersStore[lead.profile_id] = lead;
      await syncToStorage();

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:number',
          response: { value: Object.keys(usersStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:leads:remove') {
      delete usersStore[request.data.profile_id];
      await syncToStorage();

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:number',
          response: { value: Object.keys(usersStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:users:add') {
      const user = request.data;
      usersStore[user.name] = user;
      await syncToStorage();

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:number',
          response: { value: Object.keys(usersStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:users:remove') {
      delete usersStore[request.data.name];
      await syncToStorage();

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:number',
          response: { value: Object.keys(usersStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:company:add') {
      const company = request.data;
      console.log('[Extension BG] Company added:', company.name, '| Store count:', Object.keys(companiesStore).length + 1);
      companiesStore[company.company_id] = company;
      await syncToStorage();

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'companies:number',
          response: { value: Object.keys(companiesStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:companies:remove') {
      delete companiesStore[request.data.company_id];
      await syncToStorage();

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'companies:number',
          response: { value: Object.keys(companiesStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:users:send') {
      const all_users = Object.values(usersStore);
      console.log('[Extension BG] Exporting leads, count:', all_users.length);

      if (all_users.length === 0) {
        console.warn('[Extension BG] No leads found to export.');
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'users:sent',
            response: { status: { code: 400, message: 'No leads selected' } },
            callback_id: request.callback_id
          });
        }
        return;
      }

      const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_url', 'lead_source'];
      const csvRows = [header.join(',')];

      for (const u of all_users) {
        const row = header.map((key) => {
          let value;
          if (key === 'profile_url') {
            // Prefer the captured LinkedIn URL (e.g. /in/slug/) when available.
            // Fallback to Sales Navigator lead URL for legacy data.
            value = u['profile_url'] || (u['profile_id'] ? 'https://www.linkedin.com/sales/lead/' + u['profile_id'] : '');
          } else {
            value = u[key] || '';
          }
          return '"' + String(value).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);

      try {
        await chrome.downloads.download({
          url,
          filename: 'sales-navigator-leads-export.csv',
          conflictAction: 'uniquify',
          saveAs: true
        });

        // Clear the store after successful download initiation
        usersStore = {};
        await syncToStorage();

        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'users:sent',
            response: { status: { code: 200 } },
            callback_id: request.callback_id
          });
        }
      } catch (err) {
        console.error('[Extension BG] Leads download failed:', err);
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'users:sent',
            response: { status: { code: 500, message: err.message } },
            callback_id: request.callback_id
          });
        }
      }

    } else if (request.type === 'extension:companies:send') {
      const all_companies = Object.values(companiesStore);
      console.log('[Extension BG] Exporting companies, count:', all_companies.length);

      if (all_companies.length === 0) {
        console.warn('[Extension BG] No companies found to export.');
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'companies:sent',
            response: { status: { code: 400, message: 'No companies selected' } },
            callback_id: request.callback_id
          });
        }
        return;
      }

      const header = ['name', 'industry', 'revenue', 'employees', 'description', 'website', 'location', 'company_url'];
      const csvRows = [header.join(',')];

      for (const c of all_companies) {
        const row = header.map((key) => {
          let value;
          if (key === 'company_url') {
            value = c['company_id'] ? 'https://www.linkedin.com/sales/company/' + c['company_id'] : '';
          } else {
            value = c[key] || '';
          }
          return '"' + String(value).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);

      try {
        await chrome.downloads.download({
          url,
          filename: 'sales-navigator-companies-export.csv',
          conflictAction: 'uniquify',
          saveAs: true
        });

        // Clear the store after successful download initiation
        companiesStore = {};
        await syncToStorage();

        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'companies:sent',
            response: { status: { code: 200 } },
            callback_id: request.callback_id
          });
        }
      } catch (err) {
        console.error('[Extension BG] Companies download failed:', err);
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'companies:sent',
            response: { status: { code: 500, message: err.message } },
            callback_id: request.callback_id
          });
        }
      }

    } else if (request.type === 'popup:export_leads_csv_data') {
      const all_users = Object.values(usersStore);
      if (all_users.length === 0) {
        sendResponse({ ok: false, error: 'No leads selected' });
        return;
      }

      const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_url', 'lead_source'];
      const csvRows = [header.join(',')];

      for (const u of all_users) {
        const row = header.map((key) => {
          let value;
          if (key === 'profile_url') {
            value = u['profile_url'] || (u['profile_id'] ? 'https://www.linkedin.com/sales/lead/' + u['profile_id'] : '');
          } else {
            value = u[key] || '';
          }
          return '"' + String(value).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = '\uFEFF' + csvRows.join('\r\n');
      sendResponse({ ok: true, csv });

    } else if (request.type === 'popup:download_csv') {
      const all_users = Object.values(usersStore);
      if (all_users.length === 0) {
        sendResponse({ ok: false, error: 'No leads selected' });
        return;
      }

      const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_url', 'lead_source'];
      const csvRows = [header.join(',')];

      for (const u of all_users) {
        const row = header.map((key) => {
          let value;
          if (key === 'profile_url') {
            value = u['profile_url'] || (u['profile_id'] ? 'https://www.linkedin.com/sales/lead/' + u['profile_id'] : '');
          } else {
            value = u[key] || '';
          }
          return '"' + String(value).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);

      try {
        await chrome.downloads.download({
          url,
          filename: 'sales-navigator-leads-export.csv',
          conflictAction: 'uniquify',
          saveAs: true
        });

        // Clear the store after export
        usersStore = {};
        await syncToStorage();
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[Extension BG] Popup download failed:', err);
        sendResponse({ ok: false, error: err.message });
      }

    } else if (request.type === 'popup:download_companies_csv') {
      const all_companies = Object.values(companiesStore);
      if (all_companies.length === 0) {
        sendResponse({ ok: false, error: 'No companies selected' });
        return;
      }

      const header = ['name', 'industry', 'revenue', 'employees', 'description', 'website', 'location', 'company_url'];
      const csvRows = [header.join(',')];

      for (const c of all_companies) {
        const row = header.map((key) => {
          let value;
          if (key === 'company_url') {
            value = c['company_id'] ? 'https://www.linkedin.com/sales/company/' + c['company_id'] : '';
          } else {
            value = c[key] || '';
          }
          return '"' + String(value).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);

      try {
        await chrome.downloads.download({
          url,
          filename: 'sales-navigator-companies-export.csv',
          conflictAction: 'uniquify',
          saveAs: true
        });

        // Clear the store after export
        companiesStore = {};
        await syncToStorage();
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[Extension BG] Popup download failed:', err);
        sendResponse({ ok: false, error: err.message });
      }

    } else if (request.type === 'popup:get_counts') {
      sendResponse({
        users: Object.keys(usersStore).length,
        companies: Object.keys(companiesStore).length
      });

    } else if (request.type === 'extension:get_count') {
      const isCompany = request.data && request.data.type === 'companies';
      const count = isCompany ? Object.keys(companiesStore).length : Object.keys(usersStore).length;
      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: isCompany ? 'companies:number' : 'users:number',
          response: { value: count },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:clear_all') {
      usersStore = {};
      companiesStore = {};
      await syncToStorage();
      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'cleared',
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:jobs:send') {
      const all_jobs = request.data || [];
      console.log('[Extension BG] Exporting jobs, count:', all_jobs.length);

      if (all_jobs.length === 0) {
        console.warn('[Extension BG] No jobs found to export.');
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'jobs:sent',
            response: { status: { code: 400, message: 'No jobs found on page' } },
            callback_id: request.callback_id
          });
        }
        return;
      }

      const header = ['title', 'company', 'location', 'posted', 'link'];
      const csvRows = [header.join(',')];

      for (const j of all_jobs) {
        const row = header.map((key) => {
          const value = j[key] || '';
          return '"' + String(value).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);

      try {
        await chrome.downloads.download({
          url,
          filename: 'linkedin-jobs-export.csv',
          conflictAction: 'uniquify',
          saveAs: true
        });

        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'jobs:sent',
            response: { status: { code: 200 } },
            callback_id: request.callback_id
          });
        }
      } catch (err) {
        console.error('[Extension BG] Jobs download failed:', err);
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            type: 'jobs:sent',
            response: { status: { code: 500, message: err.message } },
            callback_id: request.callback_id
          });
        }
      }

    } else if (request.type === 'popup:clear_all') {
      usersStore = {};
      companiesStore = {};
      await syncToStorage();
      sendResponse({ ok: true });
    }
  })();
  return true;
});
