import { makeContext, priceCart, cheapest, withinBudget, tierBoosts } from './optimizer.js';

// ---------- state (saved in this browser, optionally synced through a private GitHub gist) ----------
const LS = 'caraway-state', TOKEN = 'caraway-token', GIST = 'caraway-gist', FILE = 'caraway-tracker-state.json';
const DEFAULTS = { owned: {}, wishlist: [], exclude: {}, coupons: [], budget: 500, objective: 'count', group: 'control', updatedAt: 0 };
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
let state = { ...DEFAULTS, ...(JSON.parse(safeGet(LS) || 'null') || {}) };
const ui = { q: '', coll: '', sort: 'name', kind: 'all', onSale: false, showGone: false, ownedOnly: false, hideOwned: false, mode: 'cheapest', color: {} };

function save(rerender = true) {
  state.updatedAt = Date.now();
  safeSet(LS, JSON.stringify(state));
  refreshNav();
  scheduleSync();
  if (rerender) render();
}

// ---------- data ----------
let D = null; // { products, history, promos, bundles, meta }
let ctx = null;
async function loadJSON(name, fallback) {
  try { const r = await fetch(`data/${name}?v=${Math.floor(Date.now() / 600000)}`); return r.ok ? await r.json() : fallback; } catch { return fallback; }
}
async function loadData() {
  const [catalog, history, promos, bundles, meta, coupons] = await Promise.all([
    loadJSON('products.json', { products: {} }), loadJSON('price-history.json', {}), loadJSON('promos.json', { log: [] }),
    loadJSON('bundles.json', { bundles: {} }), loadJSON('meta.json', {}), loadJSON('coupons.json', { coupons: [] }),
  ]);
  D = { catalog, products: catalog.products || {}, history, promos, bundles, meta, coupons: coupons.coupons || [] };
  rebuildContext();
}
function rebuildContext() { ctx = makeContext(D.catalog, D.bundles, D.promos, { group: state.group, owned: state.owned }); }

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (x) => (x == null ? '—' : '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: x % 1 ? 2 : 0, maximumFractionDigits: 2 }));
const lc = (s) => String(s || '').trim().toLowerCase();
const img = (u, w = 500) => (u ? u + (u.includes('?') ? '&' : '?') + 'width=' + w : '');
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const fmtDate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const SWATCH = { cream: '#EDE4D3', navy: '#26324D', sage: '#A6B49D', gray: '#8D9294', grey: '#8D9294', perracotta: '#C8714E', marigold: '#E4A63A', black: '#1E1E1E', white: '#F7F6F2', mist: '#C9D3D6', charcoal: '#3B3D3F', blush: '#E8C3B9', emerald: '#2F6B4F', slate: '#5C6670', chrome: '#C9CCCF', gold: '#C9A55A', copper: '#B87333', stainless: '#B9BCBF', natural: '#D9C3A0' };
const swatch = (c) => SWATCH[lc(c).split(/[\s/]+/)[0]] || `hsl(${[...lc(c)].reduce((h, ch) => h + ch.charCodeAt(0) * 7, 0) % 360} 25% 55%)`;
const ownKey = (h, c) => `${h}|${lc(c)}`;
const isOwned = (h, c) => !!state.owned[ownKey(h, c)];
const liveVariants = (p) => (p.variants || []).filter((v) => v.live !== false);
const ownedColors = (p) => (p.variants || []).filter((v) => isOwned(p.handle, v.color || v.title)).map((v) => v.color || v.title);
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 1800); }

function alonePrice(p, v) {
  if (!v || v.price == null || p.discontinued) return null;
  return priceCart([{ handle: p.handle, variantId: String(v.id), base: v.price, tags: p.tags || [] }], ctx.pricing).total;
}
function productSummary(p) {
  const vs = liveVariants(p).filter((v) => v.price != null);
  const pool = vs.length ? vs : (p.variants || []).filter((v) => v.price != null);
  const cheapestV = [...pool].sort((a, b) => a.price - b.price)[0];
  const base = cheapestV ? cheapestV.price : null;
  const compareAt = cheapestV ? cheapestV.compareAt : null;
  const sale = cheapestV ? alonePrice(p, cheapestV) : null;
  let low = null, lowDate = null;
  for (const v of p.variants || []) for (const r of (D.history[v.id] || {}).runs || []) if (low == null || r.price < low) { low = r.price; lowDate = r.from; }
  const ref = Math.max(compareAt || 0, base || 0);
  const best = sale ?? base;
  return { base, compareAt, sale, low, lowDate, off: ref && best != null ? Math.round((1 - best / ref) * 100) : 0, inStock: vs.some((v) => v.available !== false) };
}
function bundlesContaining(handle) {
  return Object.values(D.bundles.bundles || {}).filter((b) => b.items.some((i) => i.handle === handle || (i.variants || []).some((v) => v.handle === handle)));
}

// ---------- navigation ----------
function refreshNav() {
  const n = Object.keys(state.owned).length, w = state.wishlist.length;
  $('#nOwned').textContent = n ? n : '';
  $('#nWish').textContent = w ? w : '';
}
function route() { return (location.hash.replace(/^#\/?/, '') || '').split('/'); }
function render() {
  const [page, arg] = route();
  const cur = page === 'p' ? 'catalog' : page || 'catalog';
  document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === cur ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const app = $('#app');
  if (!D) return;
  if (!Object.keys(D.products).length && page !== 'settings') { app.innerHTML = `<h1>No data yet</h1><p class="sub">The first scrape hasn't run. Open the repo's Actions tab, choose "Scrape Caraway", and click "Run workflow".</p>`; return; }
  const views = { '': viewCatalog, catalog: viewCatalog, p: viewProduct, sales: viewSales, kitchen: viewKitchen, wishlist: viewWishlist, settings: viewSettings };
  (views[page] || viewCatalog)(app, arg && decodeURIComponent(arg));
  const m = D.meta.lastRun;
  $('#updated').textContent = m ? `Last scrape: ${fmtDate(m.date)} (${m.products} products).` : '';
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ---------- catalog ----------
function saleBanner() {
  const cur = D.promos.current || {};
  const parts = [];
  if (cur.holidayEnabled && ctx.pricing.tiers.length) parts.push('<b>Sale now:</b> ' + ctx.pricing.tiers.map((t) => `${t.percentOff}% off at ${money(t.threshold)}`).join(' · '));
  if (ctx.pricing.gift) parts.push(`free ${esc((ctx.pricing.gift.title || '').replace(/ - GWP$/, ''))} at ${money(ctx.pricing.gift.threshold)} before discounts`);
  if (ctx.pricing.freeShippingAt) parts.push(`free shipping ${money(ctx.pricing.freeShippingAt)}+`);
  return parts.length ? `<div class="banner">${parts.join('<span class="muted">·</span>')} <a href="#/sales">details</a></div>` : '';
}
function viewCatalog(app) {
  const all = Object.values(D.products).filter((p) => !p.isGiftCard);
  const colls = [...new Set(all.flatMap((p) => p.collections || []))].sort();
  app.innerHTML = `
    <p class="prompt">$ caraway --all</p><h1>Every product and bundle</h1>
    <p class="sub">${all.filter((p) => !p.discontinued).length} on sale now · ${all.filter((p) => p.discontinued).length} discontinued · prices per color, history since tracking began</p>
    ${saleBanner()}
    <div class="filters">
      <div class="fld"><label for="q">Search</label><input class="f" id="q" placeholder="fry pan, sage, bundle…" value="${esc(ui.q)}"></div>
      <div class="fld"><label for="coll">Category</label><select id="coll"><option value="">All</option>${colls.map((c) => `<option ${c === ui.coll ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="fld"><label for="kind">Type</label><select id="kind">${[['all', 'Products and bundles'], ['single', 'Single items'], ['bundle', 'Bundles and sets']].map(([v, l]) => `<option value="${v}" ${v === ui.kind ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="fld"><label for="sort">Sort</label><select id="sort">${[['name', 'Name'], ['price', 'Price, low to high'], ['-price', 'Price, high to low'], ['off', 'Biggest discount'], ['low', 'Closest to lowest ever'], ['new', 'Newest']].map(([v, l]) => `<option value="${v}" ${v === ui.sort ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="chips">
      ${[['onSale', 'On sale'], ['ownedOnly', 'Owned'], ['hideOwned', 'Hide owned'], ['showGone', 'Include discontinued']].map(([k, l]) => `<button class="chip" data-k="${k}" aria-pressed="${!!ui[k]}">${l}</button>`).join('')}
    </div>
    <p class="count" id="count"></p><div class="grid" id="grid"></div>`;
  const draw = () => {
    const q = lc(ui.q);
    let list = all.filter((p) => (ui.showGone || !p.discontinued)
      && (!ui.coll || (p.collections || []).includes(ui.coll))
      && (ui.kind === 'all' || (ui.kind === 'bundle') === !!p.bundle)
      && (!q || lc(p.title + ' ' + (p.productType || '') + ' ' + (p.variants || []).map((v) => v.color || v.title).join(' ') + ' ' + p.handle).includes(q)));
    const S = new Map(list.map((p) => [p.handle, productSummary(p)]));
    if (ui.onSale) list = list.filter((p) => S.get(p.handle).off > 0);
    if (ui.ownedOnly) list = list.filter((p) => ownedColors(p).length);
    if (ui.hideOwned) list = list.filter((p) => !ownedColors(p).length);
    const price = (p) => S.get(p.handle).sale ?? S.get(p.handle).base ?? 1e9;
    const sorters = {
      name: (a, b) => a.title.localeCompare(b.title), price: (a, b) => price(a) - price(b), '-price': (a, b) => price(b) - price(a),
      off: (a, b) => S.get(b.handle).off - S.get(a.handle).off,
      low: (a, b) => (price(a) / (S.get(a.handle).low || 1)) - (price(b) / (S.get(b.handle).low || 1)),
      new: (a, b) => String(b.publishedAt || b.firstSeen).localeCompare(String(a.publishedAt || a.firstSeen)),
    };
    list.sort((a, b) => (a.discontinued - b.discontinued) || sorters[ui.sort](a, b));
    $('#count').textContent = `${list.length} shown`;
    $('#grid').innerHTML = list.map((p) => card(p, S.get(p.handle))).join('') || '<p class="empty">Nothing matches.</p>';
  };
  $('#q').oninput = (e) => { ui.q = e.target.value; draw(); };
  for (const id of ['coll', 'kind', 'sort']) $('#' + id).onchange = (e) => { ui[id] = e.target.value; draw(); };
  app.querySelectorAll('.chip').forEach((b) => (b.onclick = () => { ui[b.dataset.k] = !ui[b.dataset.k]; b.setAttribute('aria-pressed', ui[b.dataset.k]); draw(); }));
  draw();
}
function card(p, s) {
  const owned = ownedColors(p);
  const colors = [...new Map((p.variants || []).map((v) => [lc(v.color || v.title), v.color || v.title])).values()];
  const flags = [p.discontinued ? '<span class="badge b-red">Discontinued</span>' : '', p.bundle ? '<span class="badge b-line">Bundle</span>' : '',
    s.off >= 5 ? `<span class="badge b-gold">${s.off}% off</span>` : '', owned.length ? '<span class="badge b-green">Owned</span>' : '', !p.discontinued && !s.inStock ? '<span class="badge b-line">Sold out</span>' : ''].join('');
  const atLow = s.low != null && (s.sale ?? s.base) <= s.low;
  return `<div class="tile">
    <div class="flags">${flags}</div>
    <a class="cover" href="#/p/${encodeURIComponent(p.handle)}">${p.image ? `<img loading="lazy" src="${esc(img(p.image, 480))}" alt="">` : ''}</a>
    <div class="tb">
      <span class="tk">${esc(p.productType || (p.bundle ? 'Bundle' : ''))}</span>
      <a class="tn" href="#/p/${encodeURIComponent(p.handle)}">${esc(p.title)}</a>
      ${colors.length > 1 || colors[0] && colors[0] !== 'Default Title' ? `<div class="dots" title="${esc(colors.join(', '))}">${colors.slice(0, 12).map((c) => `<i style="background:${swatch(c)}" class="${isOwned(p.handle, c) ? 'own' : ''}" title="${esc(c)}${isOwned(p.handle, c) ? ' (owned)' : ''}"></i>`).join('')}</div>` : ''}
      <div class="tp">
        ${s.sale != null && s.sale < s.base ? `<b>${money(s.sale)}</b><span class="strike">${money(s.base)}</span>` : `<b>${money(s.base)}</b>`}
        ${s.compareAt && s.compareAt > s.base ? `<span class="strike small">${money(s.compareAt)}</span>` : ''}
      </div>
      <span class="small ${atLow ? 'gold' : 'muted'}">${s.low != null ? (atLow ? 'At its lowest tracked price' : `Lowest: ${money(s.low)} (${fmtDate(s.lowDate)})`) : ''}</span>
    </div></div>`;
}

// ---------- product ----------
function viewProduct(app, handle) {
  const p = D.products[handle];
  if (!p) { app.innerHTML = `<p class="empty">Unknown product. <a href="#/">Back to catalog</a></p>`; return; }
  const s = productSummary(p);
  const variants = (p.variants || []).filter((v) => v.price != null).sort((a, b) => (b.live !== false) - (a.live !== false));
  const inBundles = bundlesContaining(handle);
  const bundle = D.bundles.bundles && D.bundles.bundles[handle];
  app.innerHTML = `
    <p class="prompt">$ caraway show ${esc(handle)}</p>
    <div class="detail">
      <div><div class="pic">${p.image ? `<img src="${esc(img(p.image, 900))}" alt="">` : ''}</div></div>
      <div>
        <div class="row">${p.discontinued ? `<span class="badge b-red">Discontinued${p.discontinuedOn ? ' ' + fmtDate(p.discontinuedOn) : ''}</span>` : ''}${p.bundle ? '<span class="badge b-line">Bundle</span>' : ''}${(p.badges || []).map((b) => `<span class="badge b-line">${esc(b)}</span>`).join('')}</div>
        <h1 style="margin-top:8px">${esc(p.title)}</h1>
        <p class="sub">${esc(p.byline || p.productType || '')}${p.rating ? ` · ★ ${p.rating} (${Number(p.reviews || 0).toLocaleString()} reviews)` : ''}</p>
        <div class="kv">
          <div><span>Price</span><b>${money(s.base)}</b>${s.compareAt > s.base ? ` <span class="strike small">${money(s.compareAt)}</span>` : ''}</div>
          <div><span>With today's sale, alone</span><b class="${s.sale < s.base ? 'gold' : ''}">${money(s.sale)}</b></div>
          <div><span>Lowest tracked</span><b>${money(s.low)}</b> <span class="small muted">${s.lowDate ? fmtDate(s.lowDate) : ''}</span></div>
          <div><span>Tracked since</span><b>${fmtDate(p.archiveFirstSeen || p.firstSeen)}</b></div>
        </div>
        <div class="row">
          <a class="btn primary" href="${esc(p.url)}" target="_blank" rel="noopener">Open on Caraway ↗</a>
          ${p.archiveUrl || p.discontinued ? `<a class="btn" href="${esc(p.archiveUrl || 'https://web.archive.org/web/*/' + p.url)}" target="_blank" rel="noopener">Internet Archive ↗</a>` : ''}
          <button class="btn" data-wish="*">+ Wishlist (any color)</button>
        </div>
        <h3 class="sec" style="margin-top:22px">Colors</h3>
        <div class="colors">${variants.map((v) => {
          const c = v.color || v.title;
          const alone = alonePrice(p, v);
          return `<div class="crow">
            <span><i style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${swatch(c)};vertical-align:-1px;margin-right:8px"></i>${esc(c)}
              <span class="small muted">${v.live === false ? (v.archived ? ' · old color' : ' · no longer sold') : v.available === false ? ' · sold out' : ''}${v.sku ? ' · ' + esc(v.sku) : ''}</span></span>
            <span class="small">${money(v.price)}${v.compareAt > v.price ? ` <span class="strike">${money(v.compareAt)}</span>` : ''}${alone != null && alone < v.price ? ` <span class="gold">→ ${money(alone)}</span>` : ''}</span>
            <button class="btn sm ${isOwned(handle, c) ? 'on' : ''}" data-own="${esc(c)}">${isOwned(handle, c) ? '✓ Owned' : 'I own this'}</button>
            <button class="btn sm" data-wish="${esc(c)}">+ Wishlist</button>
          </div>`;
        }).join('')}</div>
      </div>
    </div>
    ${bundle ? bundleTable(bundle, s) : ''}
    <section class="sec"><h2>Price history</h2><div id="hist"></div></section>
    ${inBundles.length ? `<section class="sec"><h2>Bundles that include it</h2><div class="tablewrap"><table><tr><th>Bundle</th><th class="num">Price</th><th class="num">Parts value</th><th></th></tr>${inBundles.map((b) => { const bp = D.products[b.handle]; const bs = bp ? productSummary(bp) : {}; return `<tr><td><a href="#/p/${encodeURIComponent(b.handle)}">${esc(b.title)}</a></td><td class="num">${money(bs.base)}</td><td class="num">${money(b.componentValue)}</td><td class="small muted">${bp && bp.discontinued ? 'discontinued' : ''}</td></tr>`; }).join('')}</table></div></section>` : ''}`;
  app.querySelectorAll('[data-own]').forEach((b) => (b.onclick = () => { const k = ownKey(handle, b.dataset.own); if (state.owned[k]) delete state.owned[k]; else state.owned[k] = { at: new Date().toISOString().slice(0, 10) }; rebuildContext(); save(); }));
  app.querySelectorAll('[data-wish]').forEach((b) => (b.onclick = () => addWish(handle, b.dataset.wish === '*' ? null : b.dataset.wish)));
  drawHistory($('#hist'), p);
}
function bundleTable(b, s) {
  const rows = b.items.map((i) => `<tr><td>${i.handle ? `<a href="#/p/${encodeURIComponent(i.handle)}">${esc(i.name)}</a>` : esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${money(i.unitPrice)}</td><td class="num">${i.unitPrice != null ? money(i.unitPrice * i.qty) : '—'}</td></tr>`).join('');
  const save1 = b.componentValue && s.base ? b.componentValue - s.base : null;
  return `<section class="sec"><h2>What's included</h2><p class="sub">Parts bought separately: ${money(b.componentValue)} · bundle price ${money(s.base)}${save1 > 0 ? ` · <span class="gold">saves ${money(save1)} before sales</span>` : ''}</p>
    <div class="tablewrap"><table><tr><th>Item</th><th class="num">Qty</th><th class="num">Each</th><th class="num">Total</th></tr>${rows}</table></div></section>`;
}
const SERIES_COLORS = ['#7CF29A', '#FFD635', '#6FC3FF', '#FF8A65', '#C792EA', '#B0BEC5'];
function drawHistory(el, p) {
  const groups = new Map();
  for (const v of p.variants || []) {
    const h = D.history[v.id];
    if (!h || !h.runs.length) continue;
    const sig = JSON.stringify(h.runs.map((r) => [r.price, r.compareAt, r.from, r.to]));
    if (!groups.has(sig)) groups.set(sig, { colors: [], runs: h.runs, id: v.id });
    groups.get(sig).colors.push(v.color || v.title);
  }
  const series = [...groups.values()].sort((a, b) => b.colors.length - a.colors.length).slice(0, 6);
  if (!series.length) { el.innerHTML = '<p class="muted">No history yet.</p>'; return; }
  const all = series.flatMap((s) => s.runs);
  const today = new Date().toISOString().slice(0, 10);
  const t0 = Date.parse(all.reduce((m, r) => (r.from < m ? r.from : m), today));
  const t1 = Math.max(Date.parse(today), t0 + 86400000 * 7);
  const prices = all.flatMap((r) => [r.price, r.compareAt].filter((x) => x != null));
  let lo = Math.min(...prices), hi = Math.max(...prices);
  if (lo === hi) { lo *= 0.8; hi *= 1.1; }
  const pad = (hi - lo) * 0.12; lo = Math.max(0, lo - pad); hi += pad;
  const W = 760, H = 230, L = 52, R = 12, T = 12, B = 26;
  const x = (d) => L + ((Date.parse(d) - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const next = (d) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
  const end = (r) => (next(r.to) > today ? today : next(r.to));
  // Solid steps where we watched the price daily; dotted where we only have archive snapshots with gaps between.
  const path = (runs, key) => {
    let d = '';
    runs.forEach((r, i) => {
      if (r[key] == null) return;
      const prev = runs[i - 1];
      const joined = prev && prev[key] != null && end(prev) >= r.from;
      d += (joined ? `V${y(r[key]).toFixed(1)}` : `M${x(r.from).toFixed(1)},${y(r[key]).toFixed(1)}`) + `H${x(end(r)).toFixed(1)}`;
    });
    return d;
  };
  const gaps = (runs, key) => {
    let d = '';
    runs.forEach((r, i) => {
      const prev = runs[i - 1];
      if (prev && prev[key] != null && r[key] != null && end(prev) < r.from) d += `M${x(end(prev)).toFixed(1)},${y(prev[key]).toFixed(1)}H${x(r.from).toFixed(1)}V${y(r[key]).toFixed(1)}`;
    });
    return d;
  };
  const ticks = 4, yt = Array.from({ length: ticks + 1 }, (_, i) => lo + ((hi - lo) * i) / ticks);
  const xt = Array.from({ length: 5 }, (_, i) => new Date(t0 + ((t1 - t0) * i) / 4).toISOString().slice(0, 10));
  el.innerHTML = `
    <div class="legend">${series.map((s, i) => `<span><i style="background:${SERIES_COLORS[i]}"></i>${esc(s.colors.join(', '))}</span>`).join('')}<span><i style="background:var(--line2)"></i>compare-at</span></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history">
      ${yt.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#1B2A1E"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">$${Math.round(v)}</text>`).join('')}
      ${xt.map((d, i) => `<text x="${x(d)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit', ...(t1 - t0 < 1e10 ? { day: 'numeric' } : {}) })}</text>`).join('')}
      ${series.map((s) => `<path d="${path(s.runs, 'compareAt')}" fill="none" stroke="#2A4430" stroke-width="1.5" stroke-dasharray="4 3"/>`).join('')}
      ${series.map((s, i) => `<path d="${gaps(s.runs, 'price')}" fill="none" stroke="${SERIES_COLORS[i]}" stroke-width="1.5" stroke-dasharray="2 4" opacity=".7"/>`).join('')}
      ${series.map((s, i) => `<path d="${path(s.runs, 'price')}" fill="none" stroke="${SERIES_COLORS[i]}" stroke-width="2.2"/>`).join('')}
      ${series.map((s, i) => s.runs.map((r) => `<circle cx="${x(r.from)}" cy="${y(r.price)}" r="2.6" fill="${SERIES_COLORS[i]}"><title>${esc(s.colors[0])}: ${money(r.price)} from ${r.from} to ${r.to}</title></circle>`).join('')).join('')}
    </svg>
    <div class="row" style="margin-top:10px"><label class="small muted" for="hsel">Price list for</label>
      <select id="hsel" style="max-width:320px">${series.map((s, i) => `<option value="${i}">${esc(s.colors.join(', '))}</option>`).join('')}</select></div>
    <div class="tablewrap" id="htab"></div>`;
  const table = (i) => {
    const runs = [...series[i].runs].reverse();
    $('#htab').innerHTML = `<table><tr><th>Price</th><th>Compare-at</th><th>From</th><th>To</th><th class="num">Days at price</th><th>Source</th></tr>${runs.map((r) => `<tr><td>${money(r.price)}</td><td>${r.compareAt ? money(r.compareAt) : '—'}</td><td>${fmtDate(r.from)}</td><td>${r.to === D.meta.lastRun?.date && r.source !== 'wayback' ? 'still' : fmtDate(r.to)}</td><td class="num">${r.source === 'wayback' && r.from === r.to ? '1 snapshot' : days(r.from, r.to)}</td><td class="small muted">${r.source === 'wayback' ? 'Internet Archive' : 'daily scrape'}</td></tr>`).join('')}</table>
      <p class="small muted">Archive prices come from occasional snapshots, so their start and end dates are approximate.</p>`;
  };
  $('#hsel').onchange = (e) => table(+e.target.value);
  table(0);
}

// ---------- sales ----------
function viewSales(app) {
  const cur = D.promos.current || {};
  const tp = cur.tierPricing;
  const title = (h) => (D.products[h] ? `<a href="#/p/${encodeURIComponent(h)}">${esc(D.products[h].title)}</a>` : esc(h));
  const groups = (cur.progressBars || []).filter((b) => b.enabled);
  const log = (D.promos.log || []);
  app.innerHTML = `
    <p class="prompt">$ caraway sales</p><h1>Sales, tiers and free gifts</h1>
    <p class="sub">What's running now, and every offer seen since tracking began.</p>
    <section class="sec"><h2>Right now</h2>
      ${cur.holidayEnabled && tp && tp.tiers.length ? `
      <div class="tablewrap"><table><tr><th>Cart before discounts</th><th>You get</th><th>Items with a special price at this level</th></tr>
      ${tp.tiers.map((t) => `<tr><td>${money(t.threshold)}+</td><td class="gold">${t.percentOff}% off everything</td><td class="small">${Object.entries(t.prices).map(([h, m]) => `${title(h)} ${money(Math.min(...Object.values(m)))}`).join(' · ') || '—'}</td></tr>`).join('')}
      </table></div>` : '<p class="muted">No spend tiers running.</p>'}
      ${groups.map((b) => b.tiers.filter((t) => t.giftHandle).map((t) => `<p>🎁 <b class="gold">Free ${esc((t.giftTitle || t.giftHandle).replace(/ - GWP$/, ''))}</b> when the cart reaches ${money(t.amount)} before discounts${b.featureFlag && b.featureFlag.variant !== 'control' ? ` <span class="muted small">(only for shoppers in Caraway's "${esc(b.featureFlag.variant)}" test group)</span>` : ''}.</p>`).join('')).join('')}
      ${tp && tp.segments && Object.keys(tp.segments).length ? `<p class="small muted">Caraway is also testing other offers on some shoppers: ${Object.entries(tp.segments).map(([k, s]) => `"${esc(k)}" = ${s.percentOff}% off from the first dollar`).join('; ')}. Pick your group on the Wishlist page if your cart shows that.</p>` : ''}
      ${cur.freeShipping && cur.freeShipping.enabled ? `<p>Free shipping on orders ${money(cur.freeShipping.threshold)}+.</p>` : ''}
      ${(cur.promoText || []).length ? `<div class="panel small">${cur.promoText.map((t) => `<div>${esc(t)}</div>`).join('')}</div>` : ''}
    </section>
    <section class="sec"><h2>Coupon codes</h2>
      <p class="sub">Caraway doesn't post codes on the site, so add the ones you get by email here. They're saved with your synced data.</p>
      <div class="tablewrap"><table><tr><th>Code</th><th>Deal</th><th>From</th><th>To</th><th></th></tr>
      ${[...D.coupons.map((c) => ({ ...c, repo: true })), ...state.coupons].sort((a, b) => String(b.from).localeCompare(String(a.from))).map((c, i) => `<tr><td><b>${esc(c.code)}</b></td><td>${esc(c.deal || c.description || '')}</td><td>${fmtDate(c.from)}</td><td>${c.to ? fmtDate(c.to) : '—'}</td><td>${c.repo ? '' : `<button class="btn sm" data-delc="${esc(c.id)}">Remove</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}
      </table></div>
      <form id="cform" class="row" style="margin-top:10px">
        <input class="f" name="code" placeholder="CODE" required style="max-width:150px">
        <input class="f" name="deal" placeholder="e.g. 15% off $200+, new subscribers" style="max-width:340px">
        <input class="f" type="date" name="from" style="max-width:170px" value="${new Date().toISOString().slice(0, 10)}">
        <input class="f" type="date" name="to" style="max-width:170px">
        <button class="btn">Add code</button>
      </form>
    </section>
    <section class="sec"><h2>Offer history</h2>
      <div class="tablewrap"><table><tr><th>Offer</th><th>Kind</th><th>First seen</th><th>Last seen</th><th class="num">Days</th></tr>
      ${log.map((e) => `<tr><td>${e.kind === 'tier-price' ? title(e.detail.handle) + ` drops to ${money(Math.min(...e.detail.prices))} at ${money(e.detail.threshold)}` : esc(e.title)}</td><td class="small muted">${esc(e.kind)}</td><td>${fmtDate(e.firstSeen)}</td><td>${e.lastSeen === D.promos.updatedAt ? '<span class="green">running</span>' : fmtDate(e.lastSeen)}</td><td class="num">${days(e.firstSeen, e.lastSeen)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing logged yet.</td></tr>'}
      </table></div>
    </section>`;
  $('#cform').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    state.coupons.push({ id: Math.random().toString(36).slice(2), code: f.get('code').trim().toUpperCase(), deal: f.get('deal').trim(), from: f.get('from'), to: f.get('to') || null });
    save();
  };
  app.querySelectorAll('[data-delc]').forEach((b) => (b.onclick = () => { state.coupons = state.coupons.filter((c) => c.id !== b.dataset.delc); save(); }));
}

// ---------- picker (search a product, then a color) ----------
function picker(el, onPick, { anyColor = true, label = 'Add' } = {}) {
  el.innerHTML = `<div class="row"><div class="picker" style="flex:1;min-width:220px"><input class="f" placeholder="Search products…" autocomplete="off"><div class="list" hidden></div></div>
    <select style="max-width:200px" disabled><option>Color</option></select><button class="btn primary" disabled>${label}</button></div>`;
  const [input, list, sel, btn] = [$('input', el), $('.list', el), $('select', el), $('button.btn', el)];
  let chosen = null;
  const all = Object.values(D.products).filter((p) => !p.isGiftCard).sort((a, b) => a.discontinued - b.discontinued || a.title.localeCompare(b.title));
  input.oninput = () => {
    const q = lc(input.value);
    const hits = q ? all.filter((p) => lc(p.title + ' ' + p.handle).includes(q)).slice(0, 30) : [];
    list.hidden = !hits.length;
    list.innerHTML = hits.map((p) => `<button type="button" data-h="${esc(p.handle)}">${esc(p.title)} <span class="small muted">${p.discontinued ? 'discontinued' : money(productSummary(p).base)}</span></button>`).join('');
  };
  list.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    chosen = D.products[b.dataset.h]; input.value = chosen.title; list.hidden = true;
    const colors = [...new Map((chosen.variants || []).map((v) => [lc(v.color || v.title), v.color || v.title])).values()];
    sel.innerHTML = (anyColor && colors.length > 1 ? '<option value="">Any color</option>' : '') + colors.map((c) => `<option>${esc(c)}</option>`).join('');
    sel.disabled = false; btn.disabled = false;
  };
  btn.onclick = () => { if (chosen) { onPick(chosen.handle, sel.value || null); input.value = ''; sel.disabled = btn.disabled = true; chosen = null; } };
}

// ---------- my kitchen ----------
function viewKitchen(app) {
  const rows = Object.keys(state.owned).map((k) => { const [h, c] = k.split('|'); const p = D.products[h]; const v = p && (p.variants || []).find((x) => lc(x.color || x.title) === c); return { k, h, c: v ? v.color || v.title : c, p, v }; })
    .sort((a, b) => String(a.p?.title || a.h).localeCompare(String(b.p?.title || b.h)));
  const value = rows.reduce((s, r) => s + (r.v ? Math.max(r.v.price || 0, r.v.compareAt || 0) : 0), 0);
  app.innerHTML = `<p class="prompt">$ caraway owned</p><h1>My kitchen</h1>
    <p class="sub">${rows.length} items owned, about ${money(value)} at full price. Owned colors are flagged everywhere and left out of suggestions.</p>
    <div class="sec panel"><h3>Add something you own</h3><div id="pick" style="margin-top:10px"></div></div>
    <div class="sec tablewrap"><table><tr><th>Product</th><th>Color</th><th class="num">Price now</th><th></th></tr>
    ${rows.map((r) => `<tr><td>${r.p ? `<a href="#/p/${encodeURIComponent(r.h)}">${esc(r.p.title)}</a>` : esc(r.h)}</td><td><i style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${swatch(r.c)};margin-right:6px"></i>${esc(r.c)}</td><td class="num">${money(r.v && r.v.price)}</td><td><button class="btn sm" data-del="${esc(r.k)}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing marked yet. Open any product and press "I own this" next to a color.</td></tr>'}
    </table></div>`;
  picker($('#pick'), (h, c) => { const p = D.products[h]; const color = c || (p.variants[0] && (p.variants[0].color || p.variants[0].title)); state.owned[ownKey(h, color)] = { at: new Date().toISOString().slice(0, 10) }; rebuildContext(); save(); toast('Marked as owned'); }, { anyColor: false, label: 'I own it' });
  app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { delete state.owned[b.dataset.del]; rebuildContext(); save(); }));
}

// ---------- wishlist + optimizer ----------
function addWish(handle, color) {
  if (color && isOwned(handle, color) && !confirmOwned()) return;
  state.wishlist.push({ id: Math.random().toString(36).slice(2), handle, color: color || null });
  save(false); toast('Added to wishlist');
}
function confirmOwned() { toast('You already own that color; added anyway'); return true; }

function solutionHTML(sol, entries, i, extra = '') {
  const pr = ctx.pricing;
  const line = (o) => {
    const priced = sol.lines.find((l) => l.handle === o.handle && l.variantId === o.variantId);
    return `<tr><td>${o.kind === 'bundle' || D.products[o.handle]?.bundle ? '<span class="badge b-line">Bundle</span> ' : ''}<a href="#/p/${encodeURIComponent(o.handle)}">${esc(o.title)}</a> <span class="small muted">${esc(o.color || '')}</span>
      <div class="small muted">covers: ${o.covers.map((j) => esc(D.products[entries[j].handle]?.title || entries[j].handle)).join(', ')}</div></td>
      <td class="num">${money(o.base)}</td><td class="num">${priced && priced.price < o.base ? `<span class="gold">${money(priced.price)}</span>` : money(priced ? priced.price : o.base)}</td>
      <td><a class="small" href="${esc(o.url || '')}" target="_blank" rel="noopener">buy ↗</a></td></tr>`;
  };
  return `<div class="sol ${i === 0 ? 'best' : ''}">
    <div class="row" style="justify-content:space-between"><div><span class="small muted">${i === 0 ? 'Best option' : 'Option ' + (i + 1)}</span><div class="tot">${money(sol.total)}</div></div>
      <div class="small" style="text-align:right">${sol.tier ? `<span class="gold">${sol.tier.percentOff}% tier</span> on ${money(sol.subtotal)}` : `subtotal ${money(sol.subtotal)}`} · you save ${money(sol.savings)}<br>
      ${sol.gift ? `<span class="green">🎁 free ${esc((sol.gift.title || '').replace(/ - GWP$/, ''))} included</span>` : pr.gift ? `<span class="muted">${money(sol.giftNeeded)} more for the free gift</span>` : ''}
      ${sol.freeShipping === false ? '<br><span class="red">under the free-shipping line, shipping extra</span>' : ''}</div></div>
    ${extra}
    <div class="tablewrap"><table><tr><th>Buy</th><th class="num">Price</th><th class="num">In this cart</th><th></th></tr>${sol.chosen.map(line).join('')}</table></div>
    ${sol.extras.length ? `<p class="small" style="margin:8px 0 0"><b>Also comes with:</b> ${sol.extras.map((e) => `${e.qty > 1 ? e.qty + '× ' : ''}${esc(e.name)}${e.color ? ' (' + esc(e.color) + ')' : ''}${e.owned ? ' <span class="red">already owned</span>' : ''}`).join(', ')}</p>` : ''}
    ${sol.nextTier ? `<p class="small muted" style="margin:6px 0 0">${money(sol.nextTier.needed)} more before discounts reaches ${sol.nextTier.percentOff}% off.</p>` : ''}
  </div>`;
}

function viewWishlist(app) {
  const groups = [['control', 'Normal sale tiers'], ...Object.keys(D.promos.current?.tierPricing?.segments || {}).map((k) => [k, `"${k}" test offer`])];
  app.innerHTML = `<p class="prompt">$ caraway wishlist --optimize</p><h1>Wishlist</h1>
    <p class="sub">Add what you want. It finds the cheapest mix of single items and bundles using today's sale tiers, tier-only prices and the free-gift line, or the most you can get for a budget.</p>
    <div class="sec panel"><h3>Add to wishlist</h3><div id="pick" style="margin-top:10px"></div></div>
    <div class="sec tablewrap"><table><tr><th>Item</th><th>Color</th><th class="num">Price</th><th>Leave out of budget</th><th></th></tr>
      ${state.wishlist.map((w) => { const p = D.products[w.handle]; return `<tr><td>${p ? `<a href="#/p/${encodeURIComponent(w.handle)}">${esc(p.title)}</a>${p.discontinued ? ' <span class="badge b-red">gone</span>' : ''}` : esc(w.handle)}</td><td>${esc(w.color || 'Any')}${w.color && isOwned(w.handle, w.color) ? ' <span class="small red">owned</span>' : ''}</td><td class="num">${p ? money(productSummary(p).base) : '—'}</td>
        <td><input type="checkbox" data-ex="${esc(w.id)}" ${state.exclude[w.id] ? 'checked' : ''} aria-label="Leave out of budget"></td><td><button class="btn sm" data-rm="${esc(w.id)}">Remove</button></td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">Empty. Search above, or use "+ Wishlist" on any product.</td></tr>'}
    </table></div>
    <div class="sec row">
      <div class="tabs"><button class="chip" data-mode="cheapest" aria-pressed="${ui.mode === 'cheapest'}">Cheapest way to get all</button><button class="chip" data-mode="budget" aria-pressed="${ui.mode === 'budget'}">Best for my budget</button></div>
      <label class="small muted" for="grp">Offer</label><select id="grp" style="max-width:220px">${groups.map(([v, l]) => `<option value="${v}" ${v === state.group ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>
    <div id="budgetbar" class="row" ${ui.mode === 'budget' ? '' : 'hidden'}>
      <label class="small muted" for="budget">Budget $</label><input class="f" id="budget" type="number" min="0" step="5" value="${state.budget}" style="max-width:140px">
      <label class="small muted" for="obj">Goal</label><select id="obj" style="max-width:230px"><option value="count" ${state.objective === 'count' ? 'selected' : ''}>Most items</option><option value="value" ${state.objective === 'value' ? 'selected' : ''}>Most value (full price)</option></select>
    </div>
    <div id="results"></div>`;
  picker($('#pick'), (h, c) => addWishAndRender(h, c));
  app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { state.wishlist = state.wishlist.filter((w) => w.id !== b.dataset.rm); delete state.exclude[b.dataset.rm]; save(); }));
  app.querySelectorAll('[data-ex]').forEach((b) => (b.onchange = () => { if (b.checked) state.exclude[b.dataset.ex] = true; else delete state.exclude[b.dataset.ex]; save(false); runOptimizer(); }));
  app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { ui.mode = b.dataset.mode; render(); }));
  $('#grp').onchange = (e) => { state.group = e.target.value; rebuildContext(); save(false); runOptimizer(); };
  const b = $('#budget'); if (b) b.onchange = () => { state.budget = Number(b.value) || 0; save(false); runOptimizer(); };
  const o = $('#obj'); if (o) o.onchange = () => { state.objective = o.value; save(false); runOptimizer(); };
  runOptimizer();
}
function addWishAndRender(h, c) { addWish(h, c); render(); }

function runOptimizer() {
  const el = $('#results'); if (!el) return;
  const wish = state.wishlist.map((w) => ({ handle: w.handle, color: w.color, id: w.id }));
  if (!wish.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="muted">Working…</p>';
  setTimeout(() => {
    const t0 = performance.now();
    if (ui.mode === 'cheapest') {
      const r = cheapest(wish, ctx, { topK: 4 });
      if (!r.solutions.length) { el.innerHTML = '<p class="muted">Nothing on the list can be bought right now.</p>'; return; }
      const best = r.solutions[0];
      const singlesOnly = cheapest(wish, { ...ctx, bundleOptions: [] }, { topK: 1 }).solutions[0];
      const boosts = tierBoosts(best, ctx, { limit: 6 });
      el.innerHTML = `
        ${r.skipped.length ? `<p class="red small">Can't be bought now (discontinued or sold out): ${r.skipped.map((j) => esc(D.products[r.entries[j].handle]?.title || r.entries[j].handle)).join(', ')}</p>` : ''}
        ${singlesOnly && singlesOnly.total > best.total + 0.01 ? `<p class="small">Buying each item on its own would be ${money(singlesOnly.total)}, so this saves <b class="gold">${money(singlesOnly.total - best.total)}</b> more.</p>` : ''}
        ${r.solutions.map((s, i) => solutionHTML(s, r.entries, i)).join('')}
        ${boosts.length ? `<section class="sec"><h3>Add one thing to unlock more savings</h3><p class="sub">Items that push the best cart into a better tier or past the free-gift line, ranked by what they really add to the bill.</p>
          <div class="tablewrap"><table><tr><th>Add</th><th class="num">Price</th><th class="num">Adds to bill</th><th>Unlocks</th></tr>${boosts.map((x) => `<tr><td><a href="#/p/${encodeURIComponent(x.handle)}">${esc(x.title)}</a> <span class="small muted">${esc(x.color)}</span></td><td class="num">${money(x.price)}</td><td class="num ${x.addsToBill <= 0 ? 'green' : ''}">${x.addsToBill <= 0 ? 'free (' + money(-x.addsToBill) + ' cheaper)' : money(x.addsToBill)}</td><td class="small">${x.tier && (!best.tier || x.tier.threshold > best.tier.threshold) ? x.tier.percentOff + '% tier' : ''}${x.gift && !best.gift ? ' 🎁 free gift' : ''}</td></tr>`).join('')}</table></div></section>` : ''}
        <p class="small muted">${r.truncated ? 'List is long, so the search stopped early; results are good but may not be the very best. ' : ''}Checked in ${Math.round(performance.now() - t0)} ms.</p>`;
    } else {
      const exclude = wish.map((w, j) => (state.exclude[w.id] ? j : null)).filter((j) => j != null);
      const r = withinBudget(wish, ctx, state.budget, { objective: state.objective, exclude, topK: 5 });
      if (!r.solutions.length) { el.innerHTML = `<p class="muted">Nothing fits in ${money(state.budget)}.</p>`; return; }
      el.innerHTML = r.solutions.map((s, i) => {
        const got = s.covered.map((j) => esc(D.products[r.entries[j].handle]?.title || r.entries[j].handle));
        const missed = r.entries.map((e, j) => j).filter((j) => !s.covered.includes(j) && !exclude.includes(j)).map((j) => esc(D.products[r.entries[j].handle]?.title || r.entries[j].handle));
        return solutionHTML(s, r.entries, i, `<p class="small" style="margin:6px 0">Gets <b>${s.covered.length}</b> of ${r.entries.length - exclude.length} items (${money(s.retail)} full price) · <span class="green">${money(state.budget - s.total)} left</span><br>
          <span class="muted">${got.join(', ')}${missed.length ? ' · skips: ' + missed.join(', ') : ''}</span></p>`);
      }).join('') + `<p class="small muted">Tick "Leave out of budget" to see what else fits without an item, e.g. two smaller things instead of one big one.${r.truncated ? ' The list is long, so the search stopped early.' : ''}</p>`;
    }
  }, 10);
}

// ---------- settings / sync ----------
function viewSettings(app) {
  const token = safeGet(TOKEN);
  app.innerHTML = `<p class="prompt">$ caraway sync</p><h1>Sync between devices</h1>
    <p class="sub">Your owned items, wishlist and coupon codes are saved in this browser. To share them between your phone and computer, connect a GitHub token. They're stored in a private (secret) gist on your GitHub account, not in the public repo.</p>
    <div class="sec panel">
      ${token ? `<p class="green">Connected. ${esc(syncStatus.msg || '')}</p><div class="row"><button class="btn primary" id="syncnow">Sync now</button><button class="btn" id="disc">Disconnect this device</button></div>` : `
      <ol class="small">
        <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained token on GitHub ↗</a>. Name it "Caraway tracker", set an expiration you like, choose "Public repositories".</li>
        <li>Under <b>Account permissions</b>, set <b>Gists</b> to <b>Read and write</b>. Nothing else is needed. Generate it and copy it.</li>
        <li>Paste it below. Do the same on your other device with the same token.</li>
      </ol>
      <div class="row"><input class="f" id="tok" type="password" placeholder="github_pat_…" style="max-width:420px" autocomplete="off"><button class="btn primary" id="conn">Connect</button></div>
      <p class="small muted">The token stays in this browser only. It can only read and write your gists.</p>`}
    </div>
    <div class="sec panel"><h3>Backup</h3><p class="small muted">Download or restore everything as a file.</p>
      <div class="row"><button class="btn" id="exp">Download backup</button><label class="btn">Restore from file<input type="file" id="imp" accept="application/json" hidden></label></div></div>`;
  const conn = $('#conn'); if (conn) conn.onclick = async () => { const t = $('#tok').value.trim(); if (!t) return; safeSet(TOKEN, t); safeSet(GIST, null); await syncNow(true); render(); };
  const sn = $('#syncnow'); if (sn) sn.onclick = async () => { await syncNow(true); render(); };
  const dc = $('#disc'); if (dc) dc.onclick = () => { safeSet(TOKEN, null); safeSet(GIST, null); syncStatus = { cls: '', msg: '' }; setSyncLink(); render(); };
  $('#exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' })); a.download = 'caraway-tracker-backup.json'; a.click(); };
  $('#imp').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { state = { ...DEFAULTS, ...JSON.parse(await f.text()) }; rebuildContext(); save(); toast('Restored'); } catch { toast('That file could not be read'); } };
}

let syncStatus = { cls: '', msg: '' }; let syncTimer = null; let syncing = false;
function setSyncLink() {
  const a = $('#syncLink');
  a.className = 'sync ' + (safeGet(TOKEN) ? syncStatus.cls || 'on' : '');
  a.textContent = safeGet(TOKEN) ? (syncStatus.cls === 'err' ? 'sync: error' : 'sync: on') : 'sync: off';
}
function scheduleSync() { if (!safeGet(TOKEN)) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(false), 1500); }
async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, { ...opts, headers: { Authorization: 'Bearer ' + safeGet(TOKEN), Accept: 'application/vnd.github+json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!r.ok) throw new Error(r.status === 401 ? 'token rejected' : r.status === 403 || r.status === 404 ? 'token needs Gists read/write' : 'GitHub error ' + r.status);
  return r.json();
}
async function findGist() {
  const cached = safeGet(GIST);
  if (cached) { try { return await gh('/gists/' + cached); } catch {} }
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const g = list.find((x) => x.files && x.files[FILE]);
    if (g) { safeSet(GIST, g.id); return gh('/gists/' + g.id); }
    if (list.length < 100) break;
  }
  const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ public: false, description: 'Caraway tracker: owned items and wishlist', files: { [FILE]: { content: JSON.stringify(state, null, 1) } } }) });
  safeSet(GIST, g.id);
  return g;
}
async function syncNow(loud) {
  if (!safeGet(TOKEN) || syncing) return;
  syncing = true;
  try {
    const g = await findGist();
    let file = g.files[FILE];
    if (file.truncated) file = { content: await (await fetch(file.raw_url)).text() };
    const remote = JSON.parse(file.content || '{}');
    if ((remote.updatedAt || 0) > (state.updatedAt || 0)) {
      state = { ...DEFAULTS, ...remote };
      safeSet(LS, JSON.stringify(state));
      rebuildContext(); refreshNav(); render();
      syncStatus = { cls: 'on', msg: 'Loaded changes from your other device.' };
    } else if ((state.updatedAt || 0) > (remote.updatedAt || 0)) {
      await gh('/gists/' + g.id, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(state, null, 1) } } }) });
      syncStatus = { cls: 'on', msg: 'Saved at ' + new Date().toLocaleTimeString() + '.' };
    } else syncStatus = { cls: 'on', msg: 'Up to date.' };
    if (loud) toast('Synced');
  } catch (e) {
    syncStatus = { cls: 'err', msg: 'Sync failed: ' + e.message };
    if (loud) toast(syncStatus.msg);
  } finally { syncing = false; setSyncLink(); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(false); });

// ---------- start ----------
refreshNav(); setSyncLink();
loadData().then(() => { render(); syncNow(false); });
