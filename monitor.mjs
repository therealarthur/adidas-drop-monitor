/**
 * Adidas F1 Audi Drop Monitor v0.4.0
 * Multi-layer detection for fastest possible drop alerts.
 *
 * Layer 0: ETag/Last-Modified optimization (skip unchanged sitemaps)
 * Layer 1: Multi-region sitemaps (UK/DE detect products before US)
 * Layer 2: PLP collection page sitemaps (new collections appear first)
 * Layer 3: Sneaker news RSS feeds (advance intel, days early)
 * Baseline: US product sitemap (confirmed ground truth)
 *
 * All layers run in parallel. No browser needed, just fetch().
 * Sends Telegram + SMS notifications with View and Add-to-Cart links.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';

// ── Config ──────────────────────────────────────────────────────────────────
const STATE_FILE = 'state/products.json';
const NOTIFY_LOG = 'state/notifications.log';
const TEST_MODE = process.argv.includes('--test-notify');

// ── Sitemap URLs (all bypass Akamai WAF via /glass/ path) ───────────────────
const SITEMAPS = {
  // US product sitemap (primary, ground truth)
  us: 'https://www.adidas.com/glass/sitemaps/adidas/US/en/sitemaps/adidas-US-en-us-product.xml',
  // UK product sitemap (may update before US for global launches)
  uk: 'https://www.adidas.co.uk/glass/sitemaps/adidas/GB/en/sitemaps/adidas-GB-en-gb-product.xml',
  // DE product sitemap (may update before US for global launches)
  de: 'https://www.adidas.de/glass/sitemaps/adidas/DE/de/sitemaps/adidas-DE-de-de-product.xml',
};

// PLP (collection page) sitemaps, 1 through 4
const PLP_SITEMAP_BASE = 'https://www.adidas.com/glass/sitemaps/adidas/US/en/sitemaps/plp-sitemap-';
const PLP_SITEMAP_COUNT = 4;

// Sneaker news RSS feeds for advance intelligence
const NEWS_FEEDS = [
  'https://hypebeast.com/feed',
  'https://sneakernews.com/feed/',
];

// ── Filters ─────────────────────────────────────────────────────────────────
const AUDI_FILTER = /audi/i;
const SAUDI_EXCLUSION = /saudi/i;
// Keywords for RSS feed matching (must match at least one from each group)
const RSS_KEYWORDS_PRIMARY = ['audi'];
const RSS_KEYWORDS_SECONDARY = ['adidas', 'f1', 'formula', 'revolut'];

// ── Notification config from env ────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TWILIO_SID = process.env.TWILIO_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const TWILIO_TO = process.env.TWILIO_TO || '';
const DEFAULT_SIZE = process.env.DEFAULT_SIZE || 'L';

// ── Utility functions ───────────────────────────────────────────────────────

/**
 * Log with timestamp
 * @param {string} msg - Message to log
 */
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/**
 * Load previous state from JSON file
 * @returns {Object} State object with products, plpPages, etags, rssChecked, notifiedEvents
 */
function loadState() {
  mkdirSync('state', { recursive: true });
  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, '{}');
    return { products: {}, plpPages: {}, etags: {}, rssChecked: {}, notifiedEvents: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    // Migrate from old flat format (just products) to new structured format
    if (!raw._version) {
      return {
        products: raw,
        plpPages: {},
        etags: {},
        rssChecked: {},
        notifiedEvents: {},
      };
    }
    return raw;
  } catch {
    return { products: {}, plpPages: {}, etags: {}, rssChecked: {}, notifiedEvents: {} };
  }
}

/**
 * Save state to JSON file
 * @param {Object} state - Full state object
 */
function saveState(state) {
  state._version = 2;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Build the "add to cart" URL for an Adidas product
 * @param {string} sku - Product SKU
 * @param {string} productUrl - Product page URL
 * @param {string} size - Default size to pre-select
 * @returns {string} ATC URL
 */
function buildAtcUrl(sku, productUrl, size) {
  if (productUrl && productUrl.includes('.html')) {
    return `${productUrl}?size=${encodeURIComponent(size)}`;
  }
  return `https://www.adidas.com/us/search?q=${sku}`;
}

/**
 * Fetch a URL with retries and timeout
 * @param {string} url - URL to fetch
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {number} retries - Number of retries
 * @returns {Promise<{status: number, text: string, headers: Object}>} Response
 */
async function fetchWithRetry(url, timeoutMs = 30000, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AdidasMonitor/1.0)',
          'Accept': 'text/xml, application/xml, text/html',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await resp.text();
      return {
        status: resp.status,
        text,
        headers: {
          etag: resp.headers.get('etag') || '',
          lastModified: resp.headers.get('last-modified') || '',
        },
      };
    } catch (err) {
      if (attempt < retries) {
        log(`  Retry ${attempt + 1}/${retries} for ${url}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
}

/**
 * HEAD request to check if a URL has changed (ETag/Last-Modified)
 * @param {string} url - URL to check
 * @param {Object} prevEtags - Previous etag/lastModified values
 * @returns {Promise<{changed: boolean, etag: string, lastModified: string}>}
 */
async function checkIfChanged(url, prevEtags) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AdidasMonitor/1.0)' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const etag = resp.headers.get('etag') || '';
    const lastModified = resp.headers.get('last-modified') || '';
    const prevData = prevEtags[url] || {};

    const changed = !prevData.etag || etag !== prevData.etag || lastModified !== prevData.lastModified;
    return { changed, etag, lastModified };
  } catch {
    // On error, assume changed (fetch the full content to be safe)
    return { changed: true, etag: '', lastModified: '' };
  }
}

// ── Notification functions ──────────────────────────────────────────────────

/**
 * Send Telegram notification
 * @param {string} text - Message text (supports Markdown)
 * @returns {Promise<boolean>} Success
 */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log('  Telegram not configured, skipping');
    return false;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4000),
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      }),
    });
    const data = await resp.json();
    if (data.ok) {
      log('  Telegram sent!');
      return true;
    }
    log(`  Telegram error: ${JSON.stringify(data)}`);
    // Retry without markdown if parse failed
    if (data.description && data.description.includes('parse')) {
      const retry = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text.slice(0, 4000),
          disable_web_page_preview: false,
        }),
      });
      const retryData = await retry.json();
      if (retryData.ok) {
        log('  Telegram sent (plain text fallback)!');
        return true;
      }
    }
    return false;
  } catch (err) {
    log(`  Telegram failed: ${err.message}`);
    return false;
  }
}

/**
 * Send SMS notification via Twilio
 * @param {string} body - SMS body text
 * @returns {Promise<boolean>} Success
 */
async function sendSms(body) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !TWILIO_TO) {
    log('  Twilio not configured, skipping');
    return false;
  }
  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        },
        body: new URLSearchParams({ From: TWILIO_FROM, To: TWILIO_TO, Body: body.slice(0, 1600) }),
      }
    );
    const data = await resp.json();
    if (data.sid) {
      log(`  SMS sent! SID: ${data.sid}`);
      return true;
    }
    log(`  SMS error: ${JSON.stringify(data)}`);
    return false;
  } catch (err) {
    log(`  SMS failed: ${err.message}`);
    return false;
  }
}

/**
 * Send notification for confirmed products (NEW DROP / RESTOCK)
 * Sends both Telegram (with links) and SMS
 * @param {Array} products - Array of {sku, name, price, url} objects
 * @param {string} eventType - 'new_drop' or 'restock'
 */
async function notifyProducts(products, eventType) {
  if (products.length === 0) return;

  const emoji = eventType === 'restock' ? '🔄' : '🚨';
  const label = eventType === 'restock' ? 'RESTOCK' : 'NEW DROP';

  // Build Telegram message
  let tgMsg = `${emoji} *ADIDAS AUDI F1 ${label}*\n`;
  tgMsg += `${products.length} item(s) detected!\n\n`;

  for (const p of products) {
    const viewUrl = p.url || `https://www.adidas.com/us/search?q=${p.sku}`;
    const atcUrl = buildAtcUrl(p.sku, p.url, DEFAULT_SIZE);
    tgMsg += `*${p.name || p.sku}*\n`;
    if (p.price) tgMsg += `Price: ${p.price}\n`;
    tgMsg += `SKU: \`${p.sku}\`\n`;
    tgMsg += `[View Product](${viewUrl})\n`;
    tgMsg += `[Add to Cart (size ${DEFAULT_SIZE})](${atcUrl})\n\n`;
  }

  // Build SMS message
  const firstProduct = products[0];
  const firstViewUrl = firstProduct.url || `https://www.adidas.com/us/audi_revolut_f1_team`;
  const firstAtcUrl = buildAtcUrl(firstProduct.sku, firstProduct.url, DEFAULT_SIZE);
  let smsMsg = `[AUDI F1 ${label}] ${products.length} item(s)!\n`;
  smsMsg += `${firstProduct.name || firstProduct.sku}`;
  if (firstProduct.price) smsMsg += ` - ${firstProduct.price}`;
  smsMsg += `\n\nView: ${firstViewUrl}\nAdd to Cart: ${firstAtcUrl}`;
  if (products.length > 1) {
    smsMsg += `\n\n+${products.length - 1} more on Telegram`;
  }

  await Promise.all([sendTelegram(tgMsg), sendSms(smsMsg)]);

  mkdirSync('state', { recursive: true });
  const logLine = `[${new Date().toISOString()}] ${label}: ${products.map((p) => p.sku).join(', ')}\n`;
  appendFileSync(NOTIFY_LOG, logLine);
}

/**
 * Send Telegram-only notification (no SMS) for intel alerts
 * @param {string} alertType - 'incoming', 'collection', or 'early_intel'
 * @param {string} message - Alert message body
 */
async function notifyIntel(alertType, message) {
  const emojis = { incoming: '📡', collection: '📦', early_intel: '📰' };
  const labels = { incoming: 'INCOMING', collection: 'NEW COLLECTION', early_intel: 'EARLY INTEL' };
  const emoji = emojis[alertType] || '📢';
  const label = labels[alertType] || alertType.toUpperCase();

  const tgMsg = `${emoji} *AUDI F1 ${label}*\n${message}`;
  await sendTelegram(tgMsg);

  mkdirSync('state', { recursive: true });
  appendFileSync(NOTIFY_LOG, `[${new Date().toISOString()}] ${label}: ${message.slice(0, 200)}\n`);
}

// ── XML parsing helpers ─────────────────────────────────────────────────────

/**
 * Extract Audi F1 product URLs from sitemap XML
 * @param {string} xml - Sitemap XML content
 * @param {Map<string, Object>} products - Map to add products to
 * @param {string} region - Region code for URL building ('us', 'gb', 'de')
 * @returns {number} Count of new products added
 */
function extractAudiProductsFromXml(xml, products, region = 'us') {
  let added = 0;
  const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];
    if (!AUDI_FILTER.test(url) || SAUDI_EXCLUSION.test(url)) continue;

    // Match product page URLs for any region: /us/slug/SKU.html, /en-gb/slug/SKU.html, etc.
    const productMatch = url.match(/\/(?:us|en-gb|[a-z]{2})\/([a-z0-9][a-z0-9-]+)\/([A-Z][A-Z0-9]{3,9})\.html/);
    if (!productMatch) continue;

    const slug = productMatch[1];
    const sku = productMatch[2];

    if (!products.has(sku)) {
      const name = slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      // Always store the US URL for purchase links, even if found via UK/DE
      const usUrl = `https://www.adidas.com/us/${slug}/${sku}.html`;

      products.set(sku, {
        sku,
        name,
        price: '',
        url: usUrl,
        foundIn: region,
      });
      added++;
    }
  }
  return added;
}

/**
 * Extract sub-sitemap URLs from a sitemap index XML
 * @param {string} xml - XML content
 * @returns {string[]} Array of sub-sitemap URLs
 */
function extractSubSitemapUrls(xml) {
  const urls = [];
  if (!xml.includes('<sitemapindex') && !xml.includes('<sitemap>')) return urls;
  const sitemapRegex = /<sitemap>\s*<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match;
  while ((match = sitemapRegex.exec(xml)) !== null) {
    urls.push(match[1].trim());
  }
  return urls;
}

/**
 * Extract Audi-related PLP (collection) page URLs from sitemap XML
 * @param {string} xml - Sitemap XML content
 * @returns {string[]} Array of matching collection URLs
 */
function extractAudiPlpPages(xml) {
  const pages = [];
  const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];
    if (AUDI_FILTER.test(url) && !SAUDI_EXCLUSION.test(url)) {
      pages.push(url);
    }
  }
  return pages;
}

// ── Detection layers ────────────────────────────────────────────────────────

/**
 * Layer 0 + Baseline: Fetch US product sitemap with ETag optimization
 * @param {Object} etags - Previous ETag/Last-Modified values
 * @returns {Promise<{products: Map, etags: Object}>}
 */
async function fetchUsProducts(etags) {
  const products = new Map();
  const url = SITEMAPS.us;

  // Check if sitemap has changed
  const headerCheck = await checkIfChanged(url, etags);
  const newEtags = { ...etags, [url]: { etag: headerCheck.etag, lastModified: headerCheck.lastModified } };

  if (!headerCheck.changed) {
    log('  US sitemap unchanged (ETag match), skipping full download');
    return { products, etags: newEtags, skipped: true };
  }

  log('Fetching US product sitemap...');
  try {
    const { status, text: xml } = await fetchWithRetry(url);
    log(`  US sitemap: HTTP ${status} (${xml.length} chars)`);

    if (status === 200) {
      const subUrls = extractSubSitemapUrls(xml);
      if (subUrls.length > 0) {
        log(`  US sitemap is an index with ${subUrls.length} sub-sitemaps`);
        const batchSize = 5;
        for (let i = 0; i < subUrls.length; i += batchSize) {
          const batch = subUrls.slice(i, i + batchSize);
          const results = await Promise.allSettled(batch.map((u) => fetchWithRetry(u, 30000, 1)));
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value.status === 200) {
              extractAudiProductsFromXml(result.value.text, products, 'us');
            }
          }
        }
      } else {
        const count = extractAudiProductsFromXml(xml, products, 'us');
        log(`  US sitemap: ${count} Audi F1 products`);
      }
    }
  } catch (err) {
    log(`  US sitemap failed: ${err.message}`);
  }

  return { products, etags: newEtags, skipped: false };
}

/**
 * Layer 1: Fetch regional sitemaps (UK/DE) for early detection
 * @returns {Promise<Map<string, Object>>} Products found in other regions
 */
async function fetchRegionalProducts() {
  const products = new Map();
  const regions = [
    { code: 'uk', url: SITEMAPS.uk },
    { code: 'de', url: SITEMAPS.de },
  ];

  const results = await Promise.allSettled(
    regions.map(async ({ code, url }) => {
      try {
        const { status, text: xml } = await fetchWithRetry(url, 30000, 1);
        log(`  ${code.toUpperCase()} sitemap: HTTP ${status} (${xml.length} chars)`);
        if (status === 200) {
          const subUrls = extractSubSitemapUrls(xml);
          if (subUrls.length > 0) {
            // Index format, fetch sub-sitemaps
            const subResults = await Promise.allSettled(
              subUrls.map((u) => fetchWithRetry(u, 30000, 0))
            );
            for (const r of subResults) {
              if (r.status === 'fulfilled' && r.value.status === 200) {
                extractAudiProductsFromXml(r.value.text, products, code);
              }
            }
          } else {
            const count = extractAudiProductsFromXml(xml, products, code);
            log(`  ${code.toUpperCase()} sitemap: ${count} Audi F1 products`);
          }
        }
      } catch (err) {
        log(`  ${code.toUpperCase()} sitemap failed: ${err.message}`);
      }
    })
  );

  return products;
}

/**
 * Layer 2: Fetch PLP sitemaps to detect new collection pages
 * @returns {Promise<string[]>} Array of Audi collection page URLs
 */
async function fetchPlpPages() {
  const allPages = [];

  const urls = [];
  for (let i = 1; i <= PLP_SITEMAP_COUNT; i++) {
    urls.push(`${PLP_SITEMAP_BASE}${i}.xml`);
  }

  const results = await Promise.allSettled(
    urls.map((url) => fetchWithRetry(url, 20000, 1))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value.status === 200) {
      const pages = extractAudiPlpPages(result.value.text);
      if (pages.length > 0) {
        log(`  PLP sitemap ${i + 1}: ${pages.length} Audi page(s)`);
        allPages.push(...pages);
      }
    } else if (result.status === 'rejected') {
      // PLP sitemaps are not critical, just skip
    }
  }

  return [...new Set(allPages)];
}

/**
 * Layer 3: Fetch sneaker news RSS feeds for advance intelligence
 * Only runs every 30 min (6th invocation at 5-min intervals)
 * @param {Object} rssChecked - Previous check timestamps per feed URL
 * @returns {Promise<{articles: Array, rssChecked: Object}>}
 */
async function fetchNewsFeeds(rssChecked) {
  const articles = [];
  const newRssChecked = { ...rssChecked };

  // Only run RSS checks every 30 minutes
  const now = Date.now();
  const thirtyMin = 30 * 60 * 1000;
  if (rssChecked._lastRun && (now - rssChecked._lastRun) < thirtyMin) {
    log('  RSS feeds: skipping (checked within last 30 min)');
    return { articles, rssChecked: newRssChecked };
  }
  newRssChecked._lastRun = now;

  for (const feedUrl of NEWS_FEEDS) {
    try {
      const { status, text: xml } = await fetchWithRetry(feedUrl, 15000, 1);
      if (status !== 200) {
        log(`  RSS ${feedUrl}: HTTP ${status}`);
        continue;
      }

      // Extract <item> entries from RSS
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let itemMatch;
      while ((itemMatch = itemRegex.exec(xml)) !== null) {
        const itemXml = itemMatch[1];

        // Extract title, link, pubDate
        const title = (itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
        const link = (itemXml.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const pubDate = (itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';

        // Check if article is about Audi F1 + Adidas
        const combined = `${title} ${itemXml}`.toLowerCase();
        const hasPrimary = RSS_KEYWORDS_PRIMARY.some((kw) => combined.includes(kw));
        const hasSecondary = RSS_KEYWORDS_SECONDARY.some((kw) => combined.includes(kw));

        if (hasPrimary && hasSecondary) {
          // Skip if we already notified about this article
          const articleKey = link || title;
          if (rssChecked[articleKey]) continue;

          // Skip articles older than 7 days
          if (pubDate) {
            const pubTime = new Date(pubDate).getTime();
            if (now - pubTime > 7 * 24 * 60 * 60 * 1000) continue;
          }

          articles.push({ title: title.trim(), link: link.trim(), pubDate: pubDate.trim() });
          newRssChecked[articleKey] = now;
        }
      }

      log(`  RSS ${new URL(feedUrl).hostname}: checked`);
    } catch (err) {
      log(`  RSS ${feedUrl} failed: ${err.message}`);
    }
  }

  return { articles, rssChecked: newRssChecked };
}

// ── Main monitor ────────────────────────────────────────────────────────────

/**
 * Main monitor function
 * Runs all detection layers in parallel, diffs against state, notifies
 */
async function runMonitor() {
  log('Starting Adidas Audi F1 drop monitor (multi-layer v0.4.0)');

  // Handle test notification mode
  if (TEST_MODE) {
    log('TEST MODE: Sending test notifications with real products...');
    const testProducts = [
      {
        sku: 'KE8919',
        name: 'Audi Revolut F1 Team Engineers & Marketing Track Top',
        price: '$110.00',
        url: 'https://www.adidas.com/us/audi-revolut-f1-team-engineers-marketing-track-top/KE8919.html',
      },
      {
        sku: 'KE6123',
        name: 'Audi Revolut F1 Team DNA Graphic Tee',
        price: '$45.00',
        url: 'https://www.adidas.com/us/audi-revolut-f1-team-dna-graphic-tee/KE6123.html',
      },
    ];
    await notifyProducts(testProducts, 'new_drop');
    log('Test notifications sent!');
    return;
  }

  const state = loadState();
  const prevProducts = state.products || {};
  const prevSkus = new Set(Object.keys(prevProducts));
  log(`Previous state: ${prevSkus.size} known products, ${Object.keys(state.plpPages || {}).length} PLP pages`);

  // ── Run all layers in parallel ──────────────────────────────────────────
  log('Running all detection layers in parallel...');
  const [usResult, regionalProducts, plpPages, newsResult] = await Promise.all([
    fetchUsProducts(state.etags || {}),
    fetchRegionalProducts(),
    fetchPlpPages(),
    fetchNewsFeeds(state.rssChecked || {}),
  ]);

  const usProducts = usResult.products;
  log(`Layer results: US=${usProducts.size}, Regional=${regionalProducts.size}, PLP=${plpPages.length}, News=${newsResult.articles.length}`);

  // ── Merge US products (ground truth) ────────────────────────────────────
  // If US sitemap was skipped (unchanged) but we have previous products, use those
  const allUsProducts = new Map();
  if (usResult.skipped && prevSkus.size > 0) {
    for (const [sku, data] of Object.entries(prevProducts)) {
      if (!data.outOfStock) {
        allUsProducts.set(sku, { sku, name: data.name, price: data.price, url: data.url });
      }
    }
    log(`  Using ${allUsProducts.size} products from previous state (sitemap unchanged)`);
  } else {
    for (const [sku, product] of usProducts) {
      allUsProducts.set(sku, product);
    }
  }

  // ── Detect NEW DROPS (products in US sitemap not seen before) ───────────
  const newProducts = [];
  const restockedProducts = [];

  for (const [sku, product] of allUsProducts) {
    if (!prevSkus.has(sku)) {
      newProducts.push(product);
    } else if (prevProducts[sku]?.outOfStock) {
      restockedProducts.push(product);
    }
  }

  // ── Detect INCOMING (products in UK/DE but not in US yet) ───────────────
  const incomingProducts = [];
  for (const [sku, product] of regionalProducts) {
    if (!allUsProducts.has(sku) && !prevSkus.has(sku)) {
      incomingProducts.push(product);
    }
  }

  // ── Detect NEW COLLECTION pages ─────────────────────────────────────────
  const prevPlpPages = state.plpPages || {};
  const newPlpPages = [];
  for (const pageUrl of plpPages) {
    if (!prevPlpPages[pageUrl]) {
      newPlpPages.push(pageUrl);
    }
  }

  // ── Build updated state ─────────────────────────────────────────────────
  const currentProducts = {};

  // Add all US products
  for (const [sku, product] of allUsProducts) {
    currentProducts[sku] = {
      name: product.name,
      price: product.price,
      url: product.url,
      firstSeen: prevProducts[sku]?.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
  }

  // Track disappeared products for restock detection
  for (const sku of prevSkus) {
    if (!allUsProducts.has(sku)) {
      currentProducts[sku] = {
        ...prevProducts[sku],
        lastSeen: prevProducts[sku]?.lastSeen,
        outOfStock: true,
      };
    }
  }

  // Track PLP pages
  const currentPlpPages = {};
  for (const url of plpPages) {
    currentPlpPages[url] = prevPlpPages[url] || new Date().toISOString();
  }

  // Save state
  const newState = {
    products: currentProducts,
    plpPages: currentPlpPages,
    etags: usResult.etags,
    rssChecked: newsResult.rssChecked,
    notifiedEvents: state.notifiedEvents || {},
  };
  saveState(newState);
  log(`State updated: ${Object.keys(currentProducts).length} products, ${Object.keys(currentPlpPages).length} PLP pages`);

  // ── Log all found products for debugging ────────────────────────────────
  if (!usResult.skipped) {
    for (const [sku, p] of allUsProducts) {
      log(`  [${sku}] ${p.name}`);
    }
  }

  // ── Send notifications (in priority order) ──────────────────────────────

  // 1. NEW DROP (Telegram + SMS)
  if (newProducts.length > 0) {
    log(`${newProducts.length} NEW product(s) detected in US!`);
    await notifyProducts(newProducts, 'new_drop');
  }

  // 2. RESTOCK (Telegram + SMS)
  if (restockedProducts.length > 0) {
    log(`${restockedProducts.length} RESTOCKED product(s) detected!`);
    await notifyProducts(restockedProducts, 'restock');
  }

  // 3. INCOMING from other regions (Telegram only)
  if (incomingProducts.length > 0) {
    log(`${incomingProducts.length} product(s) incoming from other regions!`);
    let msg = `${incomingProducts.length} product(s) found in UK/DE sitemaps but NOT yet on US store:\n\n`;
    for (const p of incomingProducts) {
      msg += `*${p.name}* (${p.sku})\n`;
      msg += `Region: ${(p.foundIn || '').toUpperCase()}\n`;
      msg += `[Search US Store](https://www.adidas.com/us/search?q=${p.sku})\n\n`;
    }
    msg += '_These may appear on the US store soon._';
    await notifyIntel('incoming', msg);
  }

  // 4. NEW COLLECTION pages (Telegram only)
  if (newPlpPages.length > 0) {
    log(`${newPlpPages.length} new collection page(s) detected!`);
    let msg = `${newPlpPages.length} new Audi collection page(s) detected:\n\n`;
    for (const url of newPlpPages) {
      msg += `${url}\n`;
    }
    msg += '\n_New products may be added to this collection soon._';
    await notifyIntel('collection', msg);
  }

  // 5. EARLY INTEL from news feeds (Telegram only)
  if (newsResult.articles.length > 0) {
    log(`${newsResult.articles.length} news article(s) about Audi F1!`);
    let msg = `${newsResult.articles.length} article(s) mentioning Audi F1:\n\n`;
    for (const article of newsResult.articles) {
      msg += `*${article.title}*\n`;
      if (article.pubDate) msg += `Published: ${article.pubDate}\n`;
      if (article.link) msg += `[Read Article](${article.link})\n`;
      msg += '\n';
    }
    await notifyIntel('early_intel', msg);
  }

  // Summary
  if (newProducts.length === 0 && restockedProducts.length === 0 && incomingProducts.length === 0 && newPlpPages.length === 0 && newsResult.articles.length === 0) {
    log('No new drops, restocks, or intel detected');
  }

  log('Monitor run complete');
}

// ── Entry point ─────────────────────────────────────────────────────────────
runMonitor().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
