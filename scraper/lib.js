// Pure helpers for merging a scrape into the stored history. No network, no browser.

export const today = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d); // YYYY-MM-DD, Eastern time

// Collections worth keeping on a product: the public ones listed in the sitemap (the rest are internal).
export function keepCollections(handles, sitemapCollections) {
  const keep = new Set(sitemapCollections);
  return [...new Set(handles || [])].filter((h) => keep.has(h));
}

// A bundle = sold as one product but made of 2+ standalone products.
export function isBundle(p) {
  const linked = (p.components || []).filter((c) => c.variants && c.variants.length);
  if (linked.length >= 2) return true;
  if ((p.components || []).reduce((n, c) => n + (c.qty || 1), 0) >= 2 && (p.collections || []).includes('bundles')) return true;
  return false;
}

/**
 * Merge freshly scraped products into the catalog.
 * catalog = { products: { handle: {...} } }
 * scraped = { handle: productObject } (only products that loaded this run)
 * missing = handles confirmed gone (404) this run
 */
export function mergeCatalog(catalog, scraped, missing, date, sitemapCollections) {
  const products = catalog.products || {};
  for (const [handle, p] of Object.entries(scraped)) {
    const prev = products[handle] || {};
    const variants = {};
    for (const v of prev.variants || []) variants[v.id] = { ...v, live: false };
    for (const v of p.variants) {
      const old = variants[v.id] || {};
      variants[v.id] = { ...old, ...v, live: true, firstSeen: old.firstSeen || date, lastSeen: date };
    }
    const collections = keepCollections(p.collections, sitemapCollections);
    products[handle] = {
      ...prev,
      ...p,
      url: `https://www.carawayhome.com/products/${handle}`,
      collections,
      bundle: isBundle({ ...p, collections }),
      variants: Object.values(variants),
      firstSeen: prev.firstSeen || date,
      lastSeen: date,
      discontinued: false,
      discontinuedOn: null,
      source: 'live',
      archiveUrl: undefined,
    };
  }
  for (const handle of missing) {
    const prev = products[handle];
    if (!prev) continue;
    if (!prev.discontinued) { prev.discontinued = true; prev.discontinuedOn = date; }
    for (const v of prev.variants || []) v.live = false;
  }
  return { ...catalog, products };
}

/**
 * Price runs per variant: a new run starts whenever the price or compare-at price changes.
 * history = { variantId: { handle, title, color, runs: [{price, compareAt, from, to}], stock: [{available, from, to}] } }
 * A run's `to` is the last day it was seen at that price, so days at price = to - from + 1.
 */
export function mergePriceHistory(history, scraped, date) {
  for (const p of Object.values(scraped)) {
    for (const v of p.variants) {
      if (v.price == null) continue;
      const h = history[v.id] || (history[v.id] = { handle: p.handle, title: p.title, color: v.color || v.title, runs: [], stock: [] });
      h.handle = p.handle; h.title = p.title; h.color = v.color || v.title;
      const last = h.runs[h.runs.length - 1];
      if (last && last.price === v.price && last.compareAt === v.compareAt && !last.source) last.to = date;
      else h.runs.push({ price: v.price, compareAt: v.compareAt, from: date, to: date });
      const ls = h.stock[h.stock.length - 1];
      if (ls && ls.available === v.available) ls.to = date;
      else h.stock.push({ available: v.available, from: date, to: date });
    }
  }
  return history;
}

/**
 * Promo log entries: each distinct offer (tier set, tier-only price, gift, free-shipping line, banner text)
 * becomes one entry with first/last seen dates.
 */
export function promoEntries(root) {
  const out = [];
  if (!root) return out;
  const tp = root.tierPricing;
  if (root.holidayEnabled && tp && tp.tiers.length) {
    out.push({
      kind: 'tiers',
      key: 'tiers:' + tp.tiers.map((t) => `${t.percentOff}@${t.threshold}`).join(','),
      title: 'Spend tiers: ' + tp.tiers.map((t) => `${t.percentOff}% off at $${t.threshold}`).join(', '),
      detail: { tiers: tp.tiers.map((t) => ({ threshold: t.threshold, percentOff: t.percentOff })) },
    });
    for (const t of tp.tiers) {
      for (const [handle, m] of Object.entries(t.prices)) {
        const prices = [...new Set(Object.values(m))];
        out.push({
          kind: 'tier-price',
          key: `tier-price:${handle}:${t.threshold}:${prices.join('/')}`,
          title: `${handle} drops to $${prices.join('/')} once the cart reaches $${t.threshold}`,
          detail: { handle, threshold: t.threshold, prices },
        });
      }
    }
  }
  for (const b of root.progressBars || []) {
    if (!b.enabled) continue;
    const group = b.featureFlag && b.featureFlag.variant;
    for (const t of b.tiers) {
      if (!t.giftHandle) continue;
      out.push({
        kind: 'gift',
        key: `gift:${t.giftHandle}:${t.amount}:${group || ''}`,
        title: `Free ${t.giftTitle || t.giftHandle} when the cart reaches $${t.amount} before discounts${group && group !== 'control' ? ` (${group} shoppers)` : ''}`,
        detail: { giftHandle: t.giftHandle, giftTitle: t.giftTitle, threshold: t.amount, bar: b.name, group: group || null },
      });
    }
  }
  if (root.freeShipping && root.freeShipping.enabled && root.freeShipping.threshold != null) {
    out.push({ kind: 'shipping', key: `shipping:${root.freeShipping.threshold}`, title: `Free shipping on orders $${root.freeShipping.threshold}+`, detail: { threshold: root.freeShipping.threshold } });
  }
  for (const d of root.addOnDeals || []) {
    out.push({ kind: 'add-on', key: `add-on:${d.handle}:${d.host}:${d.type}:${d.value}`,
      title: `${d.handle} ${d.type === 'percent' ? d.value + '% off' : '$' + d.value + ' off'} when added with ${d.host}`, detail: d });
  }
  for (const s of root.promoText || []) out.push({ kind: 'banner', key: 'banner:' + s.toLowerCase(), title: s });
  return out;
}

export function mergePromos(promos, root, date) {
  const log = promos.log || [];
  const byKey = new Map(log.map((e) => [e.key, e]));
  for (const e of promoEntries(root)) {
    const prev = byKey.get(e.key);
    if (prev) { prev.lastSeen = date; if (e.detail) prev.detail = e.detail; }
    else { const n = { ...e, firstSeen: date, lastSeen: date }; log.push(n); byKey.set(e.key, n); }
  }
  log.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.firstSeen.localeCompare(a.firstSeen));
  return { updatedAt: date, current: root, log };
}

/**
 * Bundles: list each bundle's components mapped to standalone products, and its value vs. price.
 */
/**
 * Some products have their colors under a generic "Title" option (Cookie Sheet, Pie Pan, Grill Press...),
 * so the scraper saw no color. If every value of a lone option is a color used elsewhere, treat it as the color.
 */
export function inferColors(products) {
  const known = new Set();
  for (const p of Object.values(products)) for (const v of p.variants || []) if (v.color) known.add(v.color.toLowerCase());
  const isColor = (x) => known.has(String(x).toLowerCase()) || /^iconics /i.test(x);
  let n = 0;
  for (const p of Object.values(products)) {
    const vs = p.variants || [];
    if (vs.length < 2 || vs.some((v) => v.color)) continue;
    const keys = [...new Set(vs.flatMap((v) => Object.keys(v.options || {})))];
    if (keys.length !== 1) continue;
    const vals = vs.map((v) => v.options[keys[0]]);
    if (vals.every(isColor)) { for (const v of vs) v.color = v.options[keys[0]]; n++; }
  }
  return n;
}

// Bundle parts Caraway doesn't link to a product (organizers, lid holders, some pans): match them by name.
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9.]+/g, ' ').trim();
const PART_ALIASES = [
  [/^(cookware )?storage organizers?$/, 'cookware-set-pan-organizers'],
  [/^canvas lid holder$/, 'cookware-set-hanging-lid-holder'],
  [/^cookware storage organizer$/, 'cookware-organizer'],
  [/^squareware storage organizers?$/, 'squareware-set-organizers'],
];

export function buildBundles(products) {
  const byVariant = new Map();
  for (const p of Object.values(products)) for (const v of p.variants || []) byVariant.set(v.id, { handle: p.handle, color: v.color });
  const byTitle = new Map();
  for (const p of Object.values(products)) if (!p.bundle && !p.discontinued) byTitle.set(norm(p.title), p.handle);
  const findByName = (c) => {
    const n = norm(c.name), sn = norm(c.shortName);
    for (const [re, h] of PART_ALIASES) if ((re.test(n) || re.test(sn)) && products[h]) return h;
    return byTitle.get(n) || byTitle.get(sn) || null;
  };
  const out = {};
  for (const p of Object.values(products)) {
    if (!p.bundle) continue;
    const items = (p.components || []).map((c) => {
      let handles = [...new Set(c.variants.map((cv) => byVariant.get(cv.id)?.handle).filter(Boolean))];
      let variants = c.variants.map((cv) => ({ id: cv.id, color: cv.color, handle: byVariant.get(cv.id)?.handle || null }));
      let matchedBy = handles.length ? 'link' : null;
      if (!handles.length) { const h = findByName(c); if (h) { handles = [h]; matchedBy = 'name'; } }
      const h = handles.length === 1 ? handles[0] : null;
      const prod = h && products[h];
      // Fill in every color of the part's product, so any bundle color finds its matching part.
      if (prod) {
        const have = new Set(variants.map((v) => v.id));
        let extra = (prod.variants || []).filter((v) => !have.has(v.id) && v.live !== false);
        const size = (c.name.match(/^([\d.]+)[”"]/) || [])[1];
        if (size) extra = extra.filter((v) => Object.values(v.options || {}).some((o) => String(o).startsWith(size + '"')));
        variants = [...variants, ...extra.map((v) => ({ id: v.id, color: v.color ? v.color.toLowerCase() : null, handle: h }))];
      }
      const firstPrice = prod && variants[0] && (prod.variants || []).find((v) => v.id === variants[0].id)?.price;
      const price = c.priceOverride ?? (c.variants[0] && c.variants[0].price) ?? firstPrice ?? null;
      return { name: c.name, qty: c.qty, type: c.type, match: c.match, handle: h || handles[0] || null, matchedBy, unitPrice: price, variants };
    });
    const value = items.reduce((s, i) => s + (i.unitPrice || 0) * i.qty, 0);
    out[p.handle] = { handle: p.handle, title: p.title, discontinued: !!p.discontinued, items, componentValue: Math.round(value * 100) / 100 };
  }
  return out;
}

/**
 * Fold Internet Archive observations into the catalog and price history.
 * Archive runs (source: 'wayback') are rebuilt from scratch each time and placed before the first live run.
 * Between two snapshots we don't know the exact change day, so a run spans first to last snapshot at that price.
 */
export function mergeBackfill(catalog, history, obs) {
  const products = catalog.products || (catalog.products = {});
  for (const [vid, rec] of Object.entries(obs.variants || {})) {
    const seen = [...rec.seen].sort((a, b) => a[0].localeCompare(b[0]));
    const h = history[vid] || (history[vid] = { handle: rec.handle, title: (obs.products[rec.handle] || {}).title || rec.handle, color: rec.color || rec.title, runs: [], stock: [] });
    const live = h.runs.filter((r) => r.source !== 'wayback');
    const firstLive = live.length ? live[0].from : '9999-12-31';
    const runs = [];
    for (const [date, price, compareAt] of seen) {
      if (date >= firstLive) continue;
      const last = runs[runs.length - 1];
      if (last && last.price === price && last.compareAt === compareAt) last.to = date;
      else runs.push({ price, compareAt, from: date, to: date, source: 'wayback' });
    }
    h.runs = [...runs, ...live];
    if (!h.color && rec.color) h.color = rec.color;
  }
  for (const [handle, p] of Object.entries(obs.products || {})) {
    if (!/^[a-z0-9-]+$/.test(handle)) continue; // junk archive URLs like "bundle\\"
    const cur = products[handle];
    const variants = Object.entries(obs.variants || {}).filter(([, r]) => r.handle === handle).map(([id, r]) => {
      const last = [...r.seen].sort((a, b) => a[0].localeCompare(b[0])).pop();
      return { id, title: r.color || r.title, color: r.color || r.title || null, sku: r.sku || null, price: last[1], compareAt: last[2], available: null, live: false, firstSeen: r.seen.map((s) => s[0]).sort()[0], lastSeen: last[0] };
    });
    if (cur && cur.source !== 'wayback') {
      // A live product: just extend its first-seen date and add archived-only variants (old colors).
      if (p.firstSeen < cur.firstSeen) cur.archiveFirstSeen = p.firstSeen;
      const ids = new Set((cur.variants || []).map((v) => v.id));
      for (const v of variants) if (!ids.has(v.id)) cur.variants.push({ ...v, archived: true });
      continue;
    }
    // Never seen live: an old, discontinued product.
    products[handle] = {
      handle, title: p.title || handle, productType: p.productType || null, tags: p.tags || [], collections: [],
      url: `https://www.carawayhome.com/products/${handle}`, image: p.image || null, variants, components: [],
      bundle: /bundle|set|duo|trio/i.test(p.title || ''), firstSeen: p.firstSeen, lastSeen: p.lastSeen,
      discontinued: true, discontinuedOn: null, source: 'wayback',
      archiveUrl: `https://web.archive.org/web/${p.lastSeen.replace(/-/g, '')}/https://www.carawayhome.com/products/${handle}`,
    };
  }
  return { catalog, history };
}

/**
 * Add-on deals: product X is cheaper when added from product H's page ("Utensil Holder $25 off with the Utensil Set").
 * Returns [{host, handle, type: 'amount'|'percent', value, label}] for every pair where the page actually offers X.
 */
export function buildAddOnDeals(products) {
  const byVariant = new Map();
  for (const p of Object.values(products)) for (const v of p.variants || []) byVariant.set(String(v.id), p.handle);
  const deals = [];
  for (const host of Object.values(products)) {
    if (host.discontinued) continue;
    for (const o of host.addOns || []) {
      const offered = new Set(o.items.map((i) => i.handle || byVariant.get(String(i.variantId))).filter(Boolean));
      for (const h of offered) {
        const d = o.priceOverrides && o.priceOverrides[h];
        if (!d || !d.value) continue;
        if (!deals.some((x) => x.host === host.handle && x.handle === h)) deals.push({ host: host.handle, handle: h, type: d.type, value: d.value, label: o.label });
      }
    }
  }
  return deals;
}
