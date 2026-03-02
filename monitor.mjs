/**
 * Adidas F1 Audi Drop Monitor
 * Uses Google Search + Adidas Newsroom to find products (bypasses Akamai WAF).
 * Diffs against stored state, sends Telegram + SMS notifications
 * with View and Add-to-Cart links.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';

// Config
const STATE_FILE = 'state/products.json';
const NOTIFY_LOG = 'state/notifications.log';

// Google Cache fallback
const GOOGLE_CACHE_URL = 'https://webcache.googleusercontent.com/search?q=cache:www.adidas.com/us/audi_revolut_f1_team';
const TEST_MODE = process.argv.includes('--test-notify');

// Notification config from env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TWILIO_SID = process.env.TWILIO_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const TWILIO_TO = process.env.TWILIO_TO || '';
const DEFAULT_SIZE = process.env.DEFAULT_SIZE || 'L';

/**
 * Log with timestamp
 * @param {string} msg - Message to log
 */
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/**
 * Load previous product state from JSON file
 * @returns {Object} Map of SKU to product data
 */
function loadState() {
  mkdirSync('state', { recursive: true });
  if (!existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, '{}');
    return {};
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save current product state to JSON file
 * @param {Object} state - Map of SKU to product data
 */
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Build the "add to cart" URL for an Adidas product
 * Uses the Adidas direct-add-to-cart URL pattern
 * @param {string} sku - Product SKU
 * @param {string} productUrl - Product page URL
 * @param {string} size - Default size to pre-select
 * @returns {string} ATC URL
 */
function buildAtcUrl(sku, productUrl, size) {
  // Adidas ATC pattern: product page with size query param
  if (productUrl && productUrl.includes('.html')) {
    return `${productUrl}?size=${encodeURIComponent(size)}`;
  }
  return `https://www.adidas.com/us/search?q=${sku}`;
}

/**
 * Send Telegram notification with product details
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
    if (data.description && data.description.includes("parse")) {
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
 * Send notifications for new/restocked products
 * @param {Array} products - Array of {sku, name, price, url, type} objects
 * @param {string} eventType - 'new_drop' or 'restock'
 */
async function notifyProducts(products, eventType) {
  if (products.length === 0) return;

  const emoji = eventType === 'restock' ? '🔄' : '🚨';
  const label = eventType === 'restock' ? 'RESTOCK' : 'NEW DROP';

  // Build Telegram message (detailed, with links)
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

  // Build SMS message (concise, with first product link)
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

  // Send both
  await Promise.all([sendTelegram(tgMsg), sendSms(smsMsg)]);

  // Log
  mkdirSync('state', { recursive: true });
  const logLine = `[${new Date().toISOString()}] ${label}: ${products.map((p) => p.sku).join(', ')}\n`;
  appendFileSync(NOTIFY_LOG, logLine);
}

/**
 * Extract products from a Playwright page
 * Tries multiple strategies: __NEXT_DATA__, data attributes, DOM scraping
 * @param {import('playwright').Page} page - Playwright page
 * @returns {Promise<Array>} Array of product objects
 */
async function extractProducts(page) {
  const products = [];
  const seenSkus = new Set();

  // Strategy 1: Extract from __NEXT_DATA__ JSON
  try {
    const nextData = await page.evaluate(() => {
      const el = document.querySelector('script#__NEXT_DATA__');
      if (el) return el.textContent;
      return null;
    });
    if (nextData) {
      log('  Found __NEXT_DATA__, extracting products...');
      const parsed = JSON.parse(nextData);
      const items = findProductsInObject(parsed);
      for (const item of items) {
        if (item.sku && !seenSkus.has(item.sku)) {
          seenSkus.add(item.sku);
          products.push(item);
        }
      }
      log(`  __NEXT_DATA__ yielded ${items.length} products`);
    }
  } catch (err) {
    log(`  __NEXT_DATA__ extraction failed: ${err.message}`);
  }

  // Strategy 2: Extract from data-testid product cards
  try {
    const domProducts = await page.evaluate(() => {
      const results = [];

      // Try common Adidas product card selectors
      const selectors = [
        '[data-testid="product-card"]',
        '[data-auto-id="product-card"]',
        '.product-card',
        '.plp-card',
        '[class*="product-card"]',
        '[class*="ProductCard"]',
        'article[data-index]',
        '.glass-product-card',
        '[data-testid="plp-product-card"]',
      ];

      for (const sel of selectors) {
        const cards = document.querySelectorAll(sel);
        if (cards.length === 0) continue;

        for (const card of cards) {
          const link = card.querySelector('a[href*="/us/"]');
          const nameEl =
            card.querySelector('[data-testid="product-card-title"]') ||
            card.querySelector('[class*="product-card__title"]') ||
            card.querySelector('[class*="ProductCard__title"]') ||
            card.querySelector('h2') ||
            card.querySelector('[class*="name"]');
          const priceEl =
            card.querySelector('[data-testid="product-card-price"]') ||
            card.querySelector('[class*="price"]') ||
            card.querySelector('[class*="Price"]');

          const href = link ? link.getAttribute('href') : '';
          const skuMatch = href.match(/\/([A-Z][A-Z0-9]{3,9})\.html/);

          results.push({
            sku: skuMatch ? skuMatch[1] : '',
            name: nameEl ? nameEl.textContent.trim() : '',
            price: priceEl ? priceEl.textContent.trim() : '',
            url: href ? (href.startsWith('http') ? href : `https://www.adidas.com${href}`) : '',
          });
        }

        if (results.length > 0) break;
      }

      return results;
    });

    for (const p of domProducts) {
      if (p.sku && !seenSkus.has(p.sku)) {
        seenSkus.add(p.sku);
        products.push(p);
      }
    }
    if (domProducts.length > 0) {
      log(`  DOM card extraction yielded ${domProducts.length} products`);
    }
  } catch (err) {
    log(`  DOM extraction failed: ${err.message}`);
  }

  // Strategy 3: Extract all product links from the page
  try {
    const linkProducts = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*=".html"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const skuMatch = href.match(/\/us\/([^/]+)\/([A-Z][A-Z0-9]{3,9})\.html/);
        if (skuMatch) {
          const name = skuMatch[1].replace(/-/g, ' ');
          results.push({
            sku: skuMatch[2],
            name: link.textContent.trim() || name,
            price: '',
            url: href.startsWith('http') ? href : `https://www.adidas.com${href}`,
          });
        }
      }
      return results;
    });

    for (const p of linkProducts) {
      if (p.sku && !seenSkus.has(p.sku)) {
        seenSkus.add(p.sku);
        products.push(p);
      }
    }
    if (linkProducts.length > 0) {
      log(`  Link extraction yielded ${linkProducts.length} products`);
    }
  } catch (err) {
    log(`  Link extraction failed: ${err.message}`);
  }

  // Strategy 4: Look for JSON-LD structured data
  try {
    const jsonLd = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      const results = [];
      for (const script of scripts) {
        try {
          results.push(JSON.parse(script.textContent));
        } catch {}
      }
      return results;
    });

    for (const data of jsonLd) {
      const items = findProductsInJsonLd(data);
      for (const item of items) {
        if (item.sku && !seenSkus.has(item.sku)) {
          seenSkus.add(item.sku);
          products.push(item);
        }
      }
    }
  } catch (err) {
    log(`  JSON-LD extraction failed: ${err.message}`);
  }

  return products;
}

/**
 * Recursively find product-like objects in a nested JSON structure
 * @param {*} obj - Object to search
 * @param {number} depth - Current recursion depth
 * @returns {Array} Array of product objects
 */
function findProductsInObject(obj, depth = 0) {
  const results = [];
  if (depth > 15 || !obj || typeof obj !== 'object') return results;

  // Check if this object looks like a product
  if (obj.productId || obj.article_number || (obj.id && obj.name && typeof obj.id === 'string' && /^[A-Z][A-Z0-9]{3,9}$/.test(obj.id))) {
    const sku = obj.productId || obj.article_number || obj.id || '';
    if (sku && /^[A-Z][A-Z0-9]{3,9}$/.test(sku)) {
      results.push({
        sku,
        name: obj.name || obj.displayName || obj.title || sku,
        price: obj.price || obj.salePrice || obj.formattedPrice || '',
        url: obj.link || obj.url || obj.pdpLink || '',
      });
    }
  }

  // Check arrays of items (common API pattern)
  if (obj.items || obj.products || obj.itemList || obj.results) {
    const list = obj.items || obj.products || obj.itemList || obj.results;
    if (Array.isArray(list)) {
      for (const item of list) {
        results.push(...findProductsInObject(item, depth + 1));
      }
    }
  }

  // Recurse into all values
  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...findProductsInObject(item, depth + 1));
    }
  } else {
    for (const key of Object.keys(obj)) {
      results.push(...findProductsInObject(obj[key], depth + 1));
    }
  }

  return results;
}

/**
 * Extract products from JSON-LD structured data
 * @param {*} data - JSON-LD object or array
 * @returns {Array} Array of product objects
 */
function findProductsInJsonLd(data) {
  const results = [];
  if (!data) return results;

  if (Array.isArray(data)) {
    for (const item of data) {
      results.push(...findProductsInJsonLd(item));
    }
    return results;
  }

  if (data['@type'] === 'Product' || data['@type'] === 'IndividualProduct') {
    results.push({
      sku: data.sku || data.productID || data.identifier || '',
      name: data.name || '',
      price: data.offers?.price ? `$${data.offers.price}` : '',
      url: data.url || '',
    });
  }

  if (data.itemListElement) {
    for (const item of data.itemListElement) {
      results.push(...findProductsInJsonLd(item.item || item));
    }
  }

  return results;
}

/**
 * Main monitor function
 * Launches browser, scrapes products, diffs, notifies
 */
async function runMonitor() {
  log('Starting Adidas Audi F1 drop monitor');

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

  const prevState = loadState();
  const prevSkus = new Set(Object.keys(prevState));
  log(`Previous state: ${prevSkus.size} known products`);

  // Launch browser
  log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();

  const allProducts = new Map();

  /**
   * Helper: extract Adidas Audi F1 product SKUs and URLs from HTML text
   * Handles URL-encoded links from search engine redirect wrappers
   * @param {string} html - HTML content to search
   * @returns {Array} products found
   */
  function extractProductsFromHtml(html) {
    const results = [];
    const seen = new Set();

    // First, URL-decode the entire HTML to catch encoded URLs
    // Search engines encode links like: https%3A%2F%2Fwww.adidas.com%2Fus%2F...
    let decoded = html;
    try {
      // Decode multiple times in case of double-encoding
      decoded = decodeURIComponent(html.replace(/&amp;/g, '&'));
    } catch {
      // Partial decode: manually replace common encodings
      decoded = html
        .replace(/%3A/gi, ':')
        .replace(/%2F/gi, '/')
        .replace(/%3F/gi, '?')
        .replace(/%3D/gi, '=')
        .replace(/%26/gi, '&')
        .replace(/%2B/gi, '+')
        .replace(/%22/gi, '"')
        .replace(/&amp;/g, '&');
    }

    // Match Adidas product page URLs: /us/product-slug/SKU.html
    const regex = /(?:https?:\/\/)?(?:www\.)?adidas\.com\/us\/([a-z0-9][a-z0-9-]+)\/([A-Z][A-Z0-9]{3,9})\.html/g;
    let match;
    while ((match = regex.exec(decoded)) !== null) {
      const slug = match[1];
      const sku = match[2];
      if (!seen.has(sku)) {
        seen.add(sku);
        results.push({
          sku,
          name: slug.replace(/-/g, ' '),
          price: '',
          url: `https://www.adidas.com/us/${slug}/${sku}.html`,
        });
      }
    }
    return results;
  }

  // STRATEGY 1 (PRIMARY): Plain fetch() to DuckDuckGo Lite
  // DuckDuckGo Lite is designed for lightweight/programmatic access.
  // No JS required, no CAPTCHAs, returns simple HTML.
  const ddgQueries = [
    'site:adidas.com/us audi revolut f1',
    'site:adidas.com/us "audi f1" team adidas',
  ];

  for (const query of ddgQueries) {
    try {
      log(`DuckDuckGo Lite: ${query}`);
      const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'text/html',
        },
      });
      const html = await resp.text();
      log(`  Response: ${resp.status} (${html.length} chars)`);
      const products = extractProductsFromHtml(html);
      for (const p of products) {
        if (!allProducts.has(p.sku)) allProducts.set(p.sku, p);
      }
      log(`  Found ${products.length} products (${allProducts.size} unique total)`);
    } catch (err) {
      log(`  DuckDuckGo Lite failed: ${err.message}`);
    }
  }

  // STRATEGY 2: Plain fetch() to Google (no browser fingerprint)
  if (allProducts.size === 0) {
    const googleQueries = [
      'site:adidas.com/us "audi revolut f1"',
      'site:adidas.com/us "audi f1" team',
    ];
    for (const query of googleQueries) {
      try {
        log(`Google (fetch): ${query}`);
        const resp = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=50`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        const html = await resp.text();
        log(`  Response: ${resp.status} (${html.length} chars)`);
        if (html.includes('captcha') || html.includes('unusual traffic')) {
          log('  Google CAPTCHA detected, skipping');
          continue;
        }
        const products = extractProductsFromHtml(html);
        for (const p of products) {
          if (!allProducts.has(p.sku)) allProducts.set(p.sku, p);
        }
        log(`  Found ${products.length} products (${allProducts.size} unique total)`);
      } catch (err) {
        log(`  Google fetch failed: ${err.message}`);
      }
    }
  }

  // STRATEGY 3: Playwright-based search (fallback, uses the open browser)
  if (allProducts.size === 0) {
    log('Fetch-based search found nothing. Trying Playwright browser search...');
    try {
      await page.goto('https://www.google.com/search?q=site:adidas.com/us+%22audi+revolut+f1%22&num=50', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await page.waitForTimeout(2000);
      const content = await page.content();
      if (!content.includes('captcha') && !content.includes('unusual traffic')) {
        const products = extractProductsFromHtml(content);
        for (const p of products) {
          if (!allProducts.has(p.sku)) allProducts.set(p.sku, p);
        }
        log(`  Playwright Google: ${products.length} products found`);
      } else {
        log('  Playwright Google: CAPTCHA detected');
      }
    } catch (err) {
      log(`  Playwright Google failed: ${err.message}`);
    }
  }

  // STRATEGY 2: Adidas Newsroom (not behind Akamai WAF, catches announcements early)
  try {
    log('Checking Adidas Newsroom for new Audi F1 announcements...');
    await page.goto('https://news.adidas.com/motorsport', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForTimeout(1500);

    // Extract any product links from newsroom articles
    const newsProducts = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="adidas.com/us/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const skuMatch = href.match(/\/us\/([^/]+)\/([A-Z][A-Z0-9]{3,9})\.html/);
        if (skuMatch) {
          results.push({
            sku: skuMatch[2],
            name: link.textContent.trim() || skuMatch[1].replace(/-/g, ' '),
            price: '',
            url: `https://www.adidas.com/us/${skuMatch[1]}/${skuMatch[2]}.html`,
          });
        }
      }
      return results;
    });

    for (const p of newsProducts) {
      if (p.sku && !allProducts.has(p.sku)) {
        allProducts.set(p.sku, p);
      }
    }
    log(`  Newsroom: ${newsProducts.length} product links found`);
  } catch (err) {
    log(`  Newsroom check failed: ${err.message}`);
  }

  // STRATEGY 3 (FALLBACK): Google Cache of collection page
  if (allProducts.size === 0) {
    log('No products from search. Trying Google Cache...');
    try {
      const cacheResp = await page.goto(GOOGLE_CACHE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      if (cacheResp?.status() === 200) {
        await page.waitForTimeout(2000);
        const products = await extractProducts(page);
        for (const p of products) {
          if (p.sku) allProducts.set(p.sku, p);
        }
        log(`  Google Cache: ${products.length} products extracted`);
      }
    } catch (err) {
      log(`  Google Cache failed: ${err.message}`);
    }
  }

  await browser.close();
  log(`Total unique products found: ${allProducts.size}`);

  if (allProducts.size === 0) {
    log('No products found across all sources. Keeping previous state.');
    log('Monitor run complete');
    return;
  }

  // Diff against previous state
  const newProducts = [];
  const restockedProducts = [];
  const currentState = {};

  for (const [sku, product] of allProducts) {
    // Normalize URL to full URL
    if (product.url && !product.url.startsWith('http')) {
      product.url = `https://www.adidas.com${product.url}`;
    }

    currentState[sku] = {
      name: product.name,
      price: product.price,
      url: product.url,
      firstSeen: prevState[sku]?.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    if (!prevSkus.has(sku)) {
      // Brand new product
      newProducts.push({ ...product, type: 'new_drop' });
    } else if (prevState[sku]?.outOfStock && !product.outOfStock) {
      // Was out of stock, now back
      restockedProducts.push({ ...product, type: 'restock' });
    }
  }

  // Check for products that disappeared (potential restock tracking)
  for (const sku of prevSkus) {
    if (!allProducts.has(sku)) {
      // Product disappeared, mark as potentially out of stock for restock detection
      currentState[sku] = {
        ...prevState[sku],
        lastSeen: prevState[sku]?.lastSeen,
        outOfStock: true,
      };
    }
  }

  // Save updated state
  saveState(currentState);
  log(`State updated: ${Object.keys(currentState).length} products tracked`);

  // Send notifications
  if (newProducts.length > 0) {
    log(`${newProducts.length} NEW product(s) detected!`);
    await notifyProducts(newProducts, 'new_drop');
  }

  if (restockedProducts.length > 0) {
    log(`${restockedProducts.length} RESTOCKED product(s) detected!`);
    await notifyProducts(restockedProducts, 'restock');
  }

  if (newProducts.length === 0 && restockedProducts.length === 0) {
    log('No new drops or restocks detected');
  }

  log('Monitor run complete');
}

// Run
runMonitor().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
