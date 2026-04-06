/**
 * Runs in the page's JavaScript world (MAIN) at document_start.
 * Patches history.pushState / replaceState and listens to popstate so we never miss
 * LinkedIn jobs SPA updates to ?currentJobId= — isolated content scripts cannot patch history.
 *
 * Syncs the latest id to document.documentElement[data-le-current-job-id] for the
 * isolated inject script to read. Also postMessages for optional listeners.
 */
(function leJobsHistoryHook() {
  var FLAG = '__leLinkedInJobsHistoryHook';
  if (window[FLAG]) return;
  window[FLAG] = true;

  var MSG_SOURCE = 'LE_JOBS_HISTORY';

  function syncCurrentJobIdFromLocation() {
    var id = '';
    try {
      var u = new URL(location.href);
      id = (u.searchParams.get('currentJobId') || '').trim();
    } catch (e) {
      id = '';
    }
    if (id) {
      document.documentElement.setAttribute('data-le-current-job-id', id);
    } else {
      document.documentElement.removeAttribute('data-le-current-job-id');
    }
    try {
      window.postMessage({ source: MSG_SOURCE, currentJobId: id }, '*');
    } catch (e2) {}
  }

  function wrapHistoryMethod(name) {
    var orig = history[name];
    if (typeof orig !== 'function') return;
    history[name] = function () {
      var ret = orig.apply(this, arguments);
      syncCurrentJobIdFromLocation();
      return ret;
    };
  }

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  window.addEventListener('popstate', syncCurrentJobIdFromLocation);
  syncCurrentJobIdFromLocation();
})();
