/* Runs the compiled contracts in an in-process EVM (ethereumjs, Cancun) and checks every number against
   ../lib/engine.js, the reference implementation of the JPEG Trading formulas. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { LegacyTransaction } from '@ethereumjs/tx';
import { Block } from '@ethereumjs/block';
import { Address, Account, randomBytes, privateToAddress, bytesToHex } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, decodeErrorResult, encodeDeployData, parseEther, formatEther } from 'viem';
import * as E from '../lib/engine.js';

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const MKT = art('PngMarket'), FAC = art('PngFactory');
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });
let now = 1_800_000_000, blockNo = 1n, pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) pass++; else { fail++; console.log('  FAIL', label, extra); } };
const eq = (a, b, label) => ok(BigInt(a) === BigInt(b), label, `contract ${a} vs engine ${b}`);

function wallet() { const pk = randomBytes(32); return { pk, address: new Address(privateToAddress(pk)), hex: bytesToHex(privateToAddress(pk)) }; }
async function fund(w, eth) { await vm.stateManager.putAccount(w.address, Account.fromAccountData({ balance: parseEther(eth) })); }
const block = () => Block.fromBlockData({ header: { number: blockNo++, timestamp: BigInt(now), gasLimit: 30_000_000n, baseFeePerGas: 1n } }, { common });

async function send(w, to, data, value = 0n) {
  const acct = await vm.stateManager.getAccount(w.address);
  const tx = LegacyTransaction.fromTxData({ nonce: acct.nonce, gasPrice: 1n, gasLimit: 29_000_000n, to: to ? Address.fromString(to) : undefined, value, data }, { common }).sign(w.pk);
  const r = await vm.runTx({ tx, block: block(), skipBlockGasLimitValidation: true });
  const err = r.execResult.exceptionError;
  let reason = null;
  if (err) { try { reason = decodeErrorResult({ abi: MKT.abi.concat(FAC.abi), data: bytesToHex(r.execResult.returnValue) }).errorName; } catch { reason = err.error; } }
  const logs = (r.receipt.logs || []).map(([addr, topics, d]) => { try { return { address: bytesToHex(addr), ...decodeEventLog({ abi: MKT.abi.concat(FAC.abi), topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
  return { reverted: !!err, reason, logs, created: r.createdAddress ? r.createdAddress.toString() : null, gas: r.totalGasSpent };
}
async function call(to, abi, functionName, args = [], from = '0x0000000000000000000000000000000000000001') {
  const data = encodeFunctionData({ abi, functionName, args });
  const r = await vm.evm.runCall({ to: Address.fromString(to), caller: Address.fromString(from), data: Buffer.from(data.slice(2), 'hex'), block: block() });
  if (r.execResult.exceptionError) throw Error(functionName + ' reverted');
  return decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) });
}
const tx = (w, to, abi, fn, args = [], value = 0n) => send(w, to, encodeFunctionData({ abi, functionName: fn, args }), value);
const balanceOf = async a => (await vm.stateManager.getAccount(Address.fromString(a)))?.balance ?? 0n;

/* deploy */
const deployer = wallet(); await fund(deployer, '1000');
const impl = (await send(deployer, null, MKT.bytecode)).created;
const factory = (await send(deployer, null, encodeDeployData({ abi: FAC.abi, bytecode: FAC.bytecode, args: [impl] }))).created;
console.log('implementation', impl, 'factory', factory);

async function createMarket(w, { name, symbol, base, supply, target = 0n }) {
  const r = await tx(w, factory, FAC.abi, 'create', [name, symbol, 'ipfs://art', base, supply, target]);
  if (r.reverted) return { reverted: true, reason: r.reason };
  return { market: r.logs.find(l => l.eventName === 'MarketCreated').args.market, gas: r.gas };
}
async function check(M, market, label) {
  const [supply, curve, pool, reserved, gross, margins, volume, live] = await call(market, MKT.abi, 'stats');
  eq(supply, M.supply, label + ' supply'); eq(curve, M.curve, label + ' curve'); eq(pool, M.pool, label + ' pool');
  eq(reserved, M.reserved, label + ' reserved'); eq(gross, M.gross, label + ' gross'); eq(volume, M.volume, label + ' volume');
  ok(live === M.live, label + ' live', `${live} vs ${M.live}`);
  eq(await call(market, MKT.abi, 'price'), E.price(M), label + ' price');
  const openMargin = M.positions.filter(p => p.open).reduce((s, p) => s + p.margin, 0n);
  eq(margins, openMargin, label + ' margins');
  eq(await balanceOf(market), curve + pool + margins, label + ' solvency: balance == curve + pool + margins');
}

/* 1. the JPEG Trading docs example */
{
  console.log('1. docs example: 1000 editions from 0.05, minimum target');
  const u = wallet(); await fund(u, '100');
  const { market } = await createMarket(u, { name: 'Docs', symbol: 'DOCS', base: parseEther('0.05'), supply: 1000n });
  const [, , step, maximum, principal, target, capacity] = await call(market, MKT.abi, 'terms');
  const T = E.makeTerms(parseEther('0.05'), 1000n, null);
  eq(step, T.step, 'step'); eq(maximum, T.maximum, 'maximum'); eq(principal, T.principal, 'principal'); eq(target, T.target, 'target'); eq(capacity, T.capacity, 'capacity');
  let buys = 0, spent = 0n, live = false;
  while (!live) {
    const [raw, fee, total] = await call(market, MKT.abi, 'quoteBuy', [1n]);
    const r = await tx(u, market, MKT.abi, 'buy', [1n], total);
    if (r.reverted) { ok(false, 'docs buy reverted ' + r.reason); break; }
    buys++; spent += total; live = r.logs.some(l => l.eventName === 'PoolLive');
  }
  const [, , pool] = await call(market, MKT.abi, 'stats');
  ok(buys === 323, 'docs: 323 buys to open perps', buys);
  ok(formatEther(spent) === '19.6876575', 'docs: 19.6876575 ETH spent', formatEther(spent));
  ok(formatEther(pool) === '0.9375075', 'docs: pool 0.9375075', formatEther(pool));
}

/* 2. mixed scenario, contract vs engine after every step */
{
  console.log('2. mixed scenario vs engine');
  const users = await Promise.all([0, 1, 2, 3].map(async () => { const w = wallet(); await fund(w, '5000'); return w; }));
  const base = parseEther('0.01'), supply = 100n;
  const { market } = await createMarket(users[0], { name: 'Robin Frog', symbol: 'FROG', base, supply });
  const M = E.newMarket({ id: 'frog', name: 'Robin Frog', symbol: 'FROG', art: 'frog', creator: users[0].hex, base, supply, target: null, now });
  const P = Object.fromEntries(users.map(u => [u.hex, { pid: u.hex, wallet: 10n ** 30n }]));
  const ids = Object.fromEntries(users.map(u => [u.hex, []]));

  async function buyStep(u, n) {
    const q = E.quoteEditions(M, n, true);
    const r = await tx(u, market, MKT.abi, 'buy', [BigInt(n)], q.total + parseEther('0.01'));
    ok(!r.reverted, `buy ${n}`, r.reason);
    const b = r.logs.find(l => l.eventName === 'Bought');
    for (let i = 0; i < n; i++) ids[u.hex].push(b.args.firstId + BigInt(i));
    E.buyEditions(M, u.hex, n, P[u.hex], now);
  }
  async function sellStep(u, n) {
    const take = ids[u.hex].splice(0, n), q = E.quoteEditions(M, n, false);
    const r = await tx(u, market, MKT.abi, 'sell', [take, q.total]);
    ok(!r.reverted, `sell ${n}`, r.reason);
    eq(r.logs.find(l => l.eventName === 'Sold').args.raw, q.raw, 'sell raw');
    E.sellEditions(M, u.hex, n, P[u.hex], now);
  }
  async function openStep(u, long, margin, lev) {
    const fee = await call(market, MKT.abi, 'openFee', [margin, lev]);
    const r = await tx(u, market, MKT.abi, 'open', [long, margin, lev], margin + fee);
    let engineErr = null, res = null;
    try { res = E.openPosition(M, u.hex, long, margin, lev, P[u.hex], now); } catch (e) { engineErr = e.message; }
    ok(r.reverted === !!engineErr, `open ${long ? 'long' : 'short'} ${formatEther(margin)}×${lev} agrees (contract ${r.reason || 'ok'}, engine ${engineErr || 'ok'})`);
    if (res) { const o = r.logs.find(l => l.eventName === 'Opened').args; eq(o.id, res.pos.id, 'position id'); eq(o.qty, res.pos.qty, 'position qty'); eq(o.reserve, res.pos.reserve, 'position reserve'); eq(o.entry, res.pos.entry, 'entry'); }
    return res && res.pos.id;
  }
  async function markStep(id, label) {
    const k = await call(market, MKT.abi, 'mark', [BigInt(id)]), pos = M.positions.find(p => p.id === id), j = E.mark(M, pos, now);
    eq(k.pnl, j.pnl, label + ' pnl'); eq(k.borrow, j.borrow, label + ' borrow'); eq(k.equity, j.equity, label + ' equity'); eq(k.payout, j.payout, label + ' payout');
    ok(k.liquidatable === j.liquidatable, label + ' liquidatable', `${k.liquidatable} vs ${j.liquidatable}`);
    return j;
  }
  async function closeStep(u, id, label) {
    const pos = M.positions.find(p => p.id === id), j = E.mark(M, pos, now);
    const r = await tx(u, market, MKT.abi, 'close', [BigInt(id)]);
    let engineErr = null, res = null;
    try { res = E.closePosition(M, u.hex, id, P, now); } catch (e) { engineErr = e.message; }
    ok(r.reverted === !!engineErr, label + ` agrees (contract ${r.reason || 'ok'}, engine ${engineErr || 'ok'})`);
    if (res) { const c = r.logs.find(l => l.eventName === 'Closed').args; eq(c.payout, res.payout, label + ' payout'); eq(c.reward, res.reward, label + ' reward'); }
    return { reverted: r.reverted, j };
  }

  const [a, b, c, d] = users;
  const early = await openStep(a, true, parseEther('0.001'), 2);
  ok(early === undefined || early === null, 'open before live is refused');
  for (const [u, n] of [[a, 5], [b, 3], [c, 4], [a, 2], [d, 5]]) await buyStep(u, n);
  await check(M, market, 'after buys');
  await sellStep(b, 2); await check(M, market, 'after sell');
  for (let i = 0; i < 14 && !M.live; i++) await buyStep([a, b, c, d][i % 4], 4);
  await check(M, market, 'pool live');
  ok(M.live, 'pool opened in the scenario');
  const maxL = await call(market, MKT.abi, 'maxCollateral', [3, true]);
  eq(maxL, E.maxCollateral(M, 3, true), 'maxCollateral long 3x');
  const L1 = await openStep(c, true, maxL > parseEther('0.02') ? parseEther('0.02') : maxL / 2n, 3);
  const S1 = await openStep(d, false, parseEther('0.003'), 2);
  const tooBig = await openStep(b, true, parseEther('50'), 3);
  ok(!tooBig, 'oversized position refused');
  await check(M, market, 'after opens');
  now += 3600 * 7; for (const [u, n] of [[a, 4], [b, 4], [a, 3]]) await buyStep(u, n);
  if (L1) await markStep(L1, 'long after pump');
  if (S1) await markStep(S1, 'short after pump');
  if (S1) { const r = await closeStep(a, S1, 'stranger closing a healthy short'); }
  if (L1) { const r = await closeStep(c, L1, 'owner closes long in profit'); console.log('  long closed, pnl', formatEther(r.j.pnl), 'payout', formatEther(r.j.payout)); }
  await check(M, market, 'after closes');
  /* crash the price under a fresh 3x long and liquidate it */
  const L2 = await openStep(b, true, parseEther('0.004'), 3);
  for (const u of [a, b, c, d]) while (ids[u.hex].length >= 4) await sellStep(u, 4);
  now += 86400 * 3;
  console.log('  positions: long', L1, 'short', S1, 'crash long', L2, 'price', formatEther(E.price(M)));
  if (L2) { const j = await markStep(L2, 'long after crash'); console.log('  crash long liquidatable:', j.liquidatable, 'equity', formatEther(j.equity)); const r = await closeStep(d, L2, 'liquidation by a stranger'); ok(j.liquidatable ? !r.reverted : r.reverted, 'liquidation allowed only when liquidatable'); }
  if (S1 && M.positions.find(p => p.id === S1).open) await closeStep(d, S1, 'owner closes short');
  await check(M, market, 'end of scenario');
}

/* 4. a position that really gets liquidated */
{
  console.log('4. liquidation');
  const us = await Promise.all([0, 1, 2].map(async () => { const w = wallet(); await fund(w, '5000'); return w; }));
  const [whale, trader, keeper] = us, base = parseEther('0.01'), supply = 100n;
  const { market } = await createMarket(whale, { name: 'Liq', symbol: 'LIQ', base, supply });
  const M = E.newMarket({ id: 'liq', name: 'Liq', symbol: 'LIQ', art: 'x', creator: whale.hex, base, supply, target: null, now });
  const P = Object.fromEntries(us.map(u => [u.hex, { pid: u.hex, wallet: 10n ** 30n }]));
  const held = [];
  while (!M.live || M.supply < 70n) {
    const q = E.quoteEditions(M, 10, true);
    const r = await tx(whale, market, MKT.abi, 'buy', [10n], q.total);
    const b = r.logs.find(l => l.eventName === 'Bought'); for (let i = 0n; i < 10n; i++) held.push(b.args.firstId + i);
    E.buyEditions(M, whale.hex, 10, P[whale.hex], now);
  }
  const margin = E.maxCollateral(M, 3, true) / 2n;
  const fee = await call(market, MKT.abi, 'openFee', [margin, 3]);
  const o = await tx(trader, market, MKT.abi, 'open', [true, margin, 3], margin + fee);
  ok(!o.reverted, 'max-ish 3x long opens', o.reason);
  const { pos } = E.openPosition(M, trader.hex, true, margin, 3, P[trader.hex], now);
  let j = E.mark(M, pos, now);
  while (held.length && !j.liquidatable) {
    const q = E.quoteEditions(M, 1, false);
    await tx(whale, market, MKT.abi, 'sell', [[held.pop()], 0n]);
    E.sellEditions(M, whale.hex, 1, P[whale.hex], now);
    j = E.mark(M, pos, now);
  }
  const k = await call(market, MKT.abi, 'mark', [pos.id]);
  ok(j.equity > 0n, 'liquidated with equity left, so the reward path runs', formatEther(j.equity));
  eq(k.equity, j.equity, 'crashed long equity');
  ok(k.liquidatable && j.liquidatable, 'crashed long is liquidatable', `${k.liquidatable}/${j.liquidatable}`);
  const before = await balanceOf(trader.hex);
  const r = await tx(keeper, market, MKT.abi, 'close', [pos.id]);
  ok(!r.reverted, 'keeper liquidates', r.reason);
  const res = E.closePosition(M, keeper.hex, pos.id, P, now);
  const c = r.logs.find(l => l.eventName === 'Closed').args;
  ok(c.liquidated === true, 'Closed event marks liquidation');
  eq(c.reward, res.reward, 'liquidation reward'); eq(c.payout, res.payout, 'owner remainder');
  eq((await balanceOf(trader.hex)) - before, res.payout, 'owner received the remainder');
  console.log('  liquidated: equity', formatEther(j.equity), 'reward', formatEther(res.reward), 'owner gets', formatEther(res.payout));
  await check(M, market, 'after liquidation');
}

/* 3. guards */
{
  console.log('3. guards');
  const u = wallet(), v = wallet(); await fund(u, '10'); await fund(v, '10');
  const { market } = await createMarket(u, { name: 'Guard', symbol: 'GRD', base: parseEther('0.002'), supply: 500n });
  const [raw, fee, total] = await call(market, MKT.abi, 'quoteBuy', [2n]);
  ok((await tx(u, market, MKT.abi, 'buy', [2n], total - 1n)).reverted, 'underpaid buy reverts');
  const r = await tx(u, market, MKT.abi, 'buy', [2n], total + parseEther('1'));
  ok(!r.reverted, 'overpaid buy succeeds');
  ok((await balanceOf(market)) === total, 'overpayment refunded', formatEther(await balanceOf(market)));
  ok((await tx(v, market, MKT.abi, 'sell', [[1n], 0n])).reverted, 'selling someone else\'s edition reverts');
  ok((await tx(u, market, MKT.abi, 'buy', [21n], parseEther('5'))).reverted, 'batch above 20 reverts');
  ok((await tx(u, market, MKT.abi, 'initialize', [u.hex, 'x', 'x', 'x', parseEther('0.01'), 100n, 0n])).reverted, 'market cannot be initialised twice');
  ok((await tx(u, impl, MKT.abi, 'initialize', [u.hex, 'x', 'x', 'x', parseEther('0.01'), 100n, 0n])).reverted, 'implementation cannot be initialised');
  ok((await createMarket(u, { name: 'Bad', symbol: 'BAD', base: 1n, supply: 100n })).reverted, 'bad terms revert');
  const sellQ = await call(market, MKT.abi, 'quoteSell', [1n]);
  ok((await tx(u, market, MKT.abi, 'sell', [[1n], sellQ[2] + 1n])).reverted, 'sell below minOut reverts');
  ok(!(await tx(u, market, MKT.abi, 'transferFrom', [u.hex, v.hex, 2n])).reverted, 'editions transfer like any ERC-721');
  ok(!(await tx(v, market, MKT.abi, 'sell', [[2n], 0n])).reverted, 'new owner can sell a transferred edition');
  const created = await createMarket(u, { name: 'Gas', symbol: 'GAS', base: parseEther('0.01'), supply: 100n });
  console.log('  gas: create market', created.gas.toString());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
