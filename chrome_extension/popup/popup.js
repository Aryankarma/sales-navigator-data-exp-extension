function updateCount() {
  chrome.runtime.sendMessage({ type: 'popup:get_counts' }, function(response) {
    if (response) {
      document.getElementById('user_count').textContent = response.users || 0;
      document.getElementById('company_count').textContent = response.companies || 0;
    }
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
    chrome.runtime.sendMessage({ type: 'popup:download_csv' }, () => {
      updateCount();
    });
  });

  document.getElementById('download_companies_csv').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:download_companies_csv' }, () => {
      updateCount();
    });
  });

  document.getElementById('clear_data').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:clear_all' }, function() {
      updateCount();
    });
  });
});
