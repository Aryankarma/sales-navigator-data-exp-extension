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

      const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_url'];
      const csvRows = [header.join(',')];

      for (const u of all_users) {
        const row = header.map((key) => {
          let value;
          if (key === 'profile_url') {
            value = u['profile_id'] ? 'https://www.linkedin.com/sales/lead/' + u['profile_id'] : '';
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

    } else if (request.type === 'popup:download_csv') {
      const all_users = Object.values(usersStore);
      if (all_users.length === 0) {
        sendResponse({ ok: false, error: 'No leads selected' });
        return;
      }

      const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_url'];
      const csvRows = [header.join(',')];

      for (const u of all_users) {
        const row = header.map((key) => {
          let value;
          if (key === 'profile_url') {
            value = u['profile_id'] ? 'https://www.linkedin.com/sales/lead/' + u['profile_id'] : '';
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
