// Runs INSIDE the Caraway page (via page.evaluate). Must be self-contained: no imports, no closures.
// Reads the decoded React Router loader data of the storefront and returns small plain objects.

export function extractRootInPage() {
  const ld = window.__reactRouterDataRouter && window.__reactRouterDataRouter.state.loaderData;
  if (!ld || !ld.root) return null;
  const root = ld.root;
  const num = (x) => (x == null || x === '' ? null : Number(x));
  const settings = (((root.siteSettings || {}).data || {}).siteSettings || {}).settings || {};
  const cart = settings.cart || {};
  const hp = root.holidayPricing || null;

  const priceMap = (prices) => {
    // {handle: {variantGid: price}} -> {handle: {variantId: price}}
    const out = {};
    for (const [h, m] of Object.entries(prices || {})) {
      out[h] = {};
      for (const [gid, p] of Object.entries(m || {})) out[h][String(gid).split('/').pop()] = num(p);
    }
    return out;
  };

  const tierPricing = hp ? {
    tiers: (hp.tiers || []).map((t) => ({ threshold: num(t.threshold), percentOff: num(t.percentOff), prices: priceMap(t.prices) })),
    segments: Object.fromEntries(Object.entries(hp.segments || {}).map(([k, s]) => [k, { percentOff: num(s.percentOff), prices: priceMap(s.prices) }])),
    productOverrides: Object.fromEntries(Object.entries(hp.products || {}).map(([k, s]) => [k, { percentOff: num(s.percentOff), prices: priceMap(s.prices) }])),
    excludeTags: hp.excludeTags || [],
  } : null;

  const progressBars = (cart.progressBars || []).map((b) => ({
    name: b.name || '',
    enabled: !!b.enabled,
    featureFlag: b.featureFlag || null,
    completedMessage: b.completedMessage || '',
    progressCalculation: b.progressCalculation || null,
    tiers: (b.tiers || []).map((t) => ({
      title: t.title || '',
      amount: num(t.amount),
      applyCode: t.applyCode || '',
      progressMessage: t.progressMessage || '',
      giftHandle: (t.autoAddProduct && t.autoAddProduct.handle) || null,
      giftTitle: (t.autoAddProduct && t.autoAddProduct.data && t.autoAddProduct.data.title) || null,
    })),
  }));

  // Promo text anywhere in root settings/dialogs (banners, gift dialogs). Keep short, unique strings.
  const strip = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const promoText = new Set();
  const seen = new WeakSet();
  const walk = (o, path, depth) => {
    if (o == null || depth > 14 || promoText.size > 80) return;
    if (typeof o === 'string') {
      if (o.length < 400 && /(\d+% off|free gift|free .{0,30}(oven|pan|set|towel)|sale|limited[- ]time|ends|save up to|bogo|gift with)/i.test(o)
          && /(announcement|banner|promo|dialog|gwp|heading|eyebrow|subheading|message|title|text)/i.test(path)
          && !/progressMessage|rewardMessage/.test(path)) promoText.add(strip(o));
      return;
    }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) walk(o[k], path + '.' + k, depth + 1);
  };
  walk(settings.header, 'header', 0);
  walk(root.globalDialogs, 'dialogs', 0);

  const fs = cart.freeShipping || {};
  return {
    holidayEnabled: !!root.holidayEnabled,
    tierPricing,
    progressBars,
    freeShipping: { enabled: fs.enabled !== false, threshold: num(fs.minCartSpend ?? fs.threshold ?? fs.amount ?? null), raw: JSON.stringify(fs).slice(0, 500) },
    cartDiscounts: JSON.stringify(cart.discounts || null).slice(0, 2000),
    promoText: [...promoText].filter(Boolean).slice(0, 60),
  };
}

export function extractProductInPage() {
  const r = window.__reactRouterDataRouter;
  if (!r) return { error: 'no-router' };
  const errs = r.state.errors;
  const key = Object.keys(r.state.loaderData).find((k) => k.includes('products.$handle'));
  const pd = key && r.state.loaderData[key];
  if (!pd || !pd.product) {
    const e = errs && Object.values(errs)[0];
    return { error: 'not-found', status: (e && (e.status || e.statusCode)) || null };
  }
  const num = (x) => (x == null || x === '' ? null : Number(x));
  const id = (gid) => (gid ? String(gid).split('/').pop() : null);
  const pr = pd.product;
  const badgeNames = (r.state.loaderData.root && r.state.loaderData.root.badgeNamesById) || {};
  const badgeList = (val) => {
    let arr = val;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = [arr]; } }
    if (!Array.isArray(arr)) arr = arr ? [arr] : [];
    return arr.map((g) => { const n = badgeNames[g]; return typeof n === 'string' ? n.split(' | ')[0] : (n && (n.name || n.label || n.title)) || null; }).filter(Boolean);
  };
  const nodes = (x) => (x ? (Array.isArray(x) ? x : x.nodes || []) : []);
  const mf = {};
  for (const m of pr.metafields || []) if (m && m.key) mf[m.key] = m.value;
  const parseJSON = (s) => { try { return JSON.parse(s); } catch { return s; } };
  const rating = pr.reviewsRating && parseJSON(pr.reviewsRating.value);

  const variants = nodes(pr.variants).map((v) => {
    const opts = {};
    for (const o of v.selectedOptions || []) opts[o.name] = o.value;
    return {
      id: id(v.id),
      title: v.title,
      options: opts,
      color: opts.Color || opts.Colour || null,
      sku: v.sku || null,
      price: num(v.price && v.price.amount),
      compareAt: num(v.compareAtPrice && v.compareAtPrice.amount),
      available: !!v.availableForSale,
      availability: v.availability || null,
      discontinued: v.discontinued || null,
      edition: (v.edition && (v.edition.value || v.edition)) || null,
      shippingLabel: v.shippingLabel || null,
      byline: v.variantByline || null,
      image: (v.image && v.image.url) || null,
      badges: badgeList(v.badges),
    };
  });

  const wi = pd.whatsIncluded;
  const components = wi && wi.productItems ? wi.productItems.map((it) => ({
    name: it.name,
    shortName: it.shortName || null,
    qty: num(it.quantity) || 1,
    type: it.type || null,
    match: it.match || null,
    priceOverride: num(it.priceOverride && it.priceOverride.amount),
    variants: (it.productVariants || []).map((pv) => ({
      id: id(pv.id), color: pv.color || null, edition: pv.edition || null, label: pv.label || null,
      price: num(pv.price && pv.price.amount),
    })),
  })) : [];

  return {
    handle: pr.handle,
    title: pr.title,
    productType: pr.productType || null,
    vendor: pr.vendor || null,
    tags: pr.tags || [],
    collections: nodes(pr.collections).map((c) => c.handle),
    publishedAt: pr.publishedAt || null,
    status: pd.productStatus || null,
    isGiftCard: !!pr.isGiftCard,
    image: (pr.featuredImage && pr.featuredImage.url) || null,
    description: (mf.short_desc || pr.description || '').slice(0, 400),
    byline: mf.product_byline || null,
    badges: [...new Set([...badgeList(mf.badges), ...badgeList(mf.product_card_badge)])].filter((b) => !/^[a-z0-9-]+$/.test(b)),
    rating: rating && rating.value ? Number(rating.value) : null,
    reviews: pr.reviewsRatingCount ? Number(pr.reviewsRatingCount.value) : null,
    options: (pr.options || []).map((o) => ({ name: o.name, values: (o.optionValues || []).map((x) => x.name) })),
    variants,
    components,
  };
}
