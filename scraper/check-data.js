// Sanity check before the workflows push data: every file parses and nothing shrank suspiciously.
import { readFile } from 'node:fs/promises';
const DATA = new URL('../data/', import.meta.url);
const read = async (n) => JSON.parse(await readFile(new URL(n, DATA), 'utf8'));
const products = Object.values((await read('products.json')).products || {});
const live = products.filter((p) => p.source !== 'wayback' && !p.discontinued).length;
const bundles = Object.keys((await read('bundles.json')).bundles || {}).length;
const history = Object.keys(await read('price-history.json')).length;
await read('promos.json'); await read('meta.json');
console.log(`check: ${products.length} products (${live} live), ${bundles} bundles, ${history} price histories`);
const problems = [];
if (live < 150) problems.push(`only ${live} live products`);
if (bundles < 50) problems.push(`only ${bundles} bundles`);
if (history < 800) problems.push(`only ${history} price histories`);
if (problems.length) { console.error('data check failed: ' + problems.join(', ')); process.exit(1); }
