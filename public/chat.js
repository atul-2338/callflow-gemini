/* CallFlow chat widget — dependency-free, FAQ quick replies + lead capture.
   Records page views, chat_opened, lead_submitted and trial_cta_clicked into the
   separate analytics DB via /api/chat/track and /api/chat-lead. */
(function () {
  'use strict';
  if (window.__cfChatLoaded) return;
  window.__cfChatLoaded = true;

  var pagePath = window.location.pathname || '/';

  function sessionId() {
    try {
      var key = 'cf_chat_sid';
      var existing = window.sessionStorage.getItem(key);
      if (existing) return existing;
      var made = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      window.sessionStorage.setItem(key, made);
      return made;
    } catch (e) {
      return 's_anon';
    }
  }
  var SID = sessionId();

  function post(url, payload) {
    try {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {});
    } catch (e) {
      return Promise.resolve();
    }
  }

  function track(event, detail) {
    post('/api/chat/track', {
      kind: 'event',
      event: event,
      detail: detail || null,
      path: pagePath,
      sessionId: SID
    });
  }

  try {
    var body = JSON.stringify({ kind: 'page_view', path: pagePath, referrer: document.referrer || null, sessionId: SID });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/chat/track', new Blob([body], { type: 'application/json' }));
    } else {
      post('/api/chat/track', { kind: 'page_view', path: pagePath, sessionId: SID });
    }
  } catch (e) { /* never break the page */ }

  document.addEventListener('click', function (ev) {
    var target = ev.target;
    if (!target || !target.closest) return;
    var hit = target.closest('[data-auth-open="trial"], a[href*="trial=1"]');
    if (hit) track('trial_cta_clicked', (hit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60));
  }, true);

  var FAQS = [
    ['Does it replace my number?', 'No. You keep the number customers already dial — only the calls you miss are forwarded to the AI receptionist.'],
    ['What does it cost?', '$0 for 3 days, then $99/month. Cancel anytime, no contract.'],
    ['How fast can I start?', 'Same day. Setup takes about five minutes: forward your missed calls, add your business details, done.'],
    ['Plumbing, HVAC or electrical?', 'All three. Greeting, questions and emergency rules are configured per business.']
  ];

  var BOT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.9 8.9 0 0 1-3.8-.8L3 21l1.9-4.9a8.4 8.4 0 0 1-.9-4.6A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z"/></svg>';

  function mount() {
    if (document.getElementById('cfChatLauncher')) return;

    var launcher = document.createElement('button');
    launcher.id = 'cfChatLauncher';
    launcher.type = 'button';
    launcher.className = 'cf-chat-launcher';
    launcher.setAttribute('aria-label', 'Ask a question about CallFlow');
    launcher.innerHTML = BOT_ICON + '<span>Questions?</span>';

    var panel = document.createElement('div');
    panel.id = 'cfChatPanel';
    panel.className = 'cf-chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'CallFlow assistant');
    panel.innerHTML =
      '<div class="cf-chat-head">' +
        '<div><span class="cf-chat-title">CallFlow assistant</span><span class="cf-chat-sub">Typical reply: instantly</span></div>' +
        '<button class="cf-chat-close" type="button" aria-label="Close chat">&times;</button>' +
      '</div>' +
      '<div class="cf-chat-body">' +
        '<div class="cf-chat-msg bot">Hi — I am the CallFlow assistant. Pick a question below, or leave your details and a human will call you back.</div>' +
        '<div class="cf-chat-faqs" id="cfChatFaqs"></div>' +
        '<button class="cf-chat-faq" type="button" id="cfChatShowForm" style="align-self:flex-start">Leave my details &rarr;</button>' +
        '<form class="cf-chat-form" id="cfChatForm" novalidate>' +
          '<label for="cfChatName">Name *</label><input id="cfChatName" name="name" type="text" autocomplete="name" required />' +
          '<label for="cfChatContact">Phone or email *</label><input id="cfChatContact" name="contact" type="text" autocomplete="tel" required />' +
          '<label for="cfChatTrade">Business / trade</label><input id="cfChatTrade" name="business_trade" type="text" placeholder="Plumbing, HVAC..." />' +
          '<label for="cfChatZip">City / ZIP</label><input id="cfChatZip" name="city_zip" type="text" placeholder="Round Rock, 78664" />' +
          '<label for="cfChatMessage">Anything else?</label><textarea id="cfChatMessage" name="message" maxlength="1000"></textarea>' +
          '<input class="cf-chat-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />' +
          '<button class="cf-chat-submit" type="submit" id="cfChatSubmit">Send to CallFlow</button>' +
          '<p class="cf-chat-note">We only use these details to contact you about CallFlow. No spam.</p>' +
          '<p class="cf-chat-error" id="cfChatError" hidden></p>' +
        '</form>' +
      '</div>';

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    var faqBox = panel.querySelector('#cfChatFaqs');
    var form = panel.querySelector('#cfChatForm');
    var errorEl = panel.querySelector('#cfChatError');
    var submit = panel.querySelector('#cfChatSubmit');
    var bodyEl = panel.querySelector('.cf-chat-body');

    function bubble(text, who) {
      var el = document.createElement('div');
      el.className = 'cf-chat-msg ' + (who || 'bot');
      el.textContent = text;
      bodyEl.insertBefore(el, form);
      bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    FAQS.forEach(function (pair) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cf-chat-faq';
      btn.textContent = pair[0];
      btn.addEventListener('click', function () {
        bubble(pair[0], 'user');
        bubble(pair[1], 'bot');
        track('faq_opened', pair[0]);
      });
      faqBox.appendChild(btn);
    });

    launcher.addEventListener('click', function () {
      var open = panel.classList.toggle('is-open');
      launcher.setAttribute('aria-expanded', String(open));
      if (open) {
        track('chat_opened');
        bodyEl.scrollTop = bodyEl.scrollHeight;
        var first = panel.querySelector('input');
        if (first) first.focus({ preventScroll: true });
      }
    });

    panel.querySelector('.cf-chat-close').addEventListener('click', function () {
      panel.classList.remove('is-open');
      launcher.setAttribute('aria-expanded', 'false');
    });

    panel.querySelector('#cfChatShowForm').addEventListener('click', function () {
      form.classList.add('is-open');
      panel.querySelector('#cfChatName').focus({ preventScroll: true });
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      errorEl.hidden = true;
      var field = function (n) { return (form.elements[n] && form.elements[n].value) || ''; };
      var data = {
        name: field('name').trim(),
        contact: field('contact').trim(),
        business_trade: field('business_trade').trim(),
        city_zip: field('city_zip').trim(),
        message: field('message').trim(),
        website: field('website'),
        path: pagePath,
        sessionId: SID
      };
      if (data.name.length < 2 || data.contact.length < 3) {
        errorEl.textContent = 'Please add your name and a phone or email.';
        errorEl.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Sending…';
      post('/api/chat-lead', data).then(function (res) {
        return res && res.ok ? res.json() : null;
      }).then(function (json) {
        if (json && json.ok) {
          bubble('Thanks ' + data.name.split(' ')[0] + ' — got it. We will contact you shortly.', 'bot');
          track('lead_submitted', data.business_trade || null);
          form.reset();
          form.classList.remove('is-open');
          submit.textContent = 'Sent';
        } else {
          errorEl.textContent = 'Could not send that just now — please try again or email hello@callflow.biz.';
          errorEl.hidden = false;
          submit.disabled = false;
          submit.textContent = 'Send to CallFlow';
        }
      }).catch(function () {
        errorEl.textContent = 'Network error — please try again.';
        errorEl.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Send to CallFlow';
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();

