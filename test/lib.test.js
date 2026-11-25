import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalog, mergePriceHistory, mergePromos, mergeBackfill, buildBundles } from '../scraper/lib.js';

const prod = (price, extra = {}) => ({
  handle: 'fry-pan', title: 'Fry Pan', tags: [], collections: ['cookware', 'internal-x'], components: [],
  variants: [{ id: '1', title: 'Sage', color: 'Sage', price, compareAt: null, available: true }], ...extra,
});

test('price runs record how long each price lasted', () => {
  const h = {};
  mergePriceHistory(h, { 'fry-pan': prod(125) }, '2026-11-01');
  mergePriceHistory(h, { 'fry-pan': prod(125) }, '2026-11-02');
  mergePriceHistory(h, { 'fry-pan': prod(99) }, '2026-11-03');
  mergePriceHistory(h, { 'fry-pan': prod(125) }, '2026-11-04');
  assert.deepEqual(h['1'].runs.map((r) => [r.price, r.from, r.to]), [[125, '2026-11-01', '2026-11-02'], [99, '2026-11-03', '2026-11-03'], [125, '2026-11-04', '2026-11-04']]);
});

test('catalog keeps public collections and marks 404s discontinued without losing data', () => {
  let c = mergeCatalog({ products: {} }, { 'fry-pan': prod(125) }, [], '2026-11-01', ['cookware']);
  assert.deepEqual(c.products['fry-pan'].collections, ['cookware']);
  c = mergeCatalog(c, {}, ['fry-pan'], '2026-11-05', ['cookware']);
  assert.equal(c.products['fry-pan'].discontinued, true);
  assert.equal(c.products['fry-pan'].discontinuedOn, '2026-11-05');
  assert.equal(c.products['fry-pan'].variants[0].price, 125);
  c = mergeCatalog(c, { 'fry-pan': prod(110) }, [], '2026-12-01', ['cookware']);
  assert.equal(c.products['fry-pan'].discontinued, false);
});

test('promo log keeps first/last seen dates', () => {
  const root = { holidayEnabled: true, tierPricing: { tiers: [{ threshold: 85, percentOff: 15, prices: {} }] }, progressBars: [], freeShipping: { enabled: true, threshold: 90 }, promoText: ['Big sale'] };
  let p = mergePromos({}, root, '2026-11-24');
  p = mergePromos(p, root, '2026-11-25');
  const tiers = p.log.find((e) => e.kind === 'tiers');
  assert.equal(tiers.firstSeen, '2026-11-24');
  assert.equal(tiers.lastSeen, '2026-11-25');
  assert.equal(p.log.length, 3);
});

test('archive backfill goes before live runs and adds old discontinued products', () => {
  const h = {};
  const c = mergeCatalog({ products: {} }, { 'fry-pan': prod(125) }, [], '2026-11-25', ['cookware']);
  mergePriceHistory(h, { 'fry-pan': prod(125) }, '2026-11-25');
  const obs = {
    products: { 'fry-pan': { handle: 'fry-pan', title: 'Fry Pan', firstSeen: '2021-03-01', lastSeen: '2025-01-01' },
      'old-kettle': { handle: 'old-kettle', title: 'Kettle', firstSeen: '2022-01-01', lastSeen: '2023-05-01' } },
    variants: { 1: { handle: 'fry-pan', color: 'Sage', seen: [['2021-03-01', 95, null], ['2022-01-01', 95, null], ['2025-01-01', 115, 135]] },
      9: { handle: 'old-kettle', color: 'Navy', seen: [['2022-01-01', 80, null], ['2023-05-01', 60, 80]] } },
  };
  mergeBackfill(c, h, obs);
  mergeBackfill(c, h, obs); // idempotent
  assert.deepEqual(h['1'].runs.map((r) => [r.price, r.from, r.to, r.source || 'live']), [[95, '2021-03-01', '2022-01-01', 'wayback'], [115, '2025-01-01', '2025-01-01', 'wayback'], [125, '2026-11-25', '2026-11-25', 'live']]);
  assert.equal(c.products['old-kettle'].discontinued, true);
  assert.equal(c.products['old-kettle'].variants[0].price, 60);
  assert.equal(c.products['fry-pan'].archiveFirstSeen, '2021-03-01');
});

test('bundles map components to standalone products', () => {
  const products = {
    'fry-pan': { ...prod(125), variants: [{ id: '1', color: 'Sage', price: 125 }] },
    set: { handle: 'set', title: 'Set', bundle: true, variants: [{ id: '50', color: 'Sage', price: 300 }],
      components: [{ name: 'Fry Pan', qty: 2, variants: [{ id: '1', color: 'sage', price: 125 }] }, { name: 'Organizer', qty: 1, priceOverride: 50, variants: [] }] },
  };
  const b = buildBundles(products).set;
  assert.equal(b.items[0].handle, 'fry-pan');
  assert.equal(b.componentValue, 300);
});
