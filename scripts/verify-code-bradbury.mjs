// Checks that the code deployed at an address on Bradbury testnet is byte-identical to contracts/aid_pledge.bradbury.py.
//
//   node scripts/verify-code-bradbury.mjs <contract-address>

import { readFileSync } from "fs";
import { reader } from "./bradbury.mjs";

const address = process.argv[2];
const local = readFileSync(new URL("../contracts/aid_pledge.bradbury.py", import.meta.url), "utf8");
let onchain = await reader.getContractCode(address);
if (onchain instanceof Uint8Array) onchain = new TextDecoder().decode(onchain);
if (/^[A-Za-z0-9+/=]+$/.test(onchain) && !onchain.includes("\n")) onchain = Buffer.from(onchain, "base64").toString("utf8");
console.log(onchain === local ? `identical (${local.length} bytes)` : `DIFFERENT (on-chain ${onchain.length} bytes, local ${local.length} bytes)`);
process.exit(onchain === local ? 0 : 1);
