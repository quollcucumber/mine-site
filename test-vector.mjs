import { randomx_create_vm, randomx_init_cache } from "randomx.js";

const key = new TextEncoder().encode("test key 000");
const input = new TextEncoder().encode("This is a test");
const randomx = randomx_create_vm(randomx_init_cache(key));
const actual = Buffer.from(randomx.calculate_hash(input)).toString("hex");
const expected = "639183aae1bf4c9a35884cb46b09cad9175f04efd7684e7262a0ac1c2f0b4e3f";
if (actual !== expected) throw new Error(`RandomX vector mismatch: ${actual}`);
console.log(`RandomX test vector passed: ${actual}`);
