// Small fake catalog shaped like real scraper output (prices taken from carawayhome.com on 2026-11-25).
const colors = ['Cream', 'Sage'];
const ids = { 'fry-pan': 100, 'sauce-pan': 200, 'saute-pan': 300, 'dutch-oven': 400, 'cookware-sets': 500, 'tea-towels': 600, 'mini-fry-pan': 700 };
const vid = (h, c) => String(ids[h] + colors.indexOf(c));
const single = (handle, title, price, extra = {}) => ({
  handle, title, productType: 'Cookware Singles', tags: [], collections: ['cookware'], bundle: false, discontinued: false,
  url: `https://www.carawayhome.com/products/${handle}`, image: null, firstSeen: '2026-11-01', lastSeen: '2026-11-25',
  variants: colors.map((c) => ({ id: vid(handle, c), title: c, color: c, price, compareAt: null, available: true, live: true })),
  components: [], ...extra,
});

export function catalog() {
  const products = {
    'fry-pan': single('fry-pan', 'Fry Pan', 125),
    'sauce-pan': single('sauce-pan', 'Sauce Pan', 135),
    'saute-pan': single('saute-pan', 'Sauté Pan', 165),
    'dutch-oven': single('dutch-oven', 'Dutch Oven', 165),
    'tea-towels': single('tea-towels', 'Tea Towels', 55, { productType: 'Linens', collections: ['linens'] }),
    'mini-fry-pan': single('mini-fry-pan', 'Mini Fry Pan', 105),
    'gift-card': { ...single('gift-card', 'Gift Card', 50), isGiftCard: true },
    'old-griddle': { ...single('old-griddle', 'Old Griddle', 99), discontinued: true, discontinuedOn: '2026-10-01' },
    'cookware-sets': {
      ...single('cookware-sets', 'Cookware Set', 445, { productType: 'Cookware Sets', collections: ['bundles', 'cookware'], bundle: true }),
      components: ['fry-pan', 'sauce-pan', 'saute-pan', 'dutch-oven'].map((h) => ({
        name: h, qty: 1, type: 'pan', match: 'color', priceOverride: null,
        variants: colors.map((c) => ({ id: vid(h, c), color: c.toLowerCase(), price: { 'fry-pan': 125, 'sauce-pan': 135, 'saute-pan': 165, 'dutch-oven': 165 }[h] })),
      })).concat([{ name: 'Storage Organizer', qty: 4, type: 'storage_organizer', match: 'color', priceOverride: 50, variants: [] }]),
    },
  };
  products['cookware-sets'].variants.forEach((v) => { v.compareAt = 675; });
  return { products };
}

export function promos() {
  return {
    current: {
      holidayEnabled: true,
      tierPricing: {
        tiers: [
          { threshold: 85, percentOff: 15, prices: {} },
          { threshold: 425, percentOff: 20, prices: { 'mini-fry-pan': { 700: 89, 701: 89 } } },
          { threshold: 525, percentOff: 25, prices: {} },
        ],
        segments: { flat20: { percentOff: 20, prices: {} } },
        productOverrides: { 'gift-card': { percentOff: 0, prices: {} } },
        excludeTags: ['exclude-from-discounts'],
      },
      progressBars: [
        { name: 'Holiday Tiers - 4 Tiers', enabled: true, featureFlag: { key: 'holiday-offer', variant: 'control' },
          tiers: [{ title: '15% Off', amount: 85 }, { title: '20% Off', amount: 425 }, { title: '25% Off', amount: 525 },
            { title: 'Free Gift', amount: 966.66, giftHandle: 'cast-iron-dutch-oven-and-lid-gwp', giftTitle: '6.5 qt Enameled Cast Iron Dutch Oven - GWP' }] },
        { name: 'Holiday Tiers - 2 Tiers', enabled: true, featureFlag: { key: 'holiday-offer', variant: 'flat20' },
          tiers: [{ title: '20% Off', amount: 0 }, { title: 'Free Gift', amount: 906.25, giftHandle: 'cast-iron-dutch-oven-and-lid-gwp', giftTitle: '6.5 qt Enameled Cast Iron Dutch Oven - GWP' }] },
      ],
      freeShipping: { enabled: true, threshold: 90 },
      promoText: ['Our Biggest Sale of the Year'],
    },
    log: [],
  };
}
