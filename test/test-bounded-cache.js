import assert from 'node:assert/strict';
import { BoundedCache } from '../dist/utils/bounded-cache.js';

let now = 1000;
const cache = new BoundedCache(3, () => now);
cache.set('a', 1);
cache.set('b', 2);
cache.set('c', 3);
assert.equal(cache.get('a'), 1, 'cache hit returns its value');
cache.set('d', 4);
assert.equal(cache.size, 3, 'cache must never exceed its configured capacity');
assert.equal(cache.get('b'), undefined, 'least recently used entry must be evicted');
assert.equal(cache.get('a'), 1, 'recently accessed entry must survive eviction');

cache.set('negative', 'miss', 500);
assert.equal(cache.get('negative'), 'miss');
now += 500;
assert.equal(cache.get('negative'), undefined, 'negative entries must expire at their deadline');
assert.ok(cache.size <= 3);
cache.clear();
assert.equal(cache.size, 0);
assert.throws(() => new BoundedCache(0), RangeError);
assert.throws(() => cache.set('invalid', 1, -1), RangeError);
console.log('PASS bounded cache enforces capacity, LRU eviction, and per-entry expiration');
