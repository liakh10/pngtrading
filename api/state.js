import * as A from '../lib/api.js';
import { redis } from '../lib/store.js';
export default async function handler(req, res) {
  try {
    await A.seed();
    const R = redis(), t = A.now(), q = req.query || {};
    let pid = null, player = null;
    if (q.key) { pid = A.pidOf(q.key); player = await A.loadPlayer(pid, false); }
    const ids = await R.lrange('png:ms', 0, 99);
    const sums = ids.length ? (await R.mget(...ids.map(i => 'png:s:' + i))).filter(Boolean).map(s => JSON.parse(s)) : [];
    const out = { now: t, pid, player: player ? { pid, wallet: player.wallet, faucetAt: player.faucetAt } : null, markets: sums };
    if (q.m) out.market = A.marketView(await A.loadMarket(String(q.m)), pid, t);
    A.json(res, 200, out);
  } catch (e) { A.json(res, 400, { error: e.message }); }
}
