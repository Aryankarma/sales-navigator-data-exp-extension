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

    const header = ['name', 'firstName', 'lastName', 'company', 'company_id', 'title'];
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
      filename: 'sales-navigator-export.csv',
      conflictAction: 'uniquify',
      saveAs: true
    });

    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'users:sent',
      response: {status: {code: 200}},
      callback_id: request.callback_id
    });

  } else if (request.type === 'extension:company:add') {
    const company = request.data;
    const company_obj = await chrome.storage.local.get(COMPANIES_KEY);
    const companies = company_obj[COMPANIES_KEY] || {};

    companies[company.company_id] = company;
    await chrome.storage.local.set({[COMPANIES_KEY]: companies});
  }
});
