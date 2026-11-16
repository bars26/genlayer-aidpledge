// genlayer-js 2.0.0-rc.2 reads Bradbury's fee policy without a sender, and the node then rejects the read as coming
// from the unfunded zero address ("insufficient funds"). This adds the client's account to those two reads.
// Runs on postinstall; idempotent; a no-op when the package is absent or already fixed upstream.

import { existsSync, readFileSync, writeFileSync } from "fs";

const FIXES = [
  ["const roundFees = await publicClient.readContract({\n        address: client.chain.feeManagerContract.address,",
   "const roundFees = await publicClient.readContract({\n        account: client.account,\n        address: client.chain.feeManagerContract.address,"],
  ["await publicClient.call({ to: address, data, gasPrice: receiptGasPrice, batch: false })",
   "await publicClient.call({ account: client.account, to: address, data, gasPrice: receiptGasPrice, batch: false })"],
];

for (const root of ["node_modules/genlayer-js-bradbury", "frontend/node_modules/genlayer-js-bradbury"]) {
  for (const file of ["dist/index.js", "dist/index.cjs"]) {
    const path = `${root}/${file}`;
    if (!existsSync(path)) continue;
    let code = readFileSync(path, "utf8");
    let changed = 0;
    for (const [from, to] of FIXES) if (code.includes(from)) { code = code.replace(from, to); changed++; }
    if (changed) { writeFileSync(path, code); console.log(`patched ${path} (${changed})`); }
  }
}
