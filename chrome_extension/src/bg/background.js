const USERS_KEY = 'users';
const COMPANIES_KEY = 'companies';

chrome.runtime.onMessage.addListener(async function(request, sender) {
  if (request.type === 'extension:users:add') {
    const user = request.data;
    const user_obj = await chrome.storage.local.get(USERS_KEY);
    const users = user_obj[USERS_KEY] || {};
    users[user.name] = user;

    await chrome.storage.local.set({[USERS_KEY]: users});
    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'users:number',
      response: {value: Object.keys(users).length},
      callback_id: request.callback_id
    });

  } else if (request.type === 'extension:company:add') {
    const company = request.data;
    const company_obj = await chrome.storage.local.get(COMPANIES_KEY);
    const companies = company_obj[COMPANIES_KEY] || {};
    companies[company.company_id] = company;

    await chrome.storage.local.set({[COMPANIES_KEY]: companies});
    
    if (sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: 'companies:number',
        response: {value: Object.keys(companies).length},
        callback_id: request.callback_id
      });
    }
  } else if (request.type === 'extension:companies:remove') {
    const company_id = request.data.company_id;
    const company_obj = await chrome.storage.local.get(COMPANIES_KEY);
    const companies = company_obj[COMPANIES_KEY] || {};

    delete companies[company_id];
    await chrome.storage.local.set({[COMPANIES_KEY]: companies});

    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'companies:number',
      response: {value: Object.keys(companies).length},
      callback_id: request.callback_id
    });
  } else if (request.type === 'extension:lead:add') {
    // DOM-scraped lead from people search
    const lead = request.data;
    const user_obj = await chrome.storage.local.get(USERS_KEY);
    const users = user_obj[USERS_KEY] || {};
    users[lead.profile_id] = lead;

    await chrome.storage.local.set({[USERS_KEY]: users});

    if (sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: 'users:number',
        response: {value: Object.keys(users).length},
        callback_id: request.callback_id
      });
    }

  } else if (request.type === 'extension:leads:remove') {
    const profile_id = request.data.profile_id;
    const user_obj = await chrome.storage.local.get(USERS_KEY);
    const users = user_obj[USERS_KEY] || {};

    delete users[profile_id];
    await chrome.storage.local.set({[USERS_KEY]: users});

    if (sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: 'users:number',
        response: {value: Object.keys(users).length},
        callback_id: request.callback_id
      });
    }

  } else if (request.type === 'extension:users:remove') {
    const user = request.data;
    const user_obj = await chrome.storage.local.get(USERS_KEY);
    const users = user_obj[USERS_KEY] || {};

    delete users[user.name];
    await chrome.storage.local.set({[USERS_KEY]: users});

    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'users:number',
      response: {value: Object.keys(users).length},
      callback_id: request.callback_id
    });

  } else if (request.type === 'extension:users:send') {
    const user_obj = await chrome.storage.local.get(USERS_KEY);
    const all_users = Object.values(user_obj[USERS_KEY] || {});

    const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_id'];
    const csvRows = [header.join(',')];

    for (const u of all_users) {
      const row = header.map((key) => {
        const value = u[key] || '';
        const escaped = String(value).replace(/"/g, '""');
        return `"${escaped}"`;
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

    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'users:sent',
      response: {status: {code: 200}},
      callback_id: request.callback_id
    });

  } else if (request.type === 'extension:companies:send') {
    const company_obj = await chrome.storage.local.get(COMPANIES_KEY);
    const all_companies = Object.values(company_obj[COMPANIES_KEY] || {});

    console.log('[Extension BG] Sending companies CSV, count:', all_companies.length);

    const header = ['name', 'industry', 'revenue', 'employees', 'description', 'website', 'location', 'company_id'];
    const csvRows = [header.join(',')];

    for (const c of all_companies) {
      const row = header.map((key) => {
        const value = c[key] || '';
        const escaped = String(value).replace(/"/g, '""');
        return `"${escaped}"`;
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

    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'companies:sent',
      response: {status: {code: 200}},
      callback_id: request.callback_id
    });
  } else if (request.type === 'popup:download_csv') {
    const user_obj = await chrome.storage.local.get(USERS_KEY);
    const all_users = Object.values(user_obj[USERS_KEY] || {});

    const header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_id'];
    const csvRows = [header.join(',')];

    for (const u of all_users) {
      const row = header.map((key) => {
        const value = u[key] || '';
        const escaped = String(value).replace(/"/g, '""');
        return `"${escaped}"`;
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
    const company_obj = await chrome.storage.local.get(COMPANIES_KEY);
    const all_companies = Object.values(company_obj[COMPANIES_KEY] || {});

    const header = ['name', 'industry', 'revenue', 'employees', 'description', 'website', 'location', 'company_id'];
    const csvRows = [header.join(',')];

    for (const c of all_companies) {
      const row = header.map((key) => {
        const value = c[key] || '';
        const escaped = String(value).replace(/"/g, '""');
        return `"${escaped}"`;
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
  }
});
