import assert from "node:assert/strict";
import {
  canChangeRole,
  canKick,
  clampReportedHashes,
  hashPassword,
  targetToDifficulty,
  validateGroupName,
  validateUsername,
  verifyPassword
} from "./cf/auth.mjs";

assert.equal(validateUsername("valid_user"), true);
assert.equal(validateUsername("no"), false);
assert.equal(validateUsername("bad-name"), false);
assert.equal(validateGroupName("Team Alpha_1"), true);
assert.equal(validateGroupName(" bad"), false);
assert.equal(canKick("owner", "admin"), true);
assert.equal(canKick("admin", "admin"), false);
assert.equal(canChangeRole("owner", "member", "admin"), true);
assert.equal(canChangeRole("admin", "member", "admin"), false);
assert.equal(clampReportedHashes(10000, 4, 1000), 240);
assert.equal(clampReportedHashes(10000, 8, 1000), 240);
assert.equal(clampReportedHashes(10000, 4, 0), 0);
assert.equal(targetToDifficulty("b2df0000"), 75000);
assert.equal(targetToDifficulty("ffffffffffffffff"), 1);

const password = await hashPassword("correct horse battery staple");
assert.equal(await verifyPassword("correct horse battery staple", password.hash, password.salt), true);
assert.equal(await verifyPassword("wrong password", password.hash, password.salt), false);
console.log("Auth helper test passed: validation, PBKDF2 verification, and difficulty");
