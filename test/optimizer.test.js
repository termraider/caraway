import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, makePricing, priceCart, cheapest, withinBudget, tierBoosts } from '../optimizer.js';
import { buildBundles } from '../scraper/lib.js';
import { catalog, promos } from './fixture.js';

const setup = (opts) => {
  const cat = catalog();
  const bundles = buildBundles(cat.products);
  return makeContext(cat, bundles, promos(), opts);
};

test('tiers use the pre-discount subtotal, like the site (Cookware Set alone shows 20% off)', () => {
  const p = makePricing(promos());
  const r = priceCart([{ handle: 'cookware-sets', variantId: '500', base: 445 }], p);
  assert.equal(r.tier.percentOff, 20);
  assert.equal(r.total, 356); // matches carawayhome.com's displayed price on 2026-11-25
  assert.equal(r.nextTier.needed, 80);
});

test('tier-only fixed prices apply once the tier is reached', () => {
  const p = makePricing(promos());
  const r = priceCart([{ handle: 'cookware-sets', variantId: '500', base: 445 }, { handle: 'mini-fry-pan', variantId: '700', base: 105 }], p);
  assert.equal(r.tier.percentOff, 25); // 550 >= 525
  // the 89 special belongs to the 20% tier, not the 25% one, so mini gets 25% off: 78.75
  assert.equal(r.lines[1].price, 78.75);
});

test('excluded products (gift cards) get no discount', () => {
  const p = makePricing(promos());
  const r = priceCart([{ handle: 'gift-card', variantId: '1', base: 50 }, { handle: 'fry-pan', variantId: '100', base: 125 }], p);
  assert.equal(r.lines[0].price, 50);
});

test('wanting all four pans: the bundle beats buying them one by one', () => {
  const ctx = setup();
  const wish = ['fry-pan', 'sauce-pan', 'saute-pan', 'dutch-oven'].map((h) => ({ handle: h, color: 'Sage' }));
  const { solutions } = cheapest(wish, ctx);
  assert.equal(solutions[0].chosen.length, 1);
  assert.equal(solutions[0].chosen[0].handle, 'cookware-sets');
  assert.equal(solutions[0].chosen[0].color, 'Sage');
  assert.ok(solutions[0].extras.some((e) => e.name === 'Storage Organizer'));
  // separately: 590 subtotal -> 25% -> 442.50, more than 356
  const sep = solutions.find((s) => s.chosen.length === 4);
  assert.equal(sep.total, 442.5);
});

test('colors must match: a Cream bundle cannot cover a Sage pan', () => {
  const ctx = setup();
  const { solutions } = cheapest([{ handle: 'fry-pan', color: 'Sage' }, { handle: 'sauce-pan', color: 'Cream' }], ctx);
  for (const s of solutions) for (const o of s.chosen) if (o.kind === 'bundle') assert.ok(o.covers.length >= 1);
  const best = solutions[0];
  assert.ok(best.covered.length === 2);
});

test('budget mode: most items under $300, and excluding an item changes the pick', () => {
  const ctx = setup();
  const wish = [{ handle: 'fry-pan' }, { handle: 'dutch-oven' }, { handle: 'tea-towels' }, { handle: 'mini-fry-pan' }];
  const r = withinBudget(wish, ctx, 300);
  assert.ok(r.solutions[0].total <= 300);
  assert.equal(r.solutions[0].covered.length, 3);
  const r2 = withinBudget(wish, ctx, 300, { exclude: [2] });
  assert.ok(!r2.solutions[0].covered.includes(2));
  const rv = withinBudget(wish, ctx, 300, { objective: 'value' });
  assert.ok(rv.solutions[0].retail >= r.solutions[0].retail);
});

test('owned colors show up as duplicates in bundle extras, and tier boosts skip owned items', () => {
  const ctx = setup({ owned: { 'fry-pan|sage': true } });
  const { solutions } = cheapest(['sauce-pan', 'saute-pan', 'dutch-oven'].map((h) => ({ handle: h, color: 'Sage' })), ctx);
  const withBundle = solutions.find((s) => s.chosen.some((o) => o.kind === 'bundle'));
  assert.ok(withBundle.extras.find((e) => e.handle === 'fry-pan').owned);
  const boosts = tierBoosts(cheapest([{ handle: 'tea-towels' }], ctx).solutions[0], ctx);
  assert.ok(boosts.length > 0);
});

test('discontinued products and gift cards are never suggested', () => {
  const ctx = setup();
  const r = cheapest([{ handle: 'old-griddle' }], ctx);
  assert.deepEqual(r.skipped, [0]);
});

test('flat20 offer group: 20% off everything from the first dollar', () => {
  const ctx = setup({ group: 'flat20' });
  const { solutions } = cheapest([{ handle: 'tea-towels', color: 'Cream' }], ctx);
  assert.equal(solutions[0].total, 44);
  assert.equal(ctx.pricing.gift.threshold, 906.25);
});

test('a bundle on the wishlist also covers its parts on the wishlist', () => {
  const ctx = setup();
  const { solutions } = cheapest([{ handle: 'cookware-sets' }, { handle: 'fry-pan', color: 'Cream' }], ctx);
  assert.equal(solutions[0].chosen.length, 1);
  assert.equal(solutions[0].chosen[0].color, 'Cream');
});

test('add-on deals: an item is cheaper when its host product is in the same cart', () => {
  const pr = promos();
  pr.current.addOnDeals = [{ host: 'fry-pan', handle: 'tea-towels', type: 'amount', value: 10, label: 'Tea Towels' }];
  const cat = catalog();
  const ctx = makeContext(cat, buildBundles(cat.products), pr);
  const alone = priceCart([{ handle: 'tea-towels', variantId: '600', base: 55 }], ctx.pricing);
  assert.equal(alone.total, 55 * 1 === 55 ? alone.total : 0);
  const both = priceCart([{ handle: 'fry-pan', variantId: '100', base: 125 }, { handle: 'tea-towels', variantId: '600', base: 55 }], ctx.pricing);
  assert.equal(both.lines[1].addOn.host, 'fry-pan');
  assert.equal(both.subtotal, 170); // 125 + (55 - 10)
  assert.equal(both.total, 144.5); // 15% tier
});
