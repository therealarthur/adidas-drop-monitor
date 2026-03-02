#!/usr/bin/env bash
# Adidas F1 Audi Drop Monitor
# Fetches Adidas product pages, diffs against stored state,
# sends Telegram + optional SMS notifications on new products.

set -euo pipefail

STATE_FILE="state/products.json"
NOTIFY_LOG="state/notifications.log"

# Ensure state directory exists
mkdir -p state

# Initialize empty state if first run
if [ ! -f "$STATE_FILE" ]; then
  echo '{}' > "$STATE_FILE"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting Adidas monitor run"

# URLs to check - primary collection page + API endpoints + search fallbacks
URLS=(
  "https://www.adidas.com/us/audi_revolut_f1_team"
  "https://www.adidas.com/us/search?q=audi%20f1"
  "https://www.adidas.com/us/search?q=audi%20revolut%20f1"
)

# Adidas API endpoints (return JSON, more reliable than HTML scraping)
API_URLS=(
  "https://www.adidas.com/api/plp/content-engine/pages/us/audi_revolut_f1_team"
  "https://www.adidas.com/api/search?query=audi+f1&start=0&count=48"
)

# Fetch all HTML URLs and combine
COMBINED_HTML=""
for url in "${URLS[@]}"; do
  echo "  Fetching: $url"
  HTTP_CODE=$(curl -sL -o /tmp/adidas_response.html -w "%{http_code}" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
    -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
    -H "Accept-Language: en-US,en;q=0.9" \
    -H "Accept-Encoding: identity" \
    --max-time 30 \
    "$url" 2>/dev/null || echo "000")
  echo "    HTTP $HTTP_CODE ($(wc -c < /tmp/adidas_response.html) bytes)"
  if [ "$HTTP_CODE" = "200" ]; then
    HTML=$(cat /tmp/adidas_response.html)
    COMBINED_HTML="$COMBINED_HTML$HTML"
  else
    echo "    Non-200 response, dumping first 500 chars:"
    head -c 500 /tmp/adidas_response.html 2>/dev/null || true
    echo ""
  fi
done

# Fetch API endpoints (JSON)
COMBINED_JSON=""
for url in "${API_URLS[@]}"; do
  echo "  Fetching API: $url"
  HTTP_CODE=$(curl -sL -o /tmp/adidas_api.json -w "%{http_code}" \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
    -H "Accept: application/json, text/plain, */*" \
    -H "Accept-Language: en-US,en;q=0.9" \
    --max-time 30 \
    "$url" 2>/dev/null || echo "000")
  echo "    HTTP $HTTP_CODE ($(wc -c < /tmp/adidas_api.json) bytes)"
  if [ "$HTTP_CODE" = "200" ]; then
    JSON=$(cat /tmp/adidas_api.json)
    COMBINED_JSON="$COMBINED_JSON$JSON"
    # Debug: show first 1000 chars of API response
    echo "    API preview: $(head -c 1000 /tmp/adidas_api.json)"
  else
    echo "    Non-200, preview: $(head -c 500 /tmp/adidas_api.json 2>/dev/null || true)"
  fi
done

# Check if we got blocked (403 / Akamai)
if echo "$COMBINED_HTML" | grep -qi "access denied\|unable to give you access\|akamai"; then
  echo "  WARNING: Possible WAF block detected on HTML pages."
fi

# Extract products using multiple patterns from HTML
# Pattern 1: Product links (/us/product-name/SKU.html)
PRODUCTS_RAW=$(echo "$COMBINED_HTML" | grep -oP 'href="(/us/[^"]*?/[A-Z0-9]{5,10}\.html)"' | sort -u || true)

# Pattern 2: JSON product data embedded in HTML (from __NEXT_DATA__ or inline scripts)
JSON_PRODUCTS=$(echo "$COMBINED_HTML" | grep -oP '"productId"\s*:\s*"[A-Z0-9]+"' | grep -oP '"[A-Z0-9]+"$' | tr -d '"' | sort -u || true)

# Pattern 3: Search result items in HTML
SEARCH_PRODUCTS=$(echo "$COMBINED_HTML" | grep -oP '"id"\s*:\s*"[A-Z]{2}[0-9]{4}"' | grep -oP '"[A-Z]{2}[0-9]{4}"' | tr -d '"' | sort -u || true)

# Pattern 4: modelId / article number patterns in HTML
MODEL_PRODUCTS=$(echo "$COMBINED_HTML" | grep -oP '"modelId"\s*:\s*"[A-Z0-9]+"' | grep -oP '"[A-Z0-9]+"$' | tr -d '"' | sort -u || true)

# Pattern 5: Extract from API JSON responses
API_PRODUCTS=""
if [ -n "$COMBINED_JSON" ]; then
  # Look for productId, id, article_number patterns in API JSON
  API_PRODUCTS=$(echo "$COMBINED_JSON" | grep -oP '"(?:productId|article_number|id|product_id)"\s*:\s*"[A-Z][A-Z0-9]{3,9}"' | grep -oP '"[A-Z][A-Z0-9]{3,9}"$' | tr -d '"' | sort -u || true)
  # Also look for URL-based product IDs
  API_URL_PRODUCTS=$(echo "$COMBINED_JSON" | grep -oP '/us/[^"]*?/[A-Z0-9]{5,10}\.html' | grep -oP '[A-Z0-9]{5,10}(?=\.html)' | sort -u || true)
  API_PRODUCTS="$API_PRODUCTS $API_URL_PRODUCTS"
  # Also look for product names with links (common API shape)
  API_NAME_PRODUCTS=$(echo "$COMBINED_JSON" | grep -oP '"link"\s*:\s*"/us/[^"]*?/([A-Z0-9]{5,10})\.html"' | grep -oP '[A-Z0-9]{5,10}(?=\.html)' | sort -u || true)
  API_PRODUCTS="$API_PRODUCTS $API_NAME_PRODUCTS"
fi

echo "  Debug: HTML product links found: $(echo "$PRODUCTS_RAW" | grep -c 'href' || echo 0)"
echo "  Debug: JSON productIds found: $(echo "$JSON_PRODUCTS" | wc -w)"
echo "  Debug: Search IDs found: $(echo "$SEARCH_PRODUCTS" | wc -w)"
echo "  Debug: Model IDs found: $(echo "$MODEL_PRODUCTS" | wc -w)"
echo "  Debug: API products found: $(echo "$API_PRODUCTS" | wc -w)"

# Also try to extract product data from __NEXT_DATA__ script tag
NEXT_DATA=$(echo "$COMBINED_HTML" | grep -oP '<script id="__NEXT_DATA__"[^>]*>[^<]+</script>' || true)
if [ -n "$NEXT_DATA" ]; then
  echo "  Debug: Found __NEXT_DATA__ tag ($(echo "$NEXT_DATA" | wc -c) chars)"
  NEXT_PRODUCTS=$(echo "$NEXT_DATA" | grep -oP '"productId"\s*:\s*"[A-Z0-9]+"' | grep -oP '"[A-Z0-9]+"$' | tr -d '"' | sort -u || true)
  JSON_PRODUCTS="$JSON_PRODUCTS $NEXT_PRODUCTS"
else
  echo "  Debug: No __NEXT_DATA__ tag found in HTML"
fi

# Build current product set as JSON
echo "{" > /tmp/current_products.json
FIRST=true
PRODUCT_COUNT=0

# Process URL-based products
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # Extract path and SKU
  PATH_PART=$(echo "$line" | grep -oP '/us/[^"]+' || true)
  SKU=$(echo "$PATH_PART" | grep -oP '[A-Z0-9]{5,10}(?=\.html)' || true)
  [ -z "$SKU" ] && continue

  # Extract product name from URL path
  NAME=$(echo "$PATH_PART" | sed 's|/us/||' | sed "s|/$SKU.html||" | tr '-' ' ')

  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    echo "," >> /tmp/current_products.json
  fi
  printf '  "%s": {"name": "%s", "url": "https://www.adidas.com%s"}' "$SKU" "$NAME" "$PATH_PART" >> /tmp/current_products.json
  PRODUCT_COUNT=$((PRODUCT_COUNT + 1))
done <<< "$PRODUCTS_RAW"

# Process all detected SKUs (JSON, search, model, API) if not already found
ALL_SKUS="$JSON_PRODUCTS $SEARCH_PRODUCTS $MODEL_PRODUCTS $API_PRODUCTS"
for SKU in $ALL_SKUS; do
  [ -z "$SKU" ] && continue
  # Skip non-SKU patterns (too short, lowercase, etc.)
  if ! echo "$SKU" | grep -qP '^[A-Z][A-Z0-9]{3,9}$'; then
    continue
  fi
  # Check if already in our set
  if grep -q "\"$SKU\"" /tmp/current_products.json 2>/dev/null; then
    continue
  fi
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    echo "," >> /tmp/current_products.json
  fi

  # Try to find the product name from API JSON
  PROD_NAME="$SKU"
  if [ -n "$COMBINED_JSON" ]; then
    FOUND_NAME=$(echo "$COMBINED_JSON" | grep -oP "\"name\"\s*:\s*\"[^\"]+\"" | head -1 | grep -oP '"[^"]+$' | tr -d '"' || true)
    [ -n "$FOUND_NAME" ] && PROD_NAME="$FOUND_NAME"
  fi

  printf '  "%s": {"name": "%s", "url": "https://www.adidas.com/us/search?q=%s"}' "$SKU" "$PROD_NAME" "$SKU" >> /tmp/current_products.json
  PRODUCT_COUNT=$((PRODUCT_COUNT + 1))
done

echo "" >> /tmp/current_products.json
echo "}" >> /tmp/current_products.json

echo "  Found $PRODUCT_COUNT products in current scan"

# Load previous state
PREV_STATE=$(cat "$STATE_FILE")

# Find new products (SKUs in current but not in previous)
NEW_PRODUCTS=""
NEW_COUNT=0

while IFS= read -r sku; do
  [ -z "$sku" ] && continue
  sku=$(echo "$sku" | tr -d ' "')
  [ -z "$sku" ] && continue

  if ! echo "$PREV_STATE" | grep -q "\"$sku\""; then
    # This is a new product
    NAME=$(grep "\"$sku\"" /tmp/current_products.json | grep -oP '"name"\s*:\s*"[^"]*"' | head -1 | grep -oP '"[^"]*"$' | tr -d '"' || echo "$sku")
    URL=$(grep "\"$sku\"" /tmp/current_products.json | grep -oP '"url"\s*:\s*"[^"]*"' | head -1 | grep -oP '"[^"]*"$' | tr -d '"' || echo "https://www.adidas.com/us/search?q=$sku")

    NEW_PRODUCTS="$NEW_PRODUCTS\n[$sku] $NAME - $URL"
    NEW_COUNT=$((NEW_COUNT + 1))
    echo "  NEW: [$sku] $NAME"
  fi
done <<< "$(grep -oP '"[A-Z0-9]{5,10}"(?=\s*:)' /tmp/current_products.json | tr -d '"' || true)"

# Update state (only if we found products, otherwise keep old state to avoid false positives)
if [ "$PRODUCT_COUNT" -gt 0 ]; then
  cp /tmp/current_products.json "$STATE_FILE"
  echo "  State updated ($PRODUCT_COUNT products)"
else
  echo "  No products found, keeping previous state"
fi

# Send notifications if new products found
if [ "$NEW_COUNT" -gt 0 ]; then
  echo "  $NEW_COUNT new product(s) detected!"

  # Format message
  MSG="[ADIDAS AUDI F1 DROP] $NEW_COUNT new product(s) detected:$(echo -e "$NEW_PRODUCTS")"

  # Telegram notification
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "  Sending Telegram notification..."
    curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\": \"${TELEGRAM_CHAT_ID}\", \"text\": \"$(echo "$MSG" | sed 's/"/\\"/g' | head -c 4000)\", \"disable_web_page_preview\": false}" \
      > /dev/null 2>&1 && echo "  Telegram sent!" || echo "  Telegram failed"
  fi

  # SMS notification via Twilio
  if [ -n "${TWILIO_SID:-}" ] && [ -n "${TWILIO_TOKEN:-}" ] && [ -n "${TWILIO_FROM:-}" ] && [ -n "${TWILIO_TO:-}" ]; then
    echo "  Sending SMS notification..."
    SHORT_MSG="[AUDI F1 DROP] $NEW_COUNT new item(s) on adidas.com/us/audi_revolut_f1_team - check Telegram for details"
    curl -sS -X POST "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json" \
      -u "${TWILIO_SID}:${TWILIO_TOKEN}" \
      -d "From=${TWILIO_FROM}" \
      -d "To=${TWILIO_TO}" \
      -d "Body=${SHORT_MSG}" \
      > /dev/null 2>&1 && echo "  SMS sent!" || echo "  SMS failed"
  fi

  # Log notification
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] NEW: $NEW_COUNT products - $(echo -e "$NEW_PRODUCTS" | tr '\n' ' ')" >> "$NOTIFY_LOG"
else
  echo "  No new products"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Monitor run complete"
