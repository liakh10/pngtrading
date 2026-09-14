import crypto from 'node:crypto';
import * as E from './engine.js';
import { redis, withLocks } from './store.js';
export const now = () => Math.floor(Date.now() / 1000);
export function pidOf(secret) {
  if (!/^[a-f0-9]{32}$/.test(String(secret || ''))) throw Error('Missing wallet key.');
  return crypto.createHash('sha256').update('png:' + secret).digest('hex').slice(0, 16);
}
export async function loadPlayer(pid, create) {
  const s = await redis().get('png:p:' + pid);
  if (s) return E.unpackPlayer(s);
  if (!create) return null;
  return { pid, wallet: E.toWei('10'), faucetAt: now(), created: now(), fresh: true };
}
export async function savePlayer(P) { const { fresh, ...rest } = P; await redis().set('png:p:' + P.pid, JSON.stringify(E.packPlayer(rest))); }
export async function loadMarket(id) { const s = await redis().get('png:m:' + id); if (!s) throw Error('Market not found.'); return E.unpackMarket(s); }
export async function saveMarket(M) {
  const R = redis();
  await R.set('png:m:' + M.id, JSON.stringify(E.packMarket(M)));
  await R.set('png:s:' + M.id, JSON.stringify(summary(M)));
}
export function summary(M) {
  const p = E.price(M), t = now();
  const first = M.trades.find(x => x.t >= t - 86400), open = first ? first.before : p;
  return {
    id: M.id, name: M.name, symbol: M.symbol, art: M.art, createdAt: M.createdAt,
    price: p.toString(), base: M.T.base.toString(), maximum: M.T.maximum.toString(),
    supply: M.supply.toString(), cap: M.T.supply.toString(), pool: M.pool.toString(), target: M.T.target.toString(),
    live: M.live, volume: M.volume.toString(), trades: M.trades.length,
    change: open > 0n ? Number((p - open) * 10000n / open) / 100 : 0,
    openPositions: M.positions.filter(x => x.open).length
  };
}
export async function seed() {
  const R = redis();
  if (await R.llen('png:ms')) return;
  await withLocks(['seed'], async () => {
    if (await R.llen('png:ms')) return;
    const t = now();
    const list = [
      { id: 'frog', name: 'Robin Frog', symbol: 'FROG', art: 'frog', base: E.toWei('0.01'), supply: 100 },
      { id: 'bot', name: 'Acrylic Bot', symbol: 'ABOT', art: 'bot', base: E.toWei('0.002'), supply: 500 }
    ];
    for (const x of list.reverse()) { const M = E.newMarket({ ...x, creator: 'house', now: t }); await saveMarket(M); await R.lpush('png:ms', M.id); }
  });
}
export function marketView(M, pid, t) {
  return {
    id: M.id, name: M.name, symbol: M.symbol, art: M.art, creator: M.creator, createdAt: M.createdAt, T: M.T,
    supply: M.supply, curve: M.curve, pool: M.pool, reserved: M.reserved, gross: M.gross, volume: M.volume, live: M.live, price: E.price(M),
    trades: M.trades.slice(-200),
    open: M.positions.filter(x => x.open).map(x => ({ ...x, mark: E.mark(M, x, t), mine: x.pid === pid })),
    mineClosed: M.positions.filter(x => !x.open && x.pid === pid).slice(-20),
    myEditions: M.holders[pid] || [], holders: Object.keys(M.holders).length
  };
}
export function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v));
}
