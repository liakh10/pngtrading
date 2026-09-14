import * as E from '../lib/engine.js';
import * as A from '../lib/api.js';
import { redis, withLocks } from '../lib/store.js';
const ARTS = ['frog', 'cat', 'pigeon', 'bot'];
export default async function handler(req, res) {
  if (req.method !== 'POST') return A.json(res, 405, { error: 'POST only' });
  try {
    const R = redis(), t = A.now();
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const pid = A.pidOf(b.key);
    const ip = String(req.headers['x-forwarded-for'] || 'local').split(',')[0].trim();
    const rl = 'png:rl:' + ip, hits = await R.incr(rl);
    if (hits === 1) await R.expire(rl, 10);
    if (hits > 40) throw Error('Slow down a little.');
    await A.seed();
    let msg = '', marketId = b.m ? String(b.m) : null;

    if (b.type === 'hello' || b.type === 'faucet') {
      await withLocks(['p:' + pid], async () => {
        const P = await A.loadPlayer(pid, true);
        if (P.fresh) msg = 'Wallet created with 10 pETH.';
        else if (b.type === 'faucet') {
          const wait = P.faucetAt + 86400 - t;
          if (wait > 0) throw Error('Faucet refills in ' + Math.ceil(wait / 3600) + 'h.');
          P.wallet += E.toWei('5'); P.faucetAt = t; msg = '5 pETH added.';
        } else msg = 'Welcome back.';
        await A.savePlayer(P);
      });
    } else if (b.type === 'create') {
      const ck = 'png:cr:' + pid + ':' + Math.floor(t / 86400), c = await R.incr(ck);
      if (c === 1) await R.expire(ck, 90000);
      if (c > 3) throw Error('3 collections per wallet per day.');
      const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      const symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (name.length < 2 || symbol.length < 2) throw Error('Name and symbol need at least 2 characters.');
      if (!ARTS.includes(b.art)) throw Error('Pick an artwork.');
      const supply = parseInt(b.supply, 10);
      if (!Number.isInteger(supply)) throw Error('Maximum editions must be a whole number.');
      const id = symbol.toLowerCase() + '-' + Math.random().toString(36).slice(2, 7);
      const M = E.newMarket({ id, name, symbol, art: b.art, creator: pid, base: E.toWei(b.base, 'Starting price'), supply: BigInt(supply), target: b.target ? E.toWei(b.target, 'Pool target') : null, now: t });
      await withLocks(['p:' + pid], async () => { const P = await A.loadPlayer(pid, true); await A.savePlayer(P); });
      await A.saveMarket(M); await R.lpush('png:ms', id);
      marketId = id; msg = name + ' launched. Buy editions to fill its pool.';
    } else if (['buy', 'sell', 'open', 'close'].includes(b.type)) {
      if (!marketId) throw Error('Market is required.');
      let keys = ['m:' + marketId, 'p:' + pid];
      if (b.type === 'close') {
        const pos = (await A.loadMarket(marketId)).positions.find(x => x.id === Number(b.id));
        if (!pos) throw Error('Position not found.');
        keys = ['m:' + marketId, ...[...new Set([pid, pos.pid])].sort().map(x => 'p:' + x)];
      }
      await withLocks(keys, async () => {
        const M = await A.loadMarket(marketId), P = await A.loadPlayer(pid, true), players = { [pid]: P };
        if (b.type === 'buy') { const r = E.buyEditions(M, pid, b.n, P, t); msg = 'Bought ' + r.n + ' for ' + E.fromWei(r.total) + ' pETH.' + (r.opened ? ' Pool target reached, perps are open.' : ''); }
        if (b.type === 'sell') { const r = E.sellEditions(M, pid, b.n, P, t); msg = 'Sold ' + r.n + ' for ' + E.fromWei(r.total) + ' pETH.'; }
        if (b.type === 'open') { const r = E.openPosition(M, pid, b.side === 'long', E.toWei(b.margin, 'Collateral'), b.lev, P, t); msg = (b.side === 'long' ? 'Long' : 'Short') + ' #' + r.pos.id + ' opened.'; }
        if (b.type === 'close') {
          const pos = M.positions.find(x => x.id === Number(b.id));
          if (pos && pos.pid !== pid) players[pos.pid] = await A.loadPlayer(pos.pid, true);
          const r = E.closePosition(M, pid, b.id, players, t);
          if (pos.pid !== pid) { await A.savePlayer(players[pos.pid]); msg = 'Position #' + pos.id + ' liquidated. Reward ' + E.fromWei(r.reward, 9) + ' pETH.'; }
          else msg = 'Position #' + pos.id + ' closed. ' + E.fromWei(r.payout) + ' pETH returned.';
        }
        await A.saveMarket(M); await A.savePlayer(P);
      });
    } else throw Error('Unknown action.');

    const P = await A.loadPlayer(pid, false);
    const out = { ok: true, msg, now: t, pid, player: P ? { pid, wallet: P.wallet, faucetAt: P.faucetAt } : null };
    if (marketId) out.market = A.marketView(await A.loadMarket(marketId), pid, t);
    A.json(res, 200, out);
  } catch (e) { A.json(res, 400, { error: e.message }); }
}
