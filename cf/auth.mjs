const textEncoder = new TextEncoder();
const SALT_BYTES = 16;
const HASH_BITS = 256;
const ITERATIONS = 100_000;

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

export function validateUsername(username) {
  return typeof username === "string" && /^[A-Za-z0-9_]{3,20}$/.test(username);
}

export function validatePassword(password) {
  return typeof password === "string" && password.length >= 8;
}

export function validateGroupName(name) {
  return typeof name === "string" &&
    name.trim() === name &&
    /^[A-Za-z0-9 _-]{3,24}$/.test(name);
}

export function canKick(actorRole, targetRole) {
  return actorRole === "owner" ? targetRole !== "owner" : actorRole === "admin" && targetRole === "member";
}

export function canChangeRole(actorRole, targetRole, newRole) {
  if (actorRole !== "owner" || !["admin", "member", "owner"].includes(newRole)) return false;
  if (newRole === "owner") return targetRole !== "owner";
  return targetRole !== "owner";
}

export function clampReportedHashes(hashes, threads, elapsedMs) {
  const safeHashes = Number.isFinite(hashes) && hashes > 0 ? hashes : 0;
  const safeThreads = Math.max(1, Math.min(16, Number(threads) || 1));
  const safeElapsed = Math.max(0, Number(elapsedMs) || 0);
  return Math.floor(Math.min(safeHashes, 60 * safeThreads * safeElapsed / 1000));
}

export function computePoints(reportedHashes, shares) {
  const safeReportedHashes = Number.isFinite(Number(reportedHashes)) ? Math.max(0, Math.floor(Number(reportedHashes))) : 0;
  const safeShares = Number.isFinite(Number(shares)) ? Math.max(0, Math.floor(Number(shares))) : 0;
  return safeReportedHashes + 20_000 * safeShares;
}

export async function hashPassword(password, salt = null) {
  const saltBytes = salt ? base64ToBytes(salt) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    HASH_BITS
  );
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(saltBytes) };
}

export async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = await hashPassword(password, salt);
  const expected = base64ToBytes(hash);
  const actual = base64ToBytes(candidate.hash);
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ actual[index];
  return difference === 0;
}

export async function hashToken(token) {
  return bytesToBase64(await sha256(textEncoder.encode(token)));
}

export function createSessionToken() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export function targetToDifficulty(target) {
  if (typeof target !== "string" || !/^[0-9a-f]+$/i.test(target) || ![8, 16].includes(target.length)) {
    return 0;
  }
  const bytes = target.match(/../g).reverse().join("");
  const value = BigInt(`0x${bytes}`);
  if (value === 0n) return 0;
  return Number((1n << BigInt(target.length * 4)) / value);
}
