/* PNG Trading engine. Bonding-curve editions + perp pool, ported from the formulas JPEG Trading publishes.
   All amounts are bigint wei (1 play ETH = 1e18). Shared by the API (authoritative) and the page (quotes). */
export const WEI = 10n ** 18n;
export const MIN = 10n ** 12n;
export const MAX_MARGIN = 100n * WEI;
export const ceilDiv = (a, b) => (a + b - 1n) / b;
export const bps = (x, b) => ceilDiv(x * BigInt(b), 10000n);
export const NFT_FEE_BPS = 500, OPEN_BPS = 10, CLOSE_BPS = 10, MAINT_BPS = 500, BORROW_BPS_DAY = 5, LIQ_REWARD_BPS = 50;

export function toWei(v, label = 'Amount') {
  const s = String(v).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(s)) throw Error(label + ' must be a positive decimal with at most 18 places.');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * WEI + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export function fromWei(w, dp = 6) {
  const neg = w < 0n; if (neg) w = -w;
  const i = w / WEI, f = (w % WEI).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
}

/* curve terms, fixed at creation */
export function makeTerms(base, supply, target) {
  base = BigInt(base); supply = BigInt(supply);
  if (base < MIN || base > WEI || supply < 10n || supply > 10000n) throw Error('Use 10–10,000 editions and a starting price between 0.000001 and 1 ETH.');
  const step = ceilDiv(base, supply), maximum = base + step * supply;
  const principal = supply * base + step * supply * (supply - 1n) / 2n;
  const minTarget = ceilDiv(bps(principal, NFT_FEE_BPS), 4n), maxTarget = bps(principal, NFT_FEE_BPS);
  const capacity = base * 500n * WEI / (20000n * step);
  if (capacity * base / WEI < 2n * MIN || minTarget < ceilDiv(MIN * (maximum - base), base)) throw Error('Raise the starting price or edition count so the pool can support minimum-size positions.');
  const t = target == null || target === '' ? minTarget : BigInt(target);
  if (t < minTarget || t > maxTarget) throw Error('Pool target must be between ' + fromWei(minTarget) + ' and ' + fromWei(maxTarget) + ' ETH.');
  return { base, supply, step, maximum, principal, target: t, minTarget, maxTarget, capacity };
}
export const cum = (T, k) => k * T.base + T.step * k * (k - 1n) / 2n;
export const priceAt = (T, s) => T.base + T.step * s;
export const price = (M) => priceAt(M.T, M.supply);

/* editions */
export function quoteEditions(M, n, buy) {
  n = BigInt(n);
  if (n < 1n || n > 20n) throw Error('Choose 1–20 editions.');
  if (buy && M.supply + n > M.T.supply) throw Error('All editions are currently held.');
  if (!buy && n > M.supply) throw Error('Not that many editions exist.');
  const raw = buy ? cum(M.T, M.supply + n) - cum(M.T, M.supply) : cum(M.T, M.supply) - cum(M.T, M.supply - n);
  const fee = bps(raw, NFT_FEE_BPS);
  return { n, buy, raw, fee, total: buy ? raw + fee : raw - fee };
}
export function buyEditions(M, pid, n, P, now) {
  const q = quoteEditions(M, n, true);
  if (P.wallet < q.total) throw Error('Not enough play ETH.');
  const before = price(M);
  P.wallet -= q.total; M.supply += q.n; M.curve += q.raw; M.pool += q.fee; M.volume += q.raw;
  const own = M.holders[pid] || (M.holders[pid] = []);
  for (let i = 0n; i < q.n; i++) own.push(Number(M.nextToken++));
  const opened = !M.live && M.pool >= M.T.target; if (M.pool >= M.T.target) M.live = true;
  pushTrade(M, { t: now, side: 'buy', n: Number(q.n), raw: q.raw, before, after: price(M), pid });
  return { ...q, opened };
}
export function sellEditions(M, pid, n, P, now) {
  const own = M.holders[pid] || [];
  if (BigInt(own.length) < BigInt(n)) throw Error('You do not own that many editions.');
  const q = quoteEditions(M, n, false), before = price(M);
  M.supply -= q.n; M.curve -= q.raw; M.pool += q.fee; M.volume += q.raw; P.wallet += q.total;
  own.splice(0, Number(q.n)); if (!own.length) delete M.holders[pid];
  if (M.pool >= M.T.target) M.live = true;
  pushTrade(M, { t: now, side: 'sell', n: Number(q.n), raw: q.raw, before, after: price(M), pid });
  return q;
}
function pushTrade(M, tr) { M.trades.push(tr); if (M.trades.length > 400) M.trades.splice(0, M.trades.length - 400); }

/* perps */
export function maxCollateral(M, lev, long) {
  lev = BigInt(lev); if (!M.live) return 0n;
  const p = price(M), free = M.pool - M.reserved, qty = M.T.capacity - M.gross;
  const room = long ? M.T.maximum - p : p - M.T.base;
  const byReserve = room === 0n ? qty : free * WEI / room;
  const q = qty < byReserve ? qty : byReserve;
  let m = q <= 0n ? 0n : ((q + 1n) * p - 1n) / (lev * WEI);
  if (m > MAX_MARGIN) m = MAX_MARGIN;
  return m >= MIN && m * lev * WEI / p > 0n ? m : 0n;
}
export function openPosition(M, pid, long, margin, lev, P, now) {
  margin = BigInt(margin); lev = Number(lev);
  if (!M.live) throw Error('Perps open when the pool reaches its target.');
  if (!(lev >= 1 && lev <= 3) || !Number.isInteger(lev)) throw Error('Choose 1–3× leverage.');
  if (margin < MIN) throw Error('Use at least 0.000001 ETH collateral.');
  if (margin > MAX_MARGIN) throw Error('Collateral is capped at 100 ETH per position.');
  const notional = margin * BigInt(lev), fee = bps(notional, OPEN_BPS), p = price(M);
  const qty = notional * WEI / p;
  const reserve = ceilDiv(qty * (long ? M.T.maximum - p : p - M.T.base), WEI);
  if (qty <= 0n) throw Error('Position too small.');
  if (M.gross + qty > M.T.capacity) throw Error('Reduce the size: the market exposure limit would be exceeded.');
  if (reserve > M.pool - M.reserved + fee) throw Error('Reduce the size: the pool needs more profit reserve.');
  if (P.wallet < margin + fee) throw Error('Not enough play ETH.');
  P.wallet -= margin + fee; M.pool += fee; M.reserved += reserve; M.gross += qty;
  const pos = { id: M.nextPos++, pid, long, margin, lev, notional, entry: p, qty, reserve, t: now, open: true };
  M.positions.push(pos);
  return { pos, fee };
}
export function mark(M, pos, now) {
  const p = price(M), good = pos.long ? p >= pos.entry : p <= pos.entry, diff = p >= pos.entry ? p - pos.entry : pos.entry - p;
  const abs = good ? pos.qty * diff / WEI : ceilDiv(pos.qty * diff, WEI), pnl = good ? abs : -abs;
  const secs = BigInt(Math.max(0, Math.floor(now - pos.t)));
  const borrow = ceilDiv(pos.notional * BigInt(BORROW_BPS_DAY) * secs, 10000n * 86400n);
  let equity = pos.margin + pnl - borrow; if (equity < 0n) equity = 0n;
  let closing = bps(pos.qty * p / WEI, CLOSE_BPS); if (closing > equity) closing = equity;
  return { price: p, pnl, borrow, equity, closing, payout: equity - closing, liquidatable: equity <= bps(pos.notional, MAINT_BPS) };
}
export function closePosition(M, pid, id, players, now) {
  const pos = M.positions.find(x => x.id === Number(id) && x.open);
  if (!pos) throw Error('Position not found or already closed.');
  const k = mark(M, pos, now), owner = players[pos.pid];
  if (pid === pos.pid) {
    M.pool += pos.margin - k.payout; owner.wallet += k.payout; settle(M, pos, now, 'closed', k.payout, 0n);
    return { ...k, reward: 0n };
  }
  if (!k.liquidatable) throw Error('Only the owner can close a position that is not liquidatable.');
  let reward = bps(pos.notional, LIQ_REWARD_BPS); if (reward > k.payout) reward = k.payout;
  const ownerGets = k.payout - reward, liq = players[pid];
  M.pool += pos.margin - ownerGets - reward; owner.wallet += ownerGets; liq.wallet += reward;
  settle(M, pos, now, 'liquidated', ownerGets, reward);
  return { ...k, reward, payout: ownerGets };
}
function settle(M, pos, now, how, payout, reward) {
  M.reserved -= pos.reserve; M.gross -= pos.qty; pos.open = false; pos.closedAt = now; pos.how = how; pos.exitPrice = price(M); pos.payout = payout; pos.reward = reward;
  const closed = M.positions.filter(x => !x.open);
  if (closed.length > 200) { const drop = new Set(closed.slice(0, closed.length - 200)); M.positions = M.positions.filter(x => !drop.has(x)); }
}

/* bigint <-> json */
const BIG_M = ['supply', 'curve', 'pool', 'reserved', 'gross', 'volume', 'nextToken'];
const BIG_T = ['base', 'supply', 'step', 'maximum', 'principal', 'target', 'minTarget', 'maxTarget', 'capacity'];
const BIG_P = ['margin', 'notional', 'entry', 'qty', 'reserve', 'exitPrice', 'payout', 'reward'];
const BIG_TR = ['raw', 'before', 'after'];
const conv = (o, keys, f) => { for (const k of keys) if (o[k] != null) o[k] = f(o[k]); return o; };
export function packMarket(M) {
  const o = JSON.parse(JSON.stringify(M, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  return o;
}
export function unpackMarket(o) {
  const M = typeof o === 'string' ? JSON.parse(o) : structuredClone(o);
  conv(M, BIG_M, BigInt); conv(M.T, BIG_T, BigInt);
  M.positions.forEach(p => conv(p, BIG_P, BigInt)); M.trades.forEach(t => conv(t, BIG_TR, BigInt));
  return M;
}
export function packPlayer(P) { return { ...P, wallet: P.wallet.toString() }; }
export function unpackPlayer(o) { const P = typeof o === 'string' ? JSON.parse(o) : { ...o }; P.wallet = BigInt(P.wallet); return P; }

export function newMarket({ id, name, symbol, art, creator, base, supply, target, now }) {
  const T = makeTerms(base, supply, target);
  return { id, name, symbol, art, creator, createdAt: now, T, supply: 0n, curve: 0n, pool: 0n, reserved: 0n, gross: 0n, volume: 0n, live: false, nextToken: 1n, nextPos: 1, holders: {}, positions: [], trades: [] };
}
