import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderStore } from '../src/store.js';

test('creates an order with defaults', () => {
  const s = new OrderStore();
  const o = s.create({ customer: 'ada', items: [{ sku: 'a', price: 10, quantity: 2 }] });
  assert.equal(o.currency, 'USD');
  assert.equal(o.status, 'open');
});

test('totals an order', () => {
  const s = new OrderStore();
  const o = s.create({ customer: 'ada', items: [{ sku: 'a', price: 10, quantity: 2 }, { sku: 'b', price: 5, quantity: 1 }] });
  assert.equal(s.total(o.id), 25);
});

test('rejects an empty item list', () => {
  const s = new OrderStore();
  assert.throws(() => s.create({ customer: 'ada', items: [] }));
});
