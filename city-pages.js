// ---------------------------------------------------------------------------
// /austin/<city> SEO landing pages
//
// One page per Austin-metro city, rendered on the server (no client JS) so both
// crawlers and a phone on 3G get the whole page in one request. Every page has
// one job: explain the missed-call problem in that city, then send the owner to
// the 3-day free trial.
//
// Routes are registered in server.js: GET /austin and GET /austin/:city.
// ---------------------------------------------------------------------------

const SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://callflow.biz').replace(/\/+$/, '');
const TRIAL_CTA = '/?trial=1';
const LOGIN_CTA = '/?login=1';

export const CITY_PAGES = [
  {
    slug: 'round-rock',
    city: 'Round Rock',
    county: 'Williamson County',
    zips: ['78664', '78665', '78681', '78682', '78683'],
    landmarks: ['Old Town Round Rock', 'Dell Diamond', 'Forest Creek'],
    blurb: 'Round Rock has grown faster than almost any city in Central Texas, and every new neighborhood means another plumber, HVAC tech and electrician whose phone rings while they are on a ladder.',
  },
  {
    slug: 'cedar-park',
    city: 'Cedar Park',
    county: 'Williamson County',
    zips: ['78613', '78630'],
    landmarks: ['H-E-B Center', 'Brushy Creek', 'Lakeline'],
    blurb: 'From Lakeline to Brushy Creek, Cedar Park homeowners expect a call back within minutes. One missed call usually means they have already dialled the next name on the list.',
  },
  {
    slug: 'pflugerville',
    city: 'Pflugerville',
    county: 'Travis County',
    zips: ['78660', '78691'],
    landmarks: ['Pfluger Park', 'Blackhawk', 'Falcon Pointe'],
    blurb: 'Pflugerville is full of newer homes hitting the age where water heaters, hose bibs and AC units start failing - and those calls almost always come in while you are under a sink.',
  },
  {
    slug: 'georgetown',
    city: 'Georgetown',
    county: 'Williamson County',
    zips: ['78626', '78627', '78628', '78633'],
    landmarks: ['The Square', 'Sun City', 'Wolf Ranch'],
    blurb: 'Georgetown mixes historic downtown with fast-growing Sun City and Wolf Ranch. Older homes mean more emergency leaks, and many of those callers will not chase you down twice.',
  },
  {
    slug: 'lakeway',
    city: 'Lakeway',
    county: 'Travis County',
    zips: ['78734', '78738'],
    landmarks: ['Lake Travis', 'Flintrock Falls', 'Bee Cave'],
    blurb: 'Lakeway and the Lake Travis shoreline are full of second homes and weekend properties where a burst pipe or failed well pump is an expensive emergency that cannot wait until Monday.',
  },
  {
    slug: 'kyle',
    city: 'Kyle',
    county: 'Hays County',
    zips: ['78640'],
    landmarks: ['Kyle Crossing', 'Plum Creek', 'Bunton Creek'],
    blurb: 'Kyle is one of the fastest-growing cities on the I-35 corridor, and new-build owners are just starting to need real service work - usually at the exact moment you are already booked out.',
  },
];

export const CITY_SLUGS = new Set(CITY_PAGES.map((page) => page.slug));
export const CITY_BY_SLUG = new Map(CITY_PAGES.map((page) => [page.slug, page]));

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BRAND_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 3h3.2l1 3.4-2 1.7a12.6 12.6 0 0 0 4.8 4.8l1.7-2 3.4 1v3.2a2 2 0 0 1-2.2 2A16.3 16.3 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3Z" /></svg>';

function header() {
  return `<header class="city-bar">
      <div class="bar-inner">
        <a class="brand" href="/">
          <span class="brand-mark">${BRAND_SVG}</span>
          <span>
            <span class="brand-title">CallFlow<span>.biz</span></span>
            <span class="brand-sub">Missed-call recovery &middot; Austin, TX</span>
          </span>
        </a>
        <nav class="bar-actions" aria-label="CallFlow">
          <a class="btn btn-ghost" href="${LOGIN_CTA}">Log In</a>
          <a class="btn btn-gold" href="${TRIAL_CTA}">Start 3-Day Free Trial</a>
        </nav>
      </div>
    </header>`;
}

function footer(currentSlug) {
  const cityLinks = CITY_PAGES.filter((page) => page.slug !== currentSlug)
    .map((page) => `<a href="/austin/${page.slug}">${esc(page.city)}</a>`)
    .join('');
  return `<footer class="city-foot">
      <strong>CallFlow.biz</strong> &middot; missed-call recovery and AI dispatch for Central Texas service businesses<br />
      Calls are answered only after your own line goes unanswered. Results vary by trade and call volume.
      <nav class="foot-links" aria-label="Austin-area cities"><a href="/austin">All Austin-area cities</a>${cityLinks}</nav>
      <nav class="foot-links foot-links-legal" aria-label="Legal and support">
        <a href="/privacy-policy">Privacy Policy</a>
        <a href="/refund-and-cancellation">Refund and Cancellation</a>
        <a href="/contact">Contact Us</a>
      </nav>
    </footer>`;
}

function serviceJsonLd(page) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: `CallFlow AI receptionist for ${page.city}, TX`,
    serviceType: 'AI receptionist and missed-call recovery for home service businesses',
    provider: { '@type': 'LocalBusiness', name: 'CallFlow.biz', url: SITE_URL, telephone: '+1-737-292-2340' },
    areaServed: {
      '@type': 'City',
      name: page.city,
      containedInPlace: { '@type': 'State', name: 'Texas' },
    },
    url: `${SITE_URL}/austin/${page.slug}`,
    description: `CallFlow answers the calls ${page.city} plumbers, HVAC technicians and electricians miss, takes the job details and books the appointment.`,
  });
}

function faqJsonLd(page) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: `How does CallFlow work for ${page.city} plumbers?`,
        acceptedAnswer: {
          '@type': 'Answer',
          text: `You keep your existing ${page.city} phone number. When you do not pick up, the call is forwarded to the CallFlow answering line, which greets the caller in your business name, captures the job details and texts you the lead.`,
        },
      },
      {
        '@type': 'Question',
        name: 'What does CallFlow cost?',
        acceptedAnswer: { '@type': 'Answer', text: 'The first 3 days are free. After the trial it is $99 per month, cancel anytime.' },
      },
      {
        '@type': 'Question',
        name: 'Do I need to change my phone number?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'No. CallFlow works alongside the number your customers already dial. Only the calls you miss are forwarded to the answering line.',
        },
      },
    ],
  });
}

function heroHtml(page) {
  return `<section class="hero">
    <p class="kicker">${esc(page.city)}, TX &middot; ${esc(page.county)}</p>
    <h1>Never miss another ${esc(page.city)} customer</h1>
    <p class="lede">
      When you are under a sink or up a ladder, calls go to voicemail and the job goes to the next
      name on Google. CallFlow answers those missed calls in your business name, takes the details
      and books the appointment &mdash; 24 hours a day.
    </p>
    <p class="local">${esc(page.blurb)}</p>
    <div class="cta-row">
      <a class="btn btn-gold btn-lg" href="${TRIAL_CTA}">Start the 3-day free trial</a>
      <a class="btn btn-ghost btn-lg" href="/#pricing">See pricing</a>
    </div>
    <p class="cta-note">$0 today &middot; then $99/month &middot; cancel anytime &middot; no new phone number needed</p>
  </section>`;
}

function factsHtml(page) {
  return `<section class="fact-strip" aria-label="${esc(page.city)} coverage">
    <div><span>County</span><strong>${esc(page.county)}</strong></div>
    <div><span>ZIP codes served</span><strong>${esc(page.zips.join(', '))}</strong></div>
    <div><span>Local areas</span><strong>${page.landmarks.map(esc).join(' &middot; ')}</strong></div>
  </section>`;
}

function cardsHtml(page) {
  return `<section class="cards" aria-label="What CallFlow does">
    <article class="card">
      <h2>Answers 24/7</h2>
      <p>Nights, weekends and the middle of a job. Every unanswered call still gets picked up by a
        receptionist that knows your trade, your ${esc(page.city)} service area and your hours.</p>
    </article>
    <article class="card">
      <h2>Captures the job</h2>
      <p>Name, number, address, what broke and how urgent it is &mdash; written down the same way every
        time, so nothing gets lost on a sticky note.</p>
    </article>
    <article class="card">
      <h2>Puts it in your app</h2>
      <p>The lead lands in your CallFlow log with the call time and duration, plus a push alert on
        your phone so you can call back while the job is still yours.</p>
    </article>
  </section>`;
}

function stepsHtml() {
  return `<section class="steps">
    <h2>How it works</h2>
    <ol>
      <li><strong>Keep your number.</strong> Set up conditional forwarding so only the calls you
        miss ring CallFlow.</li>
      <li><strong>Describe your business.</strong> Name, service area, hours and what an emergency
        looks like for you.</li>
      <li><strong>Call back and close.</strong> Every missed call arrives as a qualified lead with the
        details already collected.</li>
    </ol>
  </section>`;
}

function pricingHtml(page) {
  return `<section class="pricing" id="pricing">
    <h2>Simple pricing for ${esc(page.city)} shops</h2>
    <div class="price-card">
      <div class="price-top"><strong>$0</strong><span>for 3 days</span></div>
      <p class="price-line">Then <strong>$99/month</strong>. Cancel anytime &mdash; no contract, no setup fee.</p>
      <a class="btn btn-gold btn-lg" href="${TRIAL_CTA}">Start the 3-day free trial</a>
    </div>
  </section>`;
}

function faqHtml(page) {
  return `<section class="faq">
    <h2>Questions ${esc(page.city)} owners ask</h2>
    <details><summary>Do I have to change my phone number?</summary>
      <p>No. CallFlow sits behind the number your customers already dial. Only the calls you do not
        answer are forwarded to the AI receptionist.</p></details>
    <details><summary>Does it work for HVAC and electrical too?</summary>
      <p>Yes. The greeting, the questions and the emergency rules are configured per business, not
        per trade.</p></details>
    <details><summary>What happens after the 3-day trial?</summary>
      <p>You can continue on the $99/month plan or stop &mdash; there is no lock-in and no
        cancellation fee.</p></details>
  </section>`;
}

function otherCitiesHtml(currentSlug) {
  const links = CITY_PAGES.filter((item) => item.slug !== currentSlug)
    .map((item) => `<a href="/austin/${item.slug}">${esc(item.city)}</a>`)
    .join('');
  return `<section class="other-cities">
    <h2>Other Austin-area cities</h2>
    <div class="city-links">${links}</div>
  </section>`;
}

export function renderCityPage(page) {
  const title = `AI Receptionist for ${page.city} Plumbers & Home Services | CallFlow.biz`;
  const description = `CallFlow answers the calls ${page.city} plumbers, HVAC and electrical businesses miss, captures the job details and books the appointment. 3-day free trial, then $99/mo.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${SITE_URL}/austin/${page.slug}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${SITE_URL}/austin/${page.slug}" />
<meta property="og:site_name" content="CallFlow.biz" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/city.css" />
<script type="application/ld+json">${serviceJsonLd(page)}</script>
<script type="application/ld+json">${faqJsonLd(page)}</script>
</head>
<body>
${header()}
<main class="city-main">
${heroHtml(page)}
${factsHtml(page)}
${cardsHtml(page)}
${stepsHtml()}
${pricingHtml(page)}
${faqHtml(page)}
${otherCitiesHtml(page.slug)}
</main>
${footer(page.slug)}
</body>
</html>`;
}

export function renderAustinIndex() {
  const title = 'AI Receptionist for Austin-Area Service Businesses | CallFlow.biz';
  const description = 'CallFlow answers missed calls for plumbers, HVAC and electrical businesses across Austin, Round Rock, Cedar Park, Pflugerville, Georgetown, Lakeway and Kyle.';
  const tiles = CITY_PAGES.map(
    (page) => `<a class="city-tile" href="/austin/${page.slug}">
        <strong>${esc(page.city)}, TX</strong>
        <span>${page.zips.slice(0, 2).map(esc).join(' &middot; ')} &middot; ${esc(page.county)}</span>
      </a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${SITE_URL}/austin" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${SITE_URL}/austin" />
<link rel="icon" href="/icon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/city.css" />
</head>
<body>
${header()}
<main class="city-main">
  <section class="hero">
    <p class="kicker">Austin metro &middot; Texas</p>
    <h1>Never miss another Central Texas customer</h1>
    <p class="lede">CallFlow answers the calls plumbers, HVAC technicians and electricians miss across
      the Austin metro, captures the job details and books the appointment &mdash; 24 hours a day.</p>
    <div class="cta-row">
      <a class="btn btn-gold btn-lg" href="${TRIAL_CTA}">Start the 3-day free trial</a>
    </div>
    <p class="cta-note">$0 today &middot; then $99/month &middot; cancel anytime</p>
  </section>
  <section class="other-cities">
    <h2>Choose your city</h2>
    <div class="city-tiles">${tiles}</div>
  </section>
  <section class="faq">
    <h2>Why missed calls matter here</h2>
    <p class="lede">The Austin metro is one of the fastest-growing regions in the country. New
      neighborhoods mean more service work &mdash; and more competition for the same call. The shop
      that answers first usually wins the job, even when it is not the cheapest quote.</p>
  </section>
</main>
${footer('')}
</body>
</html>`;
}

export function sitemapEntries() {
  return [
    '/',
    '/privacy-policy',
    '/refund-and-cancellation',
    '/contact',
    '/austin',
    ...CITY_PAGES.map((page) => `/austin/${page.slug}`),
  ];
}
