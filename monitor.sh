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

# URLs to check (collection page + search variations)
URLS=(
  "https://www.adidas.com/us/audi"
  "https://www.adidas.com/us/search?q=audi%20f1"
  "https://www.adidas.com/us/search?q=audi%20formula"
  "https://www.adidas.com/us/audi-f1"
)

# Fetch all URLs and combine HTML
COMBINED_HTML=""
for url in "${URLS[@]}"; do
  echo "  Fetching: $url"
  HTML=$(curl -sL \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
    -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
    -H "Accept-Language: en-US,en;q=0.9" \
    -H "Accept-Encoding: identity" \
    --max-time 30 \
    "$url" 2>/dev/null || echo "")
  COMBINED_HTML="$COMBINED_HTML$HTML"
done

# Check if we got blocked (403)
if echo "$COMBINED_HTML" | grep -q "UNABLE TO GIVE YOU ACCESS"; then
  echo "  WARNING: Akamai WAF block detected. GitHub Actions IP may be flagged."
  echo "  Will check alternative sources..."
fi

# Extract products using multiple patterns
# Pattern 1: Product links (/us/product-name/SKU.html)
PRODUCTS_RAW=$(echo "$COMBINED_HTML" | grep -oP 'href="(/us/[^"]*?/[A-Z0-9]{5,10}\.html)"' | sort -u || true)

# Pattern 2: JSON product data (from __NEXT_DATA__ or inline scripts)
JSON_PRODUCTS=$(echo "$COMBINED_HTML" | grep -oP '"productId"\s*:\s*"[A-Z0-9]+"' | grep -oP '"[A-Z0-9]+"$' | tr -d '"' | sort -u || true)

# Pattern 3: Search result items
SEARCH_PRODUCTS=$(echo "$COMBINED_HTML" | grep -oP '"id"\s*:\s*"[A-Z]{2}[0-9]{4}"' | grep -oP '"[A-Z]{2}[0-9]{4}"' | tr -d '"' | sort -u || true)

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

# Process JSON-detected SKUs (if not already found)
for SKU in $JSON_PRODUCTS $SEARCH_PRODUCTS; do
  [ -z "$SKU" ] && continue
  # Check if already in our set
  if grep -q "\"$SKU\"" /tmp/current_products.json 2>/dev/null; then
    continue
  fi
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    echo "," >> /tmp/current_products.json
  fi
  printf '  "%s": {"name": "%s", "url": "https://www.adidas.com/us/search?q=%s"}' "$SKU" "$SKU" "$SKU" >> /tmp/current_products.json
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
    SHORT_MSG="[AUDI F1 DROP] $NEW_COUNT new item(s) on adidas.com/us/audi - check Telegram for details"
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
