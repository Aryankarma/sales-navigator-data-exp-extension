function updateCount() {
  chrome.storage.local.get('users', (res) => {
    const count = res.users ? Object.keys(res.users).length : 0;
    document.getElementById('user_count').textContent = count;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  updateCount();

  document.getElementById('clear_data').addEventListener('click', () => {
    chrome.storage.local.clear(() => {
      updateCount();
    });
  });
});
