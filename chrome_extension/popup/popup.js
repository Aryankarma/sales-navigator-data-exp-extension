function updateCount() {
  chrome.runtime.sendMessage({ type: 'popup:get_counts' }, function(response) {
    if (response) {
      document.getElementById('user_count').textContent = response.users || 0;
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'users:number') {
    document.getElementById('user_count').textContent = request.response.value;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  updateCount();

  document.getElementById('download_csv').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:download_csv' }, () => {
      updateCount();
    });
  });

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

  document.getElementById('clear_data').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:clear_all' }, function() {
      updateCount();
    });
  });
});
