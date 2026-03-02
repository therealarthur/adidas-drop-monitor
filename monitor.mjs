/**
 * Adidas F1 Audi Drop Monitor v0.3.0
 * Uses Adidas public sitemaps (not behind Akamai WAF) to detect products.
 * No browser needed, just fetch().
 * Diffs against stored state, sends Telegram + SMS notifications
 * with View and Add-to-Cart links.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';

// Config
const STATE_FILE = 'state/products.json';
const NOTIFY_LOG = 'state/notifications.log';

// Adidas sitemap URLs (NOT behind Akamai WAF, freely accessible from datacenter IPs)
const PRODUCT_SITEMAP = 'https://www.adidas.com/glass/sitemaps/adidas/US/en/sitemaps/adidas-US-en-us-product.xml';
const SITEMAP_INDEX = 'https://www.adidas.com/glass/sitemaps/adidas/US/en/sitemap-index.xml';
const TEST_MODE = process.argv.includes('--test-notify');

// Audi filter: match URLs containing "audi" but NOT "saudi"
const AUDI_FILTER = /audi/i;
const SAUDI_EXCLUSION = /saudi/i;

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
 * Fetch a URL with retries and timeout
 * @param {string} url - URL to fetch
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {number} retries - Number of retries
 * @returns {Promise<{status: number, text: string}>} Response
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
      return { status: resp.status, text };
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
 * Extract Audi F1 product URLs from sitemap XML content
 * Filters for URLs containing "audi" (excluding "saudi") with a valid product path
 * @param {string} xml - Sitemap XML content
 * @param {Map<string, Object>} products - Map to add discovered products to
 * @returns {number} Count of new products added
 */
function extractAudiProductsFromXml(xml, products) {
  let added = 0;
  // Match all <loc> tags in the sitemap
  const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];

    // Must contain "audi" but not "saudi"
    if (!AUDI_FILTER.test(url) || SAUDI_EXCLUSION.test(url)) continue;

    // Must be a product page URL pattern: /us/product-slug/SKU.html
    const productMatch = url.match(/\/us\/([a-z0-9][a-z0-9-]+)\/([A-Z][A-Z0-9]{3,9})\.html/);
    if (!productMatch) continue;

    const slug = productMatch[1];
    const sku = productMatch[2];

    if (!products.has(sku)) {
      // Convert slug to human-readable name (e.g. "audi-revolut-f1-team-track-top" -> "Audi Revolut F1 Team Track Top")
      const name = slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      products.set(sku, {
        sku,
        name,
        price: '',
        url: url.startsWith('http') ? url : `https://www.adidas.com${url}`,
      });
      added++;
    }
  }
  return added;
}

/**
 * Check if a sitemap XML is a sitemap index (contains <sitemap> entries)
 * @param {string} xml - XML content
 * @returns {string[]} Array of sub-sitemap URLs, empty if not an index
 */
function extractSubSitemapUrls(xml) {
  const urls = [];
  // Sitemap index has <sitemap><loc>...</loc></sitemap> entries
  if (!xml.includes('<sitemapindex') && !xml.includes('<sitemap>')) return urls;

  const sitemapRegex = /<sitemap>\s*<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match;
  while ((match = sitemapRegex.exec(xml)) !== null) {
    urls.push(match[1].trim());
  }
  return urls;
}

/**
 * Fetch Adidas sitemaps and find all Audi F1 products
 * Uses the public sitemap infrastructure which is NOT behind Akamai WAF
 * @returns {Promise<Map<string, Object>>} Map of SKU to product data
 */
async function fetchSitemapProducts() {
  const allProducts = new Map();

  // Strategy 1: Fetch the main product sitemap directly
  log('Fetching Adidas product sitemap...');
  try {
    const { status, text: xml } = await fetchWithRetry(PRODUCT_SITEMAP);
    log(`  Product sitemap: HTTP ${status} (${xml.length} chars)`);

    if (status === 200) {
      // Check if this is a sitemap index or a direct sitemap
      const subUrls = extractSubSitemapUrls(xml);
      if (subUrls.length > 0) {
        // It's a sitemap index, fetch relevant sub-sitemaps
        log(`  Sitemap index with ${subUrls.length} sub-sitemaps`);
        // Filter for sub-sitemaps that might contain product pages
        // Fetch them in parallel batches of 5
        const batchSize = 5;
        for (let i = 0; i < subUrls.length; i += batchSize) {
          const batch = subUrls.slice(i, i + batchSize);
          const results = await Promise.allSettled(
            batch.map((url) => fetchWithRetry(url, 30000, 1))
          );
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value.status === 200) {
              const count = extractAudiProductsFromXml(result.value.text, allProducts);
              if (count > 0) {
                log(`  Found ${count} Audi products in sub-sitemap`);
              }
            }
          }
          // Early exit if we found products (optimization)
          if (allProducts.size > 0 && i + batchSize >= subUrls.length * 0.5) {
            log(`  Found ${allProducts.size} products, stopping sub-sitemap scan`);
            break;
          }
        }
      } else {
        // Direct sitemap with <url> entries
        const count = extractAudiProductsFromXml(xml, allProducts);
        log(`  Found ${count} Audi F1 products in product sitemap`);
      }
    }
  } catch (err) {
    log(`  Product sitemap failed: ${err.message}`);
  }

  // Strategy 2: If nothing found, try the sitemap index to discover other sitemaps
  if (allProducts.size === 0) {
    log('No products in main sitemap. Checking sitemap index...');
    try {
      const { status, text: xml } = await fetchWithRetry(SITEMAP_INDEX);
      log(`  Sitemap index: HTTP ${status} (${xml.length} chars)`);

      if (status === 200) {
        const subUrls = extractSubSitemapUrls(xml);
        log(`  Found ${subUrls.length} sitemaps in index`);

        // Filter for product-related sitemaps
        const productSitemaps = subUrls.filter(
          (u) => u.includes('product') || u.includes('plp')
        );
        log(`  ${productSitemaps.length} product/plp sitemaps to check`);

        for (const url of productSitemaps) {
          try {
            const { status: s, text: subXml } = await fetchWithRetry(url, 30000, 1);
            if (s === 200) {
              // Could be another index level
              const nestedUrls = extractSubSitemapUrls(subXml);
              if (nestedUrls.length > 0) {
                // Fetch nested sitemaps
                const results = await Promise.allSettled(
                  nestedUrls.map((u) => fetchWithRetry(u, 30000, 1))
                );
                for (const result of results) {
                  if (result.status === 'fulfilled' && result.value.status === 200) {
                    extractAudiProductsFromXml(result.value.text, allProducts);
                  }
                }
              } else {
                extractAudiProductsFromXml(subXml, allProducts);
              }
            }
          } catch (err) {
            log(`  Sub-sitemap ${url} failed: ${err.message}`);
          }
        }
        log(`  Sitemap index scan found ${allProducts.size} Audi products`);
      }
    } catch (err) {
      log(`  Sitemap index failed: ${err.message}`);
    }
  }

  return allProducts;
}

/**
 * Main monitor function
 * Fetches sitemaps, extracts Audi F1 products, diffs against state, notifies
 */
async function runMonitor() {
  log('Starting Adidas Audi F1 drop monitor (sitemap mode)');

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

  // Fetch products from Adidas sitemaps
  const allProducts = await fetchSitemapProducts();
  log(`Total Audi F1 products found: ${allProducts.size}`);

  if (allProducts.size === 0) {
    log('No products found in sitemaps. Keeping previous state.');
    log('Monitor run complete');
    return;
  }

  // Log all found products for debugging
  for (const [sku, p] of allProducts) {
    log(`  [${sku}] ${p.name}`);
  }

  // Diff against previous state
  const newProducts = [];
  const restockedProducts = [];
  const currentState = {};

  for (const [sku, product] of allProducts) {
    currentState[sku] = {
      name: product.name,
      price: product.price,
      url: product.url,
      firstSeen: prevState[sku]?.firstSeen || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    if (!prevSkus.has(sku)) {
      // Brand new product never seen before
      newProducts.push({ ...product, type: 'new_drop' });
    } else if (prevState[sku]?.outOfStock) {
      // Was marked out of stock (disappeared from sitemap previously), now it's back
      restockedProducts.push({ ...product, type: 'restock' });
    }
  }

  // Track products that disappeared (for restock detection on next run)
  for (const sku of prevSkus) {
    if (!allProducts.has(sku)) {
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
