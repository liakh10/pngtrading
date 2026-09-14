import fs from 'node:fs';
import { createPublicClient, http, encodeDeployData, formatEther } from 'viem';
const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const M = JSON.parse(fs.readFileSync('artifacts/PngMarket.json')), F = JSON.parse(fs.readFileSync('artifacts/PngFactory.json'));
const from = '0x' + [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
const so = [{ address: from, balance: 10n ** 18n }], gp = await c.getGasPrice();
const g1 = await c.estimateGas({ account: from, data: M.bytecode, stateOverride: so });
const g2 = await c.estimateGas({ account: from, data: encodeDeployData({ abi: F.abi, bytecode: F.bytecode, args: ['0x0000000000000000000000000000000000000001'] }), stateOverride: so });
console.log('mainnet deploy estimate · market impl gas', g1, '≈', formatEther(g1 * gp), 'ETH · factory gas', g2, '≈', formatEther(g2 * gp), 'ETH');
