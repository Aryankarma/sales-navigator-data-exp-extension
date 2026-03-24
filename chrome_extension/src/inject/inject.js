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
  return true;
});

var COMPANIES_KEY = 'companies';
var USERS_KEY = 'users';

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
  // Company name
  var name = $item.find('a[data-control-name="view_company_via_result_name"]').text().trim();

  // Company ID from the href  e.g. /sales/company/13480?...
  var href = $item.find('a[data-control-name="view_company_via_result_name"]').attr('href') || '';
  var company_id = href.split('?')[0].split('/').slice(-1)[0];

  // Industry
  var industry = $item.find('[data-anonymize="industry"]').text().trim();

  // Revenue
  var revenue = $item.find('[data-anonymize="revenue"]').text().trim();

  // Employee count — the aria-label on the employees link is most reliable
  var employees_label = $item.find('[data-anonymize="company-size"]').attr('aria-label') || '';
  var employees = $item.find('[data-anonymize="company-size"]').text().trim() || employees_label;

  // About / description  — pull from the full `title` attribute of the clamped div
  var description = $item.find('[data-anonymize="person-blurb"]').attr('title') || 
                    $item.find('[data-anonymize="person-blurb"]').text().trim();

  // Location
  var location = $item.find('[data-anonymize="location"]').text().trim();

  // Website — not present in the search list DOM, leave blank
  var website = '';

  console.log('[Extension] Scraped company:', { name, company_id, industry, revenue, employees, location });

  return { name, company_id, industry, revenue, employees, description, website, location };
}

// ---------------------------------------------------------------------------
// Scrape a single lead row from the people search DOM
// ---------------------------------------------------------------------------
function scrape_lead_from_row($item) {
  // Full name
  var name = $item.find('a[data-control-name="view_lead_panel_via_search_lead_name"] span[data-anonymize="person-name"]').text().trim();

  // Profile ID from the lead href  e.g. /sales/lead/ACwAADeCQ7s...,NAME_SEARCH,...
  var profileHref = $item.find('a[data-control-name="view_lead_panel_via_search_lead_name"]').attr('href') || '';
  var profile_id = profileHref.split('?')[0].split('/sales/lead/').slice(-1)[0].split(',')[0];

  // Current title / position
  var title = $item.find('span[data-anonymize="title"]').first().text().trim();

  // Current company name + ID
  var $companyLink = $item.find('a[data-control-name="view_company_via_profile_lockup"]').first();
  var company = $companyLink.text().trim();
  var companyHref = $companyLink.attr('href') || '';
  var company_id = companyHref.split('?')[0].split('/').slice(-1)[0];

  // Location
  var location = $item.find('span[data-anonymize="location"]').first().text().trim();

  // About / blurb — full text lives in the title attribute of the clamped container
  var about = $item.find('[data-anonymize="person-blurb"]').attr('title') ||
              $item.find('[data-anonymize="person-blurb"]').text().trim();

  // Time in role / company
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
    
    chrome.runtime.sendMessage({
      type: "extension:users:add",
      data: user_data,
      callback_id: callback_id
    });
    
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
  chrome.runtime.sendMessage({
    type: "extension:users:remove",
    data: {name, company},
    callback_id: callback_id
  });
  
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
// Update the floating button count
// ---------------------------------------------------------------------------
function refresh_count() {
  var key = window.location.href.includes('/search/company') ? COMPANIES_KEY : USERS_KEY;
  chrome.storage.local.get(key).then(function(data) {
    var count = Object.keys(data[key] || {}).length;
    console.log('[Extension] refresh_count key=' + key + ' count=' + count);
    $('.extension-button').html('<b>Export ' + count + ' items</b>');
  });
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

    // Clear button
    $($button.find('.extension-button-delete')[0]).on('click', async function() {
      chrome.storage.local.clear();
      reset_user();
      $('.extension-button').html('<b>Export 0 items</b>');
    });

    // Export / download button
    var $button_elem = $($button.find('.extension-button')[0]);
    $button_elem.on('click', async function() {
      var callback_id = (new Date()).getTime();

      callbacks[callback_id] = function(rsp) {
        $button_elem.removeClass('loading');
        if (rsp.type === 'companies:sent' || rsp.type === 'users:sent') {
          var r = rsp.response;
          if (r.status.code == 200) {
            $button_elem.addClass('valid').text('Exported!');
            reset_user();
            chrome.storage.local.clear();
            setTimeout(function() {
              $button_elem.removeClass('valid');
              $button_elem.html('<b>Export 0 items</b>');
            }, 3000);
          } else {
            $button_elem.addClass('error').text('Error: ' + r.status.message);
          }
        }
      };

      if (window.location.href.includes('/search/company')) {
        console.log('[Extension] Sending extension:companies:send');
        chrome.runtime.sendMessage({ type: "extension:companies:send", callback_id: callback_id });
      } else {
        chrome.runtime.sendMessage({ type: "extension:users:send", all_users, callback_id: callback_id });
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

      // Skip skeleton/loading rows — only process fully loaded ACCOUNT rows
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

      // Mark as init AFTER we confirmed we have valid data
      $item.addClass('extension-init');

      var $btn = $('<div/>').addClass('extension-individual-button available').html('Export');

      // Check if already saved (Promise API for MV3)
      chrome.storage.local.get(COMPANIES_KEY).then(function(data) {
        var companies = data[COMPANIES_KEY] || {};
        if (companies[company_data.company_id]) {
          $btn.removeClass('available').addClass('added').html('Added');
        }
      });

      $btn.on('click', function(e) {
        var $b = $(e.currentTarget);

        if ($b.hasClass('added')) {
          // Remove
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
          // Add — re-scrape fresh data at click time
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

  } else {
    // People / leads search page — scrape directly from DOM
    $('.artdeco-list__item').each(function() {
      if ($(this).hasClass('extension-init')) return;

      // Only process fully loaded LEAD rows
      if ($(this).find('[data-x-search-result="LEAD"]').length === 0) return;

      var $item = $(this);
      var actions = $item.find('.ml8').last().find('ul').first();
      if (!actions.length) return;

      var lead_data = scrape_lead_from_row($item);
      if (!lead_data.profile_id || !lead_data.name) {
        console.warn('[Extension] Could not scrape lead profile_id or name from row');
        return;
      }

      $item.addClass('extension-init');

      var $btn = $('<div/>').addClass('extension-individual-button available').html('Export');

      // Check if already saved
      chrome.storage.local.get(USERS_KEY).then(function(data) {
        var users = data[USERS_KEY] || {};
        if (users[lead_data.profile_id]) {
          $btn.removeClass('available').addClass('added').html('Added');
        }
      });

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
