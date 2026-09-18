import assert from "node:assert/strict";
import { hashPassword, targetToDifficulty, validateUsername, verifyPassword } from "./cf/auth.mjs";

assert.equal(validateUsername("valid_user"), true);
assert.equal(validateUsername("no"), false);
assert.equal(validateUsername("bad-name"), false);
assert.equal(targetToDifficulty("b2df0000"), 75000);
assert.equal(targetToDifficulty("ffffffffffffffff"), 1);

const password = await hashPassword("correct horse battery staple");
assert.equal(await verifyPassword("correct horse battery staple", password.hash, password.salt), true);
assert.equal(await verifyPassword("wrong password", password.hash, password.salt), false);
console.log("Auth helper test passed: validation, PBKDF2 verification, and difficulty");
