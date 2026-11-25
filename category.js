// A friendly category for each product. Caraway's own "product type" is often missing, very granular
// ("Cookware Singles") or Shopify's placeholder "Physical", so fall back to tags, collections and the name.
const TYPE = [
  [/^cookware|^steamer|^grill press|^cast iron/i, 'Cookware'],
  [/^bakeware/i, 'Bakeware'],
  [/^food storage/i, 'Food Storage'],
  [/^prepware|^spoon rest|^mixing bowl|^knife|^utensil/i, 'Prepware'],
  [/^linens?/i, 'Linens'],
  [/^tea kettle|^coffee|^drinkware/i, 'Coffee & Bar'],
  [/^gift card/i, 'Gift Card'],
];
const TAG = { prepware: 'Prepware', cookware: 'Cookware', bakeware: 'Bakeware', 'food storage': 'Food Storage' };
const COLL = [
  [/^coffee-and-tea$/, 'Coffee & Bar'],
  [/trash|recycling/, 'Trash & Recycling'],
  [/^(kitchen-tools|kitchen-gadgets|knives|utensils|cutting-boards|mixing-bowls)/, 'Prepware'],
  [/glass-lids|steamers/, 'Cookware'],
  [/^food-storage/, 'Food Storage'],
  [/^bakeware/, 'Bakeware'],
  [/^(cookware|ceramic-cookware|cast-iron|stainless-steel|skillet|dutch-ovens|pots-and-pans|non-stick)/, 'Cookware'],
  [/^linens|towels|aprons/, 'Linens'],
];
const NAME = [
  [/knife|utensil|cutting-board|gadget|prep|butcher|peeler|opener|scoop|garlic|pizza-cutter|strainer|mixing/, 'Prepware'],
  [/bakeware|baking|muffin|cookie|sheet|loaf|cake/, 'Bakeware'],
  [/food-storage|airtight|container/, 'Food Storage'],
  [/cookware|pan|pot|lid|squareware|mini|cast-iron|fry|saute|dutch|braiser|skillet|kettle|griddle/, 'Cookware'],
  [/towel|apron|mitt|linen/, 'Linens'],
  [/coffee|tea|mug/, 'Coffee & Bar'],
];

const OVERRIDE = [[/timer/, 'Prepware'], [/bar-set/, 'Coffee & Bar'], [/press-and-rest/, 'Cookware']];

export function categoryOf(p) {
  for (const [re, c] of OVERRIDE) if (re.test(p.handle || '')) return c;
  const type = String(p.productType || '').trim();
  for (const [re, c] of TYPE) if (re.test(type)) return c;
  for (const t of p.tags || []) if (TAG[String(t).toLowerCase()]) return TAG[String(t).toLowerCase()];
  const colls = p.collections || [];
  for (const [re, c] of COLL) if (colls.some((x) => re.test(x))) return c;
  const name = String(p.handle || '') + ' ' + String(p.title || '').toLowerCase().replace(/\s+/g, '-');
  for (const [re, c] of NAME) if (re.test(name)) return c;
  if (p.bundle) return 'Bundle';
  return type && !/^physical$/i.test(type) ? type : 'Accessories';
}
