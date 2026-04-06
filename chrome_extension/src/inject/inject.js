// Add monkey patch to catch requests
var s = document.createElement('script');
s.src = chrome.runtime.getURL("src/inject/interceptRequest.js");
s.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(s);

// CRM `lead_source` CSV column — keep in sync with Alpha-Foundry `lib/crm/extension-lead-source.ts`
var EXTENSION_LEAD_SOURCE = {
  LINKEDIN_CONNECTION: 'linkedin_connection',
  /** 1:1 messaging thread — keep in sync with Alpha-Foundry `EXTENSION_LEAD_SOURCE_SLUGS.LINKEDIN_CONNECTION_MESSAGES` */
  LINKEDIN_CONNECTION_MESSAGES: 'linkedin_connection_messages',
  LINKEDIN_SENT_INVITATIONS: 'linkedin_sent_invitations',
  LINKEDIN_SALES_LIST: 'linkedin_sales_list',
  LINKEDIN_SALES_SEARCH: 'linkedin_sales_search'
};

function is_messaging_thread_page() {
  try {
    return /\/messaging\/thread\//i.test(window.location.pathname || '');
  } catch (e) {
    return false;
  }
}

/**
 * Scrape open LinkedIn 1:1 thread: counterparty profile card + all visible messages.
 * DOM: `.msg-s-profile-card`, `li.msg-s-message-list__event` / `.msg-s-event-listitem`.
 */
function scrape_messaging_thread_for_crm() {
  var $root = $('.msg-s-message-list-container, .msg-s-message-list').first();
  if (!$root.length) {
    return { ok: false, error: 'Message list not found. Open a conversation first.' };
  }

  var $card = $('.msg-s-profile-card').first();
  if (!$card.length) {
    return { ok: false, error: 'Profile card not found in this thread.' };
  }

  var $nameEl = $card.find('.profile-card-one-to-one__profile-link .truncate').first();
  if (!$nameEl.length) {
    $nameEl = $card.find('.artdeco-entity-lockup__title a span.truncate').first();
  }
  var name = $.trim($nameEl.text()) || '';

  var $profileLink = $card.find('a.profile-card-one-to-one__profile-link[href*="/in/"]').first();
  if (!$profileLink.length) {
    $profileLink = $card.find('a[href*="/in/"]').first();
  }
  var href = ($profileLink.attr('href') || '').trim();
  if (!href) {
    return { ok: false, error: 'Could not read profile URL from thread header.' };
  }
  var profileUrl;
  try {
    profileUrl = new URL(href, window.location.origin).href;
  } catch (err) {
    profileUrl = href.indexOf('http') === 0 ? href : 'https://www.linkedin.com' + (href.indexOf('/') === 0 ? '' : '/') + href;
  }

  var $sub = $card.find('.artdeco-entity-lockup__subtitle div').first();
  var title = $.trim($sub.attr('title') || $sub.text() || '');

  var connectionDegree = '';
  var $degA11y = $card.find('.a11y-text').filter(function () {
    return /connection/i.test($(this).text() || '');
  }).first();
  if ($degA11y.length) connectionDegree = $.trim($degA11y.text());
  if (!connectionDegree) {
    connectionDegree = $.trim($card.find('.artdeco-entity-lockup__degree').text() || '');
  }

  var listReversed = $('.msg-s-message-list-container').is('.msg-s-message-list-container--column-reversed');

  var messages = [];
  var currentDateHeading = '';
  var $content = $root.find('ul.msg-s-message-list-content').first();
  if (!$content.length) $content = $root;

  $content.children('li').each(function () {
    var $li = $(this);
    var $dh = $li.children('time.msg-s-message-list__time-heading');
    if ($dh.length) {
      currentDateHeading = $.trim($dh.first().text() || '');
    }

    if ($li.find('.msg-s-profile-card').length && !$li.find('.msg-s-event-listitem').length) {
      return;
    }

    var $event = $li.find('.msg-s-event-listitem').first();
    if (!$event.length) return;

    var isOther = $event.hasClass('msg-s-event-listitem--other');
    var from = $.trim($event.find('.msg-s-message-group__name').first().text() || '');
    var time = $.trim($event.find('.msg-s-message-group__timestamp').first().text() || '');
    var body = $.trim($event.find('.msg-s-event-listitem__body').first().text() || '');
    var attachments = [];
    $event.find('.ui-attachment__filename').each(function () {
      var t = $.trim($(this).text() || '');
      if (t) attachments.push(t);
    });

    var eventUrn = $event.attr('data-event-urn') || '';

    messages.push({
      from: from,
      isOther: isOther,
      time: time,
      dateHeading: currentDateHeading,
      body: body,
      attachments: attachments,
      eventUrn: eventUrn
    });
  });

  var conversation = {
    threadUrl: window.location.href,
    scrapedAt: new Date().toISOString(),
    listReversed: listReversed,
    note:
      'Only messages currently loaded in the page DOM are included. Scroll the thread to load older messages, then send again to refresh.',
    profile: {
      name: name,
      title: title,
      profileUrl: profileUrl,
      connectionDegree: connectionDegree
    },
    messages: messages
  };

  var lead = {
    name: name || null,
    title: title || null,
    company: null,
    companyId: null,
    location: null,
    /** Thread text lives in `conversation` / CRM timeline only — not duplicated in about. */
    about: null,
    tenure: null,
    profileUrl: profileUrl,
    leadSource: EXTENSION_LEAD_SOURCE.LINKEDIN_CONNECTION_MESSAGES,
    conversation: conversation
  };

  return { ok: true, lead: lead };
}

function post_messaging_lead_to_crm(done) {
  var scraped = scrape_messaging_thread_for_crm();
  if (!scraped.ok) {
    if (typeof done === 'function') done(scraped);
    return;
  }
  try {
    if (chrome.runtime && chrome.runtime.id) {
      var payloadStr;
      try {
        payloadStr = JSON.stringify({ leads: [scraped.lead] });
      } catch (stringifyErr) {
        if (typeof done === 'function') {
          done({ ok: false, error: (stringifyErr && stringifyErr.message) || 'Could not serialize lead' });
        }
        return;
      }
      var stageKey = 'crm_import_body_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
      var setObj = {};
      setObj[stageKey] = payloadStr;
      chrome.storage.local.set(setObj, function () {
        if (chrome.runtime.lastError) {
          if (typeof done === 'function') {
            done({ ok: false, error: chrome.runtime.lastError.message || 'storage failed' });
          }
          return;
        }
        chrome.runtime.sendMessage(
          {
            type: 'auth:fetch',
            data: {
              path: '/api/crm/import',
              method: 'POST',
              bodyStorageKey: stageKey
            }
          },
          function (rsp) {
            if (chrome.runtime.lastError) {
              if (typeof done === 'function') {
                done({ ok: false, error: chrome.runtime.lastError.message || 'No response from extension' });
              }
              return;
            }
            if (typeof done === 'function') done(rsp);
          }
        );
      });
    } else if (typeof done === 'function') {
      done({ ok: false, error: 'Extension runtime unavailable' });
    }
  } catch (ex) {
    if (typeof done === 'function') done({ ok: false, error: (ex && ex.message) || 'send failed' });
  }
}

function ensure_messaging_thread_crm_ui() {
  if (!is_messaging_thread_page()) return;
  if (document.getElementById('ext-messaging-crm-root')) return;

  var root = document.createElement('div');
  root.id = 'ext-messaging-crm-root';

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ext-messaging-crm-btn';
  btn.textContent = 'Send this chat to CRM';
  btn.title = 'Imports the other person’s profile + full visible thread as one lead (linkedin_connection_messages).';

  var status = document.createElement('div');
  status.className = 'ext-messaging-crm-status';
  status.setAttribute('aria-live', 'polite');

  btn.addEventListener('click', function () {
    btn.disabled = true;
    status.textContent = 'Sending...';
    var sendFinished = false;
    var timeoutId = setTimeout(function () {
      if (sendFinished) return;
      sendFinished = true;
      btn.disabled = false;
      status.textContent =
        'Timed out. Open the extension popup → Send to CRM, or check login and network.';
    }, 90000);
    post_messaging_lead_to_crm(function (rsp) {
      if (sendFinished) return;
      sendFinished = true;
      clearTimeout(timeoutId);
      btn.disabled = false;
      if (rsp && rsp.ok && rsp.data && typeof rsp.data === 'object') {
        var imp = Number(rsp.data.imported);
        var skip = Number(rsp.data.alreadyExistsSkipped);
        if (Number.isFinite(imp) && imp > 0) status.textContent = 'Saved to CRM (' + imp + ' new).';
        else if (Number.isFinite(skip) && skip > 0) status.textContent = 'Already in CRM (same profile URL).';
        else if (rsp.data.success) status.textContent = 'Done.';
        else status.textContent = 'Unexpected response from CRM.';
      } else if (rsp && rsp.status === 401) {
        status.textContent = 'Log in to Alpha Foundry (extension popup).';
      } else {
        var err =
          rsp && rsp.data && rsp.data.error
            ? rsp.data.error
            : rsp && rsp.error
              ? rsp.error
              : 'Send failed';
        status.textContent = String(err).slice(0, 120);
      }
    });
  });

  root.appendChild(btn);
  root.appendChild(status);
  document.body.appendChild(root);
}

// Handle callbacks from background script
var callbacks = {};
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (callbacks[request.callback_id]) {
    callbacks[request.callback_id](request);
  }

  if (request.type === 'popup:export_jobs') {
    const jobs = scrape_all_jobs();
    console.log('[Extension] Scraped jobs:', jobs.length);
    chrome.runtime.sendMessage({
      type: 'extension:jobs:send',
      data: jobs,
      callback_id: (new Date()).getTime()
    });
    sendResponse({ ok: true, count: jobs.length });
  }

  // Scrape selected jobs for CRM send (no download)
  if (request.type === 'popup:get_jobs_data') {
    try {
      const jobs = scrape_all_jobs();
      console.log('[Extension] Jobs data for CRM:', jobs.length);
      sendResponse({ ok: true, count: jobs.length, jobs });
    } catch (e) {
      console.error('[Extension] Failed to scrape jobs for CRM:', e);
      sendResponse({ ok: false, error: (e && e.message) ? e.message : 'Failed to scrape jobs' });
    }
  }

  // Scrape selected sent invitations for CRM send
  if (request.type === 'popup:get_sent_invitations_data') {
    try {
      var leads = scrape_selected_sent_invitations();
      console.log('[Extension] Sent invitations for CRM:', leads.length);
      sendResponse({ ok: true, count: leads.length, leads: leads });
    } catch (e) {
      console.error('[Extension] Failed to scrape sent invitations:', e);
      sendResponse({ ok: false, error: (e && e.message) ? e.message : 'Failed to scrape sent invitations' });
    }
  }

  // LinkedIn /messaging/thread/ — one lead + conversation JSON
  if (request.type === 'popup:get_messaging_thread_data') {
    try {
      var msgScrape = scrape_messaging_thread_for_crm();
      if (!msgScrape.ok) {
        sendResponse(msgScrape);
      } else {
        sendResponse({ ok: true, lead: msgScrape.lead });
      }
    } catch (e) {
      console.error('[Extension] Messaging thread scrape failed:', e);
      sendResponse({ ok: false, error: (e && e.message) ? e.message : 'Failed to scrape messaging thread' });
    }
  }

  return true;
});

function get_jobs_container() {
  let container = $('[componentkey="SearchResultsMainContent"]');
  if (container.length === 0) container = $('[data-testid="lazy-column"]');
  if (container.length === 0) container = $('.scaffold-layout__list');
  if (container.length === 0) container = $('main');
  if (container.length === 0) container = $('body'); // robust fallback
  return container;
}

/**
 * New LinkedIn jobs feed: cards are `div[role="button"][componentkey]` with a dismiss
 * button `aria-label="Dismiss … job"` and often no in-card `/jobs/view/` link.
 */
function is_job_dismiss_btn(el) {
  var lab = $(el).attr('aria-label') || '';
  return /\bjob\b/i.test(lab);
}

/**
 * From a dismiss button, find the single job card root.
 *
 * New LinkedIn jobs UI: each job is a `div[role="button"][componentkey]` that
 * wraps exactly one Dismiss button. We walk UP ancestors that have role="button"
 * and componentkey, picking the INNERMOST (lowest in the tree) one that only
 * contains a single job-dismiss — that's the card shell for this job.
 */
function card_root_from_job_dismiss_btn(btn) {
  var $btn = $(btn);

  // Collect all ancestors with role="button" and componentkey, from closest outward
  var candidates = [];
  $btn.parents('div[role="button"][componentkey]').each(function () {
    candidates.push(this);
  });

  // Pick the innermost (first) one that contains exactly 1 job-dismiss btn
  for (var i = 0; i < candidates.length; i++) {
    var $c = $(candidates[i]);
    var n = $c.find('button[aria-label*="Dismiss"]').filter(is_job_dismiss_btn).length;
    if (n === 1) return $c;
  }

  // Fallback: classic li-based card (older LinkedIn)
  var $li = $btn.closest(
    'li[data-occludable-job-id], li.jobs-search-results__list-item, li.scaffold-layout__list-item',
  );
  if ($li.length) return $li;

  // Fallback: data-view-name leaf
  var cards = $btn.parents('div[data-view-name="job-card"]');
  if (cards.length) return $(cards[0]);

  // Last resort: any role=button+componentkey ancestor
  if (candidates.length) return $(candidates[0]);

  return $();
}

/**
 * One root per visible job (deduped by DOM node).
 */
function get_job_cards_via_dismiss_buttons(container) {
  var seen = Object.create(null);
  var roots = [];
  container.find('button[aria-label*="Dismiss"]').each(function () {
    if (!is_job_dismiss_btn(this)) return;
    var $card = card_root_from_job_dismiss_btn(this);
    if (!$card.length) return;
    var el = $card[0];
    if (seen[el]) return;
    seen[el] = true;
    roots.push(el);
  });
  return $(roots);
}

function get_job_items(container) {
  // Primary: dismiss-button based detection (works for current LinkedIn jobs UI)
  var items = get_job_cards_via_dismiss_buttons(container);
  if (items.length > 0) return items;

  // Classic: li-based job list
  items = container.find(
    'li.jobs-search-results__list-item, li.scaffold-layout__list-item, li[data-occludable-job-id]',
  );
  if (items.length > 0) return items;

  // data-view-name cards (older UI)
  var $jobCards = container.find('div[data-view-name="job-card"]');
  var leaves = $jobCards.filter(function () {
    return $(this).find('div[data-view-name="job-card"]').length === 0;
  });
  if (leaves.length > 0) return leaves;
  if ($jobCards.length > 0) return $jobCards;

  // Fallback: role=button+componentkey divs that look like jobs
  items = container
    .find('div[role="button"][componentkey]')
    .filter(function () {
      var $el = $(this);
      if ($el.parents('div[role="button"][componentkey]').length > 0) return false; // skip nested
      return (
        $el.find('a[href*="/jobs/view/"], a[href*="currentJobId="]').length > 0 ||
        $el.find('[data-job-id]').length > 0 ||
        $el.find('button[aria-label*="Dismiss"]').filter(function () {
          return /\bjob\b/i.test($(this).attr('aria-label') || '');
        }).length > 0
      );
    });
  if (items.length > 0) return items;

  return $();
}

var jobsInjectTimer = null;
var jobsDomObserver = null;

function schedule_jobs_inject() {
  if (jobsInjectTimer) clearTimeout(jobsInjectTimer);
  jobsInjectTimer = setTimeout(function () {
    jobsInjectTimer = null;
    inject_job_extract_buttons();
  }, 200);
}

function disconnect_jobs_dom_observer() {
  if (jobsDomObserver) {
    jobsDomObserver.disconnect();
    jobsDomObserver = null;
  }
}

function ensure_jobs_dom_observer() {
  if (!window.location.href.includes('/jobs/')) {
    disconnect_jobs_dom_observer();
    return;
  }
  if (jobsDomObserver) return;
  var target = get_jobs_container().get(0) || document.body;
  try {
    jobsDomObserver = new MutationObserver(function () {
      schedule_jobs_inject();
    });
    jobsDomObserver.observe(target, { childList: true, subtree: true });
  } catch (e) {
    console.warn('[Extension] jobs observer failed', e);
  }
}

/**
 * Best-effort numeric job posting id for a single job card/list row.
 * New LinkedIn search cards often have NO in-card <a href="/jobs/view/...">; using the page URL's
 * currentJobId for every row is wrong (it's whichever job the detail pane is showing).
 */
function extractLinkedInJobViewIdFromCard($item) {
  if (!$item || !$item.length) return '';
  var scored = {}; // id -> score

  function add(id, weight) {
    var n = String(id == null ? '' : id).replace(/\D/g, '');
    if (!n || n.length < 6 || n.length > 15) return;
    scored[n] = (scored[n] || 0) + weight;
  }

  // 1) Walk ancestors — classic list rows expose data-occludable-job-id on <li>
  var $walk = $item.first();
  for (var depth = 0; depth < 22 && $walk.length; depth++) {
    add($walk.attr('data-occludable-job-id'), 120);
    add($walk.attr('data-job-id'), 115);
    var urnA =
      $walk.attr('data-entity-urn') ||
      $walk.attr('data-chameleon-result-urn') ||
      $walk.attr('data-chameleon-result') ||
      '';
    var mA = urnA.match(/jobPost(?:ing)?[:\/](\d{6,})/i);
    if (mA) add(mA[1], 110);
    $walk = $walk.parent();
  }

  // 2) Descendants — urns and explicit ids
  $item.find('[data-entity-urn*="jobPosting"], [data-entity-urn*="jobPost:"], [data-entity-urn*="JobPosting"]').each(function () {
    var urn = $(this).attr('data-entity-urn') || '';
    var m = urn.match(/jobPost(?:ing)?[:\/](\d{6,})/i);
    if (m) add(m[1], 100);
  });
  $item.find('[data-job-id], [data-occludable-job-id]').each(function () {
    add($(this).attr('data-job-id'), 95);
    add($(this).attr('data-occludable-job-id'), 95);
  });

  // 3) Links: plain /jobs/view/ beats search-results?currentJobId= (often the focused job only)
  $item.find('a[href*="/jobs/view/"]').each(function () {
    var h = $(this).attr('href') || '';
    var mv = h.match(/\/jobs\/view\/(\d{6,})/);
    if (!mv) return;
    var w = /jobs\/search-results/i.test(h) ? 45 : 85;
    add(mv[1], w);
  });
  $item.find('a[href*="currentJobId="]').each(function () {
    var h = $(this).attr('href') || '';
    var mc = h.match(/currentJobId=(\d{6,})/);
    if (mc) add(mc[1], 40);
  });

  // 4) Serialized markup — Voyager / React sometimes embed urn:li:jobPosting:NNNNNN
  var el0 = $item.first()[0];
  if (el0 && el0.innerHTML && el0.innerHTML.length < 400000) {
    var html = el0.innerHTML;
    var reUrn = /urn:li:jobPost(?:ing)?:(\d{6,})/gi;
    var mu;
    while ((mu = reUrn.exec(html)) !== null) add(mu[1], 88);
    var reJp = /jobPosting["']?\s*[:=]\s*["']?(\d{6,})/gi;
    while ((mu = reJp.exec(html)) !== null) add(mu[1], 55);
  }

  var best = '';
  var bestScore = -1;
  Object.keys(scored).forEach(function (id) {
    if (scored[id] > bestScore) {
      bestScore = scored[id];
      best = id;
    }
  });
  return best;
}

function jobViewUrlFromId(id) {
  return id ? 'https://www.linkedin.com/jobs/view/' + id : '';
}

/**
 * Latest jobs `currentJobId` query param, synced by `linkedin-jobs-history-hook-main.js` (MAIN world)
 * onto `document.documentElement[data-le-current-job-id]` on every pushState/replaceState/popstate.
 */
function readLinkedInHistoryCurrentJobId() {
  try {
    var v = document.documentElement.getAttribute('data-le-current-job-id');
    if (!v) return '';
    var n = String(v).replace(/\D/g, '');
    return n || '';
  } catch (e) {
    return '';
  }
}

/** Canonical job URL from history navigation (trailing slash per product spec). */
function buildJobUrlFromHistoryJobId(id) {
  var n = String(id == null ? '' : id).replace(/\D/g, '');
  return n ? 'https://www.linkedin.com/jobs/view/' + n + '/' : '';
}

/**
 * When the user selects a row, bind the most recent `currentJobId` to this button.
 * Polls briefly because LinkedIn may update the URL right after the click.
 */
function attachHistoryJobUrlToExtractButton($b) {
  function apply() {
    var hid = readLinkedInHistoryCurrentJobId();
    $b.data('le-job-url', hid ? buildJobUrlFromHistoryJobId(hid) : '');
  }
  apply();
  var n = 0;
  function tick() {
    n++;
    apply();
    if (n < 12) setTimeout(tick, 100);
  }
  setTimeout(tick, 50);
}

/** Prefer per-card DOM; optional button stores a short-lived capture from select. */
function resolveJobLinkForJobCard($item, $btn) {
  var jid = extractLinkedInJobViewIdFromCard($item);
  if (jid) return jobViewUrlFromId(jid);
  if ($btn && $btn.length) {
    var cap = $btn.data('captured-link');
    if (cap) return String(cap);
  }
  return '';
}

/**
 * After click, LinkedIn may hydrate job id or update URL — poll briefly; never trust URL alone on first tick.
 */
function tryDeferJobLinkCapture($b, $scope) {
  var n = 0;
  function tick() {
    n++;
    var jid = extractLinkedInJobViewIdFromCard($scope);
    if (jid) {
      $b.data('captured-link', jobViewUrlFromId(jid));
      return;
    }
    if (!$b.data('captured-link')) {
      var pm = window.location.href.match(/currentJobId=(\d+)/);
      if (pm) $b.data('captured-link', jobViewUrlFromId(pm[1]));
    }
    if (n < 12 && !$b.data('captured-link')) {
      setTimeout(tick, 100);
    }
  }
  tick();
}

function make_extract_btn($scopeCard) {
  var $scope = $scopeCard && $scopeCard.length ? $scopeCard : $();
  var $btn = $('<div/>').addClass('extension-individual-button available jobs-extract-btn').html('Extract');
  $btn.css({
    margin: '0 0 0 8px',
    'font-size': '12px',
    padding: '4px 10px',
    'border-radius': '4px',
    background: '#fff',
    border: '1px solid #0073b1',
    color: '#0073b1',
    cursor: 'pointer',
    'font-weight': '600',
    'z-index': '9999',
    position: 'relative',
    'line-height': '1.2',
    'box-sizing': 'border-box',
    'min-height': '26px',
    display: 'inline-flex',
    'align-items': 'center',
  });
  $btn.on('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
  });
    $btn.on('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var $b = $(e.currentTarget);
      if ($b.hasClass('added')) {
        $b.removeClass('added').addClass('available').html('Extract').css({ background: '#fff', color: '#0073b1', border: '1px solid #0073b1' });
        $b.removeData('captured-link');
        $b.removeData('le-job-url');
      } else {
        $b.removeClass('available').addClass('added').html('Selected').css({ background: '#0073b1', color: '#fff', border: '1px solid #0073b1' });
        var jidNow = extractLinkedInJobViewIdFromCard($scope);
        if (jidNow) {
          $b.data('captured-link', jobViewUrlFromId(jidNow));
        } else {
          tryDeferJobLinkCapture($b, $scope);
        }
        attachHistoryJobUrlToExtractButton($b);
      }
    });
  return $btn;
}

function inject_job_extract_buttons() {
  if (!window.location.href.includes('/jobs/')) return;

  $('button[aria-label*="Dismiss"]').each(function () {
    var $dismiss = $(this);

    // Must be a job dismiss (aria-label contains "job")
    if (!/\bjob\b/i.test($dismiss.attr('aria-label') || '')) return;

    // PRIMARY GUARD: stamp the dismiss button itself so we never process it twice.
    // This is reliable regardless of card-root detection success/failure.
    if ($dismiss.data('ext-injected')) return;
    $dismiss.data('ext-injected', true);

    var $parent = $dismiss.parent();

    // Make sure parent row is flex so button sits inline
    $parent.css({
      display: 'inline-flex',
      'align-items': 'center',
      'flex-wrap': 'wrap',
      gap: '6px',
    });

    // Find the card root for scraping purposes
    var $card = card_root_from_job_dismiss_btn(this);
    if (!$card.length) $card = $dismiss.parents('div[role="button"][componentkey]').first();

    var $btn = make_extract_btn($card.length ? $card : $dismiss.closest('div'));
    $parent.append($btn);

    // Mark the card so scraping works
    if ($card.length && !$card.hasClass('extension-init')) {
      $card.addClass('extension-init');
    }
  });
}

// ---------------------------------------------------------------------------
// Select All / Deselect All master button (jobs + leads + company pages)
// ---------------------------------------------------------------------------

function show_connections_range_feedback(el, result) {
  if (!el || !result) return;
  if (el._extFeedbackTimer) {
    clearTimeout(el._extFeedbackTimer);
    el._extFeedbackTimer = null;
  }
  var msg = result.message || '';
  if (!msg) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.style.display = 'block';
  el.style.color = result.ok ? '#86efac' : '#fbbf24';
  el._extFeedbackTimer = setTimeout(function () {
    el.style.display = 'none';
    el.textContent = '';
    el._extFeedbackTimer = null;
  }, result.ok ? 4000 : 12000);
}

function ensure_select_all_button() {
  // Already in the live DOM? Nothing to do.
  if (document.getElementById('ext-select-all-btn')) return;

  // Connections page: range controls (shown only on that page)
  var rangeWrap = document.createElement('div');
  rangeWrap.id = 'ext-range-controls';
  rangeWrap.setAttribute('style', [
    'position:fixed',
    'bottom:20px',
    'left:150px',
    'z-index:2147483647',
    'display:none',
    'flex-wrap:wrap',
    'align-items:center',
    'gap:6px',
    'padding:8px 10px',
    'border-radius:10px',
    'background:rgba(17, 24, 39, 0.92)',
    'backdrop-filter:blur(6px)',
    'box-shadow:0 2px 12px rgba(0,0,0,0.35)',
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
    'color:#fff',
    'max-width:min(calc(100vw - 32px), 420px)'
  ].join(';'));

  function makeRangeInput(id, placeholder) {
    var el = document.createElement('input');
    el.id = id;
    el.type = 'number';
    el.min = '1';
    el.placeholder = placeholder;
    el.value = placeholder === 'Start' ? '1' : '10';
    el.setAttribute('style', [
      'width:72px',
      'padding:8px 10px',
      'border-radius:8px',
      'border:1px solid rgba(255,255,255,0.25)',
      'background:rgba(255,255,255,0.08)',
      'color:#fff',
      'outline:none',
      'font-size:12px'
    ].join(';'));
    return el;
  }

  var startInput = makeRangeInput('ext-range-start', 'Start');
  var endInput = makeRangeInput('ext-range-end', 'End');

  var maxLabel = document.createElement('div');
  maxLabel.id = 'ext-range-max';
  maxLabel.textContent = 'max: -';
  maxLabel.setAttribute('style', 'font-size:12px;opacity:0.85;padding:0 6px;');

  var applyBtn = document.createElement('button');
  applyBtn.id = 'ext-range-apply';
  applyBtn.textContent = 'Select range';
  applyBtn.setAttribute('style', [
    'padding:10px 14px',
    'border-radius:8px',
    'background:#10b981',
    'color:#06131b',
    'border:none',
    'font-size:12px',
    'font-weight:800',
    'cursor:pointer'
  ].join(';'));

  var rangeFeedback = document.createElement('div');
  rangeFeedback.id = 'ext-range-feedback';
  rangeFeedback.setAttribute('style', [
    'display:none',
    'flex-basis:100%',
    'width:100%',
    'margin:0',
    'padding:6px 4px 2px',
    'font-size:11px',
    'line-height:1.4',
    'font-weight:600'
  ].join(';'));

  applyBtn.addEventListener('click', async function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!is_connections_page()) return;
    applyBtn.disabled = true;
    try {
      var result = await select_connections_range(parseInt(startInput.value, 10), parseInt(endInput.value, 10));
      show_connections_range_feedback(rangeFeedback, result);
    } catch (ex) {
      console.warn('[Extension] range select failed', ex);
      show_connections_range_feedback(rangeFeedback, {
        ok: false,
        message: 'Something went wrong. Try again.'
      });
    } finally {
      applyBtn.disabled = false;
    }
  });

  rangeWrap.appendChild(startInput);
  rangeWrap.appendChild(endInput);
  rangeWrap.appendChild(maxLabel);
  rangeWrap.appendChild(applyBtn);
  rangeWrap.appendChild(rangeFeedback);

  var btn = document.createElement('button');
  btn.id = 'ext-select-all-btn';
  btn.textContent = 'Select All';
  btn.setAttribute('style', [
    'position:fixed',
    'bottom:20px',
    'left:20px',
    'z-index:2147483647',
    'padding:10px 22px',
    'border-radius:6px',
    'background:#0073b1',
    'color:#fff',
    'border:none',
    'font-size:13px',
    'font-weight:700',
    'cursor:pointer',
    'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
    'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
    'transition:background 0.15s',
    'letter-spacing:0.01em',
    'display:block',
    'visibility:visible',
    'opacity:1',
  ].join(';'));

  btn.addEventListener('mouseenter', function () { this.style.opacity = '0.85'; });
  btn.addEventListener('mouseleave', function () { this.style.opacity = '1'; });

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();

    var isJobs = window.location.href.includes('/jobs/');
    var isSentInvitations = is_sent_invitations_page();
    var isSalesList = is_sales_people_list_page();
    var isConnections = is_connections_page();
    var selector = isJobs ? '.jobs-extract-btn'
      : isSentInvitations ? '.sent-invitation-extract-btn'
      : isSalesList ? '.sales-list-extract-btn'
      : isConnections ? '.connections-extract-btn'
      : '.extension-individual-button';

    var allBtns = document.querySelectorAll(selector);
    if (allBtns.length === 0) return;

    var selectedCount = document.querySelectorAll(selector + '.added').length;
    var allSelected = selectedCount === allBtns.length;

    if (allSelected) {
      // Trigger click on every selected button to deselect — this fires all
      // background remove messages via the existing per-button click handlers.
      allBtns.forEach(function (b) {
        if (b.classList.contains('added')) {
          b.click();
        }
      });
      btn.textContent = 'Select All';
      btn.style.background = '#0073b1';
    } else {
      // Trigger click on every unselected button to select — fires all
      // background add messages via the existing per-button click handlers.
      allBtns.forEach(function (b) {
        if (b.classList.contains('available')) {
          b.click();
        }
      });
      btn.textContent = 'Deselect All';
      btn.style.background = '#c0392b';
    }
  });

  document.body.appendChild(btn);
  document.body.appendChild(rangeWrap);
}

/** True if the user marked this row via our Extract button or LinkedIn's list checkbox. */
function job_row_is_selected($item) {
  if ($item.find('.jobs-extract-btn.added').length > 0) return true;
  var $cb = $item.find('input[type="checkbox"]').first();
  if ($cb.length && $cb.prop('checked')) return true;
  if ($item.find('[role="checkbox"][aria-checked="true"]').length > 0) return true;
  return false;
}

function scrape_job_title_company_location_posted($item) {
  var title = '';

  // Method 1: title from dismiss button aria-label ("Dismiss <title> job")
  var $dismiss = $item
    .find('button[aria-label*="Dismiss"]')
    .filter(function () {
      return /\bjob\b/i.test($(this).attr('aria-label') || '');
    })
    .first();
  if ($dismiss.length) {
    var lab = $dismiss.attr('aria-label') || '';
    var dm = lab.match(/^Dismiss\s+(.+?)\s+job\s*$/i);
    if (dm && dm[1]) title = dm[1].replace(/\s+/g, ' ').trim();
  }

  // Method 2: aria-hidden="true" span inside the title paragraph (clean, no "(Verified job)" suffix)
  if (!title) {
    $item.find('p span[aria-hidden="true"]').each(function () {
      var t = $(this).clone().children('span').remove().end().text().replace(/\s+/g, ' ').trim();
      if (t && !/^\d+\s*\+?\s*results?$/i.test(t) && !/^99\+/i.test(t)) {
        title = t;
        return false;
      }
    });
  }

  // Method 3: legacy selectors
  if (!title) {
    title = $item.find('a.job-card-container__link, .job-card-list__title, h3 a, h3, [data-testid="job-card-title"]')
      .first().text().trim();
  }
  if (!title) {
    title = $item.find('a[href*="/jobs/view/"]').first().text().trim();
  }

  function is_noise(t) {
    if (!t) return true;
    if (/^\d+\s*\+?\s*results?$/i.test(t)) return true;
    if (/^99\+/i.test(t)) return true;
    if (/are these results helpful/i.test(t)) return true;
    return false;
  }

  // Company: LinkedIn rotates obfuscated class names.
  //
  // Current feed (2025+): company is in div._64713141 with a direct child <p> (e.g. "StackOne").
  // The location line is a *sibling* <p class="... _64713141 ..."> — class on <p>, not wrapping div.
  // Older: div._8f149b47 > p
  var company = '';
  var $newCompanyWrap = $item.find('div._64713141').filter(function () {
    return $(this).children('p').length > 0;
  }).first();
  if ($newCompanyWrap.length) {
    var cNew = $newCompanyWrap.children('p').first().text().replace(/\s+/g, ' ').trim();
    if (cNew && !is_noise(cNew)) {
      company = cNew;
    }
  }
  // Legacy: div._8f149b47 > p (company name text)
  if (!company || is_noise(company)) {
    var $companyDiv = $item.find('div._8f149b47').first();
    if ($companyDiv.length) {
      company = $companyDiv.find('p').first().text().replace(/\s+/g, ' ').trim();
    }
  }
  // Fallback: older LinkedIn class selectors
  if (!company || is_noise(company)) {
    company = $item.find('div.a390a9fc > p').filter(function () {
      return !$(this).hasClass('a390a9fc');
    }).first().text().trim();
  }
  if (!company || is_noise(company)) {
    company = $item.find('._41247193, .artdeco-entity-lockup__subtitle, [data-testid="company-name"], .job-card-container__primary-description')
      .first().text().trim();
  }
  if (is_noise(company)) company = '';

  // Location: paragraph with class _31a95749 (second info line after company)
  var location = '';
  $item.find('p').each(function () {
    var $p = $(this);
    if ($p.hasClass('_31a95749') || $p.is('._31a95749')) {
      var t = $p.text().replace(/\s+/g, ' ').trim();
      if (t && !is_noise(t) && t !== company) {
        location = t;
        return false;
      }
    }
  });
  // New feed: location often on <p._64713141> (company is div._64713141 > p without _64713141 on the p)
  if (!location) {
    $item.find('p._64713141').each(function () {
      var t = $(this).text().replace(/\s+/g, ' ').trim();
      if (t && !is_noise(t) && t !== company && t !== title) {
        location = t;
        return false;
      }
    });
  }
  // Fallback: find a <p> that looks like a location (contains On-site/Remote/Hybrid or has a comma)
  if (!location) {
    $item.find('p').each(function () {
      var t = $(this).text().replace(/\s+/g, ' ').trim();
      if (!t || is_noise(t) || t === title || t === company) return;
      if (/on-?site|remote|hybrid/i.test(t) || (/,/.test(t) && t.length < 80)) {
        location = t;
        return false;
      }
    });
  }
  if (!location) {
    location = $item.find('.job-card-container__metadata-item, [data-testid="job-card-location"], .job-card-list__metadata-item')
      .first().text().trim();
  }

  // Posted: use the screen-reader span (class _0c5520e7) which has the full "Posted on ..." text.
  // It is inside a <span aria-hidden="true"> wrapper — but _0c5520e7 is the real text element for AT.
  var posted = '';
  $item.find('span._0c5520e7').each(function () {
    var t = $(this).text().replace(/\s+/g, ' ').trim();
    if (/^posted\b/i.test(t)) {
      posted = t;
      return false;
    }
  });
  // Fallback: any span whose visible text starts with "posted"
  if (!posted) {
    $item.find('span').each(function () {
      var t = $(this).text().replace(/\s+/g, ' ').trim();
      if (/^posted\b/i.test(t)) {
        posted = t;
        return false;
      }
    });
  }

  return { title: title, company: company, location: location, posted: posted };
}

// Scraper for Job Search results
function scrape_all_jobs() {
  const jobs = [];

  // Find all selected extract buttons directly — no card detection needed.
  // Each button is inside the dismiss-row of a specific job card.
  // Walk up to the card root for scraping.
  $('.jobs-extract-btn.added').each(function() {
    var $btn = $(this);
    // Find the enclosing card: nearest role=button+componentkey ancestor, or fallback
    var $item = $btn.parents('div[role="button"][componentkey]').first();
    if (!$item.length) $item = $btn.closest('[data-view-name="job-card"]');
    if (!$item.length) $item = $btn.parent();

    var fields = scrape_job_title_company_location_posted($item);
    var title = fields.title;
    var company = fields.company;
    var location = fields.location;
    var posted = fields.posted;
    var link = resolveJobLinkForJobCard($item, $btn);
    var jobUrl = $btn.data('le-job-url') ? String($btn.data('le-job-url')) : '';

    if (title || company || location || link || jobUrl) {
      jobs.push({
        title: title || 'Job',
        company: company || '',
        location: location || '',
        posted: posted || '',
        link: link || '',
        jobUrl: jobUrl,
      });
    }
  });

  if (jobs.length > 0) return jobs;

  // Legacy fallback path (older LinkedIn layouts)
  let container = get_jobs_container();
  if (container.length === 0) { console.warn('[Extension] Jobs container not found'); return jobs; }

  get_job_items(container).each(function() {
    const $item = $(this);

    if (!job_row_is_selected($item)) return;

    var fields = scrape_job_title_company_location_posted($item);
    var title = fields.title;
    var company = fields.company;
    var location = fields.location;
    var posted = fields.posted;
    var link = resolveJobLinkForJobCard($item, null);

    // Include row if we can identify the job (link is enough when LI changes title/company classes).
    if (title || company || location || link) {
      jobs.push({
        title: title || 'Job',
        company: company || '',
        location: location || '',
        posted: posted || '',
        link: link || '',
        jobUrl: '',
      });
    }
  });
  
  return jobs;
}

// ---------------------------------------------------------------------------
// Sent Invitations page (/mynetwork/invitation-manager/sent)
// ---------------------------------------------------------------------------

function is_sent_invitations_page() {
  return window.location.href.includes('/mynetwork/invitation-manager/sent');
}

// ---------------------------------------------------------------------------
// My Network Connections page (/mynetwork/invite-connect/connections/)
// ---------------------------------------------------------------------------

function is_connections_page() {
  return window.location.href.includes('/mynetwork/invite-connect/connections');
}

function get_connections_list_root() {
  // Prefer the actual lazy list column (there are often two nodes with ConnectionsPage_ConnectionsList).
  var $lazy = $('[data-component-type="LazyColumn"][data-testid="lazy-column"]').first();
  if ($lazy.length) return $lazy;
  var $root = $('[componentkey="ConnectionsPage_ConnectionsList"]').first();
  if ($root.length) return $root;
  $root = $('main').first();
  if ($root.length) return $root;
  return $('body').first();
}

function normalize_linkedin_profile_url(href) {
  if (!href) return '';
  var u = href;
  if (u.startsWith('/')) u = 'https://www.linkedin.com' + u;
  u = u.split('?')[0].split('#')[0];
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

function extract_profile_id_from_profile_url(profileUrl) {
  if (!profileUrl) return '';
  var m = profileUrl.match(/linkedin\.com\/in\/([^\/\?\#]+)/i);
  return m && m[1] ? m[1] : '';
}

function connection_row_looks_valid($el) {
  if (!$el.length) return false;
  if ($el.find('a[href*="/in/"]').length === 0) return false;
  return (
    $el.find('a[aria-label="Message"], a[href*="/messaging/compose/"]').length > 0 ||
    $el.find('button[aria-label="Show more actions"]').length > 0
  );
}

function filter_out_auto_component_ancestors(candidates) {
  var els = candidates.get();
  // Drop any candidate that still contains another candidate (parent wrapper around multiple rows).
  return $(els.filter(function (el) {
    return !els.some(function (other) {
      return other !== el && $.contains(el, other);
    });
  }));
}

function get_connection_rows($root) {
  var $scope = ($root && $root.length) ? $root : $(document.body);

  // Exact structure from LinkedIn connections list (see DOM): one row is
  // div[data-display-contents="true"] > div[componentkey^="auto-component-"] — never use a parent
  // that contains multiple rows or only the first card gets an Export button.
  var $exact = $scope.find('div[data-display-contents="true"] > div[componentkey^="auto-component-"]').filter(function () {
    return connection_row_looks_valid($(this));
  });
  if ($exact.length) return $exact;

  var $auto = $scope.find('div[componentkey^="auto-component-"]').filter(function () {
    return connection_row_looks_valid($(this));
  });
  $auto = filter_out_auto_component_ancestors($auto);
  if ($auto.length) return $auto;

  // Fallback: direct child of data-display-contents that looks like a row.
  var $fallback = $scope.find('div[data-display-contents="true"] > div').filter(function () {
    return connection_row_looks_valid($(this));
  });
  if ($fallback.length) return $fallback;

  // Last resort: map each profile link to its nearest "row-ish" ancestor, but ensure we pick
  // the *closest* ancestor with actions (not the first one, which may be shared).
  var mapped = $scope.find('a[href*="/in/"]').map(function () {
    var $a = $(this);
    var $withActions = $a.closest('div').parents().filter(function () {
      var $p = $(this);
      return (
        $p.find('a[aria-label="Message"], a[href*="/messaging/compose/"]').length > 0 ||
        $p.find('button[aria-label*="Show more actions"], button[aria-label*="actions"]').length > 0
      );
    }).first();
    if ($withActions.length) return $withActions.get(0);
    return $a.closest('div').get(0);
  });

  var seen = Object.create(null);
  var uniq = [];
  $(mapped).each(function () {
    var el = this;
    if (!el) return;
    if (seen[el]) return;
    seen[el] = true;
    uniq.push(el);
  });
  return $(uniq);
}

function scrape_connection_from_row($row) {
  var profileUrl = '';
  var $profileA = $row.find('a[href*="/in/"]').first();
  if ($profileA.length) profileUrl = normalize_linkedin_profile_url($profileA.attr('href') || '');

  var name = '';
  var headline = '';
  var $nameA = $row.find('a[href*="/in/"]').filter(function () {
    return $(this).find('p').length > 0;
  }).first();
  if (!$nameA.length) $nameA = $profileA;

  if ($nameA.length) {
    var $ps = $nameA.find('p');
    if ($ps.length) {
      name = $($ps.get(0)).text().replace(/\s+/g, ' ').trim();
      if ($ps.length > 1) headline = $($ps.get(1)).text().replace(/\s+/g, ' ').trim();
    }
  }

  if (!name) {
    $row.find('p').each(function () {
      var t = $(this).text().replace(/\s+/g, ' ').trim();
      if (!t) return;
      if (/^connected on\b/i.test(t)) return;
      name = t;
      return false;
    });
  }

  var connectedOn = '';
  $row.find('p').each(function () {
    var t = $(this).text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (/^connected on\b/i.test(t)) {
      connectedOn = t;
      return false;
    }
  });

  var profileId = extract_profile_id_from_profile_url(profileUrl) || name || '';

  // Connections list: the second line is LinkedIn headline / blurb (bio), not a structured job title.
  // Put it only in `about` for CRM/CSV; leave `title` empty so it is not duplicated.
  return {
    name: name || '',
    title: '',
    company: '',
    company_id: '',
    location: '',
    about: headline || '',
    tenure: connectedOn || '',
    profile_id: profileId,
    profile_url: profileUrl || '',
    lead_source: EXTENSION_LEAD_SOURCE.LINKEDIN_CONNECTION
  };
}

function make_connections_export_btn($row) {
  var $btn = $('<button/>')
    .addClass('extension-individual-button connections-extract-btn available')
    .text('Export')
    .css({
      margin: '0 0 0 8px',
      'font-size': '12px',
      padding: '4px 10px',
      'border-radius': '4px',
      background: '#fff',
      border: '1px solid #0073b1',
      color: '#0073b1',
      cursor: 'pointer',
      'font-weight': '600',
      'z-index': '9999',
      position: 'relative',
      'line-height': '1.2',
      'box-sizing': 'border-box',
      'min-height': '26px',
      display: 'inline-flex',
      'align-items': 'center',
      'vertical-align': 'middle',
      'flex-shrink': '0'
    });

  $btn.on('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
  });

  $btn.on('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var $b = $(e.currentTarget);
    var fresh = scrape_connection_from_row($row);

    if ($b.hasClass('added')) {
      $b.removeClass('added').addClass('available').text('Export')
        .css({ background: '#fff', color: '#0073b1', border: '1px solid #0073b1' });
      var cb = (new Date()).getTime();
      try {
        if (chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({
            type: 'extension:leads:remove',
            data: { profile_id: fresh.profile_id },
            callback_id: cb
          });
        }
      } catch (ex) {}
      callbacks[cb] = function () { refresh_count(); };
    } else {
      $b.removeClass('available').addClass('added').text('Selected')
        .css({ background: '#0073b1', color: '#fff', border: '1px solid #0073b1' });
      var cb2 = (new Date()).getTime();
      try {
        if (chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({
            type: 'extension:lead:add',
            data: fresh,
            callback_id: cb2
          });
        }
      } catch (ex2) {}
      callbacks[cb2] = function () { refresh_count(); };
    }
  });

  return $btn;
}

function inject_connections_export_buttons() {
  if (!is_connections_page()) return;

  var $root = get_connections_list_root();
  var $rows = get_connection_rows($root);
  if (!$rows.length) return;

  $rows.each(function () {
    var $row = $(this);
    // Do not use jQuery .data() as a guard — virtualized lists recycle nodes. Prefer real DOM check.
    if ($row.find('.connections-extract-btn').length) return;

    var data = scrape_connection_from_row($row);
    if (!data || (!data.name && !data.profile_url)) return;

    var $msg = $row.find('a[aria-label="Message"], a[href*="/messaging/compose/"]').first();
    var $actions = $msg.length ? $msg.parent() : $row.find('button[aria-label="Show more actions"]').first().parent();
    if (!$actions.length) $actions = $row;

    $actions.css({ display: 'inline-flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap' });
    $actions.append(make_connections_export_btn($row));
  });
}

function get_connections_total_count_hint() {
  var total = 0;
  $('h1,h2,h3,span,p').each(function () {
    var t = ($(this).text() || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    var m = t.match(/(\d[\d,]*)\s+connections\b/i);
    if (m && m[1]) {
      total = parseInt(m[1].replace(/,/g, ''), 10) || 0;
      return false;
    }
  });
  return total;
}

function connections_range_scroll_first_message(s, e, loaded) {
  if (!loaded) {
    return 'Scroll first to load enough items in the list, then try again.';
  }
  return (
    'Scroll first to load enough items so rows ' +
    s +
    '–' +
    e +
    ' are all visible (' +
    loaded +
    ' loaded), then try again.'
  );
}

async function select_connections_range(startIndex, endIndex) {
  var s = parseInt(startIndex, 10);
  var e = parseInt(endIndex, 10);
  if (!isFinite(s) || !isFinite(e)) {
    return { ok: false, message: 'Enter valid start and end numbers.' };
  }
  if (s < 1) s = 1;
  if (e < s) e = s;

  inject_connections_export_buttons();
  var $root = get_connections_list_root();
  var $rows = get_connection_rows($root);
  var loaded = $rows.length;

  if (loaded < e) {
    return { ok: false, message: connections_range_scroll_first_message(s, e, loaded) };
  }

  for (var j = s; j <= e; j++) {
    var $checkRow = $($rows.get(j - 1));
    if (!$checkRow.length) {
      return { ok: false, message: connections_range_scroll_first_message(s, e, loaded) };
    }
    if (!$checkRow.find('.connections-extract-btn').length) {
      inject_connections_export_buttons();
    }
    if (!$checkRow.find('.connections-extract-btn').length) {
      return { ok: false, message: connections_range_scroll_first_message(s, e, loaded) };
    }
  }

  for (var i = s; i <= e; i++) {
    var $row = $($rows.get(i - 1));
    var $btn = $row.find('.connections-extract-btn').first();
    if ($btn.length && !$btn.hasClass('added')) {
      try { $btn.get(0).click(); } catch (ex) {}
    }
  }

  return { ok: true, message: 'Selected rows ' + s + '–' + e + '.' };
}

/**
 * Scrape a single invitation row from the sent invitations page.
 * DOM structure (from provided HTML):
 *   div[role="listitem"]
 *     div > a[href="/in/..."]  (avatar link)
 *     div > div > p > a[href="/in/..."]  (name link)
 *          > p._12486a17  (headline/bio)
 *          > p._9954391d  (sent date)
 *     div > a (Withdraw button)
 */
function scrape_sent_invitation_from_row($item) {
  // Profile URL — prefer the name link anchor
  var profileUrl = '';
  $item.find('a[href*="/in/"]').each(function() {
    var href = $(this).attr('href') || '';
    if (href.includes('/in/') && !profileUrl) {
      profileUrl = href.startsWith('http') ? href : 'https://www.linkedin.com' + href;
      profileUrl = profileUrl.split('?')[0];
    }
  });

  // Name — the anchor with class a957c9b0 (name link inside paragraph)
  var name = $item.find('a.a957c9b0').first().text().trim();
  if (!name) {
    // Fallback: any anchor inside the name paragraph
    name = $item.find('p a[href*="/in/"]').first().text().trim();
  }

  // Headline/bio — paragraph with class _12486a17 (first info line)
  var headline = $item.find('p._12486a17').first().text().trim();

  // Sent date — paragraph with class _9954391d
  var sentDate = $item.find('p._9954391d').first().text().trim();

  // Profile ID extracted from URL for use as a unique key
  var profileId = '';
  if (profileUrl) {
    var parts = profileUrl.split('/in/');
    if (parts[1]) profileId = parts[1].replace(/\/$/, '');
  }

  return {
    name: name,
    headline: headline,
    sentDate: sentDate,
    profileUrl: profileUrl,
    profileId: profileId
  };
}

/**
 * Collect all selected sent invitation rows.
 * Returns array of lead objects compatible with the CRM leads CSV format.
 */
function scrape_selected_sent_invitations() {
  var leads = [];
  $('.sent-invitation-extract-btn.added').each(function() {
    var $btn = $(this);
    var $item = $btn.closest('div[role="listitem"]');
    if (!$item.length) return;
    var data = scrape_sent_invitation_from_row($item);
    if (data.name || data.profileUrl) {
      leads.push({
        name: data.name || '',
        title: data.headline || '',    // headline maps to title/job_title
        company: '',
        company_id: '',
        location: '',
        about: data.headline || '',    // also store in about for context
        tenure: data.sentDate || '',
        profile_url: data.profileUrl || '',
        lead_source: EXTENSION_LEAD_SOURCE.LINKEDIN_SENT_INVITATIONS
      });
    }
  });
  return leads;
}

/**
 * Inject Extract buttons next to every Withdraw button on the sent invitations page.
 */
function inject_sent_invitation_extract_buttons() {
  if (!is_sent_invitations_page()) return;

  $('div[role="listitem"]').each(function() {
    var $item = $(this);

    // Find the withdraw button container — last child div with the withdraw anchor
    var $withdrawContainer = $item.find('a').filter(function() {
      return $(this).text().trim() === 'Withdraw';
    }).first().parent();

    if (!$withdrawContainer.length) return;

    // Guard: don't inject twice
    if ($withdrawContainer.data('ext-sent-injected')) return;
    $withdrawContainer.data('ext-sent-injected', true);

    var data = scrape_sent_invitation_from_row($item);
    if (!data.name && !data.profileUrl) return;

    var $btn = $('<button/>')
      .addClass('extension-individual-button sent-invitation-extract-btn available')
      .text('Extract')
      .css({
        'margin': '0 0 0 8px',
        'font-size': '12px',
        'padding': '4px 10px',
        'border-radius': '4px',
        'background': '#fff',
        'border': '1px solid #0073b1',
        'color': '#0073b1',
        'cursor': 'pointer',
        'font-weight': '600',
        'z-index': '9999',
        'position': 'relative',
        'line-height': '1.2',
        'box-sizing': 'border-box',
        'min-height': '26px',
        'display': 'inline-flex',
        'align-items': 'center',
        'vertical-align': 'middle',
        'flex-shrink': '0'
      });

    $btn.on('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();
    });

    $btn.on('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var $b = $(e.currentTarget);
      var fresh = scrape_sent_invitation_from_row($item);

      if ($b.hasClass('added')) {
        $b.removeClass('added').addClass('available').text('Extract').css({ background: '#fff', color: '#0073b1', border: '1px solid #0073b1' });
        // Remove from store
        if (fresh.profileId) {
          var cb = (new Date()).getTime();
          try {
            if (chrome.runtime && chrome.runtime.id) {
              chrome.runtime.sendMessage({ type: 'extension:leads:remove', data: { profile_id: fresh.profileId }, callback_id: cb });
            }
          } catch(ex) {}
          callbacks[cb] = function() { refresh_count(); };
        }
      } else {
        $b.removeClass('available').addClass('added').text('Selected').css({ background: '#0073b1', color: '#fff', border: '1px solid #0073b1' });
        // Add to store using the leads store so popup "Send Leads to CRM" works
        if (fresh.profileId || fresh.name) {
          var leadPayload = {
            profile_id: fresh.profileId || fresh.name,
            name: fresh.name || '',
            title: fresh.headline || '',
            company: '',
            company_id: '',
            location: '',
            about: fresh.headline || '',
            tenure: fresh.sentDate || '',
            profile_url: fresh.profileUrl || '',
            lead_source: EXTENSION_LEAD_SOURCE.LINKEDIN_SENT_INVITATIONS
          };
          var cb = (new Date()).getTime();
          try {
            if (chrome.runtime && chrome.runtime.id) {
              chrome.runtime.sendMessage({ type: 'extension:lead:add', data: leadPayload, callback_id: cb });
            }
          } catch(ex) {}
          callbacks[cb] = function() { refresh_count(); };
        }
      }
    });

    // Make the withdraw container flex so our button sits inline
    $withdrawContainer.css({
      display: 'inline-flex',
      'align-items': 'center',
      gap: '6px',
      'flex-wrap': 'nowrap'
    });

    $withdrawContainer.append($btn);
    console.log('[Extension] Extract button injected for:', data.name || data.profileUrl);
  });
}

// ---------------------------------------------------------------------------
// Sales Navigator People List page (/sales/lists/people/*)
// ---------------------------------------------------------------------------

function is_sales_people_list_page() {
  return window.location.href.includes('/sales/lists/people');
}

/**
 * Scrape a single row from the Sales Navigator people list table.
 * DOM: tr[data-x--people-list--row]
 *   td.list-people-detail-header__entity  → name, profile link, job title
 *   td.list-people-detail-header__account → company name + company link
 *   td[data-anonymize="location"]         → location text
 *   td.list-people-detail-header__date-added → date added
 */
function scrape_sales_list_row($row) {
  // Profile URL and ID — anchor with data-x--people-list--person-name or lists-detail__view-profile-name-link
  var profileHref = $row.find('a[data-x--people-list--person-name]').first().attr('href') ||
                    $row.find('a.lists-detail__view-profile-name-link').first().attr('href') ||
                    $row.find('a[href*="/sales/lead/"]').first().attr('href') || '';
  var profileUrl = profileHref ? 'https://www.linkedin.com' + profileHref.split('?')[0] : '';
  var profileId = profileHref ? profileHref.split('/sales/lead/')[1] : '';
  if (profileId) profileId = profileId.split('?')[0];

  // Name
  var name = $row.find('[data-x--people-list--person-name] span._lead-detail-entity-details_ocf42k').first().text().trim() ||
             $row.find('[data-anonymize="person-name"]').first().text().trim() ||
             $row.find('a.lists-detail__view-profile-name-link').first().text().trim();

  // Job title
  var title = $row.find('[data-anonymize="job-title"]').first().text().replace(/\s+/g, ' ').trim();

  // Company name and ID
  var $companyLink = $row.find('a[href*="/sales/company/"]').first();
  var company = $row.find('span[data-anonymize="company-name"]').first().text().trim();
  var companyHref = $companyLink.attr('href') || '';
  var company_id = '';
  var match = companyHref.match(/\/sales\/company\/(\d+)/);
  if (match) company_id = match[1];

  // Location
  var location = $row.find('td[data-anonymize="location"]').first().text().replace(/\s+/g, ' ').trim();

  // Date added (tenure repurposed)
  var dateAdded = $row.find('td.list-people-detail-header__date-added').first().text().replace(/\s+/g, ' ').trim();

  return {
    name: name,
    title: title,
    company: company,
    company_id: company_id,
    location: location,
    about: '',
    tenure: dateAdded,
    profile_id: profileId,
    profile_url: profileUrl
  };
}

var salesListDomObserver = null;

function disconnect_sales_list_dom_observer() {
  if (salesListDomObserver) {
    salesListDomObserver.disconnect();
    salesListDomObserver = null;
  }
}

function ensure_sales_list_dom_observer() {
  if (!is_sales_people_list_page()) {
    disconnect_sales_list_dom_observer();
    return;
  }
  if (salesListDomObserver) return;
  var target = document.querySelector('tbody') || document.body;
  try {
    salesListDomObserver = new MutationObserver(function() {
      inject_sales_list_extract_buttons();
    });
    salesListDomObserver.observe(target, { childList: true, subtree: true });
  } catch(e) {
    console.warn('[Extension] sales list observer failed', e);
  }
}

/**
 * Inject Extract buttons into the last actions cell of each people list row.
 * The actions cell has class list-people-detail-header__actions.
 */
function inject_sales_list_extract_buttons() {
  if (!is_sales_people_list_page()) return;

  $('tr[data-x--people-list--row]').each(function() {
    var $row = $(this);

    // Guard: inject only once per row
    if ($row.data('ext-sales-list-injected')) return;

    var data = scrape_sales_list_row($row);
    if (!data.name && !data.profile_id) return;

    $row.data('ext-sales-list-injected', true);

    var $btn = $('<button/>')
      .addClass('extension-individual-button sales-list-extract-btn available')
      .text('Extract')
      .css({
        'margin': '0',
        'font-size': '11px',
        'padding': '3px 8px',
        'border-radius': '4px',
        'background': '#fff',
        'border': '1px solid #0073b1',
        'color': '#0073b1',
        'cursor': 'pointer',
        'font-weight': '600',
        'z-index': '9999',
        'position': 'relative',
        'line-height': '1.3',
        'box-sizing': 'border-box',
        'white-space': 'nowrap',
        'display': 'inline-flex',
        'align-items': 'center'
      });

    $btn.on('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();
    });

    $btn.on('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var $b = $(e.currentTarget);
      var fresh = scrape_sales_list_row($row);

      if ($b.hasClass('added')) {
        $b.removeClass('added').addClass('available').text('Extract')
          .css({ background: '#fff', color: '#0073b1', border: '1px solid #0073b1' });
        var cb = (new Date()).getTime();
        try {
          if (chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage({
              type: 'extension:leads:remove',
              data: { profile_id: fresh.profile_id || fresh.name },
              callback_id: cb
            });
          }
        } catch(ex) {}
        callbacks[cb] = function() { refresh_count(); };
      } else {
        $b.removeClass('available').addClass('added').text('Selected')
          .css({ background: '#0073b1', color: '#fff', border: '1px solid #0073b1' });
        var leadPayload = {
          profile_id: fresh.profile_id || fresh.name,
          name: fresh.name || '',
          title: fresh.title || '',
          company: fresh.company || '',
          company_id: fresh.company_id || '',
          location: fresh.location || '',
          about: fresh.about || '',
          tenure: fresh.tenure || '',
          profile_url: fresh.profile_url || '',
          lead_source: EXTENSION_LEAD_SOURCE.LINKEDIN_SALES_LIST
        };
        var cb = (new Date()).getTime();
        try {
          if (chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage({
              type: 'extension:lead:add',
              data: leadPayload,
              callback_id: cb
            });
          }
        } catch(ex) {}
        callbacks[cb] = function() { refresh_count(); };
      }
    });

    // Append to the actions cell
    var $actionsCell = $row.find('td.list-people-detail-header__actions');
    if ($actionsCell.length) {
      $actionsCell.css({ 'white-space': 'nowrap', 'vertical-align': 'middle' });
      $actionsCell.append($btn);
    } else {
      // Fallback: append to last td
      $row.find('td').last().append($btn);
    }

    console.log('[Extension] Sales list Extract button injected for:', data.name || data.profile_id);
  });
}

// Create observer object used to check company is fetched
var observer = new MutationObserver(function(mutations) {
  mutations.forEach(function(mutation) {
    if (mutation.type == "attributes" && mutation.attributeName == "aria-expanded") {
      var parent = $(mutation.target).closest('.search-results__result-container')[0];
      var button = $(parent).find('.extension-individual-button');
      $(button).removeClass('no-company');
    }
  });
});
var extension_button_int = null;
var all_users = [];

// ---------------------------------------------------------------------------
// Company search helpers — scrape data directly from the DOM
// ---------------------------------------------------------------------------
function scrape_company_from_row($item) {
  var name = $item.find('a[data-control-name="view_company_via_result_name"]').text().trim();

  var href = $item.find('a[data-control-name="view_company_via_result_name"]').attr('href') || '';
  var company_id = href.split('?')[0].split('/').slice(-1)[0];

  var industry = $item.find('[data-anonymize="industry"]').text().trim();
  var revenue = $item.find('[data-anonymize="revenue"]').text().trim();

  var employees_label = $item.find('[data-anonymize="company-size"]').attr('aria-label') || '';
  var employees = $item.find('[data-anonymize="company-size"]').text().trim() || employees_label;

  var description = $item.find('[data-anonymize="person-blurb"]').attr('title') || 
                    $item.find('[data-anonymize="person-blurb"]').text().trim();

  var location = $item.find('[data-anonymize="location"]').text().trim();
  var website = '';

  console.log('[Extension] Scraped company:', { name, company_id, industry, revenue, employees, location });

  return { name, company_id, industry, revenue, employees, description, website, location };
}

// ---------------------------------------------------------------------------
// Scrape a single lead row from the people search DOM
// ---------------------------------------------------------------------------
function scrape_lead_from_row($item) {
  var name = $item.find('a[data-control-name="view_lead_panel_via_search_lead_name"] span[data-anonymize="person-name"]').text().trim();

  var profileHref = $item.find('a[data-control-name="view_lead_panel_via_search_lead_name"]').attr('href') || '';
  var profile_id = profileHref.split('?')[0].split('/sales/lead/').slice(-1)[0].split(',')[0];

  var title = $item.find('span[data-anonymize="title"]').first().text().trim();

  var $companyLink = $item.find('a[data-control-name="view_company_via_profile_lockup"]').first();
  var company = $companyLink.text().trim();
  var companyHref = $companyLink.attr('href') || '';
  var company_id = companyHref.split('?')[0].split('/').slice(-1)[0];

  var location = $item.find('span[data-anonymize="location"]').first().text().trim();

  var about = $item.find('[data-anonymize="person-blurb"]').attr('title') ||
              $item.find('[data-anonymize="person-blurb"]').text().trim();

  var tenure = $item.find('[data-anonymize="job-title"]').text().replace(/\s+/g, ' ').trim();

  console.log('[Extension] Scraped lead:', { name, profile_id, title, company, location });

  return {
    name,
    profile_id,
    title,
    company,
    company_id,
    location,
    about,
    tenure,
    lead_source: EXTENSION_LEAD_SOURCE.LINKEDIN_SALES_SEARCH
  };
}

// ---------------------------------------------------------------------------
// People helpers (unchanged logic, kept for people search)
// ---------------------------------------------------------------------------
function get_user_data(fullname) {
  var raw_data = $('code:contains(metadata)')[0];
  var parsed_data = JSON.parse(raw_data.innerText)['elements'];
  
  var user_data = parsed_data.filter(x => {
    return x.fullName === fullname;
  })[0];
  
  var formated_user_data = {
    firstName: user_data['firstName'],
    lastName: user_data['lastName'],
    name: user_data['fullName'],
    company: user_data['currentPositions'][0]['companyName'],
    company_id: user_data['currentPositions'][0]['companyUrn'].split(':').slice(-1)[0],
    position: user_data['currentPositions'][0]['title']
  };
  
  return formated_user_data;
}

function get_user_info(person) {
  $person = $(person);
  var name = $person.find('.result-lockup__name a:first').text().trim();
  var company = $person.find('.result-lockup__highlight-keyword a[href^="/sales/"] span:first').text().trim();
  var company_id = $person.find('.result-lockup__highlight-keyword a[href^="/sales/"]').attr('href').split('/')[3];
  var title = $person.find('.result-lockup__highlight-keyword span:first').text().trim();
  let checked = false;
  
  var button = $person.find('.extension-individual-button');
  if (button.length > 0) {
    checked = button.get()[0].classList.value.includes('added');
  }
  
  return { name, company, company_id, title, checked };
}

async function add_user(person) {
  var callback_id = (new Date()).getTime();
  var {name, company, company_id, title, checked} = get_user_info(person);
  var {firstName, lastName} = get_user_data(name);
  
  if (checked && name !== "") {
    var user_data = { name, firstName, lastName, company, company_id, title };
    
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({
          type: "extension:users:add",
          data: user_data,
          callback_id: callback_id
        });
      }
    } catch (e) { console.info('[Extension] Context invalidated, refresh required.'); }
    
    callbacks[callback_id] = function(rsp) {
      if (rsp.type == 'users:number') {
        $('.extension-button').html(`<b>Export ${rsp.response.value} leads</b>`);
      }
    };
  }
}

async function remove_user(person) {
  var {name, company} = get_user_info(person);
  var callback_id = (new Date()).getTime();
  try {
    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({
        type: "extension:users:remove",
        data: {name, company},
        callback_id: callback_id
      });
    }
  } catch (e) { console.info('[Extension] Context invalidated, refresh required.'); }
  
  callbacks[callback_id] = function(rsp) {
    if (rsp.type == 'users:number') {
      $('.extension-button').html(`<b>Export ${rsp.response.value} leads</b>`);
    }
  };
}

function reset_user() {
  all_users = [];
  
  $('.search-results__result-item, .artdeco-list__item').map(function() {
    var button = $(this).find('.extension-individual-button');
    if (button.length > 0) {
      $(button.get(0)).removeClass('added').addClass('available').html('Export');
    }
  });
}

// ---------------------------------------------------------------------------
// Update the floating button count — asks the background script (no storage)
// ---------------------------------------------------------------------------
function refresh_count() {
  var isCompany = window.location.href.includes('/search/company');

  // For sent invitations, count directly from DOM (no background store needed for display)
  if (is_sent_invitations_page()) {
    var selectedCount = document.querySelectorAll('.sent-invitation-extract-btn.added').length;
    $('.extension-button').html('<b>Send ' + selectedCount + ' leads to CRM</b>');
    return;
  }

  var cb = (new Date()).getTime();
  callbacks[cb] = function(rsp) {
    var count = rsp.response.value;
    console.log('[Extension] refresh_count count=' + count);
    $('.extension-button').html('<b>Export ' + count + ' items</b>');
  };
  try {
    if (chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({
        type: 'extension:get_count',
        data: { type: isCompany ? 'companies' : 'users' },
        callback_id: cb
      });
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Floating Export button setup
// ---------------------------------------------------------------------------
async function start_check() {
  var paths = [
    "https://www.linkedin.com/sales/search/people",
    "https://www.linkedin.com/sales/lists/people",
    "https://www.linkedin.com/sales/search/company",
    "https://www.linkedin.com/mynetwork/invitation-manager/sent",
    "https://www.linkedin.com/mynetwork/invite-connect/connections"
  ];

  var url_supported = paths.some(p => window.location.href.indexOf(p) === 0);

  if (!url_supported) {
    all_users = [];
    return;
  }

  if (!$('.extension-button').length) {
    var initialLabel = is_sent_invitations_page() ? 'Send 0 leads to CRM' : 'Export 0 items';
    var $button = $('<div/>').addClass('extension-button-wrapper').html(
      '<div class="extension-button"><b>' + initialLabel + '</b></div><div class="extension-button-delete">x</div>'
    );

    // Clear button — tells background to wipe in-memory stores
    $($button.find('.extension-button-delete')[0]).on('click', function() {
      var cb = (new Date()).getTime();
      callbacks[cb] = function() {
        reset_user();
        $('.extension-button').html('<b>Export 0 items</b>');
      };
      try {
        if (chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({ type: 'extension:clear_all', callback_id: cb });
        }
      } catch (e) {}
    });

    // Export / download button
    var $button_elem = $($button.find('.extension-button')[0]);
    $button_elem.on('click', async function() {
      var callback_id = (new Date()).getTime();

      // Check count first — don't export if zero
      var countText = $button_elem.text();
      var countMatch = countText.match(/\d+/);
      var currentCount = countMatch ? parseInt(countMatch[0]) : 0;
      
      if (currentCount === 0) {
        $button_elem.addClass('error').text('No leads to export');
        setTimeout(() => refresh_count(), 2000);
        return;
      }

      // Sent invitations page: send directly to CRM via auth:fetch
      if (is_sent_invitations_page()) {
        $button_elem.addClass('loading').text('Sending to CRM...');
        try {
          var leads = scrape_selected_sent_invitations();
          if (!leads.length) {
            $button_elem.removeClass('loading').addClass('error').text('No leads selected');
            setTimeout(() => { $button_elem.removeClass('error'); refresh_count(); }, 2500);
            return;
          }
          // Build CSV matching the CRM leads import format
          var header = ['name', 'title', 'company', 'company_id', 'location', 'about', 'tenure', 'profile_url', 'lead_source'];
          var csvRows = [header.join(',')];
          leads.forEach(function(l) {
            var row = header.map(function(k) {
              var v = l[k] || '';
              return '"' + String(v).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ') + '"';
            });
            csvRows.push(row.join(','));
          });
          var csv = csvRows.join('\r\n');

          var cb2 = (new Date()).getTime();
          callbacks[cb2] = function(rsp) {
            $button_elem.removeClass('loading');
            if (rsp && rsp.ok) {
              $button_elem.addClass('valid').text('Sent to CRM!');
              // Deselect all buttons
              document.querySelectorAll('.sent-invitation-extract-btn.added').forEach(function(b) { b.click(); });
              setTimeout(function() {
                $button_elem.removeClass('valid');
                refresh_count();
              }, 3000);
            } else {
              var errMsg = (rsp && rsp.error) ? rsp.error : 'CRM send failed';
              $button_elem.addClass('error').text('Error: ' + errMsg.slice(0, 40));
              setTimeout(() => { $button_elem.removeClass('error'); refresh_count(); }, 3000);
            }
          };
          try {
            if (chrome.runtime && chrome.runtime.id) {
              chrome.runtime.sendMessage({
                type: 'auth:fetch',
                data: { path: '/api/crm/import', method: 'POST', body: { csv: String(csv) } },
                callback_id: cb2
              }, function(rsp) {
                // Background returns directly for auth:fetch
                if (callbacks[cb2]) { callbacks[cb2](rsp); delete callbacks[cb2]; }
              });
            }
          } catch(ex) {
            $button_elem.removeClass('loading').addClass('error').text('Extension error');
            setTimeout(() => { $button_elem.removeClass('error'); refresh_count(); }, 2500);
          }
        } catch(err) {
          $button_elem.removeClass('loading').addClass('error').text('Scrape error');
          setTimeout(() => { $button_elem.removeClass('error'); refresh_count(); }, 2500);
        }
        return;
      }

      $button_elem.addClass('loading').text('Exporting...');

      callbacks[callback_id] = function(rsp) {
        $button_elem.removeClass('loading');
        if (rsp.type === 'companies:sent' || rsp.type === 'users:sent') {
          var r = rsp.response;
          if (r.status.code == 200) {
            $button_elem.addClass('valid').text('Exported!');
            reset_user();
            setTimeout(function() {
              $button_elem.removeClass('valid');
              refresh_count(); // Background already cleared the store
            }, 3000);
          } else {
            $button_elem.addClass('error').text('Error: ' + (r.status.message || r.status.code));
            setTimeout(() => refresh_count(), 3000);
          }
        }
      };

      if (window.location.href.includes('/search/company')) {
        console.log('[Extension] Sending extension:companies:send');
        chrome.runtime.sendMessage({ type: "extension:companies:send", callback_id: callback_id });
      } else {
        console.log('[Extension] Sending extension:users:send');
        chrome.runtime.sendMessage({ type: "extension:users:send", callback_id: callback_id });
      }
    });

    if (extension_button_int) clearInterval(extension_button_int);
    var attempt = 0;

    extension_button_int = setInterval(function() {
      attempt += 1;
      var container = document.getElementById('search-results-container') || $('.ember-view')[0];
      if (container) {
        clearInterval(extension_button_int);
        container.prepend($button[0]);
        console.log('[Extension] Floating button injected');
        refresh_count();
        return;
      }
      if (attempt > 60) clearInterval(extension_button_int);
    }, 500);
  }
}

start_check();

// ---------------------------------------------------------------------------
// Per-row Export button injection (runs every second)
// ---------------------------------------------------------------------------
function individual_finder_tick() {
  if (is_messaging_thread_page()) {
    ensure_messaging_thread_crm_ui();
    return;
  }

  if (is_sent_invitations_page()) {
    inject_sent_invitation_extract_buttons();
    ensure_select_all_button();
    refresh_count();
    return;
  }

  if (is_connections_page()) {
    inject_connections_export_buttons();
    ensure_select_all_button();

    var range = document.getElementById('ext-range-controls');
    if (range) range.style.display = 'inline-flex';

    var max = get_connections_total_count_hint() || get_connection_rows(get_connections_list_root()).length || 0;
    var maxEl = document.getElementById('ext-range-max');
    if (maxEl) maxEl.textContent = max ? ('max: ' + max) : 'max: -';

    var sIn = document.getElementById('ext-range-start');
    var eIn = document.getElementById('ext-range-end');
    if (sIn && max) sIn.max = String(max);
    if (eIn && max) eIn.max = String(max);

    return;
  }

  if (is_sales_people_list_page()) {
    inject_sales_list_extract_buttons();
    ensure_select_all_button();
    ensure_sales_list_dom_observer();
    return;
  }

  if (window.location.href.includes('/search/company')) {
    // Company search page
    $('.artdeco-list__item').each(function() {
      if ($(this).find('[data-x-search-result="ACCOUNT"]').length === 0) return;

      var $item = $(this);
      var actions = $item.find('.search-account-result__actions');
      if (!actions.length) {
        console.log('[Extension] No .search-account-result__actions found, skipping');
        return;
      }

      // Guard on the actions container itself
      if (actions.data('ext-injected')) return;

      var company_data = scrape_company_from_row($item);
      if (!company_data.company_id || !company_data.name) {
        console.warn('[Extension] Could not scrape company_id or name — skipping row. href was:',
          $item.find('a[data-control-name="view_company_via_result_name"]').attr('href'));
        return;
      }

      actions.data('ext-injected', true);

      var $btn = $('<div/>').addClass('extension-individual-button available').html('Export');

      $btn.on('click', function(e) {
        var $b = $(e.currentTarget);

        if ($b.hasClass('added')) {
          $b.removeClass('added').addClass('available').html('Export');
          console.log('[Extension] Removing company', company_data.company_id);
          var cb = (new Date()).getTime();
          chrome.runtime.sendMessage({
            type: "extension:companies:remove",
            data: { company_id: company_data.company_id },
            callback_id: cb
          });
          callbacks[cb] = function() { refresh_count(); };
        } else {
          var fresh = scrape_company_from_row($item);
          console.log('[Extension] Adding company:', fresh);
          $b.removeClass('available').addClass('added').html('Added');
          var cb = (new Date()).getTime();
          chrome.runtime.sendMessage({
            type: "extension:company:add",
            data: fresh,
            callback_id: cb
          });
          callbacks[cb] = function() { refresh_count(); };
        }
      });

      var $wrap = $('<span/>').addClass('extension-export-wrap').append($btn);
      actions.append($wrap);
      console.log('[Extension] Export button added for:', company_data.name, '| ID:', company_data.company_id);
    });

  } else if (window.location.href.includes('/jobs/')) {
    ensure_jobs_dom_observer();
    inject_job_extract_buttons();

  } else {
    disconnect_jobs_dom_observer();
    // People / leads search page - scrape directly from DOM
    $('.artdeco-list__item').each(function() {
      if ($(this).find('[data-x-search-result="LEAD"]').length === 0) return;

      var $item = $(this);
      var actions = $item.find('[data-x-search-result="LEAD"]').find('.mt2.mr5').children('ul').first();
      if (!actions.length) return;

      // Guard on the actions <ul> itself — survives re-renders better than
      // a class on the outer list item which LinkedIn may recreate entirely.
      if (actions.data('ext-injected')) return;
      actions.data('ext-injected', true);

      var lead_data = scrape_lead_from_row($item);
      if (!lead_data.profile_id || !lead_data.name) {
        console.warn('[Extension] Could not scrape lead profile_id or name from row');
        actions.removeData('ext-injected'); // allow retry once data is ready
        return;
      }

      var $btn = $('<div/>').addClass('extension-individual-button available').html('Export');

      $btn.on('click', function(e) {
        var $b = $(e.currentTarget);

        if ($b.hasClass('added')) {
          $b.removeClass('added').addClass('available').html('Export');
          console.log('[Extension] Removing lead', lead_data.profile_id);
          var cb = (new Date()).getTime();
          chrome.runtime.sendMessage({
            type: "extension:leads:remove",
            data: { profile_id: lead_data.profile_id },
            callback_id: cb
          });
          callbacks[cb] = function() { refresh_count(); };
        } else {
          var fresh = scrape_lead_from_row($item);
          console.log('[Extension] Adding lead:', fresh);
          $b.removeClass('available').addClass('added').html('Added');
          var cb = (new Date()).getTime();
          chrome.runtime.sendMessage({
            type: "extension:lead:add",
            data: fresh,
            callback_id: cb
          });
          callbacks[cb] = function() { refresh_count(); };
        }
      });

      var $li = $('<li/>').addClass('extension-export-li').append($btn);
      actions.append($li);
      console.log('[Extension] Export button added for lead:', lead_data.name, '| ID:', lead_data.profile_id);
    });
  }

  ensure_select_all_button();
}

var last_url = window.location.href;

setInterval(function() {
  if (last_url != window.location.href) {
    if (extension_button_int) clearInterval(extension_button_int);
    disconnect_jobs_dom_observer();
    disconnect_sales_list_dom_observer();
    var staleMx = document.getElementById('ext-messaging-crm-root');
    if (staleMx && staleMx.parentNode) staleMx.parentNode.removeChild(staleMx);
    // Remove select-all button on every navigation so it re-creates fresh
    var stale = document.getElementById('ext-select-all-btn');
    if (stale) stale.parentNode.removeChild(stale);
    var staleRange = document.getElementById('ext-range-controls');
    if (staleRange) staleRange.parentNode.removeChild(staleRange);
    setTimeout(function () {
      start_check();
    }, 300);
  }
  last_url = window.location.href;
  individual_finder_tick();
  sync_select_all_button_label();
}, 1000);

function sync_select_all_button_label() {
  var masterBtn = document.getElementById('ext-select-all-btn');
  if (!masterBtn) return;
  var isJobs = window.location.href.includes('/jobs/');
  var isSentInvitations = is_sent_invitations_page();
  var isSalesList = is_sales_people_list_page();
  var isConnections = is_connections_page();
  var selector = isJobs ? '.jobs-extract-btn'
    : isSentInvitations ? '.sent-invitation-extract-btn'
    : isSalesList ? '.sales-list-extract-btn'
    : isConnections ? '.connections-extract-btn'
    : '.extension-individual-button';
  var allBtns = document.querySelectorAll(selector);
  if (allBtns.length === 0) return;
  var addedCount = document.querySelectorAll(selector + '.added').length;
  if (addedCount === allBtns.length) {
    masterBtn.textContent = 'Deselect All';
    masterBtn.style.background = '#c0392b';
  } else {
    masterBtn.textContent = 'Select All';
    masterBtn.style.background = '#0073b1';
  }
}
