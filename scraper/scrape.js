// Daily Caraway scrape: every product and bundle on carawayhome.com, its prices per color,
// the site-wide sale tiers, tier-only prices, free gifts and banners. Writes JSON into data/.
//
// Gentle by design: obeys robots.txt, loads ONE full page, then asks the storefront for each
// product's data the same way its own links do (one small request per product), DELAY_MS apart,
// and skips images, fonts and video.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractRootInPage, extractProductInPage } from './extract.js';
import { today, mergeCatalog, mergePriceHistory, mergePromos, buildBundles, buildAddOnDeals, inferColors } from './lib.js';

const BASE = 'https://www.carawayhome.com';
const DATA = new URL('../data/', import.meta.url);
const DELAY_MS = Number(process.env.DELAY_MS || 2500);
const LIMIT = Number(process.env.LIMIT || 0); // for testing: only scrape the first N products
const UA_SUFFIX = ' CarawayPriceTracker/1.0 (personal price history; github.com/termraider/caraway)';

// Raw results of a run are kept here so MERGE_ONLY=1 can re-merge them into newer data after a pull.
const RUN_FILE = process.env.RUN_FILE || join(tmpdir(), 'caraway-run.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function readJSON(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DATA), 'utf8')); } catch { return fallback; }
}
async function writeJSON(name, value) {
  await writeFile(new URL(name, DATA), JSON.stringify(value, null, 1) + '\n');
}

// Minimal robots.txt check for the "*" group.
function robotsAllows(robots, path) {
  let applies = false; const rules = [];
  for (const raw of robots.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (/^user-agent$/i.test(k)) applies = v.trim() === '*';
    else if (applies && /^(dis)?allow$/i.test(k) && v) rules.push({ allow: /^allow$/i.test(k), path: v.trim() });
  }
  let best = null;
  for (const r of rules) if (path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
  return !best || best.allow;
}

const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

async function main() {
  await mkdir(DATA, { recursive: true });
  if (process.env.MERGE_ONLY) { await save(JSON.parse(await readFile(RUN_FILE, 'utf8'))); return; }
  const date = today();
  const started = Date.now();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: (await (await browser.newPage()).evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome') + UA_SUFFIX,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
  });
  const req = context.request;

  // 1. robots.txt
  const robots = await (await req.get(`${BASE}/robots.txt`)).text();
  for (const p of ['/', '/products/x', '/sitemap.xml']) {
    if (!robotsAllows(robots, p)) throw new Error(`robots.txt disallows ${p}; stopping`);
  }

  // 2. sitemap -> product handles + public collections
  const index = locs(await (await req.get(`${BASE}/sitemap.xml`)).text());
  const productUrls = []; const collectionUrls = [];
  for (const sm of index) {
    if (!/\/sitemap\/(products|collections)\//.test(sm)) continue;
    const urls = locs(await (await req.get(sm)).text());
    (sm.includes('/products/') ? productUrls : collectionUrls).push(...urls);
    await sleep(500);
  }
  const sitemapHandles = [...new Set(productUrls.map((u) => new URL(u).pathname.split('/products/')[1]).filter(Boolean))];
  const sitemapCollections = [...new Set(collectionUrls.map((u) => new URL(u).pathname.split('/collections/')[1]).filter(Boolean))];
  log(`sitemap: ${sitemapHandles.length} products, ${sitemapCollections.length} collections`);
  if (sitemapHandles.length < 50) throw new Error('sitemap looks wrong (under 50 products); stopping without saving');

  // 3. previous data (only to know which products to re-check; merging re-reads data/ in save())
  const catalog = await readJSON('products.json', { products: {} });

  // Re-check products we knew about that left the sitemap, to tell "discontinued" (404) from "unlisted".
  const known = Object.values(catalog.products).filter((p) => !p.discontinued).map((p) => p.handle);
  let handles = [...new Set([...sitemapHandles, ...known])];
  if (LIMIT) handles = handles.slice(0, LIMIT);

  // 4. one real page load -> site-wide promo state
  const page = await context.newPage();
  const openHome = async () => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => window.__reactRouterDataRouter && window.__reactRouterDataRouter.state.loaderData.root, null, { timeout: 90000 });
  };
  await openHome();
  const root = await page.evaluate(extractRootInPage);
  if (!root) throw new Error('could not read site data from the homepage');
  log(`promos: holiday=${root.holidayEnabled} tiers=${(root.tierPricing?.tiers || []).map((t) => `${t.percentOff}%@$${t.threshold}`).join(' ')}`);

  // 5. each product via the storefront's own client-side navigation
  const scraped = {}; const missing = []; const failed = [];
  for (const [i, handle] of handles.entries()) {
    let result = null;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try {
        const nav = await page.evaluate(async (h) => {
          const r = window.__reactRouterDataRouter;
          if (!r) return 'no-router';
          await r.navigate('/products/' + h);
          for (let n = 0; n < 300 && r.state.navigation.state !== 'idle'; n++) await new Promise((x) => setTimeout(x, 100));
          return r.state.navigation.state;
        }, handle);
        if (nav !== 'idle') throw new Error('navigation ' + nav);
        result = await page.evaluate(extractProductInPage);
        if (result.error === 'no-router') throw new Error('router lost');
      } catch (e) {
        log(`  ${handle}: attempt ${attempt} failed (${e.message.split('\n')[0]})`);
        result = null;
        await sleep(5000);
        try { await openHome(); } catch {}
      }
    }
    if (!result) failed.push(handle);
    else if (result.error === 'not-found' && (result.status === 404 || result.status == null)) missing.push(handle);
    else if (result.error) failed.push(handle);
    else {
      if (!sitemapHandles.includes(handle)) result.unlisted = true;
      scraped[result.handle || handle] = result;
    }
    if (i % 25 === 0) log(`${i + 1}/${handles.length} ${handle}`);
    await sleep(DELAY_MS);
  }
  await browser.close();
  log(`scraped ${Object.keys(scraped).length}, gone ${missing.length}, failed ${failed.length}`);
  if (missing.length) log('gone (404): ' + missing.join(', '));
  if (failed.length) log('failed: ' + failed.join(', '));

  // Don't record a broken run as mass price changes / discontinuations.
  if (Object.keys(scraped).length < handles.length * 0.7) throw new Error('too many products failed this run; not saving');

  const run = { date, started, scraped, missing, failed, root, sitemapCollections, sitemapProducts: sitemapHandles.length };
  await writeFile(RUN_FILE, JSON.stringify(run));
  await save(run);
}

// 6. merge this run into whatever is in data/ now, and write.
async function save({ date, started, scraped, missing, failed, root, sitemapCollections, sitemapProducts }) {
  const catalog = await readJSON('products.json', { products: {} });
  const history = await readJSON('price-history.json', {});
  const promos = await readJSON('promos.json', { log: [] });
  const merged = mergeCatalog(catalog, scraped, missing, date, sitemapCollections);
  merged.updatedAt = date;
  log(`colors inferred for ${inferColors(merged.products)} products`);
  mergePriceHistory(history, scraped, date);
  root.addOnDeals = buildAddOnDeals(merged.products);
  log(`add-on deals: ${root.addOnDeals.length}`);
  const promoState = mergePromos(promos, root, date);
  const bundles = buildBundles(merged.products);

  await writeJSON('products.json', merged);
  await writeJSON('price-history.json', history);
  await writeJSON('promos.json', promoState);
  await writeJSON('bundles.json', { updatedAt: date, bundles });
  const meta = await readJSON('meta.json', { runs: [] });
  meta.lastRun = { date, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000),
    products: Object.keys(scraped).length, gone: missing, failed, sitemapProducts };
  meta.runs = [meta.lastRun, ...(meta.runs || [])].slice(0, 60);
  await writeJSON('meta.json', meta);
  log('saved');
}

main().catch((e) => { console.error(e); process.exit(1); });
