// Add monkey patch to catch requests
var s = document.createElement('script');
s.src = chrome.runtime.getURL("src/inject/interceptRequest.js");
s.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(s);

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

function make_extract_btn($item) {
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
      } else {
        $b.removeClass('available').addClass('added').html('Selected').css({ background: '#0073b1', color: '#fff', border: '1px solid #0073b1' });
        // Capture the currentJobId from the page URL at selection time.
        // When a user clicks a job card on LinkedIn, the URL updates to include
        // currentJobId=XXXXX. Since our button is inside the card, clicking it
        // also activates that card, so the URL reflects this specific job.
        var pageMatch = window.location.href.match(/currentJobId=(\d+)/);
        if (pageMatch) {
          $b.data('captured-link', 'https://www.linkedin.com/jobs/view/' + pageMatch[1]);
        }
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
function ensure_select_all_button() {
  // Already in the live DOM? Nothing to do.
  if (document.getElementById('ext-select-all-btn')) return;

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
    var selector = isJobs ? '.jobs-extract-btn' : '.extension-individual-button';

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

  if (!title) {
    title =
      $item.find('.f55dc56d span._4c50b7df').first().text().trim() ||
      $item.find('.f55dc56d').first().text().trim();
  }
  if (!title) {
    title = $item
      .find(
        'a.job-card-container__link, .job-card-list__title, h3 a, h3, [data-testid="job-card-title"]',
      )
      .first()
      .text()
      .trim();
  }
  if (!title) {
    title = $item.find('a[href*="/jobs/view/"]').first().text().trim();
  }

  function is_likely_results_count_or_noise(t) {
    if (!t) return true;
    if (/^\d+\s*\+?\s*results?$/i.test(t)) return true;
    if (/^99\+/i.test(t)) return true;
    if (/\d+\s*\+\s*results?/i.test(t)) return true;
    if (/are these results helpful/i.test(t)) return true;
    return false;
  }

  // New feed: company sits in div.a390a9fc > p without class a390a9fc on the p; location line uses p.a390a9fc.
  var $companyP = $item.find('div.a390a9fc > p').filter(function () {
    return !$(this).hasClass('a390a9fc');
  }).first();
  var company = ($companyP.length && $companyP.text().trim()) || '';
  if (is_likely_results_count_or_noise(company)) company = '';

  if (!company) {
    company = $item.find('._41247193').first().text().trim();
  }
  if (!company || is_likely_results_count_or_noise(company)) {
    company = $item
      .find(
        '.artdeco-entity-lockup__subtitle, [data-testid="company-name"], .job-card-container__primary-description',
      )
      .first()
      .text()
      .trim();
  }
  if (is_likely_results_count_or_noise(company)) company = '';

  var location = '';
  var posted = '';

  if (!company || !location) {
    var paras = [];
    $item.find('p').each(function () {
      var t = $(this).text().replace(/\s+/g, ' ').trim();
      if (
        !t ||
        t === title ||
        is_likely_results_count_or_noise(t) ||
        /^posted\b/i.test(t) ||
        /\beasy apply\b/i.test(t) ||
        /\balumni\b/i.test(t) ||
        /\bworks here\b/i.test(t) ||
        /^\s*·\s*$/.test(t) ||
        /days ago\s*$/i.test(t)
      ) {
        return;
      }
      if (paras.indexOf(t) === -1) paras.push(t);
    });
    if (!company && paras.length) company = paras[0];
    if (!location && paras.length > 1) {
      for (var pi = 1; pi < paras.length; pi++) {
        var cand = paras[pi];
        if (cand === company) continue;
        if (/on-?site|remote|hybrid|,|\(/.test(cand) || cand.length < 80) {
          location = cand;
          break;
        }
      }
    }
  }

  $item.find('.ad75f074').each(function () {
    var text = $(this).text().trim();
    if (text.toLowerCase().includes('posted') || text.toLowerCase().includes(' ago')) {
      posted = text.replace(/.*\n/, '').trim();
    } else if (text.length > 0 && !location) {
      location = text;
    }
  });
  if (!location) {
    location = $item
      .find(
        '.job-card-container__metadata-item, [data-testid="job-card-location"], .job-card-list__metadata-item',
      )
      .first()
      .text()
      .trim();
  }
  if (!posted) {
    $item.find('span._4c50b7df').each(function () {
      var text = $(this).text().trim();
      if (text.toLowerCase().includes('posted')) {
        posted = text;
        return false;
      }
    });
  }
  if (!posted) {
    $item.find('span').each(function () {
      var text = $(this).text().replace(/\s+/g, ' ').trim();
      if (/^posted\b/i.test(text)) {
        posted = text;
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
    let link = '';

    // Method 0: link captured at selection time (currentJobId from URL when user clicked the card)
    var capturedLink = $btn.data('captured-link');
    if (capturedLink) { link = capturedLink; }

    // Method 1: anchor with currentJobId param inside the card
    if (!link) {
      $item.find('a[href*="currentJobId="]').each(function() {
        const href = $(this).attr('href') || '';
        const match = href.match(/currentJobId=(\d+)/);
        if (match) { link = 'https://www.linkedin.com/jobs/view/' + match[1]; return false; }
      });
    }
    // Method 2: direct /jobs/view/ anchor
    if (!link) {
      const $a = $item.find('a[href*="/jobs/view/"]').first();
      if ($a.length) { let href = $a.attr('href') || ''; if (href.startsWith('/')) href = 'https://www.linkedin.com' + href; link = href.split('?')[0]; }
    }
    // Method 3: data-job-id attribute
    if (!link) {
      const jobId = $item.attr('data-job-id') || $item.find('[data-job-id]').first().attr('data-job-id');
      if (jobId) link = 'https://www.linkedin.com/jobs/view/' + jobId;
    }
    // NOTE: No page-URL fallback — that gives all cards the same link and triggers
    // the unique-index deduplication on the server, causing only 1 row to be saved.

    if (title || company || location || link) {
      jobs.push({ title: title || 'Job', company: company || '', location: location || '', posted: posted || '', link: link || '' });
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

    // Extract Job Link from the dismiss button's aria-label componentkey
    // The componentkey on each card matches a URL param; extract the job ID
    // from anchors inside the card that point to /jobs/view/ or /jobs/search-results/
    let link = '';
    
    // Method 1: look for any anchor whose href contains currentJobId= with a numeric ID
    $item.find('a[href*="currentJobId="]').each(function() {
      const href = $(this).attr('href') || '';
      const match = href.match(/currentJobId=(\d+)/);
      if (match) {
        link = 'https://www.linkedin.com/jobs/view/' + match[1];
        return false;
      }
    });

    // Method 2: direct /jobs/view/ link (detail panel or card)
    if (!link) {
      const $a = $item.find('a[href*="/jobs/view/"]').first();
      if ($a.length) {
        let href = $a.attr('href') || '';
        if (href.startsWith('/')) href = 'https://www.linkedin.com' + href;
        link = href.split('?')[0];
      }
    }

    // Method 3: data-job-id or entity urn
    if (!link) {
      const jobId = $item.attr('data-job-id') || 
                    $item.find('[data-job-id]').first().attr('data-job-id');
      if (jobId) {
        link = 'https://www.linkedin.com/jobs/view/' + jobId;
      } else {
        const urn = $item.find('[data-entity-urn]').first().attr('data-entity-urn');
        if (urn && urn.includes('jobPost:')) {
          link = 'https://www.linkedin.com/jobs/view/' + urn.split('jobPost:')[1];
        }
      }
    }

    // NOTE: No page-URL fallback here either — same deduplication problem.
    
    // Include row if we can identify the job (link is enough when LI changes title/company classes).
    if (title || company || location || link) {
      jobs.push({
        title: title || 'Job',
        company: company || '',
        location: location || '',
        posted: posted || '',
        link: link || '',
      });
    }
  });
  
  return jobs;
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

  return { name, profile_id, title, company, company_id, location, about, tenure };
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
    "https://www.linkedin.com/sales/search/company"
  ];

  var url_supported = paths.some(p => window.location.href.indexOf(p) === 0);

  if (!url_supported) {
    all_users = [];
    return;
  }

  if (!$('.extension-button').length) {
    var $button = $('<div/>').addClass('extension-button-wrapper').html(
      '<div class="extension-button"><b>Export 0 items</b></div><div class="extension-button-delete">x</div>'
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
    // Remove select-all button on every navigation so it re-creates fresh
    var stale = document.getElementById('ext-select-all-btn');
    if (stale) stale.parentNode.removeChild(stale);
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
  var selector = isJobs ? '.jobs-extract-btn' : '.extension-individual-button';
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
