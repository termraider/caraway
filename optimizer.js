// Order optimizer for the Caraway tracker. Runs in the browser (and in Node tests). No dependencies.
//
// Caraway's sales work on the whole cart: once the cart's pre-discount subtotal passes a spend level,
// everything (except excluded products) gets that tier's % off, some items drop to a fixed tier price,
// and past another level a free gift is added. So the cheapest order is found by trying the mixes of
// single items and bundles that cover the wishlist and pricing each whole cart.

const round = (x) => Math.round(x * 100) / 100;
const lc = (s) => String(s || '').trim().toLowerCase();

/** Pricing rules for one offer group ("control" = the normal tiers; other groups, e.g. "flat20", come from A/B tests). */
export function makePricing(promos, group = 'control') {
  const cur = (promos && promos.current) || {};
  const tp = cur.tierPricing || null;
  let tiers = [];
  if (cur.holidayEnabled && tp) {
    if (group !== 'control' && tp.segments && tp.segments[group]) {
      const s = tp.segments[group];
      tiers = [{ threshold: 0, percentOff: s.percentOff, prices: s.prices || {} }];
    } else {
      tiers = (tp.tiers || []).map((t) => ({ threshold: t.threshold, percentOff: t.percentOff, prices: t.prices || {} }));
    }
  }
  tiers.sort((a, b) => a.threshold - b.threshold);
  const bars = (cur.progressBars || []).filter((b) => b.enabled);
  const bar = bars.find((b) => (b.featureFlag ? b.featureFlag.variant : 'control') === group) || bars.find((b) => !b.featureFlag) || null;
  const giftTier = bar && bar.tiers.find((t) => t.giftHandle);
  const overrides = (tp && tp.productOverrides) || {};
  return {
    group,
    tiers,
    excludedHandles: new Set(Object.entries(overrides).filter(([, o]) => o.percentOff === 0 && !Object.keys(o.prices || {}).length).map(([h]) => h)),
    excludeTags: new Set(((tp && tp.excludeTags) || []).map(lc)),
    gift: giftTier ? { threshold: giftTier.amount, handle: giftTier.giftHandle, title: giftTier.giftTitle } : null,
    freeShippingAt: cur.freeShipping && cur.freeShipping.enabled ? cur.freeShipping.threshold : null,
    addOnDeals: cur.addOnDeals || [],
  };
}

/** Prices a cart. lines = [{handle, variantId, base, tags?}] */
export function priceCart(lines, pricing) {
  // Add-on deals: an item is cheaper when a product that offers it as an add-on is in the same cart.
  const inCart = new Set(lines.map((l) => l.handle));
  const used = new Set();
  lines = lines.map((l, idx) => {
    let best = null;
    for (const d of pricing.addOnDeals || []) {
      if (d.handle !== l.handle || !inCart.has(d.host) || d.host === l.handle) continue;
      const price = d.type === 'percent' ? l.base * (1 - d.value / 100) : Math.max(0, l.base - d.value);
      if (!best || price < best.price) best = { price: round(price), deal: d };
    }
    if (!best || used.has(l.handle)) return l;
    used.add(l.handle); // one discounted add-on per product per order
    return { ...l, listBase: l.base, base: best.price, addOn: best.deal };
  });
  const subtotal = round(lines.reduce((s, l) => s + l.base, 0));
  let tier = null;
  for (const t of pricing.tiers) if (subtotal >= t.threshold) tier = t;
  let total = 0;
  const priced = lines.map((l) => {
    let price = l.base;
    const excluded = pricing.excludedHandles.has(l.handle) || (l.tags || []).some((t) => pricing.excludeTags.has(lc(t)));
    if (tier && !excluded) {
      const special = tier.prices[l.handle] && tier.prices[l.handle][l.variantId];
      price = special != null ? Math.min(special, l.base) : l.base * (1 - tier.percentOff / 100);
    }
    price = round(price);
    total += price;
    return { ...l, price, excluded };
  });
  total = round(total);
  const nextTier = pricing.tiers.find((t) => t.threshold > subtotal) || null;
  return {
    subtotal, total, savings: round(subtotal - total), tier, lines: priced,
    nextTier: nextTier ? { ...nextTier, needed: round(nextTier.threshold - subtotal) } : null,
    gift: pricing.gift && subtotal >= pricing.gift.threshold ? pricing.gift : null,
    giftNeeded: pricing.gift && subtotal < pricing.gift.threshold ? round(pricing.gift.threshold - subtotal) : 0,
    freeShipping: pricing.freeShippingAt == null ? null : total >= pricing.freeShippingAt,
  };
}

/** Lowest price an option could ever get in a cart (deepest tier, or a tier-only fixed price). */
function minPrice(o, pricing) {
  let m = o.base;
  for (const d of pricing.addOnDeals || []) if (d.handle === o.handle) m = Math.min(m, d.type === 'percent' ? o.base * (1 - d.value / 100) : Math.max(0, o.base - d.value));
  if (pricing.excludedHandles.has(o.handle)) return m;
  const b = m;
  for (const t of pricing.tiers) {
    m = Math.min(m, b * (1 - t.percentOff / 100));
    const sp = t.prices[o.handle] && t.prices[o.handle][o.variantId];
    if (sp != null) m = Math.min(m, sp);
  }
  return m;
}

/**
 * Items you own because you own a bundle that contains them.
 * Returns { 'handle|color': [{ handle, title, color }] } naming the owned bundle(s) each part came in.
 * A part's color is the bundle's color when the part comes in it, or its only variant.
 */
export function bundleOwnership(catalog, bundles, owned) {
  const products = (catalog && catalog.products) || catalog || {};
  const all = (bundles && bundles.bundles) || bundles || {};
  const byVariant = new Map();
  for (const p of Object.values(products)) for (const v of p.variants || []) byVariant.set(String(v.id), { handle: p.handle, color: v.color || v.title });
  const out = {};
  const visit = (handle, color, from, depth, seen) => {
    const b = all[handle];
    if (!b || depth > 3 || seen.has(handle)) return;
    seen.add(handle);
    for (const item of b.items || []) {
      const cvs = item.variants || [];
      const pick = cvs.find((cv) => lc(cv.color) === lc(color)) || (cvs.length === 1 ? cvs[0] : null);
      const ref = pick && byVariant.get(String(pick.id));
      if (!ref) continue;
      const key = `${ref.handle}|${lc(ref.color)}`;
      const list = out[key] || (out[key] = []);
      if (!list.some((x) => x.handle === from.handle && lc(x.color) === lc(from.color))) list.push(from);
      visit(ref.handle, ref.color, from, depth + 1, seen);
    }
  };
  for (const k of Object.keys(owned || {})) {
    const i = k.lastIndexOf('|'); const h = k.slice(0, i); const c = k.slice(i + 1);
    if (!all[h]) continue;
    const p = products[h];
    const v = p && (p.variants || []).find((x) => lc(x.color || x.title) === c);
    visit(h, c, { handle: h, title: (p && p.title) || all[h].title || h, color: v ? v.color || v.title : c }, 0, new Set());
  }
  return out;
}

const isOwned = (owned, handle, color) => !!(owned && (owned[`${handle}|${lc(color)}`] || owned[`${handle}|*`]));

/** Everything the search needs: per-product live variants and every bundle-in-a-color with what it contains. */
export function makeContext(catalog, bundles, promos, { group = 'control', owned = {}, includeUnavailable = false } = {}) {
  const products = (catalog && catalog.products) || catalog || {};
  // Owning a bundle means owning its parts (in the bundle's color).
  const via = bundleOwnership(products, bundles, owned);
  owned = { ...Object.fromEntries(Object.entries(via).map(([k, v]) => [k, { via: v }])), ...owned };
  const pricing = makePricing(promos, group);
  const buyable = (p) => p && !p.discontinued && !p.isGiftCard;
  const liveVariants = (p) => (p.variants || []).filter((v) => v.live !== false && v.price != null && (includeUnavailable || v.available !== false));
  const byVariant = new Map();
  for (const p of Object.values(products)) for (const v of p.variants || []) byVariant.set(String(v.id), { handle: p.handle, color: v.color || v.title });

  const bundleOptions = [];
  for (const b of Object.values((bundles && bundles.bundles) || bundles || {})) {
    const p = products[b.handle];
    if (!buyable(p)) continue;
    for (const v of liveVariants(p)) {
      const color = lc(v.color || v.title);
      const contents = [];
      for (const item of b.items || []) {
        const cvs = item.variants || [];
        const pick = cvs.find((cv) => lc(cv.color) === color) || (cvs.length === 1 ? cvs[0] : null) || null;
        const ref = pick && byVariant.get(String(pick.id));
        contents.push({ name: item.name, qty: item.qty || 1, handle: ref ? ref.handle : item.handle, color: ref ? ref.color : (pick && pick.color) || null, unitPrice: item.unitPrice });
      }
      bundleOptions.push({ kind: 'bundle', handle: p.handle, title: p.title, variantId: String(v.id), color: v.color || v.title, base: v.price, compareAt: v.compareAt, tags: p.tags || [], contents, url: p.url });
    }
  }
  return { products, pricing, owned, via, bundleOptions, liveVariants, buyable };
}

const matches = (entry, handle, color) => entry.handle === handle && (!entry.color || lc(entry.color) === lc(color));

/** Purchase options that can cover wishlist entry `i` (given which entries are still uncovered). */
function optionsFor(i, entries, uncovered, ctx) {
  const e = entries[i];
  const out = [];
  const p = ctx.products[e.handle];
  const isBundleProduct = ctx.bundleOptions.some((b) => b.handle === e.handle);
  if (ctx.buyable(p) && !isBundleProduct) { // a bundle itself on the wishlist is handled below, so it can also cover its parts
    let vs = ctx.liveVariants(p).filter((v) => !e.color || lc(v.color || v.title) === lc(e.color));
    // "any color": one option per distinct price is enough
    if (!e.color) { const seen = new Set(); vs = vs.sort((a, b) => a.price - b.price).filter((v) => !seen.has(v.price) && seen.add(v.price)); }
    for (const v of vs) out.push({ kind: 'single', handle: p.handle, title: p.title, variantId: String(v.id), color: v.color || v.title, base: v.price, compareAt: v.compareAt, tags: p.tags || [], url: p.url, covers: [i] });
  }
  const seenBundle = new Set();
  for (const b of ctx.bundleOptions) {
    // The bundle covers wishlist entries for the bundle itself and for each of its parts.
    const coverable = [{ handle: b.handle, color: b.color, qty: 1 }, ...b.contents];
    if (!coverable.some((c) => matches(e, c.handle, c.color))) continue;
    // Greedily assign this bundle's contents to uncovered entries, entry i first.
    const covers = [];
    for (const c of coverable) {
      let left = c.qty;
      const order = [i, ...uncovered.filter((j) => j !== i)];
      for (const j of order) {
        if (!left) break;
        if (covers.includes(j)) continue;
        if (matches(entries[j], c.handle, c.color)) { covers.push(j); left--; }
      }
    }
    if (!covers.includes(i)) continue;
    const key = `${b.handle}|${b.base}|${covers.sort((a, z) => a - z).join(',')}`;
    if (seenBundle.has(key)) continue; // same bundle, same price, same coverage in another color
    seenBundle.add(key);
    out.push({ ...b, covers });
  }
  return out;
}

function describe(chosen, entries, ctx) {
  const lines = chosen.map((o) => ({ handle: o.handle, variantId: o.variantId, base: o.base, tags: o.tags, title: o.title, color: o.color, kind: o.kind, url: o.url, compareAt: o.compareAt }));
  const priced = priceCart(lines, ctx.pricing);
  const coveredIdx = new Set(chosen.flatMap((o) => o.covers || []));
  // Bundle contents that aren't on the wishlist: bonus items, or duplicates of things you own.
  const extras = [];
  for (const o of chosen) {
    if (o.kind !== 'bundle') continue;
    const usedBy = new Map();
    for (const j of o.covers) { const k = `${entries[j].handle}`; usedBy.set(k, (usedBy.get(k) || 0) + 1); }
    for (const c of o.contents) {
      let qty = c.qty;
      const u = usedBy.get(c.handle) || 0;
      if (u) { const take = Math.min(u, qty); qty -= take; usedBy.set(c.handle, u - take); }
      if (qty > 0) extras.push({ from: o.title, name: c.name, qty, handle: c.handle, color: c.color, owned: c.handle ? isOwned(ctx.owned, c.handle, c.color) : false, unitPrice: c.unitPrice });
    }
  }
  const retail = [...coveredIdx].reduce((s, j) => s + (entries[j].retail || 0), 0);
  return { ...priced, chosen, covered: [...coveredIdx].sort((a, b) => a - b), extras, retail: round(retail) };
}

/** Entry retail value = its single price (compare-at if higher), used for the "most value" budget goal. */
export function prepareEntries(wishlist, ctx) {
  return wishlist.map((w) => {
    const p = ctx.products[w.handle];
    const vs = ctx.buyable(p) ? ctx.liveVariants(p).filter((v) => !w.color || lc(v.color || v.title) === lc(w.color)) : [];
    const v = vs.sort((a, b) => a.price - b.price)[0];
    return { ...w, retail: v ? Math.max(v.price, v.compareAt || 0) : 0, single: v ? v.price : null, buyable: !!v || ctx.bundleOptions.some((b) => b.contents.some((c) => matches(w, c.handle, c.color))) };
  });
}

/** Cheapest ways to buy every entry. Returns up to topK solutions, cheapest first. */
export function cheapest(wishlist, ctx, { topK = 5, maxNodes = 400000 } = {}) {
  const entries = prepareEntries(wishlist, ctx);
  const skipped = entries.map((e, i) => (e.buyable ? null : i)).filter((i) => i != null);
  const best = []; const seen = new Set(); let nodes = 0;
  const worst = () => (best.length < topK ? Infinity : best[best.length - 1].total);

  const dfs = (uncovered, chosen, lbSum) => {
    if (++nodes > maxNodes) return;
    if (lbSum > worst()) return; // even at the deepest possible discount this path is already too expensive
    if (!uncovered.length) {
      const key = chosen.map((o) => `${o.handle}|${o.variantId}`).sort().join(';');
      if (seen.has(key)) return; seen.add(key);
      const sol = describe(chosen, entries, ctx);
      best.push(sol); best.sort((a, b) => a.total - b.total || b.extras.length - a.extras.length); if (best.length > topK) best.pop();
      return;
    }
    const i = uncovered[0];
    const opts = optionsFor(i, entries, uncovered, ctx).sort((a, b) => a.base / a.covers.length - b.base / b.covers.length);
    for (const o of opts) dfs(uncovered.filter((j) => !o.covers.includes(j)), [...chosen, o], lbSum + minPrice(o, ctx.pricing));
  };
  dfs(entries.map((e, i) => i).filter((i) => entries[i].buyable), [], 0);
  return { entries, solutions: best, skipped, truncated: nodes > maxNodes };
}

/**
 * Best orders under a budget. objective: 'count' (most wishlist items) or 'value' (most retail value).
 * `exclude` = entry indexes to leave out. Returns up to topK distinct item sets.
 */
export function withinBudget(wishlist, ctx, budget, { objective = 'count', exclude = [], topK = 6, maxNodes = 400000 } = {}) {
  const entries = prepareEntries(wishlist, ctx);
  const pool = entries.map((e, i) => i).filter((i) => entries[i].buyable && !exclude.includes(i));
  const score = (sol) => (objective === 'value' ? sol.retail : sol.covered.length);
  const bestBySet = new Map(); let nodes = 0;
  const kth = () => {
    const arr = [...bestBySet.values()].sort((a, b) => score(b) - score(a) || a.total - b.total);
    return arr.length < topK ? -1 : score(arr[topK - 1]);
  };
  const remainingScore = (rest) => (objective === 'value' ? rest.reduce((s, j) => s + entries[j].retail, 0) : rest.length);

  const dfs = (rest, chosen, coveredScore) => {
    if (++nodes > maxNodes) return;
    if (chosen.length) {
      const sol = describe(chosen, entries, ctx);
      if (sol.total > budget) {
        // Over budget: only keep going if a bigger cart could reach a cheaper tier (handled by trying more items).
        const maxPct = Math.max(0, ...ctx.pricing.tiers.map((t) => t.percentOff)) / 100;
        if (sol.subtotal * (1 - maxPct) > budget) return;
      } else {
        const key = sol.covered.join(',');
        const prev = bestBySet.get(key);
        if (!prev || sol.total < prev.total) bestBySet.set(key, sol);
      }
    }
    if (!rest.length) return;
    if (coveredScore + remainingScore(rest) < kth()) return;
    const [i, ...tail] = rest;
    // cover entry i with some option...
    for (const o of optionsFor(i, entries, rest, ctx)) {
      const nextRest = tail.filter((j) => !o.covers.includes(j));
      const gained = objective === 'value' ? o.covers.reduce((s, j) => s + entries[j].retail, 0) : o.covers.length;
      dfs(nextRest, [...chosen, o], coveredScore + gained);
    }
    // ...or skip it
    dfs(tail, chosen, coveredScore);
  };
  dfs(pool, [], 0);
  const solutions = [...bestBySet.values()].sort((a, b) => score(b) - score(a) || a.total - b.total).slice(0, topK);
  return { entries, solutions, truncated: nodes > maxNodes };
}

/**
 * "Add one more thing" ideas: single items that push the cart into a better tier or unlock the gift,
 * ranked by what they really add to the bill (can be negative).
 */
export function tierBoosts(solution, ctx, { limit = 6, candidates = null } = {}) {
  if (!solution || (!solution.nextTier && !solution.giftNeeded)) return [];
  const lines = solution.chosen.map((o) => ({ handle: o.handle, variantId: o.variantId, base: o.base, tags: o.tags }));
  const out = [];
  for (const p of Object.values(ctx.products)) {
    if (!ctx.buyable(p) || p.bundle) continue;
    if (candidates && !candidates.has(p.handle)) continue;
    const vs = ctx.liveVariants(p).filter((v) => !isOwned(ctx.owned, p.handle, v.color || v.title));
    if (!vs.length) continue;
    const v = vs.sort((a, b) => a.price - b.price)[0];
    const r = priceCart([...lines, { handle: p.handle, variantId: String(v.id), base: v.price, tags: p.tags || [] }], ctx.pricing);
    const reachesTier = r.tier && (!solution.tier || r.tier.threshold > solution.tier.threshold);
    const reachesGift = r.gift && !solution.gift;
    if (!reachesTier && !reachesGift) continue;
    out.push({ handle: p.handle, title: p.title, color: v.color || v.title, price: v.price, addsToBill: round(r.total - solution.total), newTotal: r.total, tier: r.tier, gift: r.gift });
  }
  return out.sort((a, b) => a.addsToBill - b.addsToBill).slice(0, limit);
}
