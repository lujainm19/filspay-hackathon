import { randomInt } from "node:crypto";

// S2 fix: what was wrong — these used Math.random(). Why — Math.random is a
// fast, non-cryptographic generator; after seeing a handful of outputs an
// attacker can work out the next ones. What it broke — OTP codes, payment-link
// tokens and admin invite codes all came from here, so they were guessable.
// crypto.randomInt draws from the OS's secure random source and has no bias.

/** Generates a string of `n` random decimal digits (e.g. "042817"). */
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += String(randomInt(10));
  }
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
