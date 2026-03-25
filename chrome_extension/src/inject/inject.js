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

  return true;
});

function get_jobs_container() {
  let container = $('[componentkey="SearchResultsMainContent"]');
  if (container.length === 0) container = $('[data-testid="lazy-column"]');
  if (container.length === 0) container = $('.scaffold-layout__list');
  if (container.length === 0) container = $('body'); // robust fallback
  return container;
}

function get_job_items(container) {
  var items = container.find('div[role="button"][componentkey]');
  if (items.length === 0) {
    items = container.find('.f55dc56d').closest('div._4ac719f8.d578948b');
  }
  if (items.length === 0) {
    items = container.find('div[data-view-name="job-card"]');
  }
  return items;
}

// Scraper for Job Search results
function scrape_all_jobs() {
  const jobs = [];
  let container = get_jobs_container();
  
  if (container.length === 0) {
    console.warn('[Extension] Jobs container not found');
    return jobs;
  }

  get_job_items(container).each(function() {
    const $item = $(this);
    
    // Only scrape if the button is in 'added' selected state
    if ($item.find('.jobs-extract-btn.added').length === 0) return;

    // Title: usually in a p with class f55dc56d
    const title = $item.find('.f55dc56d').find('span._4c50b7df').first().text().trim() || 
                  $item.find('.f55dc56d').text().trim();
    
    // Company: resides in class _41247193
    const company = $item.find('._41247193').first().text().trim();
    
    // Location and Posted often share classes like ad75f074
    let location = '';
    let posted = '';
    
    $item.find('.ad75f074').each(function() {
      const text = $(this).text().trim();
      if (text.toLowerCase().includes('posted') || text.toLowerCase().includes(' ago')) {
        posted = text.replace(/.*\n/, '').trim(); // Handle potential nested spans
      } else if (text.length > 0 && !location) {
        location = text;
      }
    });

    // Fallback for posted if not caught by class
    if (!posted) {
      $item.find('span._4c50b7df').each(function() {
        const text = $(this).text().trim();
        if (text.toLowerCase().includes('posted')) {
          posted = text;
          return false; // Stop iterating once found
        }
      });
    }

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
        let href = $a.attr('href');
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

    // Method 4: fallback — parse from the page URL if a card is currently selected
    if (!link) {
      const pageUrl = window.location.href;
      const pageMatch = pageUrl.match(/currentJobId=(\d+)/);
      if (pageMatch) {
        link = 'https://www.linkedin.com/jobs/view/' + pageMatch[1];
      }
    }
    
    if (title && (company || location)) {
      jobs.push({ title, company, location, posted, link });
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
      if ($(this).hasClass('extension-init')) return;

      if ($(this).find('[data-x-search-result="ACCOUNT"]').length === 0) return;

      var $item = $(this);
      var actions = $item.find('.search-account-result__actions');
      if (!actions.length) {
        console.log('[Extension] No .search-account-result__actions found, skipping');
        return;
      }

      var company_data = scrape_company_from_row($item);
      if (!company_data.company_id || !company_data.name) {
        console.warn('[Extension] Could not scrape company_id or name — skipping row. href was:',
          $item.find('a[data-control-name="view_company_via_result_name"]').attr('href'));
        return;
      }

      $item.addClass('extension-init');

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
    // Jobs page
    let container = get_jobs_container();
    if (container.length === 0) return;

    get_job_items(container).each(function() {
      if ($(this).hasClass('extension-init')) return;
      $(this).addClass('extension-init');

      var $item = $(this);
      
      var $btn = $('<div/>').addClass('extension-individual-button available jobs-extract-btn').html('Extract');
      $btn.css({'margin': '8px', 'font-size': '12px', 'padding': '4px 8px', 'border-radius': '4px', 'background': '#fff', 'border': '1px solid #0073b1', 'color': '#0073b1', 'cursor': 'pointer', 'display': 'inline-block', 'font-weight': '600', 'z-index': '9999', 'position': 'relative'});
      
      $btn.on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var $b = $(e.currentTarget);
        if ($b.hasClass('added')) {
          $b.removeClass('added').addClass('available').html('Extract').css({'background': '#fff', 'color': '#0073b1'});
        } else {
          $b.removeClass('available').addClass('added').html('Selected').css({'background': '#0073b1', 'color': '#fff'});
        }
      });
      
      var footer = $item.find('._030d77d9').last();
      if (footer.length === 0) {
        footer = $item.find('.job-card-container__metadata-wrapper, .job-card-container__footer-item').last();
      }
      
      if (footer.length > 0) {
        footer.append($btn);
      } else {
        $item.append($btn);
      }
    });

  } else {
    // People / leads search page - scrape directly from DOM
    $('.artdeco-list__item').each(function() {
      if ($(this).hasClass('extension-init')) return;

      if ($(this).find('[data-x-search-result="LEAD"]').length === 0) return;

      var $item = $(this);
      var actions = $item.find('[data-x-search-result="LEAD"]').find('.mt2.mr5').children('ul').first();
      if (!actions.length) return;

      var lead_data = scrape_lead_from_row($item);
      if (!lead_data.profile_id || !lead_data.name) {
        console.warn('[Extension] Could not scrape lead profile_id or name from row');
        return;
      }

      $item.addClass('extension-init');

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
}

var last_url = window.location.href;

setInterval(function() {
  if (last_url != window.location.href) {
    if (extension_button_int) clearInterval(extension_button_int);
    setTimeout(function() { start_check(); }, 300);
  }
  last_url = window.location.href;
  individual_finder_tick();
}, 1000);
