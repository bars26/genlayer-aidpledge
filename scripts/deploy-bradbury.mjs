// Deploys contracts/aid_pledge.bradbury.py to Bradbury testnet (Phase 2) and prints the address.
//
//   node scripts/deploy-bradbury.mjs          (deployer key: ~/.config/genlayer-demos/fieldcall-bradbury-sponsor.json)

import { readFileSync } from "fs";
import { accountFrom, clientFor, feesFor, keyFile, outcome } from "./bradbury.mjs";

const client = clientFor(accountFrom(keyFile("fieldcall-bradbury-sponsor.json")));
const code = readFileSync(new URL("../contracts/aid_pledge.bradbury.py", import.meta.url), "utf8");
const t0 = Date.now();
const hash = await client.deployContract({ code, args: [], leaderOnly: false, fees: await feesFor(client, { leader: 120n, validator: 120n }) });
console.log("deploy tx", hash);
const r = await outcome(client, hash, t0);
console.log(JSON.stringify(r));
if (!r.ok) process.exit(1);
console.log("contract", r.recipient);
