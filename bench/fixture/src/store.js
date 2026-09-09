// In-memory order store. Not persisted; the process owns the data for its lifetime.
export class OrderStore {
  constructor() { this.orders = new Map(); this.seq = 0; }

  create({ customer, items, currency }) {
    if (!customer) throw Error('customer is required');
    if (!Array.isArray(items) || !items.length) throw Error('items must be a non-empty array');
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw Error('currency must be a 3-letter code');
    const id = 'ord_' + (++this.seq);
    const order = { id, customer, items, currency: currency || 'USD', status: 'open', createdAt: Date.now() };
    this.orders.set(id, order);
    return order;
  }

  get(id) { return this.orders.get(id) || null; }

  list({ customer, status } = {}) {
    let out = [...this.orders.values()];
    if (customer) out = out.filter(o => o.customer === customer);
    if (status) out = out.filter(o => o.status === status);
    return out;
  }

  total(id) {
    const o = this.get(id);
    if (!o) return null;
    return o.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  }

  close(id) {
    const o = this.get(id);
    if (!o) throw Error('no such order');
    o.status = 'closed';
    return o;
  }
}
