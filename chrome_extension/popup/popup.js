function updateCount() {
  chrome.storage.local.get('users', (res) => {
    const count = res.users ? Object.keys(res.users).length : 0;
    document.getElementById('user_count').textContent = count;
  });

  chrome.storage.local.get('companies', (res) => {
    const count = res.companies ? Object.keys(res.companies).length : 0;
    document.getElementById('company_count').textContent = count;
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'users:number') {
    document.getElementById('user_count').textContent = request.response.value;
  }
  if (request.type === 'companies:number') {
    document.getElementById('company_count').textContent = request.response.value;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  updateCount();

  document.getElementById('download_csv').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:download_csv' });
  });

  document.getElementById('download_companies_csv').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:download_companies_csv' });
  });

  document.getElementById('clear_data').addEventListener('click', () => {
    chrome.storage.local.clear(() => {
      updateCount();
    });
  });
});
