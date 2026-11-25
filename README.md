# Caraway tracker

**Site:** https://termraider.github.io/caraway/

Tracks every product and bundle on carawayhome.com: prices per color, how long each price lasted, sale tiers, tier-only prices, free gifts, banners, and discontinued items. The website (GitHub Pages) shows the catalog and price history, lets you mark what you own (by color), and works out the cheapest way to buy a wishlist or the most you can get for a budget.

## How it works

- `scraper/scrape.js` runs once a day on GitHub Actions (`.github/workflows/scrape.yml`). It checks robots.txt, reads the sitemap, loads one page of the site, then asks the storefront for each product's data the way the site's own links do, 2.5 s apart, without images. It writes `data/` and commits only when something changed.
- `scraper/backfill.js` (`.github/workflows/backfill.yml`, run by hand) pulls older prices and discontinued products from Internet Archive snapshots. Each run fetches up to 1,200 snapshots and saves its progress; run it again until the log says 0 left.
- `index.html` + `app.js` + `optimizer.js` are the website. No build step.

## Data files

| File | What's in it |
| --- | --- |
| `data/products.json` | Every product ever seen: link, type, collections, bundle flag, first/last seen, discontinued date, variants (color, SKU, price, compare-at, stock) |
| `data/price-history.json` | Per variant: price runs `{price, compareAt, from, to}` (and stock runs). Days at a price = to − from + 1 |
| `data/bundles.json` | Each bundle's parts mapped to the standalone products, and what the parts cost separately |
| `data/promos.json` | Today's sale tiers, tier-only prices, gifts, free shipping, banners, plus a log of every offer with first/last seen dates |
| `data/coupons.json` | Coupon codes added by hand (`{"coupons":[{"code","deal","from","to"}]}`); codes can also be added on the site |
| `data/meta.json` | Last runs: date, product counts, anything that failed |

## Changing the schedule

Edit the `cron` line in `.github/workflows/scrape.yml` (times are UTC). Examples are in the file. "Run workflow" on the Actions tab runs it any time.

## Sale math

Caraway applies its tiers to the cart's subtotal before discounts (e.g. 15% at $85, 20% at $425, 25% at $525), some items drop to a fixed price at a tier, and the free gift unlocks past another subtotal. The optimizer prices whole carts the same way. It's an estimate: check the cart before buying. Caraway also A/B tests offers (e.g. a "flat20" group with 20% off everything); pick your group on the Wishlist page if your cart shows that.

## Sync

Owned items, wishlist and coupon codes live in the browser. To sync between devices, paste a GitHub token with Gists read/write on the site's sync page; the data goes to a private gist, not this repo.

## Run locally

```bash
npm ci && npx playwright install chromium
LIMIT=10 node scraper/scrape.js   # first 10 products only
npm test
python3 -m http.server            # then open http://localhost:8000
```
