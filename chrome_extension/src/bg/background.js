// In-memory stores — wiped every time the service worker restarts or page reloads
let usersStore = {};
let companiesStore = {};

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  (async () => {
    if (request.type === 'extension:lead:add') {
      const lead = request.data;
      usersStore[lead.profile_id] = lead;

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:number',
          response: { value: Object.keys(usersStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:leads:remove') {
      delete usersStore[request.data.profile_id];

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

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:number',
          response: { value: Object.keys(usersStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:users:remove') {
      delete usersStore[request.data.name];

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:number',
          response: { value: Object.keys(usersStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:company:add') {
      const company = request.data;
      companiesStore[company.company_id] = company;

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'companies:number',
          response: { value: Object.keys(companiesStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:companies:remove') {
      delete companiesStore[request.data.company_id];

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'companies:number',
          response: { value: Object.keys(companiesStore).length },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:users:send') {
      const all_users = Object.values(usersStore);

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
          return '"' + String(value).replace(/"/g, '""') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);

      await chrome.downloads.download({
        url,
        filename: 'sales-navigator-leads-export.csv',
        conflictAction: 'uniquify',
        saveAs: true
      });

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'users:sent',
          response: { status: { code: 200 } },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'extension:companies:send') {
      const all_companies = Object.values(companiesStore);
      console.log('[Extension BG] Sending companies CSV, count:', all_companies.length);

      const header = ['name', 'industry', 'revenue', 'employees', 'description', 'website', 'location', 'company_id'];
      const csvRows = [header.join(',')];

      for (const c of all_companies) {
        const row = header.map((key) => {
          const value = c[key] || '';
          return '"' + String(value).replace(/"/g, '""') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);

      await chrome.downloads.download({
        url,
        filename: 'sales-navigator-companies-export.csv',
        conflictAction: 'uniquify',
        saveAs: true
      });

      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'companies:sent',
          response: { status: { code: 200 } },
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'popup:download_csv') {
      const all_users = Object.values(usersStore);

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
          return '"' + String(value).replace(/"/g, '""') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);

      await chrome.downloads.download({
        url,
        filename: 'sales-navigator-leads-export.csv',
        conflictAction: 'uniquify',
        saveAs: true
      });

    } else if (request.type === 'popup:download_companies_csv') {
      const all_companies = Object.values(companiesStore);

      const header = ['name', 'industry', 'revenue', 'employees', 'description', 'website', 'location', 'company_id'];
      const csvRows = [header.join(',')];

      for (const c of all_companies) {
        const row = header.map((key) => {
          const value = c[key] || '';
          return '"' + String(value).replace(/"/g, '""') + '"';
        });
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\r\n');
      const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);

      await chrome.downloads.download({
        url,
        filename: 'sales-navigator-companies-export.csv',
        conflictAction: 'uniquify',
        saveAs: true
      });

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
      if (sender.tab) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'cleared',
          callback_id: request.callback_id
        });
      }

    } else if (request.type === 'popup:clear_all') {
      usersStore = {};
      companiesStore = {};
      sendResponse({ ok: true });
    }
  })();
  return true;
});
