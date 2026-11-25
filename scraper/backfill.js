// One-time (resumable) backfill of older prices and discontinued products from Internet Archive snapshots.
//
// Sources, cheapest first:
//   1. Archived /products.json and /collections/all/products.json (the old Shopify theme): every product at once.
//   2. Archived /products/<handle>.json and .js files.
//   3. Archived product pages: Shopify's inline product JSON ("var meta", data-product-json) or JSON-LD offers.
//
// Observations are kept in data/wayback-observations.json, so later runs only fetch snapshots not seen yet.
// Each run fetches at most MAX snapshots (default 1200), ~1.5 s apart, then saves. Run it again to continue.

import { readFile, writeFile } from 'node:fs/promises';
import { mergeBackfill, today, inferColors, buildBundles } from './lib.js';

const DATA = new URL('../data/', import.meta.url);
const MAX = Number(process.env.MAX || 1200);
const DELAY_MS = Number(process.env.DELAY_MS || 1500);
const UA = 'CarawayPriceTracker/1.0 (personal price history backfill; github.com/termraider/caraway)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function readJSON(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DATA), 'utf8')); } catch { return fallback; }
}
async function writeJSON(name, value) {
  await writeFile(new URL(name, DATA), JSON.stringify(value, null, 1) + '\n');
}

async function get(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } });
      if (r.status === 429 || r.status >= 500) { log(`  ${r.status}, waiting`); await sleep(30000 * i); continue; }
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { log(`  fetch error ${e.message}`); await sleep(10000 * i); }
  }
  return null;
}

async function cdx(params) {
  const url = 'https://web.archive.org/cdx/search/cdx?output=json&' + new URLSearchParams(params);
  const txt = await get(url);
  if (!txt) return [];
  let rows; try { rows = JSON.parse(txt); } catch { return []; }
  const [head, ...data] = rows;
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const tsDate = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
const money = (x, cents) => (x == null || x === '' ? null : Math.round((cents ? Number(x) / 100 : Number(x)) * 100) / 100);
const handleOf = (url) => { const m = String(url).match(/\/products\/([^/?#.]+)/); return m ? decodeURIComponent(m[1]).toLowerCase() : null; };

// --- parsers: each returns [{handle, title, image, variants:[{id,title,color,sku,price,compareAt,available}]}]
function fromProductsJson(txt) {
  let j; try { j = JSON.parse(txt); } catch { return []; }
  const list = j.products || (j.product ? [j.product] : []);
  return list.map((p) => ({
    handle: p.handle, title: p.title, productType: p.product_type || null, tags: typeof p.tags === 'string' ? p.tags.split(/,\s*/) : (p.tags || []),
    image: (p.images && p.images[0] && (p.images[0].src || p.images[0])) || p.featured_image || null,
    variants: (p.variants || []).map((v) => {
      const cents = typeof v.price === 'number'; // .js feeds give integer cents, .json feeds give "125.00" strings
      return { id: String(v.id), title: v.title || v.public_title || v.name, color: v.option1 || v.public_title || null, sku: v.sku || null,
        price: money(v.price, cents), compareAt: money(v.compare_at_price, cents) || null, available: v.available ?? null };
    }),
  })).filter((p) => p.handle && p.variants.length);
}

function fromProductPage(html, handle) {
  const out = [];
  // Shopify themes: var meta = {"product":{...}} (prices in cents)
  const meta = html.match(/var meta = (\{"product":[\s\S]*?\});\s*\n/);
  if (meta) {
    try {
      const p = JSON.parse(meta[1]).product;
      out.push({ handle, title: null, variants: (p.variants || []).map((v) => ({ id: String(v.id), title: v.public_title || v.name, color: v.public_title || null, sku: v.sku || null, price: money(v.price, true), compareAt: null, available: null })) });
    } catch {}
  }
  // <script type="application/json" data-product-json> / id="ProductJson-..."
  for (const m of html.matchAll(/<script[^>]+(?:data-product-json|id="ProductJson[^"]*")[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const p = JSON.parse(m[1]);
      out.push({ handle: p.handle || handle, title: p.title, image: p.featured_image || null, variants: (p.variants || []).map((v) => ({ id: String(v.id), title: v.title, color: v.option1 || null, sku: v.sku || null, price: money(v.price, true), compareAt: money(v.compare_at_price, true) || null, available: v.available ?? null })) });
    } catch {}
  }
  // JSON-LD Product / ProductGroup offers
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    const items = [].concat(j['@graph'] || j);
    for (const it of items) {
      if (!it || !/Product/.test(it['@type'])) continue;
      const vs = it.hasVariant || [it];
      const variants = [];
      for (const v of vs) {
        for (const o of [].concat(v.offers || [])) {
          if (!o || o.price == null) continue;
          const vid = String(o.url || '').match(/variant=(\d+)/);
          const strike = [].concat(o.priceSpecification || []).find((s) => /Strikethrough/i.test(s.priceType || ''));
          variants.push({ id: vid ? vid[1] : (o.sku ? `sku:${o.sku}` : null), title: v.name, color: v.color || null, sku: o.sku || v.sku || null,
            price: money(o.price), compareAt: strike ? money(strike.price) : null, available: /InStock/i.test(o.availability || '') });
        }
      }
      if (variants.length) out.push({ handle, title: it.name, image: [].concat(it.image || [])[0] || null, variants: variants.filter((v) => v.id) });
    }
  }
  // Prefer the richest parse (has compare-at prices and ids).
  out.sort((a, b) => b.variants.filter((v) => v.compareAt != null).length - a.variants.filter((v) => v.compareAt != null).length);
  return out.slice(0, 1).filter((p) => p.variants.length);
}

// MERGE_ONLY=1: skip the Internet Archive and just fold the saved observations into the current data files.
// The workflow uses this after pulling, so a long backfill never overwrites data that changed meanwhile.
async function mergeInto(obs) {
  const catalog = await readJSON('products.json', { products: {} });
  const history = await readJSON('price-history.json', {});
  mergeBackfill(catalog, history, obs);
  inferColors(catalog.products);
  await writeJSON('products.json', catalog);
  await writeJSON('price-history.json', history);
  const b = await readJSON('bundles.json', {});
  await writeJSON('bundles.json', { updatedAt: b.updatedAt || today(), bundles: buildBundles(catalog.products) });
}

async function main() {
  const obs = await readJSON('wayback-observations.json', { done: [], products: {}, variants: {} });
  if (process.env.MERGE_ONLY) { await mergeInto(obs); log('merged saved observations'); return; }
  const done = new Set(obs.done);
  let fetched = 0;

  const record = (p, date, source) => {
    if (!p.handle) return;
    const prod = obs.products[p.handle] || (obs.products[p.handle] = { handle: p.handle, title: p.title, image: p.image || null, firstSeen: date, lastSeen: date, productType: p.productType || null, tags: p.tags || [] });
    if (p.title) prod.title = p.title;
    if (p.image && !prod.image) prod.image = p.image;
    if (date < prod.firstSeen) prod.firstSeen = date;
    if (date > prod.lastSeen) prod.lastSeen = date;
    for (const v of p.variants) {
      if (v.price == null) continue;
      const rec = obs.variants[v.id] || (obs.variants[v.id] = { handle: p.handle, title: v.title, color: v.color, sku: v.sku, seen: [] });
      if (v.color) rec.color = v.color;
      if (!rec.seen.some((s) => s[0] === date)) rec.seen.push([date, v.price, v.compareAt ?? null, source]);
    }
  };

  const snapshotPlan = [];
  // 1 + 2: products.json style feeds (one snapshot per month)
  for (const url of ['carawayhome.com/products.json', 'carawayhome.com/collections/all/products.json']) {
    const rows = await cdx({ url, matchType: 'prefix', fl: 'timestamp,original,statuscode', filter: 'statuscode:200', collapse: 'timestamp:6' });
    log(`${url}: ${rows.length} monthly snapshots`);
    for (const r of rows) snapshotPlan.push({ ...r, kind: 'feed' });
    await sleep(DELAY_MS);
  }
  // 3: product pages and .json/.js, one per URL per month
  const pages = await cdx({ url: 'carawayhome.com/products/', matchType: 'prefix', fl: 'timestamp,original,statuscode,mimetype', filter: 'statuscode:200', collapse: 'timestamp:6', limit: '200000' });
  log(`product URLs: ${pages.length} url-month snapshots`);
  const seenKey = new Set();
  for (const r of pages) {
    const h = handleOf(r.original);
    if (!h || /[?&](variant|view)=/.test(r.original) && !/\.json|\.js/.test(r.original)) continue;
    const key = `${h}|${r.timestamp.slice(0, 6)}`;
    if (seenKey.has(key)) continue; // one snapshot per product per month is enough
    seenKey.add(key);
    snapshotPlan.push({ ...r, kind: /\.(json|js)(\?|$)/.test(r.original) ? 'feed' : 'page', handle: h });
  }

  for (const s of snapshotPlan) {
    const id = `${s.timestamp}|${s.original}`;
    if (done.has(id)) continue;
    if (fetched >= MAX) break;
    const txt = await get(`https://web.archive.org/web/${s.timestamp}id_/${s.original}`);
    fetched++;
    const date = tsDate(s.timestamp);
    if (txt) {
      const parsed = s.kind === 'feed'
        ? (s.original.endsWith('.js') ? fromProductsJson(JSON.stringify({ product: safeJSON(txt) || {} })) : fromProductsJson(txt))
        : fromProductPage(txt, s.handle);
      for (const p of parsed) record(p, date, 'wayback');
      if (fetched % 50 === 0) log(`${fetched} fetched; ${Object.keys(obs.products).length} products, ${Object.keys(obs.variants).length} variants`);
    }
    done.add(id);
    await sleep(DELAY_MS);
  }
  obs.done = [...done];
  const remaining = snapshotPlan.filter((s) => !done.has(`${s.timestamp}|${s.original}`)).length;
  obs.updatedAt = today();
  obs.remaining = remaining;
  await writeJSON('wayback-observations.json', obs);

  // Merge into the live files.
  await mergeInto(obs);
  log(`done: fetched ${fetched}, ${remaining} snapshots left${remaining ? ' (run again to continue)' : ''}`);
}

function safeJSON(t) { try { return JSON.parse(t); } catch { return null; } }

main().catch((e) => { console.error(e); process.exit(1); });
