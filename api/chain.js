/* Read side of PNG Trading on Robinhood Chain.
   GET /api/chain?f=<factory>                    every market with terms, stats and price
   GET /api/chain?f=<factory>&m=<market>&u=<me>   plus trades, positions with live marks and my editions
   Events are indexed incrementally and cached in Redis (png2:*); writes always go from the user's wallet. */
import { createRequire } from 'node:module';
import { createPublicClient, http, fallback, getAddress, decodeEventLog } from 'viem';
import { redis } from '../lib/store.js';

const require = createRequire(import.meta.url);
const MKT = require('../lib/abi/PngMarket.json').abi;
const FAC = require('../lib/abi/PngFactory.json').abi;
const chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } };
const pub = createPublicClient({ chain, transport: fallback(['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'].map(u => http(u, { timeout: 20000 }))) });
const STEP = 45000n, isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const big = (k, v) => typeof v === 'bigint' ? v.toString() : v;
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj, big)); };

async function deployBlock(address) {
  const R = redis(), k = 'png2:born:' + address.toLowerCase(), c = await R.get(k);
  if (c) return BigInt(c);
  let lo = 0n, hi = await pub.getBlockNumber();
  if ((await pub.getCode({ address, blockNumber: hi })) === undefined) throw Error('Contract not found on Robinhood Chain.');
  while (lo < hi) { const mid = (lo + hi) / 2n; const code = await pub.getCode({ address, blockNumber: mid }).catch(() => undefined); if (code && code !== '0x') hi = mid; else lo = mid + 1n; }
  await R.set(k, lo.toString());
  return lo;
}

async function blockTimes(numbers) {
  const R = redis(), out = {};
  await Promise.all([...new Set(numbers)].map(async n => {
    const k = 'png2:bt:' + n, c = await R.get(k);
    if (c) { out[n] = Number(c); return; }
    const b = await pub.getBlock({ blockNumber: BigInt(n) });
    out[n] = Number(b.timestamp); await R.set(k, String(out[n]), { ex: 86400 * 30 });
  }));
  return out;
}

/* incremental scan of one address, folding decoded logs into a cached state with fold(state, log) */
async function indexed(address, abi, init, fold) {
  const R = redis(), k = 'png2:ix:' + address.toLowerCase();
  const saved = await R.get(k);
  const st = saved ? JSON.parse(saved) : { block: String((await deployBlock(address)) - 1n), ...init() };
  const head = await pub.getBlockNumber();
  let from = BigInt(st.block) + 1n, changed = false;
  while (from <= head) {
    const to = from + STEP - 1n > head ? head : from + STEP - 1n;
    const logs = await pub.getLogs({ address, fromBlock: from, toBlock: to });
    const decoded = logs.map(l => { try { return { ...decodeEventLog({ abi, data: l.data, topics: l.topics }), block: Number(l.blockNumber), tx: l.transactionHash, i: l.logIndex }; } catch { return null; } }).filter(Boolean);
    if (decoded.length) {
      const times = await blockTimes(decoded.map(d => d.block));
      for (const d of decoded) fold(st, { ...d, t: times[d.block] });
      changed = true;
    }
    from = to + 1n;
  }
  st.block = String(head);
  await R.set(k, JSON.stringify(st, big));
  return st;
}

const factoryIndex = f => indexed(f, FAC, () => ({ markets: [] }), (st, e) => {
  if (e.eventName === 'MarketCreated' && !st.markets.some(m => m.market === e.args.market)) st.markets.push({ market: e.args.market, creator: e.args.creator, block: e.block, t: e.t });
});
const marketIndex = m => indexed(m, MKT, () => ({ trades: [], opened: {}, closed: {}, owners: {} }), (st, e) => {
  const a = e.args;
  if (e.eventName === 'Bought' || e.eventName === 'Sold') {
    st.trades.push({ side: e.eventName === 'Bought' ? 'buy' : 'sell', who: a.buyer || a.seller, n: Number(a.n), raw: String(a.raw), fee: String(a.fee), before: String(a.priceBefore), after: String(a.priceAfter), t: e.t, block: e.block, tx: e.tx });
    if (st.trades.length > 1500) st.trades.splice(0, st.trades.length - 1500);
  } else if (e.eventName === 'Opened') {
    st.opened[String(a.id)] = { id: Number(a.id), owner: a.owner, long: a.long, margin: String(a.margin), lev: Number(a.lev), entry: String(a.entry), qty: String(a.qty), t: e.t, tx: e.tx };
  } else if (e.eventName === 'Closed') {
    st.closed[String(a.id)] = { by: a.by, liquidated: a.liquidated, exitPrice: String(a.exitPrice), pnl: String(a.pnl), payout: String(a.payout), reward: String(a.reward), t: e.t, tx: e.tx };
  } else if (e.eventName === 'Transfer') {
    const id = String(a.tokenId);
    if (a.to === '0x0000000000000000000000000000000000000000') delete st.owners[id]; else st.owners[id] = a.to;
  }
});

const SUMMARY_FNS = ['name', 'symbol', 'art', 'creator', 'createdAt', 'terms', 'stats', 'price'];
async function summaries(list) {
  const calls = list.flatMap(m => SUMMARY_FNS.map(fn => ({ address: m.market, abi: MKT, functionName: fn })));
  const res = await pub.multicall({ contracts: calls, allowFailure: true });
  return list.map((m, i) => {
    const r = SUMMARY_FNS.map((_, j) => res[i * SUMMARY_FNS.length + j].result);
    const [base, maxSupply, step, maximum, principal, target, capacity] = r[5] || [];
    const [supply, curve, pool, reserved, gross, margins, volume, live] = r[6] || [];
    return { market: m.market, block: m.block, name: r[0], symbol: r[1], art: r[2], creator: r[3], createdAt: Number(r[4] || 0), terms: { base, maxSupply, step, maximum, principal, target, capacity }, stats: { supply, curve, pool, reserved, gross, margins, volume, live }, price: r[7] };
  });
}

export default async function handler(req, res) {
  try {
    const q = req.query || {}, R = redis();
    if (!isAddr(q.f)) throw Error('Factory address is not configured.');
    const f = getAddress(q.f), out = { now: Math.floor(Date.now() / 1000) };
    const lk = 'png2:list:' + f.toLowerCase();
    let list = await R.get(lk);
    if (list) out.markets = JSON.parse(list);
    else {
      const fi = await factoryIndex(f);
      out.markets = (await summaries(fi.markets)).reverse();
      await R.set(lk, JSON.stringify(out.markets, big), { ex: 6 });
    }
    if (isAddr(q.m)) {
      const m = getAddress(q.m), meta = out.markets.find(x => x.market.toLowerCase() === m.toLowerCase());
      if (!meta) throw Error('Market not found in this factory.');
      const ix = await marketIndex(m), u = isAddr(q.u) ? q.u.toLowerCase() : null;
      const openIds = Object.keys(ix.opened).filter(id => !ix.closed[id]).map(Number);
      const marks = openIds.length ? await pub.multicall({ contracts: openIds.map(id => ({ address: m, abi: MKT, functionName: 'mark', args: [BigInt(id)] })), allowFailure: true }) : [];
      const [[sm]] = [await summaries([{ market: m, block: meta.block }])];
      out.market = {
        ...sm,
        trades: ix.trades.slice(-600),
        open: openIds.map((id, i) => ({ ...ix.opened[id], mark: marks[i] && marks[i].result, mine: !!u && ix.opened[id].owner.toLowerCase() === u })).sort((a, b) => b.id - a.id),
        closed: Object.entries(ix.closed).map(([id, c]) => ({ ...ix.opened[id], ...c })).sort((a, b) => b.t - a.t).slice(0, 40),
        holders: new Set(Object.values(ix.owners).map(x => x.toLowerCase())).size,
        mine: u ? Object.entries(ix.owners).filter(([, o]) => o.toLowerCase() === u).map(([id]) => Number(id)).sort((a, b) => a - b) : []
      };
    }
    send(res, 200, out);
  } catch (e) { send(res, 400, { error: e.shortMessage || e.message }); }
}
