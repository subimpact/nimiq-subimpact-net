/**
 * BLAKE2b-256, vendored.
 *
 * A Nimiq address is the first 20 bytes of BLAKE2b-256 over the 32-byte public key, so
 * verifying a signed-in wallet needs this one hash and nothing else. WebCrypto has no
 * BLAKE2 and the worker has no package.json — adding a dependency would mean adding a
 * build step to a file wrangler currently ships as-is — so the algorithm is carried here.
 *
 * This is the reference 32-bit-limb formulation of RFC 7693 (the shape blakejs uses,
 * BSD-licensed): BLAKE2b is defined over 64-bit words, which JavaScript numbers cannot
 * hold exactly, so every word is a pair of Uint32Array slots, low limb first. It is the
 * unkeyed, no-salt, no-personalization variant — all this codebase needs.
 *
 * Checked against RFC 7693's own vectors and against Node's blake2b512 in test-local.mjs.
 */

// IV = the first 64 bits of the fractional parts of the square roots of the first eight
// primes, as 32-bit limbs, low limb first.
const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1,
  0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab,
  0x137e2179, 0x5be0cd19,
]);

// The message-word permutation for the twelve rounds, pre-doubled so each entry indexes
// straight into the 32-bit-limb message array.
// prettier-ignore
const SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
];
const SIGMA82 = new Uint8Array(SIGMA8.map((value) => value * 2));

// Working vector and message block, allocated once rather than per call. Sharing them
// across requests is safe because blake2b() below never awaits: it runs to completion
// within one synchronous turn, so two requests in the same isolate cannot interleave.
const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** v[a,a+1] += v[b,b+1], as one 64-bit add over two limbs. */
function add64AA(vector, a, b) {
  const low = vector[a] + vector[b];
  let high = vector[a + 1] + vector[b + 1];
  if (low >= 0x100000000) high++;
  vector[a] = low;
  vector[a + 1] = high;
}

/** v[a,a+1] += (b1<<32 | b0), the constant-operand form of the above. */
function add64AC(vector, a, b0, b1) {
  let low = vector[a] + b0;
  if (b0 < 0) low += 0x100000000;
  let high = vector[a + 1] + b1;
  if (low >= 0x100000000) high++;
  vector[a] = low;
  vector[a + 1] = high;
}

/** Little-endian 32-bit read. */
function get32(bytes, index) {
  return (
    (bytes[index] ^ (bytes[index + 1] << 8) ^ (bytes[index + 2] << 16) ^ (bytes[index + 3] << 24)) >>>
    0
  );
}

/** The G mixing function, with the four rotations (32, 24, 16, 63) inlined per limb. */
function mix(a, b, c, d, ix, iy) {
  const x0 = m[ix];
  const x1 = m[ix + 1];
  const y0 = m[iy];
  const y1 = m[iy + 1];

  add64AA(v, a, b);
  add64AC(v, a, x0, x1);

  // rotate right 32 — a limb swap
  let xor0 = v[d] ^ v[a];
  let xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor1;
  v[d + 1] = xor0;

  add64AA(v, c, d);

  // rotate right 24
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);

  add64AA(v, a, b);
  add64AC(v, a, y0, y1);

  // rotate right 16
  xor0 = v[d] ^ v[a];
  xor1 = v[d + 1] ^ v[a + 1];
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);

  add64AA(v, c, d);

  // rotate right 63
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

/** Compress one 128-byte block of `state.b` into `state.h`; `last` marks the final block. */
function compress(state, last) {
  for (let i = 0; i < 16; i++) {
    v[i] = state.h[i];
    v[i + 16] = IV32[i];
  }

  // Mix the byte counter in, then invert v[14] for the last block (the f0 finalization
  // flag; f1 is unused without tree hashing).
  v[24] = v[24] ^ state.t;
  v[25] = v[25] ^ (state.t / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }

  for (let i = 0; i < 32; i++) m[i] = get32(state.b, 4 * i);

  for (let round = 0; round < 12; round++) {
    const s = SIGMA82.subarray(round * 16, round * 16 + 16);
    mix(0, 8, 16, 24, s[0], s[1]);
    mix(2, 10, 18, 26, s[2], s[3]);
    mix(4, 12, 20, 28, s[4], s[5]);
    mix(6, 14, 22, 30, s[6], s[7]);
    mix(0, 10, 20, 30, s[8], s[9]);
    mix(2, 12, 22, 24, s[10], s[11]);
    mix(4, 14, 16, 26, s[12], s[13]);
    mix(6, 8, 18, 28, s[14], s[15]);
  }

  for (let i = 0; i < 16; i++) state.h[i] = state.h[i] ^ v[i] ^ v[i + 16];
}

/**
 * BLAKE2b over `input`, `outlen` bytes out (1..64). Unkeyed: the parameter block is all
 * zero except the digest length, fanout 1 and depth 1 — the 0x01010000 below.
 */
export function blake2b(input, outlen = 32) {
  if (!(outlen >= 1 && outlen <= 64)) throw new Error('blake2b: invalid output length');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  const state = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0 };
  for (let i = 0; i < 16; i++) state.h[i] = IV32[i];
  state.h[0] ^= 0x01010000 ^ outlen;

  for (let i = 0; i < bytes.length; i++) {
    // A full buffer is only compressed once the next byte arrives: BLAKE2b's counter
    // must say "this block is not the last" while compressing it, and only the byte
    // after it proves that.
    if (state.c === 128) {
      state.t += state.c;
      compress(state, false);
      state.c = 0;
    }
    state.b[state.c++] = bytes[i];
  }

  state.t += state.c;
  // The final block is zero-padded to 128 bytes; the counter still reads the true length.
  while (state.c < 128) state.b[state.c++] = 0;
  compress(state, true);

  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = (state.h[i >> 2] >> (8 * (i & 3))) & 0xff;
  return out;
}

/** BLAKE2b-256 — the digest size Nimiq addresses are cut from. */
export function blake2b256(input) {
  return blake2b(input, 32);
}
