// ../../../home/claude/kurultay/packages/core/src/types.ts
var KIND_WRAP = 21059;
var KIND_INNER = 21061;
var KIND_ATTESTATION = 21062;
var ROUTE_TAG = "z";
var SLOT_SECONDS = 600;
var MAX_SKEW_SECONDS = 600;
var MAX_TEXT_BYTES = 32 * 1024;
var DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
var AGENT_HOSTS = ["claude", "codex", "copilot", "pi", "opencode", "cursor", "gemini", "vscode"];
// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/utils.js
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n, title = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new Error(`${prefix}expected integer >= 0, got ${n}`);
  }
}
function abytes(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== undefined;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash must wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out, undefined, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0;i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0;i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0;i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(undefined);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}

class HashMD {
  blockLen;
  outputLen;
  padOffset;
  isLE;
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos;i < blockLen; i++)
      buffer[i] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0;i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to ||= new this.constructor;
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);

class SHA2_32B extends HashMD {
  constructor(outputLen) {
    super(64, outputLen, 8, false);
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16;i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0;i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
}

class _SHA256 extends SHA2_32B {
  A = SHA256_IV[0] | 0;
  B = SHA256_IV[1] | 0;
  C = SHA256_IV[2] | 0;
  D = SHA256_IV[3] | 0;
  E = SHA256_IV[4] | 0;
  F = SHA256_IV[5] | 0;
  G = SHA256_IV[6] | 0;
  H = SHA256_IV[7] | 0;
  constructor() {
    super(32);
  }
}
var sha256 = /* @__PURE__ */ createHasher(() => new _SHA256, /* @__PURE__ */ oidNist(1));

// ../../../home/claude/kurultay/node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function abool(value, title = "") {
  if (typeof value !== "boolean") {
    const prefix = title && `"${title}" `;
    throw new Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new Error("positive bigint expected, got " + n);
  } else
    anumber(n);
  return n;
}
function numberToHexUnpadded(num) {
  const hex = abignumber(num).toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  n = abignumber(n);
  const res = hexToBytes(n.toString(16).padStart(len * 2, "0"));
  if (res.length !== len)
    throw new Error("number too large");
  return res;
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}
function asciiToBytes(ascii) {
  return Uint8Array.from(ascii, (c, i) => {
    const charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127) {
      throw new Error(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
    }
    return charCode;
  });
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0;n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  anumber(hashLen, "hashLen");
  anumber(qByteLen, "qByteLen");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  const u8n = (len) => new Uint8Array(len);
  const NULL = Uint8Array.of();
  const byte0 = Uint8Array.of(0);
  const byte1 = Uint8Array.of(1);
  const _maxDrbgIters = 1000;
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...msgs) => hmacFn(k, concatBytes(v, ...msgs));
  const reseed = (seed = NULL) => {
    k = h(byte0, seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(byte1, seed);
    v = h();
  };
  const gen = () => {
    if (i++ >= _maxDrbgIters)
      throw new Error("drbg: tried max amount of iterations");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = undefined;
    while (!(res = pred(gen())))
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
function validateObject(object, fields = {}, optFields = {}) {
  if (!object || typeof object !== "object")
    throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object[fieldName];
    if (isOpt && val === undefined)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}
function memoized(fn) {
  const map = new WeakMap;
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== undefined)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  if (!Fp.eql(Fp.sqr(root), n))
    throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp, n) {
  const p1div4 = (Fp.ORDER + _1n2) / _4n;
  const root = Fp.pow(n, p1div4);
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const p5div8 = (Fp.ORDER - _5n) / _8n;
  const n2 = Fp.mul(n, _2n);
  const v = Fp.pow(n2, p5div8);
  const nv = Fp.mul(n, v);
  const i = Fp.mul(Fp.mul(nv, _2n), v);
  const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    let tv1 = Fp.pow(n, c4);
    let tv2 = Fp.mul(tv1, c1);
    const tv3 = Fp.mul(tv1, c2);
    const tv4 = Fp.mul(tv1, c3);
    const e1 = Fp.eql(Fp.sqr(tv2), n);
    const e2 = Fp.eql(Fp.sqr(tv3), n);
    tv1 = Fp.cmov(tv1, tv2, e1);
    tv2 = Fp.cmov(tv4, tv3, e2);
    const e3 = Fp.eql(Fp.sqr(tv2), n);
    const root = Fp.cmov(tv1, tv2, e3);
    assertIsSquare(Fp, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1000)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    if (Fp.is0(n))
      return n;
    if (FpLegendre(Fp, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp.mul(Fp.ONE, cc);
    let t = Fp.pow(n, Q);
    let R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t))
        return Fp.ZERO;
      let i = 1;
      let t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE)) {
        i++;
        t_tmp = Fp.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = Fp.pow(c, exponent);
      M = i;
      c = Fp.sqr(b);
      t = Fp.mul(t, c);
      R = Fp.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  validateObject(field, opts);
  return field;
}
function FpPow(Fp, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp.ONE;
  if (power === _1n2)
    return num;
  let p = Fp.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : undefined);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp.mul(acc, num);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    inverted[i] = Fp.mul(acc, inverted[i]);
    return Fp.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  const p1mod2 = (Fp.ORDER - _1n2) / _2n;
  const powered = Fp.pow(n, p1mod2);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== undefined)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== undefined ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}

class _Field {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _sqrt;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _0n2)
      throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
    let _nbitLength = undefined;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        this.sqrt = opts.sqrt;
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = opts.allowedLengths?.slice();
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    this._sqrt = undefined;
    Object.preventExtensions(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw new Error("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return FpPow(this, num, power);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    if (!this._sqrt)
      this._sqrt = FpSqrt(this.ORDER);
    return this._sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  invertBatch(lst) {
    return FpInvertBatch(this, lst);
  }
  cmov(a, b, condition) {
    return condition ? b : a;
  }
}
function Field(ORDER, opts = {}) {
  return new _Field(ORDER, opts);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = false) {
  abytes(key);
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/curve.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
var pointPrecomputes = new WeakMap;
var pointWindowSizes = new WeakMap;
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw new Error("invalid wNAF");
}

class wNAF {
  BASE;
  ZERO;
  Fn;
  bits;
  constructor(Point, bits) {
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.Fn = Point.Fn;
    this.bits = bits;
  }
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3)
        p = p.add(d);
      d = d.double();
      n >>= _1n3;
    }
    return p;
  }
  precomputeWindow(point, W) {
    const { windows, windowSize } = calcWOpts(W, this.bits);
    const points = [];
    let p = point;
    let base = p;
    for (let window = 0;window < windows; window++) {
      base = p;
      points.push(base);
      for (let i = 1;i < windowSize; i++) {
        base = base.add(p);
        points.push(base);
      }
      p = base.double();
    }
    return points;
  }
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let p = this.ZERO;
    let f = this.BASE;
    const wo = calcWOpts(W, this.bits);
    for (let window = 0;window < wo.windows; window++) {
      const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      } else {
        p = p.add(negateCt(isNeg, precomputes[offset]));
      }
    }
    assert0(n);
    return { p, f };
  }
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    const wo = calcWOpts(W, this.bits);
    for (let window = 0;window < wo.windows; window++) {
      if (n === _0n3)
        break;
      const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        continue;
      } else {
        const item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    assert0(n);
    return acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      comp = this.precomputeWindow(point, W);
      if (W !== 1) {
        if (typeof transform === "function")
          comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    const W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    const W = getW(point);
    if (W === 1)
      return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  createCache(P, W) {
    validateW(W, this.bits);
    pointWindowSizes.set(P, W);
    pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
}
function mulEndoUnsafe(Point, point, k1, k2) {
  let acc = point;
  let p1 = Point.ZERO;
  let p2 = Point.ZERO;
  while (k1 > _0n3 || k2 > _0n3) {
    if (k1 & _1n3)
      p1 = p1.add(acc);
    if (k2 & _1n3)
      p2 = p2.add(acc);
    acc = acc.double();
    k1 >>= _1n3;
    k2 >>= _1n3;
  }
  return { p1, p2 };
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === undefined)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/hmac.js
class _HMAC {
  oHash;
  iHash;
  blockLen;
  outputLen;
  finished = false;
  destroyed = false;
  constructor(hash, key) {
    ahash(hash);
    abytes(key, undefined, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0;i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0;i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    abytes(out, this.outputLen, "output");
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
}
var hmac = (hash, key, message) => new _HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new _HMAC(hash, key);

// ../../../home/claude/kurultay/node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/weierstrass.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n2) / den;
function _splitEndoScalar(k, basis, n) {
  const [[a1, b1], [a2, b2]] = basis;
  const c1 = divNearest(b2 * k, n);
  const c2 = divNearest(-b1 * k, n);
  let k1 = k - c1 * a1 - c2 * a2;
  let k2 = -c1 * b1 - c2 * b2;
  const k1neg = k1 < _0n4;
  const k2neg = k2 < _0n4;
  if (k1neg)
    k1 = -k1;
  if (k2neg)
    k2 = -k2;
  const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
  if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM) {
    throw new Error("splitScalar (endomorphism): failed, k=" + k);
  }
  return { k1neg, k1, k2neg, k2 };
}
function validateSigFormat(format) {
  if (!["compact", "recovered", "der"].includes(format))
    throw new Error('Signature format must be "compact", "recovered", or "der"');
  return format;
}
function validateSigOpts(opts, def) {
  const optsn = {};
  for (let optName of Object.keys(def)) {
    optsn[optName] = opts[optName] === undefined ? def[optName] : opts[optName];
  }
  abool(optsn.lowS, "lowS");
  abool(optsn.prehash, "prehash");
  if (optsn.format !== undefined)
    validateSigFormat(optsn.format);
  return optsn;
}

class DERErr extends Error {
  constructor(m = "") {
    super(m);
  }
}
var DER = {
  Err: DERErr,
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = DER;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    decode(tag, data) {
      const { Err: E } = DER;
      let pos = 0;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length = 0;
      if (!isLong)
        length = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length = length << 8 | b;
        pos += lenLen;
        if (length < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length);
      if (v.length !== length)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length) };
    }
  },
  _int: {
    encode(num) {
      const { Err: E } = DER;
      if (num < _0n4)
        throw new E("integer: negative integers are not allowed");
      let hex = numberToHexUnpadded(num);
      if (Number.parseInt(hex[0], 16) & 8)
        hex = "00" + hex;
      if (hex.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex;
    },
    decode(data) {
      const { Err: E } = DER;
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return bytesToNumberBE(data);
    }
  },
  toSig(bytes) {
    const { Err: E, _int: int, _tlv: tlv } = DER;
    const data = abytes(bytes, undefined, "signature");
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    return { r: int.decode(rBytes), s: int.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int } = DER;
    const rs = tlv.encode(2, int.encode(sig.r));
    const ss = tlv.encode(2, int.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function weierstrass(params, extraOpts = {}) {
  const validated = createCurveFields("weierstrass", params, extraOpts);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor, n: CURVE_ORDER } = CURVE;
  validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object"
  });
  const { endo } = extraOpts;
  if (endo) {
    if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
      throw new Error('invalid endo: expected "beta": bigint and "basises": array');
    }
  }
  const lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes(_c, point, isCompressed) {
    const { x, y } = point.toAffine();
    const bx = Fp.toBytes(x);
    abool(isCompressed, "isCompressed");
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp.isOdd(y);
      return concatBytes(pprefix(hasEvenY), bx);
    } else {
      return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
    }
  }
  function pointFromBytes(bytes) {
    abytes(bytes, undefined, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    if (length === comp && (head === 2 || head === 3)) {
      const x = Fp.fromBytes(tail);
      if (!Fp.isValid(x))
        throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const evenY = Fp.isOdd(y);
      const evenH = (head & 1) === 1;
      if (evenH !== evenY)
        y = Fp.neg(y);
      return { x, y };
    } else if (length === uncomp && head === 4) {
      const L = Fp.BYTES;
      const x = Fp.fromBytes(tail.subarray(0, L));
      const y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y))
        throw new Error("bad point: is not on curve");
      return { x, y };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
    }
  }
  const encodePoint = extraOpts.toBytes || pointToBytes;
  const decodePoint = extraOpts.fromBytes || pointFromBytes;
  function weierstrassEquation(x) {
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n))
      throw new Error(`bad point coordinate ${title}`);
    return n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("Weierstrass Point expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises)
      throw new Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    if (Fp.eql(Z, Fp.ONE))
      return { x: X, y: Y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(Z);
    const x = Fp.mul(X, iz);
    const y = Fp.mul(Y, iz);
    const zz = Fp.mul(Z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x, y };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not field elements");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
    k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
    k1p = negateCt(k1neg, k1p);
    k2p = negateCt(k2neg, k2p);
    return k1p.add(k2p);
  }

  class Point {
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
    static Fp = Fp;
    static Fn = Fn;
    X;
    Y;
    Z;
    constructor(X, Y, Z) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y, true);
      this.Z = acoord("z", Z);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes) {
      const P = Point.fromAffine(decodePoint(abytes(bytes, undefined, "point")));
      P.assertValidity();
      return P;
    }
    static fromHex(hex) {
      return Point.fromBytes(hexToBytes(hex));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_3n2);
      return this;
    }
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    equals(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      let { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    add(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      let { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    multiply(scalar) {
      const { endo } = extraOpts;
      if (!Fn.isValidNot0(scalar))
        throw new Error("invalid scalar: out of range");
      let point, fake;
      const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
      if (endo) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
        const { p: k1p, f: k1f } = mul(k1);
        const { p: k2p, f: k2f } = mul(k2);
        fake = k1f.add(k2f);
        point = finishEndo(endo.beta, k1p, k2p, k1neg, k2neg);
      } else {
        const { p, f } = mul(scalar);
        point = p;
        fake = f;
      }
      return normalizeZ(Point, [point, fake])[0];
    }
    multiplyUnsafe(sc) {
      const { endo } = extraOpts;
      const p = this;
      if (!Fn.isValid(sc))
        throw new Error("invalid scalar: out of range");
      if (sc === _0n4 || p.is0())
        return Point.ZERO;
      if (sc === _1n4)
        return p;
      if (wnaf.hasCache(this))
        return this.multiply(sc);
      if (endo) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
        const { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
        return finishEndo(endo.beta, p1, p2, k1neg, k2neg);
      } else {
        return wnaf.unsafe(p, sc);
      }
    }
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    isTorsionFree() {
      const { isTorsionFree } = extraOpts;
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      return wnaf.unsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      const { clearCofactor } = extraOpts;
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    toBytes(isCompressed = true) {
      abool(isCompressed, "isCompressed");
      this.assertValidity();
      return encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const bits = Fn.BITS;
  const wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
  Point.BASE.precompute(8);
  return Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: true,
    signature: 2 * Fn.BYTES
  };
}
function ecdh(Point, ecdhOpts = {}) {
  const { Fn } = Point;
  const randomBytes_ = ecdhOpts.randomBytes || randomBytes;
  const lengths = Object.assign(getWLengths(Point.Fp, Fn), { seed: getMinHashLength(Fn.ORDER) });
  function isValidSecretKey(secretKey) {
    try {
      const num = Fn.fromBytes(secretKey);
      return Fn.isValidNot0(num);
    } catch (error) {
      return false;
    }
  }
  function isValidPublicKey(publicKey, isCompressed) {
    const { publicKey: comp, publicKeyUncompressed } = lengths;
    try {
      const l = publicKey.length;
      if (isCompressed === true && l !== comp)
        return false;
      if (isCompressed === false && l !== publicKeyUncompressed)
        return false;
      return !!Point.fromBytes(publicKey);
    } catch (error) {
      return false;
    }
  }
  function randomSecretKey(seed = randomBytes_(lengths.seed)) {
    return mapHashToField(abytes(seed, lengths.seed, "seed"), Fn.ORDER);
  }
  function getPublicKey(secretKey, isCompressed = true) {
    return Point.BASE.multiply(Fn.fromBytes(secretKey)).toBytes(isCompressed);
  }
  function isProbPub(item) {
    const { secretKey, publicKey, publicKeyUncompressed } = lengths;
    if (!isBytes(item))
      return;
    if ("_lengths" in Fn && Fn._lengths || secretKey === publicKey)
      return;
    const l = abytes(item, undefined, "key").length;
    return l === publicKey || l === publicKeyUncompressed;
  }
  function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
    if (isProbPub(secretKeyA) === true)
      throw new Error("first arg must be private key");
    if (isProbPub(publicKeyB) === false)
      throw new Error("second arg must be public key");
    const s = Fn.fromBytes(secretKeyA);
    const b = Point.fromBytes(publicKeyB);
    return b.multiply(s).toBytes(isCompressed);
  }
  const utils = {
    isValidSecretKey,
    isValidPublicKey,
    randomSecretKey
  };
  const keygen = createKeygen(randomSecretKey, getPublicKey);
  return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point, utils, lengths });
}
function ecdsa(Point, hash, ecdsaOpts = {}) {
  ahash(hash);
  validateObject(ecdsaOpts, {}, {
    hmac: "function",
    lowS: "boolean",
    randomBytes: "function",
    bits2int: "function",
    bits2int_modN: "function"
  });
  ecdsaOpts = Object.assign({}, ecdsaOpts);
  const randomBytes2 = ecdsaOpts.randomBytes || randomBytes;
  const hmac2 = ecdsaOpts.hmac || ((key, msg) => hmac(hash, key, msg));
  const { Fp, Fn } = Point;
  const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
  const { keygen, getPublicKey, getSharedSecret, utils, lengths } = ecdh(Point, ecdsaOpts);
  const defaultSigOpts = {
    prehash: true,
    lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : true,
    format: "compact",
    extraEntropy: false
  };
  const hasLargeCofactor = CURVE_ORDER * _2n2 < Fp.ORDER;
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n4;
    return number > HALF;
  }
  function validateRS(title, num) {
    if (!Fn.isValidNot0(num))
      throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
    return num;
  }
  function assertSmallCofactor() {
    if (hasLargeCofactor)
      throw new Error('"recovered" sig type is not supported for cofactor >2 curves');
  }
  function validateSigLength(bytes, format) {
    validateSigFormat(format);
    const size = lengths.signature;
    const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : undefined;
    return abytes(bytes, sizer);
  }

  class Signature {
    r;
    s;
    recovery;
    constructor(r, s, recovery) {
      this.r = validateRS("r", r);
      this.s = validateRS("s", s);
      if (recovery != null) {
        assertSmallCofactor();
        if (![0, 1, 2, 3].includes(recovery))
          throw new Error("invalid recovery id");
        this.recovery = recovery;
      }
      Object.freeze(this);
    }
    static fromBytes(bytes, format = defaultSigOpts.format) {
      validateSigLength(bytes, format);
      let recid;
      if (format === "der") {
        const { r, s } = DER.toSig(abytes(bytes));
        return new Signature(r, s);
      }
      if (format === "recovered") {
        recid = bytes[0];
        format = "compact";
        bytes = bytes.subarray(1);
      }
      const L = lengths.signature / 2;
      const r = bytes.subarray(0, L);
      const s = bytes.subarray(L, L * 2);
      return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
    }
    static fromHex(hex, format) {
      return this.fromBytes(hexToBytes(hex), format);
    }
    assertRecovery() {
      const { recovery } = this;
      if (recovery == null)
        throw new Error("invalid recovery id: must be present");
      return recovery;
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(messageHash) {
      const { r, s } = this;
      const recovery = this.assertRecovery();
      const radj = recovery === 2 || recovery === 3 ? r + CURVE_ORDER : r;
      if (!Fp.isValid(radj))
        throw new Error("invalid recovery id: sig.r+curve.n != R.x");
      const x = Fp.toBytes(radj);
      const R = Point.fromBytes(concatBytes(pprefix((recovery & 1) === 0), x));
      const ir = Fn.inv(radj);
      const h = bits2int_modN(abytes(messageHash, undefined, "msgHash"));
      const u1 = Fn.create(-h * ir);
      const u2 = Fn.create(s * ir);
      const Q = Point.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
      if (Q.is0())
        throw new Error("invalid recovery: point at infinify");
      Q.assertValidity();
      return Q;
    }
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    toBytes(format = defaultSigOpts.format) {
      validateSigFormat(format);
      if (format === "der")
        return hexToBytes(DER.hexFromSig(this));
      const { r, s } = this;
      const rb = Fn.toBytes(r);
      const sb = Fn.toBytes(s);
      if (format === "recovered") {
        assertSmallCofactor();
        return concatBytes(Uint8Array.of(this.assertRecovery()), rb, sb);
      }
      return concatBytes(rb, sb);
    }
    toHex(format) {
      return bytesToHex(this.toBytes(format));
    }
  }
  const bits2int = ecdsaOpts.bits2int || function bits2int_def(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - fnBits;
    return delta > 0 ? num >> BigInt(delta) : num;
  };
  const bits2int_modN = ecdsaOpts.bits2int_modN || function bits2int_modN_def(bytes) {
    return Fn.create(bits2int(bytes));
  };
  const ORDER_MASK = bitMask(fnBits);
  function int2octets(num) {
    aInRange("num < 2^" + fnBits, num, _0n4, ORDER_MASK);
    return Fn.toBytes(num);
  }
  function validateMsgAndHash(message, prehash) {
    abytes(message, undefined, "message");
    return prehash ? abytes(hash(message), undefined, "prehashed message") : message;
  }
  function prepSig(message, secretKey, opts) {
    const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    const h1int = bits2int_modN(message);
    const d = Fn.fromBytes(secretKey);
    if (!Fn.isValidNot0(d))
      throw new Error("invalid private key");
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (extraEntropy != null && extraEntropy !== false) {
      const e = extraEntropy === true ? randomBytes2(lengths.secretKey) : extraEntropy;
      seedArgs.push(abytes(e, undefined, "extraEntropy"));
    }
    const seed = concatBytes(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!Fn.isValidNot0(k))
        return;
      const ik = Fn.inv(k);
      const q = Point.BASE.multiply(k).toAffine();
      const r = Fn.create(q.x);
      if (r === _0n4)
        return;
      const s = Fn.create(ik * Fn.create(m + r * d));
      if (s === _0n4)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = Fn.neg(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, hasLargeCofactor ? undefined : recovery);
    }
    return { seed, k2sig };
  }
  function sign(message, secretKey, opts = {}) {
    const { seed, k2sig } = prepSig(message, secretKey, opts);
    const drbg = createHmacDrbg(hash.outputLen, Fn.BYTES, hmac2);
    const sig = drbg(seed, k2sig);
    return sig.toBytes(opts.format);
  }
  function verify(signature, message, publicKey, opts = {}) {
    const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);
    publicKey = abytes(publicKey, undefined, "publicKey");
    message = validateMsgAndHash(message, prehash);
    if (!isBytes(signature)) {
      const end = signature instanceof Signature ? ", use sig.toBytes()" : "";
      throw new Error("verify expects Uint8Array signature" + end);
    }
    validateSigLength(signature, format);
    try {
      const sig = Signature.fromBytes(signature, format);
      const P = Point.fromBytes(publicKey);
      if (lowS && sig.hasHighS())
        return false;
      const { r, s } = sig;
      const h = bits2int_modN(message);
      const is = Fn.inv(s);
      const u1 = Fn.create(h * is);
      const u2 = Fn.create(r * is);
      const R = Point.BASE.multiplyUnsafe(u1).add(P.multiplyUnsafe(u2));
      if (R.is0())
        return false;
      const v = Fn.create(R.x);
      return v === r;
    } catch (e) {
      return false;
    }
  }
  function recoverPublicKey(signature, message, opts = {}) {
    const { prehash } = validateSigOpts(opts, defaultSigOpts);
    message = validateMsgAndHash(message, prehash);
    return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
  }
  return Object.freeze({
    keygen,
    getPublicKey,
    getSharedSecret,
    utils,
    lengths,
    Point,
    sign,
    verify,
    recoverPublicKey,
    Signature,
    hash
  });
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/secp256k1.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var secp256k1_CURVE = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
};
var secp256k1_ENDO = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
    [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
  ]
};
var _0n5 = /* @__PURE__ */ BigInt(0);
var _2n3 = /* @__PURE__ */ BigInt(2);
function sqrtMod(y) {
  const P = secp256k1_CURVE.p;
  const _3n = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n, P) * b3 % P;
  const b9 = pow2(b6, _3n, P) * b3 % P;
  const b11 = pow2(b9, _2n3, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n3, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
var Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod });
var Pointk1 = /* @__PURE__ */ weierstrass(secp256k1_CURVE, {
  Fp: Fpk1,
  endo: secp256k1_ENDO
});
var secp256k1 = /* @__PURE__ */ ecdsa(Pointk1, sha256);
var TAGGED_HASH_PREFIXES = {};
function taggedHash(tag, ...messages) {
  let tagP = TAGGED_HASH_PREFIXES[tag];
  if (tagP === undefined) {
    const tagH = sha256(asciiToBytes(tag));
    tagP = concatBytes(tagH, tagH);
    TAGGED_HASH_PREFIXES[tag] = tagP;
  }
  return sha256(concatBytes(tagP, ...messages));
}
var pointToBytes = (point) => point.toBytes(true).slice(1);
var hasEven = (y) => y % _2n3 === _0n5;
function schnorrGetExtPubKey(priv) {
  const { Fn, BASE } = Pointk1;
  const d_ = Fn.fromBytes(priv);
  const p = BASE.multiply(d_);
  const scalar = hasEven(p.y) ? d_ : Fn.neg(d_);
  return { scalar, bytes: pointToBytes(p) };
}
function lift_x(x) {
  const Fp = Fpk1;
  if (!Fp.isValidNot0(x))
    throw new Error("invalid x: Fail if x ≥ p");
  const xx = Fp.create(x * x);
  const c = Fp.create(xx * x + BigInt(7));
  let y = Fp.sqrt(c);
  if (!hasEven(y))
    y = Fp.neg(y);
  const p = Pointk1.fromAffine({ x, y });
  p.assertValidity();
  return p;
}
var num = bytesToNumberBE;
function challenge(...args) {
  return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));
}
function schnorrGetPublicKey(secretKey) {
  return schnorrGetExtPubKey(secretKey).bytes;
}
function schnorrSign(message, secretKey, auxRand = randomBytes(32)) {
  const { Fn } = Pointk1;
  const m = abytes(message, undefined, "message");
  const { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey);
  const a = abytes(auxRand, 32, "auxRand");
  const t = Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a)));
  const rand = taggedHash("BIP0340/nonce", t, px, m);
  const { bytes: rx, scalar: k } = schnorrGetExtPubKey(rand);
  const e = challenge(rx, px, m);
  const sig = new Uint8Array(64);
  sig.set(rx, 0);
  sig.set(Fn.toBytes(Fn.create(k + e * d)), 32);
  if (!schnorrVerify(sig, m, px))
    throw new Error("sign: Invalid signature produced");
  return sig;
}
function schnorrVerify(signature, message, publicKey) {
  const { Fp, Fn, BASE } = Pointk1;
  const sig = abytes(signature, 64, "signature");
  const m = abytes(message, undefined, "message");
  const pub = abytes(publicKey, 32, "publicKey");
  try {
    const P = lift_x(num(pub));
    const r = num(sig.subarray(0, 32));
    if (!Fp.isValidNot0(r))
      return false;
    const s = num(sig.subarray(32, 64));
    if (!Fn.isValidNot0(s))
      return false;
    const e = challenge(Fn.toBytes(r), pointToBytes(P), m);
    const R = BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e)));
    const { x, y } = R.toAffine();
    if (R.is0() || !hasEven(y) || x !== r)
      return false;
    return true;
  } catch (error) {
    return false;
  }
}
var schnorr = /* @__PURE__ */ (() => {
  const size = 32;
  const seedLength = 48;
  const randomSecretKey = (seed = randomBytes(seedLength)) => {
    return mapHashToField(seed, secp256k1_CURVE.n);
  };
  return {
    keygen: createKeygen(randomSecretKey, schnorrGetPublicKey),
    getPublicKey: schnorrGetPublicKey,
    sign: schnorrSign,
    verify: schnorrVerify,
    Point: Pointk1,
    utils: {
      randomSecretKey,
      taggedHash,
      lift_x,
      pointToBytes
    },
    lengths: {
      secretKey: size,
      publicKey: size,
      publicKeyHasPrefix: false,
      signature: size * 2,
      seed: seedLength
    }
  };
})();

// ../../../home/claude/kurultay/node_modules/.bun/nostr-tools@2.25.2+1fb4c65d43e298b9/node_modules/nostr-tools/lib/esm/pure.js
var utf8Decoder = new TextDecoder("utf-8");
var utf8Encoder = new TextEncoder;
function isHex32(input) {
  if (input.length !== 64)
    return false;
  for (let i2 = 0;i2 < 64; i2++) {
    let cc = input.charCodeAt(i2);
    if (isNaN(cc) || cc < 48 || cc > 102 || cc > 57 && cc < 97) {
      return false;
    }
  }
  return true;
}
var verifiedSymbol = Symbol("verified");
var isRecord = (obj) => obj instanceof Object;
function validateEvent(event) {
  if (!isRecord(event))
    return false;
  if (typeof event.kind !== "number")
    return false;
  if (typeof event.content !== "string")
    return false;
  if (typeof event.created_at !== "number")
    return false;
  if (typeof event.pubkey !== "string")
    return false;
  if (!isHex32(event.pubkey))
    return false;
  if (!Array.isArray(event.tags))
    return false;
  for (let i2 = 0;i2 < event.tags.length; i2++) {
    let tag = event.tags[i2];
    if (!Array.isArray(tag))
      return false;
    for (let j = 0;j < tag.length; j++) {
      if (typeof tag[j] !== "string")
        return false;
    }
  }
  return true;
}
var JS = class {
  generateSecretKey() {
    return schnorr.utils.randomSecretKey();
  }
  getPublicKey(secretKey) {
    return bytesToHex(schnorr.getPublicKey(secretKey));
  }
  finalizeEvent(t, secretKey) {
    const event = t;
    event.pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
    event.id = getEventHash(event);
    event.sig = bytesToHex(schnorr.sign(hexToBytes(getEventHash(event)), secretKey));
    event[verifiedSymbol] = true;
    return event;
  }
  verifyEvent(event) {
    if (typeof event[verifiedSymbol] === "boolean")
      return event[verifiedSymbol];
    try {
      const hash = getEventHash(event);
      if (hash !== event.id) {
        event[verifiedSymbol] = false;
        return false;
      }
      const valid = schnorr.verify(hexToBytes(event.sig), hexToBytes(hash), hexToBytes(event.pubkey));
      event[verifiedSymbol] = valid;
      return valid;
    } catch (err) {
      event[verifiedSymbol] = false;
      return false;
    }
  }
};
function serializeEvent(evt) {
  if (!validateEvent(evt))
    throw new Error("can't serialize event with wrong or missing properties");
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
}
function getEventHash(event) {
  let eventHash = sha256(utf8Encoder.encode(serializeEvent(event)));
  return bytesToHex(eventHash);
}
var i = new JS;
var generateSecretKey = i.generateSecretKey;
var getPublicKey = i.getPublicKey;
var finalizeEvent = i.finalizeEvent;
var verifyEvent = i.verifyEvent;

// ../../../home/claude/kurultay/node_modules/.bun/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/utils.js
/*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) */
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abool2(b) {
  if (typeof b !== "boolean")
    throw new Error(`boolean expected, not ${b}`);
}
function anumber2(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes2(value, length, title = "") {
  const bytes = isBytes2(value);
  const len = value?.length;
  const needsLen = length !== undefined;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists2(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput2(out, instance) {
  abytes2(out, undefined, "output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean2(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function checkOpts(defaults, opts) {
  if (opts == null || typeof opts !== "object")
    throw new Error("options must be defined");
  const merged = Object.assign(defaults, opts);
  return merged;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
var wrapCipher = (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes2(key, undefined, "key");
    if (!isLE)
      throw new Error("Non little-endian hardware is not yet supported");
    if (params.nonceLength !== undefined) {
      const nonce = args[0];
      abytes2(nonce, params.varSizeNonce ? undefined : params.nonceLength, "nonce");
    }
    const tagl = params.tagLength;
    if (tagl && args[1] !== undefined)
      abytes2(args[1], undefined, "AAD");
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output) => {
      if (output !== undefined) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes2(output, undefined, "output");
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        called = true;
        abytes2(data);
        checkOutput(cipher.encrypt.length, output);
        return cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        abytes2(data);
        if (tagl && data.length < tagl)
          throw new Error('"ciphertext" expected length bigger than tagLength=' + tagl);
        checkOutput(cipher.decrypt.length, output);
        return cipher.decrypt(data, output);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === undefined)
    return new Uint8Array(expectedLength);
  if (out.length !== expectedLength)
    throw new Error('"output" expected Uint8Array of length ' + expectedLength + ", got: " + out.length);
  if (onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function u64Lengths(dataLength, aadLength, isLE) {
  abool2(isLE);
  const num = new Uint8Array(16);
  const view = createView2(num);
  view.setBigUint64(0, BigInt(aadLength), isLE);
  view.setBigUint64(8, BigInt(dataLength), isLE);
  return num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes2(bytes) {
  return Uint8Array.from(bytes);
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/_arx.js
var encodeStr = (str) => Uint8Array.from(str.split(""), (c) => c.charCodeAt(0));
var sigma16 = encodeStr("expand 16-byte k");
var sigma32 = encodeStr("expand 32-byte k");
var sigma16_32 = u32(sigma16);
var sigma32_32 = u32(sigma32);
function rotl(a, b) {
  return a << b | a >>> 32 - b;
}
function isAligned322(b) {
  return b.byteOffset % 4 === 0;
}
var BLOCK_LEN = 64;
var BLOCK_LEN32 = 16;
var MAX_COUNTER = 2 ** 32 - 1;
var U32_EMPTY = Uint32Array.of();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
  const len = data.length;
  const block = new Uint8Array(BLOCK_LEN);
  const b32 = u32(block);
  const isAligned = isAligned322(data) && isAligned322(output);
  const d32 = isAligned ? u32(data) : U32_EMPTY;
  const o32 = isAligned ? u32(output) : U32_EMPTY;
  for (let pos = 0;pos < len; counter++) {
    core(sigma, key, nonce, b32, counter, rounds);
    if (counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    const take = Math.min(BLOCK_LEN, len - pos);
    if (isAligned && take === BLOCK_LEN) {
      const pos32 = pos / 4;
      if (pos % 4 !== 0)
        throw new Error("arx: invalid block position");
      for (let j = 0, posj;j < BLOCK_LEN32; j++) {
        posj = pos32 + j;
        o32[posj] = d32[posj] ^ b32[j];
      }
      pos += BLOCK_LEN;
      continue;
    }
    for (let j = 0, posj;j < take; j++) {
      posj = pos + j;
      output[posj] = data[posj] ^ block[j];
    }
    pos += take;
  }
}
function createCipher(core, opts) {
  const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts({ allowShortKeys: false, counterLength: 8, counterRight: false, rounds: 20 }, opts);
  if (typeof core !== "function")
    throw new Error("core must be a function");
  anumber2(counterLength);
  anumber2(rounds);
  abool2(counterRight);
  abool2(allowShortKeys);
  return (key, nonce, data, output, counter = 0) => {
    abytes2(key, undefined, "key");
    abytes2(nonce, undefined, "nonce");
    abytes2(data, undefined, "data");
    const len = data.length;
    if (output === undefined)
      output = new Uint8Array(len);
    abytes2(output, undefined, "output");
    anumber2(counter);
    if (counter < 0 || counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    if (output.length < len)
      throw new Error(`arx: output (${output.length}) is shorter than data (${len})`);
    const toClean = [];
    let l = key.length;
    let k;
    let sigma;
    if (l === 32) {
      toClean.push(k = copyBytes2(key));
      sigma = sigma32_32;
    } else if (l === 16 && allowShortKeys) {
      k = new Uint8Array(32);
      k.set(key);
      k.set(key, 16);
      sigma = sigma16_32;
      toClean.push(k);
    } else {
      abytes2(key, 32, "arx key");
      throw new Error("invalid key size");
    }
    if (!isAligned322(nonce))
      toClean.push(nonce = copyBytes2(nonce));
    const k32 = u32(k);
    if (extendNonceFn) {
      if (nonce.length !== 24)
        throw new Error(`arx: extended nonce must be 24 bytes`);
      extendNonceFn(sigma, k32, u32(nonce.subarray(0, 16)), k32);
      nonce = nonce.subarray(16);
    }
    const nonceNcLen = 16 - counterLength;
    if (nonceNcLen !== nonce.length)
      throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
    if (nonceNcLen !== 12) {
      const nc = new Uint8Array(12);
      nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
      nonce = nc;
      toClean.push(nonce);
    }
    const n32 = u32(nonce);
    runCipher(core, sigma, k32, n32, data, output, counter, rounds);
    clean2(...toClean);
    return output;
  };
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/_poly1305.js
function u8to16(a, i) {
  return a[i++] & 255 | (a[i++] & 255) << 8;
}
class Poly1305 {
  blockLen = 16;
  outputLen = 16;
  buffer = new Uint8Array(16);
  r = new Uint16Array(10);
  h = new Uint16Array(10);
  pad = new Uint16Array(8);
  pos = 0;
  finished = false;
  constructor(key) {
    key = copyBytes2(abytes2(key, 32, "key"));
    const t0 = u8to16(key, 0);
    const t1 = u8to16(key, 2);
    const t2 = u8to16(key, 4);
    const t3 = u8to16(key, 6);
    const t4 = u8to16(key, 8);
    const t5 = u8to16(key, 10);
    const t6 = u8to16(key, 12);
    const t7 = u8to16(key, 14);
    this.r[0] = t0 & 8191;
    this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
    this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
    this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
    this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
    this.r[5] = t4 >>> 1 & 8190;
    this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
    this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
    this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
    this.r[9] = t7 >>> 5 & 127;
    for (let i = 0;i < 8; i++)
      this.pad[i] = u8to16(key, 16 + 2 * i);
  }
  process(data, offset, isLast = false) {
    const hibit = isLast ? 0 : 1 << 11;
    const { h, r } = this;
    const r0 = r[0];
    const r1 = r[1];
    const r2 = r[2];
    const r3 = r[3];
    const r4 = r[4];
    const r5 = r[5];
    const r6 = r[6];
    const r7 = r[7];
    const r8 = r[8];
    const r9 = r[9];
    const t0 = u8to16(data, offset + 0);
    const t1 = u8to16(data, offset + 2);
    const t2 = u8to16(data, offset + 4);
    const t3 = u8to16(data, offset + 6);
    const t4 = u8to16(data, offset + 8);
    const t5 = u8to16(data, offset + 10);
    const t6 = u8to16(data, offset + 12);
    const t7 = u8to16(data, offset + 14);
    let h0 = h[0] + (t0 & 8191);
    let h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
    let h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
    let h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
    let h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
    let h5 = h[5] + (t4 >>> 1 & 8191);
    let h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
    let h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
    let h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
    let h9 = h[9] + (t7 >>> 5 | hibit);
    let c = 0;
    let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13;
    d0 &= 8191;
    d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
    c += d0 >>> 13;
    d0 &= 8191;
    let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13;
    d1 &= 8191;
    d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
    c += d1 >>> 13;
    d1 &= 8191;
    let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13;
    d2 &= 8191;
    d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
    c += d2 >>> 13;
    d2 &= 8191;
    let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13;
    d3 &= 8191;
    d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
    c += d3 >>> 13;
    d3 &= 8191;
    let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13;
    d4 &= 8191;
    d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
    c += d4 >>> 13;
    d4 &= 8191;
    let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13;
    d5 &= 8191;
    d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
    c += d5 >>> 13;
    d5 &= 8191;
    let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13;
    d6 &= 8191;
    d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
    c += d6 >>> 13;
    d6 &= 8191;
    let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13;
    d7 &= 8191;
    d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
    c += d7 >>> 13;
    d7 &= 8191;
    let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13;
    d8 &= 8191;
    d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
    c += d8 >>> 13;
    d8 &= 8191;
    let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13;
    d9 &= 8191;
    d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    c += d9 >>> 13;
    d9 &= 8191;
    c = (c << 2) + c | 0;
    c = c + d0 | 0;
    d0 = c & 8191;
    c = c >>> 13;
    d1 += c;
    h[0] = d0;
    h[1] = d1;
    h[2] = d2;
    h[3] = d3;
    h[4] = d4;
    h[5] = d5;
    h[6] = d6;
    h[7] = d7;
    h[8] = d8;
    h[9] = d9;
  }
  finalize() {
    const { h, pad } = this;
    const g = new Uint16Array(10);
    let c = h[1] >>> 13;
    h[1] &= 8191;
    for (let i = 2;i < 10; i++) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 8191;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 8191;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 8191;
    h[2] += c;
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 8191;
    for (let i = 1;i < 10; i++) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 8191;
    }
    g[9] -= 1 << 13;
    let mask = (c ^ 1) - 1;
    for (let i = 0;i < 10; i++)
      g[i] &= mask;
    mask = ~mask;
    for (let i = 0;i < 10; i++)
      h[i] = h[i] & mask | g[i];
    h[0] = (h[0] | h[1] << 13) & 65535;
    h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
    h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
    h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
    h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
    h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
    h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
    h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
    let f = h[0] + pad[0];
    h[0] = f & 65535;
    for (let i = 1;i < 8; i++) {
      f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
      h[i] = f & 65535;
    }
    clean2(g);
  }
  update(data) {
    aexists2(this);
    abytes2(data);
    data = copyBytes2(data);
    const { buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(buffer, 0, false);
        this.pos = 0;
      }
    }
    return this;
  }
  destroy() {
    clean2(this.h, this.r, this.buffer, this.pad);
  }
  digestInto(out) {
    aexists2(this);
    aoutput2(out, this);
    this.finished = true;
    const { buffer, h } = this;
    let { pos } = this;
    if (pos) {
      buffer[pos++] = 1;
      for (;pos < 16; pos++)
        buffer[pos] = 0;
      this.process(buffer, 0, true);
    }
    this.finalize();
    let opos = 0;
    for (let i = 0;i < 8; i++) {
      out[opos++] = h[i] >>> 0;
      out[opos++] = h[i] >>> 8;
    }
    return out;
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
}
function wrapConstructorWithKey(hashCons) {
  const hashC = (msg, key) => hashCons(key).update(msg).digest();
  const tmp = hashCons(new Uint8Array(32));
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (key) => hashCons(key);
  return hashC;
}
var poly1305 = /* @__PURE__ */ (() => wrapConstructorWithKey((key) => new Poly1305(key)))();

// ../../../home/claude/kurultay/node_modules/.bun/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/chacha.js
function chachaCore(s, k, n, out, cnt, rounds = 20) {
  let y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
  let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
  for (let r = 0;r < rounds; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = y00 + x00 | 0;
  out[oi++] = y01 + x01 | 0;
  out[oi++] = y02 + x02 | 0;
  out[oi++] = y03 + x03 | 0;
  out[oi++] = y04 + x04 | 0;
  out[oi++] = y05 + x05 | 0;
  out[oi++] = y06 + x06 | 0;
  out[oi++] = y07 + x07 | 0;
  out[oi++] = y08 + x08 | 0;
  out[oi++] = y09 + x09 | 0;
  out[oi++] = y10 + x10 | 0;
  out[oi++] = y11 + x11 | 0;
  out[oi++] = y12 + x12 | 0;
  out[oi++] = y13 + x13 | 0;
  out[oi++] = y14 + x14 | 0;
  out[oi++] = y15 + x15 | 0;
}
function hchacha(s, k, i, out) {
  let x00 = s[0], x01 = s[1], x02 = s[2], x03 = s[3], x04 = k[0], x05 = k[1], x06 = k[2], x07 = k[3], x08 = k[4], x09 = k[5], x10 = k[6], x11 = k[7], x12 = i[0], x13 = i[1], x14 = i[2], x15 = i[3];
  for (let r = 0;r < 20; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = x00;
  out[oi++] = x01;
  out[oi++] = x02;
  out[oi++] = x03;
  out[oi++] = x12;
  out[oi++] = x13;
  out[oi++] = x14;
  out[oi++] = x15;
}
var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 4,
  allowShortKeys: false
});
var xchacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 8,
  extendNonceFn: hchacha,
  allowShortKeys: false
});
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var updatePadded = (h, msg) => {
  h.update(msg);
  const leftover = msg.length % 16;
  if (leftover)
    h.update(ZEROS16.subarray(leftover));
};
var ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, ciphertext, AAD) {
  if (AAD !== undefined)
    abytes2(AAD, undefined, "AAD");
  const authKey = fn(key, nonce, ZEROS32);
  const lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, true);
  const h = poly1305.create(authKey);
  if (AAD)
    updatePadded(h, AAD);
  updatePadded(h, ciphertext);
  h.update(lengths);
  const res = h.digest();
  clean2(authKey, lengths);
  return res;
}
var _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
  const tagLength = 16;
  return {
    encrypt(plaintext, output) {
      const plength = plaintext.length;
      output = getOutput(plength + tagLength, output, false);
      output.set(plaintext);
      const oPlain = output.subarray(0, -tagLength);
      xorStream(key, nonce, oPlain, oPlain, 1);
      const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
      output.set(tag, plength);
      clean2(tag);
      return output;
    },
    decrypt(ciphertext, output) {
      output = getOutput(ciphertext.length - tagLength, output, false);
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = computeTag(xorStream, key, nonce, data, AAD);
      if (!equalBytes(passedTag, tag))
        throw new Error("invalid tag");
      output.set(ciphertext.subarray(0, -tagLength));
      xorStream(key, nonce, output, output, 1);
      clean2(tag);
      return output;
    }
  };
};
var chacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 12, tagLength: 16 }, _poly1305_aead(chacha20));
var xchacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 24, tagLength: 16 }, _poly1305_aead(xchacha20));

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/hkdf.js
function extract(hash, ikm, salt) {
  ahash(hash);
  if (salt === undefined)
    salt = new Uint8Array(hash.outputLen);
  return hmac(hash, salt, ikm);
}
var HKDF_COUNTER = /* @__PURE__ */ Uint8Array.of(0);
var EMPTY_BUFFER = /* @__PURE__ */ Uint8Array.of();
function expand(hash, prk, info, length = 32) {
  ahash(hash);
  anumber(length, "length");
  const olen = hash.outputLen;
  if (length > 255 * olen)
    throw new Error("Length must be <= 255*HashLen");
  const blocks = Math.ceil(length / olen);
  if (info === undefined)
    info = EMPTY_BUFFER;
  else
    abytes(info, undefined, "info");
  const okm = new Uint8Array(blocks * olen);
  const HMAC = hmac.create(hash, prk);
  const HMACTmp = HMAC._cloneInto();
  const T = new Uint8Array(HMAC.outputLen);
  for (let counter = 0;counter < blocks; counter++) {
    HKDF_COUNTER[0] = counter + 1;
    HMACTmp.update(counter === 0 ? EMPTY_BUFFER : T).update(info).update(HKDF_COUNTER).digestInto(T);
    okm.set(T, olen * counter);
    HMAC._cloneInto(HMACTmp);
  }
  HMAC.destroy();
  HMACTmp.destroy();
  clean(T, HKDF_COUNTER);
  return okm.slice(0, length);
}

// ../../../home/claude/kurultay/node_modules/.bun/@scure+base@2.0.0/node_modules/@scure/base/index.js
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes3(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes3(b) {
  if (!isBytes3(b))
    throw new Error("Uint8Array expected");
}
function isArrayOf(isString, arr) {
  if (!Array.isArray(arr))
    return false;
  if (arr.length === 0)
    return true;
  if (isString) {
    return arr.every((item) => typeof item === "string");
  } else {
    return arr.every((item) => Number.isSafeInteger(item));
  }
}
function afn(input) {
  if (typeof input !== "function")
    throw new Error("function expected");
  return true;
}
function astr(label, input) {
  if (typeof input !== "string")
    throw new Error(`${label}: string expected`);
  return true;
}
function anumber3(n) {
  if (!Number.isSafeInteger(n))
    throw new Error(`invalid integer: ${n}`);
}
function aArr(input) {
  if (!Array.isArray(input))
    throw new Error("array expected");
}
function astrArr(label, input) {
  if (!isArrayOf(true, input))
    throw new Error(`${label}: array of strings expected`);
}
function anumArr(label, input) {
  if (!isArrayOf(false, input))
    throw new Error(`${label}: array of numbers expected`);
}
function chain(...args) {
  const id = (a) => a;
  const wrap = (a, b) => (c) => a(b(c));
  const encode = args.map((x) => x.encode).reduceRight(wrap, id);
  const decode = args.map((x) => x.decode).reduce(wrap, id);
  return { encode, decode };
}
function alphabet(letters) {
  const lettersA = typeof letters === "string" ? letters.split("") : letters;
  const len = lettersA.length;
  astrArr("alphabet", lettersA);
  const indexes = new Map(lettersA.map((l, i) => [l, i]));
  return {
    encode: (digits) => {
      aArr(digits);
      return digits.map((i) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= len)
          throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
        return lettersA[i];
      });
    },
    decode: (input) => {
      aArr(input);
      return input.map((letter) => {
        astr("alphabet.decode", letter);
        const i = indexes.get(letter);
        if (i === undefined)
          throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
        return i;
      });
    }
  };
}
function join(separator = "") {
  astr("join", separator);
  return {
    encode: (from) => {
      astrArr("join.decode", from);
      return from.join(separator);
    },
    decode: (to) => {
      astr("join.decode", to);
      return to.split(separator);
    }
  };
}
function padding(bits, chr = "=") {
  anumber3(bits);
  astr("padding", chr);
  return {
    encode(data) {
      astrArr("padding.encode", data);
      while (data.length * bits % 8)
        data.push(chr);
      return data;
    },
    decode(input) {
      astrArr("padding.decode", input);
      let end = input.length;
      if (end * bits % 8)
        throw new Error("padding: invalid, string should have whole number of bytes");
      for (;end > 0 && input[end - 1] === chr; end--) {
        const last = end - 1;
        const byte = last * bits;
        if (byte % 8 === 0)
          throw new Error("padding: invalid, string has too much padding");
      }
      return input.slice(0, end);
    }
  };
}
function normalize(fn) {
  afn(fn);
  return { encode: (from) => from, decode: (to) => fn(to) };
}
function convertRadix(data, from, to) {
  if (from < 2)
    throw new Error(`convertRadix: invalid from=${from}, base cannot be less than 2`);
  if (to < 2)
    throw new Error(`convertRadix: invalid to=${to}, base cannot be less than 2`);
  aArr(data);
  if (!data.length)
    return [];
  let pos = 0;
  const res = [];
  const digits = Array.from(data, (d) => {
    anumber3(d);
    if (d < 0 || d >= from)
      throw new Error(`invalid integer: ${d}`);
    return d;
  });
  const dlen = digits.length;
  while (true) {
    let carry = 0;
    let done = true;
    for (let i = pos;i < dlen; i++) {
      const digit = digits[i];
      const fromCarry = from * carry;
      const digitBase = fromCarry + digit;
      if (!Number.isSafeInteger(digitBase) || fromCarry / from !== carry || digitBase - digit !== fromCarry) {
        throw new Error("convertRadix: carry overflow");
      }
      const div = digitBase / to;
      carry = digitBase % to;
      const rounded = Math.floor(div);
      digits[i] = rounded;
      if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)
        throw new Error("convertRadix: carry overflow");
      if (!done)
        continue;
      else if (!rounded)
        pos = i;
      else
        done = false;
    }
    res.push(carry);
    if (done)
      break;
  }
  for (let i = 0;i < data.length - 1 && data[i] === 0; i++)
    res.push(0);
  return res.reverse();
}
var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
var radix2carry = (from, to) => from + (to - gcd(from, to));
var powers = /* @__PURE__ */ (() => {
  let res = [];
  for (let i = 0;i < 40; i++)
    res.push(2 ** i);
  return res;
})();
function convertRadix2(data, from, to, padding) {
  aArr(data);
  if (from <= 0 || from > 32)
    throw new Error(`convertRadix2: wrong from=${from}`);
  if (to <= 0 || to > 32)
    throw new Error(`convertRadix2: wrong to=${to}`);
  if (radix2carry(from, to) > 32) {
    throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${radix2carry(from, to)}`);
  }
  let carry = 0;
  let pos = 0;
  const max = powers[from];
  const mask = powers[to] - 1;
  const res = [];
  for (const n of data) {
    anumber3(n);
    if (n >= max)
      throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    carry = carry << from | n;
    if (pos + from > 32)
      throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    pos += from;
    for (;pos >= to; pos -= to)
      res.push((carry >> pos - to & mask) >>> 0);
    const pow = powers[pos];
    if (pow === undefined)
      throw new Error("invalid carry");
    carry &= pow - 1;
  }
  carry = carry << to - pos & mask;
  if (!padding && pos >= from)
    throw new Error("Excess padding");
  if (!padding && carry > 0)
    throw new Error(`Non-zero padding: ${carry}`);
  if (padding && pos > 0)
    res.push(carry >>> 0);
  return res;
}
function radix(num) {
  anumber3(num);
  const _256 = 2 ** 8;
  return {
    encode: (bytes) => {
      if (!isBytes3(bytes))
        throw new Error("radix.encode input should be Uint8Array");
      return convertRadix(Array.from(bytes), _256, num);
    },
    decode: (digits) => {
      anumArr("radix.decode", digits);
      return Uint8Array.from(convertRadix(digits, num, _256));
    }
  };
}
function radix2(bits, revPadding = false) {
  anumber3(bits);
  if (bits <= 0 || bits > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (radix2carry(8, bits) > 32 || radix2carry(bits, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (bytes) => {
      if (!isBytes3(bytes))
        throw new Error("radix2.encode input should be Uint8Array");
      return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    },
    decode: (digits) => {
      anumArr("radix2.decode", digits);
      return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    }
  };
}
function unsafeWrapper(fn) {
  afn(fn);
  return function(...args) {
    try {
      return fn.apply(null, args);
    } catch (e) {}
  };
}
var base16 = chain(radix2(4), alphabet("0123456789ABCDEF"), join(""));
var base32 = chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), padding(5), join(""));
var base32nopad = chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), join(""));
var base32hex = chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), padding(5), join(""));
var base32hexnopad = chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), join(""));
var base32crockford = chain(radix2(5), alphabet("0123456789ABCDEFGHJKMNPQRSTVWXYZ"), join(""), normalize((s) => s.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1")));
var hasBase64Builtin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toBase64 === "function" && typeof Uint8Array.fromBase64 === "function")();
var decodeBase64Builtin = (s, isUrl) => {
  astr("base64", s);
  const re = isUrl ? /^[A-Za-z0-9=_-]+$/ : /^[A-Za-z0-9=+/]+$/;
  const alphabet = isUrl ? "base64url" : "base64";
  if (s.length > 0 && !re.test(s))
    throw new Error("invalid base64");
  return Uint8Array.fromBase64(s, { alphabet, lastChunkHandling: "strict" });
};
var base64 = hasBase64Builtin ? {
  encode(b) {
    abytes3(b);
    return b.toBase64();
  },
  decode(s) {
    return decodeBase64Builtin(s, false);
  }
} : chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), padding(6), join(""));
var base64nopad = chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), join(""));
var base64url = hasBase64Builtin ? {
  encode(b) {
    abytes3(b);
    return b.toBase64({ alphabet: "base64url" });
  },
  decode(s) {
    return decodeBase64Builtin(s, true);
  }
} : chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), padding(6), join(""));
var base64urlnopad = chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), join(""));
var genBase58 = (abc) => chain(radix(58), alphabet(abc), join(""));
var base58 = genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
var base58flickr = genBase58("123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ");
var base58xrp = genBase58("rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz");
var BECH_ALPHABET = chain(alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), join(""));
var POLYMOD_GENERATORS = [996825010, 642813549, 513874426, 1027748829, 705979059];
function bech32Polymod(pre) {
  const b = pre >> 25;
  let chk = (pre & 33554431) << 5;
  for (let i = 0;i < POLYMOD_GENERATORS.length; i++) {
    if ((b >> i & 1) === 1)
      chk ^= POLYMOD_GENERATORS[i];
  }
  return chk;
}
function bechChecksum(prefix, words, encodingConst = 1) {
  const len = prefix.length;
  let chk = 1;
  for (let i = 0;i < len; i++) {
    const c = prefix.charCodeAt(i);
    if (c < 33 || c > 126)
      throw new Error(`Invalid prefix (${prefix})`);
    chk = bech32Polymod(chk) ^ c >> 5;
  }
  chk = bech32Polymod(chk);
  for (let i = 0;i < len; i++)
    chk = bech32Polymod(chk) ^ prefix.charCodeAt(i) & 31;
  for (let v of words)
    chk = bech32Polymod(chk) ^ v;
  for (let i = 0;i < 6; i++)
    chk = bech32Polymod(chk);
  chk ^= encodingConst;
  return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]], 30, 5, false));
}
function genBech32(encoding) {
  const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
  const _words = radix2(5);
  const fromWords = _words.decode;
  const toWords = _words.encode;
  const fromWordsUnsafe = unsafeWrapper(fromWords);
  function encode(prefix, words, limit = 90) {
    astr("bech32.encode prefix", prefix);
    if (isBytes3(words))
      words = Array.from(words);
    anumArr("bech32.encode", words);
    const plen = prefix.length;
    if (plen === 0)
      throw new TypeError(`Invalid prefix length ${plen}`);
    const actualLength = plen + 7 + words.length;
    if (limit !== false && actualLength > limit)
      throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    const lowered = prefix.toLowerCase();
    const sum = bechChecksum(lowered, words, ENCODING_CONST);
    return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}`;
  }
  function decode(str, limit = 90) {
    astr("bech32.decode input", str);
    const slen = str.length;
    if (slen < 8 || limit !== false && slen > limit)
      throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
    const lowered = str.toLowerCase();
    if (str !== lowered && str !== str.toUpperCase())
      throw new Error(`String must be lowercase or uppercase`);
    const sepIndex = lowered.lastIndexOf("1");
    if (sepIndex === 0 || sepIndex === -1)
      throw new Error(`Letter "1" must be present between prefix and data only`);
    const prefix = lowered.slice(0, sepIndex);
    const data = lowered.slice(sepIndex + 1);
    if (data.length < 6)
      throw new Error("Data must be at least 6 characters long");
    const words = BECH_ALPHABET.decode(data).slice(0, -6);
    const sum = bechChecksum(prefix, words, ENCODING_CONST);
    if (!data.endsWith(sum))
      throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
    return { prefix, words };
  }
  const decodeUnsafe = unsafeWrapper(decode);
  function decodeToBytes(str) {
    const { prefix, words } = decode(str, false);
    return { prefix, words, bytes: fromWords(words) };
  }
  function encodeFromBytes(prefix, bytes) {
    return encode(prefix, toWords(bytes));
  }
  return {
    encode,
    decode,
    encodeFromBytes,
    decodeToBytes,
    decodeUnsafe,
    fromWords,
    fromWordsUnsafe,
    toWords
  };
}
var bech32 = genBech32("bech32");
var bech32m = genBech32("bech32m");
var hasHexBuiltin2 = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexBuiltin = {
  encode(data) {
    abytes3(data);
    return data.toHex();
  },
  decode(s) {
    astr("hex", s);
    return Uint8Array.fromHex(s);
  }
};
var hex = hasHexBuiltin2 ? hexBuiltin : chain(radix2(4), alphabet("0123456789abcdef"), join(""), normalize((s) => {
  if (typeof s !== "string" || s.length % 2 !== 0)
    throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
  return s.toLowerCase();
}));

// ../../../home/claude/kurultay/node_modules/.bun/nostr-tools@2.25.2+1fb4c65d43e298b9/node_modules/nostr-tools/lib/esm/nip44.js
var utf8Decoder2 = new TextDecoder("utf-8");
var utf8Encoder2 = new TextEncoder;
var minPlaintextSize = 1;
var maxPlaintextSize = 4294967295;
var extendedPrefixThreshold = 65536;
function getConversationKey(privkeyA, pubkeyB) {
  const sharedX = secp256k1.getSharedSecret(privkeyA, hexToBytes("02" + pubkeyB)).subarray(1, 33);
  return extract(sha256, sharedX, utf8Encoder2.encode("nip44-v2"));
}
function getMessageKeys(conversationKey, nonce) {
  const keys = expand(sha256, conversationKey, nonce, 76);
  return {
    chacha_key: keys.subarray(0, 32),
    chacha_nonce: keys.subarray(32, 44),
    hmac_key: keys.subarray(44, 76)
  };
}
function calcPaddedLen(len) {
  if (!Number.isSafeInteger(len) || len < 1)
    throw new Error("expected positive integer");
  if (len <= 32)
    return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}
function writeU16BE(num) {
  if (!Number.isSafeInteger(num) || num < minPlaintextSize || num > 65535)
    throw new Error("invalid plaintext size: must be between 1 and 65535 bytes");
  const arr = new Uint8Array(2);
  new DataView(arr.buffer).setUint16(0, num, false);
  return arr;
}
function writeU32BE(num) {
  if (!Number.isSafeInteger(num) || num < extendedPrefixThreshold || num > maxPlaintextSize)
    throw new Error("invalid plaintext size: must be between 65536 and 4294967295 bytes");
  const arr = new Uint8Array(4);
  new DataView(arr.buffer).setUint32(0, num, false);
  return arr;
}
function pad(plaintext) {
  const unpadded = utf8Encoder2.encode(plaintext);
  const unpaddedLen = unpadded.length;
  if (unpaddedLen < minPlaintextSize || unpaddedLen > maxPlaintextSize)
    throw new Error("invalid plaintext size: must be between 1 and 4294967295 bytes");
  const prefix = unpaddedLen >= extendedPrefixThreshold ? concatBytes(new Uint8Array([0, 0]), writeU32BE(unpaddedLen)) : writeU16BE(unpaddedLen);
  const suffix = new Uint8Array(calcPaddedLen(unpaddedLen) - unpaddedLen);
  return concatBytes(prefix, unpadded, suffix);
}
function unpad(padded) {
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const firstTwo = dv.getUint16(0);
  let unpaddedLen;
  let prefixLen;
  if (firstTwo === 0) {
    unpaddedLen = dv.getUint32(2);
    if (unpaddedLen < extendedPrefixThreshold)
      throw new Error("invalid padding");
    prefixLen = 6;
  } else {
    unpaddedLen = firstTwo;
    prefixLen = 2;
  }
  const unpadded = padded.subarray(prefixLen, prefixLen + unpaddedLen);
  if (unpaddedLen < minPlaintextSize || unpaddedLen > maxPlaintextSize || unpadded.length !== unpaddedLen || padded.length !== prefixLen + calcPaddedLen(unpaddedLen))
    throw new Error("invalid padding");
  return utf8Decoder2.decode(unpadded);
}
function hmacAad(key, message, aad) {
  if (aad.length !== 32)
    throw new Error("AAD associated data must be 32 bytes");
  const combined = concatBytes(aad, message);
  return hmac(sha256, key, combined);
}
function decodePayload(payload) {
  if (typeof payload !== "string")
    throw new Error("payload must be a valid string");
  const plen = payload.length;
  if (plen < 132)
    throw new Error("invalid payload length: " + plen);
  if (payload[0] === "#")
    throw new Error("unknown encryption version");
  let data;
  try {
    data = base64.decode(payload);
  } catch (error) {
    throw new Error("invalid base64: " + error.message);
  }
  const dlen = data.length;
  if (dlen < 99)
    throw new Error("invalid data length: " + dlen);
  const vers = data[0];
  if (vers !== 2)
    throw new Error("unknown encryption version " + vers);
  return {
    nonce: data.subarray(1, 33),
    ciphertext: data.subarray(33, -32),
    mac: data.subarray(-32)
  };
}
function encrypt(plaintext, conversationKey, nonce = randomBytes(32)) {
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
  const padded = pad(plaintext);
  const ciphertext = chacha20(chacha_key, chacha_nonce, padded);
  const mac = hmacAad(hmac_key, ciphertext, nonce);
  return base64.encode(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac));
}
function decrypt(payload, conversationKey) {
  const { nonce, ciphertext, mac } = decodePayload(payload);
  const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
  const calculatedMac = hmacAad(hmac_key, ciphertext, nonce);
  if (!equalBytes(calculatedMac, mac))
    throw new Error("invalid MAC");
  const padded = chacha20(chacha_key, chacha_nonce, ciphertext);
  return unpad(padded);
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/utils.js
function isBytes4(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber4(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes4(value, length, title = "") {
  if (isBytes4(value) && (length === undefined || value.length === length))
    return value;
  if (length !== undefined)
    anumber4(length, "length");
  const bytes = isBytes4(value);
  const ofLen = length !== undefined ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
function ahash2(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  anumber4(h.outputLen);
  anumber4(h.blockLen);
  if (h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists3(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput3(out, instance) {
  abytes4(out, undefined, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean3(...arrays) {
  for (let i = 0;i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView3(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr2(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin3 = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")();
var hexes2 = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex3(bytes) {
  abytes4(bytes);
  if (hasHexBuiltin3)
    return bytes.toHex();
  let hex = "";
  for (let i = 0;i < bytes.length; i++) {
    hex += hexes2[bytes[i]];
  }
  return hex;
}
function asciiToBase162(ch) {
  return ch >= 48 && ch <= 57 ? ch - 48 : ch >= 65 && ch <= 70 ? ch - (65 - 10) : ch >= 97 && ch <= 102 ? ch - (97 - 10) : undefined;
}
function hexToBytes2(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  if (hasHexBuiltin3) {
    try {
      return Uint8Array.fromHex(hex);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    const n1 = asciiToBase162(hex.charCodeAt(hi));
    const n2 = asciiToBase162(hex.charCodeAt(hi + 1));
    if (n1 === undefined || n2 === undefined) {
      const char = hex[hi] + hex[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function checkOpts2(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== undefined)
    aopts(opts, title);
  const merged = Object.assign(Object.create(null), defaults, opts);
  return merged;
}
function createHasher2(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts2({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(undefined);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes3(bytesLength = 32) {
  anumber4(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist2 = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/hmac.js
class _HMAC2 {
  oHash;
  iHash;
  blockLen;
  outputLen;
  canXOF = false;
  finished = false;
  destroyed = false;
  constructor(hash, key) {
    ahash2(hash);
    abytes4(key, undefined, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0;i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0;i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean3(pad);
  }
  update(buf) {
    aexists3(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists3(this);
    aoutput3(out, this);
    this.finished = true;
    const buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf);
    this.oHash.update(buf);
    this.oHash.digestInto(buf);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.canXOF = canXOF;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
}
var hmac2 = /* @__PURE__ */ (() => {
  const hmac_ = (hash, key, message) => new _HMAC2(hash, key).update(message).digest();
  hmac_.create = (hash, key) => new _HMAC2(hash, key);
  return hmac_;
})();

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/hkdf.js
var HKDF_COUNTER2 = /* @__PURE__ */ Uint8Array.of(0);
var EMPTY_BUFFER2 = /* @__PURE__ */ Uint8Array.of();
function expand2(hash, prk, info, length = 32, _recycled) {
  ahash2(hash);
  anumber4(length, "length");
  abytes4(prk, undefined, "prk");
  const olen = hash.outputLen;
  if (prk.length < olen)
    throw new Error('"prk" must be at least HashLen octets');
  if (length > 255 * olen)
    throw new Error("Length must be <= 255*HashLen");
  const blocks = Math.ceil(length / olen);
  if (info === undefined)
    info = EMPTY_BUFFER2;
  else
    abytes4(info, undefined, "info");
  if (!blocks) {
    if (_recycled)
      clean3(prk);
    return new Uint8Array;
  }
  const okm = _recycled && blocks === 1 ? prk : new Uint8Array(blocks * olen);
  const { iHash, oHash } = hmac2.create(hash, prk);
  const T = _recycled ? prk : new Uint8Array(olen);
  const worker = blocks > 1 ? _recycled?.iHash || hash.create() : undefined;
  for (let counter = 0;counter < blocks - 1; counter++) {
    HKDF_COUNTER2[0] = counter + 1;
    const iWork = iHash._cloneInto(worker);
    if (counter)
      iWork.update(T);
    iWork.update(info).update(HKDF_COUNTER2).digestInto(T);
    oHash._cloneInto(worker).update(T).digestInto(T);
    okm.set(T, olen * counter);
  }
  HKDF_COUNTER2[0] = blocks;
  if (blocks > 1)
    iHash.update(T);
  iHash.update(info).update(HKDF_COUNTER2).digestInto(T);
  oHash.update(T).digestInto(T);
  okm.set(T, olen * (blocks - 1));
  iHash.destroy();
  oHash.destroy();
  worker?.destroy();
  if (T !== okm)
    clean3(T);
  clean3(HKDF_COUNTER2);
  if (length === okm.length)
    return okm;
  const res = okm.slice(0, length);
  clean3(okm);
  return res;
}
var hkdf = (hash, ikm, salt, info, length) => {
  ahash2(hash);
  if (salt === undefined)
    salt = new Uint8Array(hash.outputLen);
  const HMAC = hmac2.create(hash, salt).update(ikm);
  return expand2(hash, HMAC.digest(), info, length, HMAC);
};

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/_md.js
function Chi2(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj2(a, b, c) {
  return a & b ^ a & c ^ b & c;
}

class HashMD2 {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView3(this.buffer);
  }
  update(data) {
    aexists3(this);
    abytes4(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0;pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView3(data);
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists3(this);
    aoutput3(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView3(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0;i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
var SHA256_IV2 = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// ../../../home/claude/kurultay/node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js
var SHA256_K2 = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W2 = /* @__PURE__ */ new Uint32Array(64);

class SHA2_32B2 extends HashMD2 {
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4)
      SHA256_W2[i] = view.getUint32(offset, false);
    for (let i = 16;i < 64; i++) {
      const W15 = SHA256_W2[i - 15];
      const W2 = SHA256_W2[i - 2];
      const s0 = rotr2(W15, 7) ^ rotr2(W15, 18) ^ W15 >>> 3;
      const s1 = rotr2(W2, 17) ^ rotr2(W2, 19) ^ W2 >>> 10;
      SHA256_W2[i] = s1 + SHA256_W2[i - 7] + s0 + SHA256_W2[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0;i < 64; i++) {
      const sigma1 = rotr2(E, 6) ^ rotr2(E, 11) ^ rotr2(E, 25);
      const T1 = H + sigma1 + Chi2(E, F, G) + SHA256_K2[i] + SHA256_W2[i] | 0;
      const sigma0 = rotr2(A, 2) ^ rotr2(A, 13) ^ rotr2(A, 22);
      const T2 = sigma0 + Maj2(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean3(SHA256_W2);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean3(this.buffer);
  }
}

class _SHA2562 extends SHA2_32B2 {
  constructor() {
    super(32, SHA256_IV2);
  }
}
var sha2562 = /* @__PURE__ */ createHasher2(() => new _SHA2562, /* @__PURE__ */ oidNist2(1));

// ../../../home/claude/kurultay/packages/core/src/util.ts
var now = () => Math.floor(Date.now() / 1000);
var randomHex = (n = 32) => bytesToHex3(randomBytes3(n));
var enc = new TextEncoder;
var dec = new TextDecoder;
var utf8 = (s) => enc.encode(s);
var fromUtf8 = (b) => dec.decode(b);
function b64urlEncode(s) {
  const bytes = utf8(s);
  let bin = "";
  for (const b of bytes)
    bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0;i < bin.length; i++)
    bytes[i] = bin.charCodeAt(i);
  return fromUtf8(bytes);
}

class Emitter {
  listeners = new Map;
  on(type, fn) {
    let set = this.listeners.get(type);
    if (!set)
      this.listeners.set(type, set = new Set);
    set.add(fn);
    return () => set.delete(fn);
  }
  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set)
      return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error("[kurultay] listener error", err);
      }
    }
  }
}

// ../../../home/claude/kurultay/packages/core/src/crypto.ts
var SALT = utf8("kurultay/v1");
function derive(secretHex, info) {
  return hkdf(sha2562, hexToBytes2(secretHex), SALT, utf8(info), 32);
}
var slotOf = (t = now()) => Math.floor(t / SLOT_SECONDS);
function routeTag(secretHex, purpose, slot) {
  const key = derive(secretHex, `route/${purpose}`);
  return bytesToHex3(hmac2(sha2562, key, utf8(`slot/${slot}`))).slice(0, 32);
}
function routeWindow(secretHex, purpose, t = now()) {
  const s = slotOf(t);
  return [s - 1, s, s + 1].map((x) => routeTag(secretHex, purpose, x));
}
function groupEncKey(groupKeyHex) {
  return derive(groupKeyHex, "enc");
}
function newSecretKey() {
  return generateSecretKey();
}
function signInner(sk, env, bind) {
  return finalizeEvent({ kind: KIND_INNER, created_at: now(), tags: [bind], content: JSON.stringify(env) }, sk);
}
function outer(content, tag) {
  const throwaway = generateSecretKey();
  return finalizeEvent({ kind: KIND_WRAP, created_at: now(), tags: [[ROUTE_TAG, tag]], content }, throwaway);
}
function wrapGroup(inner, groupKeyHex) {
  const content = encrypt(JSON.stringify(inner), groupEncKey(groupKeyHex));
  return outer(content, routeTag(groupKeyHex, "group", slotOf()));
}
function wrapInbox(inner, recipientPk, recipientInboxHex) {
  const throwaway = generateSecretKey();
  const content = encrypt(JSON.stringify(inner), getConversationKey(throwaway, recipientPk));
  return finalizeEvent({
    kind: KIND_WRAP,
    created_at: now(),
    tags: [[ROUTE_TAG, routeTag(recipientInboxHex, "inbox", slotOf())]],
    content
  }, throwaway);
}

class UnwrapError extends Error {
}
function checkInner(inner, bind) {
  if (inner.kind !== KIND_INNER)
    throw new UnwrapError("bad inner kind");
  if (!verifyEvent(inner))
    throw new UnwrapError("bad inner signature");
  if (Math.abs(now() - inner.created_at) > MAX_SKEW_SECONDS)
    throw new UnwrapError("stale or future event");
  const tag = inner.tags.find((t) => t[0] === bind[0]);
  if (!tag || tag[1] !== bind[1])
    throw new UnwrapError("inner event bound to another channel");
  const env = JSON.parse(inner.content);
  if (!env || typeof env.type !== "string")
    throw new UnwrapError("bad envelope");
  return env;
}
function unwrapGroup(ev, groupId, groupKeyHex) {
  if (!verifyEvent(ev))
    throw new UnwrapError("bad outer signature");
  const plain = decrypt(ev.content, groupEncKey(groupKeyHex));
  const inner = JSON.parse(plain);
  const env = checkInner(inner, ["g", groupId]);
  return { inner, env };
}
function unwrapInbox(ev, sk) {
  if (!verifyEvent(ev))
    throw new UnwrapError("bad outer signature");
  const plain = decrypt(ev.content, getConversationKey(sk, ev.pubkey));
  const inner = JSON.parse(plain);
  const env = checkInner(inner, ["p", getPublicKey(sk)]);
  return { inner, env };
}
function attest(ownerSk, agentPk, label, ownerName) {
  return finalizeEvent({
    kind: KIND_ATTESTATION,
    created_at: now(),
    tags: [
      ["p", agentPk],
      ["label", label],
      ["name", ownerName]
    ],
    content: "kurultay agent attestation"
  }, ownerSk);
}
function attestMany(ownerSk, agents, ownerName) {
  return finalizeEvent({
    kind: KIND_ATTESTATION,
    created_at: now(),
    tags: [...agents.map((a) => ["p", a.pk, a.label]), ["name", ownerName]],
    content: "kurultay agent attestation"
  }, ownerSk);
}
function checkAttestation(att, agentPk) {
  if (!att || att.kind !== KIND_ATTESTATION)
    return null;
  try {
    if (!verifyEvent(att))
      return null;
  } catch {
    return null;
  }
  const p = att.tags.find((t) => t[0] === "p" && t[1] === agentPk);
  if (!p)
    return null;
  return {
    owner: att.pubkey,
    label: p[2] || att.tags.find((t) => t[0] === "label")?.[1] || "",
    ownerName: att.tags.find((t) => t[0] === "name")?.[1] ?? ""
  };
}
function deriveAgent(seedHex, host) {
  const sk = derive(seedHex, `agent/${host}/key`);
  return { sk, pk: getPublicKey(sk), inbox: bytesToHex3(derive(seedHex, `agent/${host}/inbox`)) };
}
// ../../../home/claude/kurultay/packages/core/src/links.ts
var DEFAULT_APP_URL = "https://kucukkanat.github.io/kurultay/app/";
function encodeInvite(link, appUrl = DEFAULT_APP_URL) {
  return `${appUrl}#join=${b64urlEncode(JSON.stringify(link))}`;
}
function encodePair(link) {
  return `kurultay-pair:${b64urlEncode(JSON.stringify(link))}`;
}
function encodeTicket(ticket) {
  return `kurultay:${b64urlEncode(JSON.stringify(ticket))}`;
}
function decodeTicket(input) {
  const m = input.trim().match(/kurultay:([A-Za-z0-9_-]+)/);
  if (!m)
    throw new Error("Not a Kurultay agent ticket (expected kurultay:…)");
  const obj = JSON.parse(b64urlDecode(m[1]));
  if (obj?.t !== "ticket" || obj.v !== 1 || !/^[0-9a-f]{64}$/.test(obj.seed))
    throw new Error("Unsupported or damaged ticket");
  return obj;
}
function decodeLink(input) {
  const s = input.trim();
  let payload;
  const join = s.match(/#join=([A-Za-z0-9_-]+)/);
  if (join)
    payload = join[1];
  else if (s.startsWith("kurultay-pair:"))
    payload = s.slice("kurultay-pair:".length);
  else if (s.startsWith("kurultay-invite:"))
    payload = s.slice("kurultay-invite:".length);
  else if (/^[A-Za-z0-9_-]+$/.test(s))
    payload = s;
  if (!payload)
    throw new Error("Not a Kurultay invite or pairing code");
  const obj = JSON.parse(b64urlDecode(payload));
  if (obj?.t !== "invite" && obj?.t !== "pair")
    throw new Error("Unknown Kurultay link type");
  return obj;
}
// ../../../home/claude/kurultay/packages/core/src/relay.ts
class RelayConn {
  pool;
  ws;
  info;
  backoff = 1000;
  closedByUs = false;
  pendingOk = new Map;
  constructor(pool, url) {
    this.pool = pool;
    this.info = { url, status: "connecting", ephemeral: null, notices: [] };
  }
  connect() {
    this.closedByUs = false;
    this.setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.info.url);
    } catch (err) {
      this.info.lastError = String(err);
      this.setStatus("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.setStatus("open");
      for (const [id, filter] of this.pool.subs)
        this.send(["REQ", id, filter]);
      this.flushOutbox();
      this.probe();
    };
    ws.onmessage = (msg) => this.onMessage(String(msg.data));
    ws.onerror = () => {
      this.info.lastError = "websocket error";
    };
    ws.onclose = () => {
      this.setStatus("closed");
      for (const [, cb] of this.pendingOk)
        cb(false, "connection closed");
      this.pendingOk.clear();
      if (!this.closedByUs)
        this.scheduleReconnect();
    };
  }
  scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    setTimeout(() => {
      if (!this.closedByUs)
        this.connect();
    }, delay);
  }
  close() {
    this.closedByUs = true;
    for (const it of this.outbox.splice(0))
      it.resolve({ ok: false, msg: "closed" });
    try {
      this.ws?.close();
    } catch {}
  }
  setStatus(s) {
    this.info.status = s;
    this.pool._emitStatus(this.info);
  }
  send(data) {
    if (this.ws?.readyState !== 1)
      return false;
    this.ws.send(JSON.stringify(data));
    this.pool._frame({ relay: this.info.url, dir: "out", ts: Date.now(), data });
    return true;
  }
  outbox = [];
  flushOutbox() {
    const t = Date.now();
    const items = this.outbox.splice(0);
    for (const it of items) {
      if (it.until < t)
        it.resolve({ ok: false, msg: "not connected" });
      else
        this.publish(it.ev).then(it.resolve);
    }
  }
  publish(ev) {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== 1) {
        if (this.closedByUs)
          return resolve({ ok: false, msg: "closed" });
        this.outbox.push({ ev, until: Date.now() + 20000, resolve });
        return;
      }
      if (!this.send(["EVENT", ev]))
        return resolve({ ok: false, msg: "not connected" });
      const timer = setTimeout(() => {
        this.pendingOk.delete(ev.id);
        resolve({ ok: true, msg: "no OK received (assumed forwarded)" });
      }, 5000);
      this.pendingOk.set(ev.id, (ok, msg) => {
        clearTimeout(timer);
        this.pendingOk.delete(ev.id);
        resolve({ ok, msg });
      });
    });
  }
  onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(data))
      return;
    this.pool._frame({ relay: this.info.url, dir: "in", ts: Date.now(), data });
    const [type] = data;
    if (type === "EVENT") {
      const [, sub, event] = data;
      if (sub === this.probeSub)
        return this.onProbe(event);
      this.pool._event(this.info.url, sub, event);
    } else if (type === "OK") {
      const [, id, ok, msg] = data;
      this.pendingOk.get(id)?.(ok, msg ?? "");
    } else if (type === "NOTICE") {
      this.info.notices = [...this.info.notices.slice(-9), String(data[1])];
      this.pool._emitStatus(this.info);
    } else if (type === "CLOSED") {
      const [, sub, msg] = data;
      this.info.notices = [...this.info.notices.slice(-9), `CLOSED ${sub}: ${msg}`];
      this.pool._emitStatus(this.info);
    }
  }
  probeSub;
  probeTag;
  probeStart = 0;
  probeTimer;
  probe() {
    this.probeSub = "probe-" + randomHex(4);
    this.probeTag = randomHex(16);
    this.send(["REQ", this.probeSub, { kinds: [KIND_WRAP], ["#" + ROUTE_TAG]: [this.probeTag] }]);
    const ev = finalizeEvent({ kind: KIND_WRAP, created_at: now(), tags: [[ROUTE_TAG, this.probeTag]], content: "kurultay-probe" }, generateSecretKey());
    this.probeStart = Date.now();
    setTimeout(() => this.send(["EVENT", ev]), 150);
    this.probeTimer = setTimeout(() => {
      if (this.info.ephemeral === null) {
        this.info.ephemeral = false;
        this.pool._emitStatus(this.info);
      }
      this.endProbe();
    }, 6000);
  }
  onProbe(ev) {
    if (ev.tags.some((t) => t[0] === ROUTE_TAG && t[1] === this.probeTag)) {
      this.info.ephemeral = true;
      this.info.latencyMs = Date.now() - this.probeStart - 150;
      this.pool._emitStatus(this.info);
      this.endProbe();
    }
  }
  endProbe() {
    if (this.probeTimer)
      clearTimeout(this.probeTimer);
    if (this.probeSub)
      this.send(["CLOSE", this.probeSub]);
    this.probeSub = undefined;
  }
}

class RelayPool extends Emitter {
  conns = new Map;
  subs = new Map;
  seen = new Map;
  constructor(relays = []) {
    super();
    this.setRelays(relays);
  }
  setRelays(relays) {
    const want = new Set(relays.map((r) => r.trim()).filter(Boolean));
    for (const [url, conn] of this.conns) {
      if (!want.has(url)) {
        conn.close();
        this.conns.delete(url);
      }
    }
    for (const url of want) {
      if (!this.conns.has(url)) {
        const conn = new RelayConn(this, url);
        this.conns.set(url, conn);
        conn.connect();
      }
    }
  }
  get relays() {
    return [...this.conns.values()].map((c) => ({ ...c.info }));
  }
  subscribe(id, filter) {
    const prev = this.subs.get(id);
    if (prev && JSON.stringify(prev) === JSON.stringify(filter))
      return;
    this.subs.set(id, filter);
    for (const c of this.conns.values())
      c.send(["REQ", id, filter]);
  }
  unsubscribe(id) {
    if (!this.subs.delete(id))
      return;
    for (const c of this.conns.values())
      c.send(["CLOSE", id]);
  }
  async publish(ev) {
    const results = await Promise.all([...this.conns.values()].map(async (c) => ({ relay: c.info.url, ...await c.publish(ev) })));
    return results;
  }
  close() {
    for (const c of this.conns.values())
      c.close();
    this.conns.clear();
  }
  _event(relay, sub, event) {
    if (this.seen.has(event.id))
      return;
    this.seen.set(event.id, Date.now());
    if (this.seen.size > 5000) {
      const cutoff = Date.now() - 20 * 60000;
      for (const [id, t] of this.seen)
        if (t < cutoff)
          this.seen.delete(id);
    }
    this.emit("event", { relay, sub, event });
  }
  _frame(f) {
    this.emit("frame", f);
  }
  _emitStatus(info) {
    this.emit("status", { ...info });
  }
}
// ../../../home/claude/kurultay/packages/core/src/engine.ts
class MemoryStorage {
  state = null;
  load() {
    return this.state ? structuredClone(this.state) : null;
  }
  save(s) {
    this.state = structuredClone(s);
  }
}
var ONLINE_WINDOW = 150;
var HISTORY_LIMIT = 500;
function emptyState() {
  return {
    v: 1,
    inbox: randomHex(32),
    groups: {},
    invites: {},
    pendingJoins: {},
    approvals: {},
    agents: {},
    pairOffers: {},
    seen: {}
  };
}

class KurultayError extends Error {
}

class Kurultay extends Emitter {
  pubkey;
  sk;
  state = emptyState();
  pool;
  name;
  kind;
  card;
  appUrl;
  storage;
  baseRelays;
  timers = [];
  saveTimer;
  tagMap = new Map;
  sendLog = new Map;
  recvLog = new Map;
  lastPresence = 0;
  lastRetry = 0;
  presenceInterval;
  limits;
  started = false;
  reconnectTimer;
  constructor(opts) {
    super();
    this.sk = opts.sk;
    this.pubkey = getPublicKey(opts.sk);
    this.name = opts.name;
    this.kind = opts.kind;
    this.card = { name: opts.name, kind: opts.kind, ...opts.card };
    this.storage = opts.storage ?? new MemoryStorage;
    this.baseRelays = opts.relays?.length ? opts.relays : DEFAULT_RELAYS;
    this.appUrl = opts.appUrl;
    this.presenceInterval = opts.presenceInterval ?? 60000;
    this.limits = {
      agentSendPerMinute: opts.limits?.agentSendPerMinute ?? 12,
      humanSendPerMinute: opts.limits?.humanSendPerMinute ?? 40,
      recvPerMinute: opts.limits?.recvPerMinute ?? 40
    };
    this.pool = new RelayPool;
    this.pool.on("event", ({ relay, event }) => this.onOuter(event, relay));
    this.pool.on("frame", (f) => this.emit("frame", f));
    this.pool.on("status", (r) => {
      this.emit("relay", r);
      if (r.status === "open" && this.started) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.syncAll();
          this.retryPending();
          this.beacon();
        }, 400);
      }
    });
  }
  async start() {
    if (this.started)
      return;
    this.started = true;
    const loaded = await this.storage.load();
    if (loaded && loaded.v === 1)
      this.state = { ...emptyState(), ...loaded };
    else
      this.persist();
    this.pool.setRelays(this.allRelays());
    this.resubscribe();
    this.syncAll();
    this.beacon();
    this.retryPending();
    this.timers.push(setInterval(() => this.tick(), 5000));
  }
  async stop() {
    if (!this.started)
      return;
    this.started = false;
    for (const t of this.timers)
      clearInterval(t);
    this.timers = [];
    await Promise.race([
      Promise.all(Object.keys(this.state.groups).map((g) => this.sendGroup(g, { type: "presence", status: "offline" }))),
      new Promise((r) => setTimeout(r, 1500))
    ]);
    this.flush();
    this.pool.close();
  }
  setRelays(relays) {
    this.baseRelays = relays.length ? relays : DEFAULT_RELAYS;
    this.pool.setRelays(this.allRelays());
  }
  get relays() {
    return this.baseRelays;
  }
  allRelays() {
    const set = new Set(this.baseRelays);
    for (const g of Object.values(this.state.groups))
      for (const r of g.relays)
        set.add(r);
    if (this.state.owner)
      for (const r of this.state.owner.relays)
        set.add(r);
    return [...set];
  }
  tick() {
    this.resubscribe();
    const t = now();
    for (const g of Object.values(this.state.groups)) {
      if (g.prevKey && g.prevKey.until < t) {
        delete g.prevKey;
        this.persist();
      }
    }
    if (Date.now() - this.lastPresence >= this.presenceInterval)
      this.beacon();
    if (Date.now() - this.lastRetry >= 30000)
      this.retryPending();
    for (const [id, inv] of Object.entries(this.state.invites))
      if (inv.expiresAt < t)
        delete this.state.invites[id];
    for (const [id, o] of Object.entries(this.state.pairOffers))
      if (o.expiresAt < t)
        delete this.state.pairOffers[id];
    for (const [id, ts] of Object.entries(this.state.seen))
      if (ts < t - 1200)
        delete this.state.seen[id];
  }
  persist() {
    if (this.saveTimer)
      return;
    this.saveTimer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    if (this.saveTimer)
      clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.storage.save(this.state);
  }
  changed(reason) {
    this.persist();
    this.emit("change", { reason });
  }
  resubscribe() {
    const tags = new Map;
    for (const tag of routeWindow(this.state.inbox, "inbox"))
      tags.set(tag, { channel: "inbox" });
    for (const g of Object.values(this.state.groups)) {
      for (const tag of routeWindow(g.key, "group"))
        tags.set(tag, { channel: "group", groupId: g.id, key: g.key });
      if (g.prevKey)
        for (const tag of routeWindow(g.prevKey.key, "group"))
          tags.set(tag, { channel: "group", groupId: g.id, key: g.prevKey.key });
    }
    this.tagMap = tags;
    this.pool.setRelays(this.allRelays());
    this.pool.subscribe("kurultay", { kinds: [KIND_WRAP], ["#" + ROUTE_TAG]: [...tags.keys()].sort() });
  }
  routes() {
    return [...this.tagMap.entries()].map(([tag, r]) => ({ tag, channel: r.channel, groupId: r.channel === "group" ? r.groupId : undefined, slot: slotOf() }));
  }
  onOuter(outer, relay) {
    const tag = outer.tags.find((t) => t[0] === ROUTE_TAG)?.[1];
    const route = tag ? this.tagMap.get(tag) : undefined;
    const base = { id: outer.id, ts: Date.now(), dir: "in", outer, relay };
    if (!route) {
      this.emit("raw", { ...base, channel: "unknown", error: "no matching route" });
      return;
    }
    try {
      if (route.channel === "group") {
        const { inner, env } = unwrapGroup(outer, route.groupId, route.key);
        if (this.isSeen(inner.id))
          return;
        this.emit("raw", { ...base, channel: "group", groupId: route.groupId, inner, env });
        this.onGroup(route.groupId, inner, env);
      } else {
        const { inner, env } = unwrapInbox(outer, this.sk);
        if (this.isSeen(inner.id))
          return;
        this.emit("raw", { ...base, channel: "inbox", inner, env });
        this.onInbox(inner, env);
      }
    } catch (err) {
      this.emit("raw", { ...base, channel: route.channel, groupId: route.channel === "group" ? route.groupId : undefined, error: err.message });
    }
  }
  isSeen(id) {
    if (this.state.seen[id])
      return true;
    this.state.seen[id] = now();
    return false;
  }
  rateOk(log, key, limit) {
    const t = Date.now();
    const arr = (log.get(key) ?? []).filter((x) => x > t - 60000);
    if (arr.length >= limit) {
      log.set(key, arr);
      return false;
    }
    arr.push(t);
    log.set(key, arr);
    return true;
  }
  onGroup(groupId, inner, env) {
    const g = this.state.groups[groupId];
    if (!g)
      return;
    const from = inner.pubkey;
    const member = g.roster.members[from];
    if (!member) {
      this.emit("notice", { level: "warn", text: `Dropped ${env.type} from non-member ${from.slice(0, 8)}`, groupId });
      return;
    }
    if (from !== this.pubkey)
      g.presence[from] = now();
    const isSpeech = env.type === "chat" || env.type === "task" || env.type === "task_update";
    if (isSpeech && from !== this.pubkey) {
      if (g.roster.muted.includes(from))
        return;
      if (g.roster.paused && member.kind === "agent")
        return;
      if (!this.rateOk(this.recvLog, groupId + from, this.limits.recvPerMinute)) {
        this.emit("notice", { level: "warn", text: `Rate-limited ${member.name}`, groupId });
        return;
      }
    }
    switch (env.type) {
      case "chat": {
        const mentions = (env.mentions ?? []).filter((m) => typeof m === "string");
        const msg = { id: inner.id, groupId, from, ts: inner.created_at, type: "chat", text: String(env.text).slice(0, MAX_TEXT_BYTES), mentions, thread: env.thread };
        this.record(g, msg, from !== this.pubkey && (g.roster.dm || mentions.includes(this.pubkey) || mentions.includes("all")));
        break;
      }
      case "typing":
        if (from !== this.pubkey)
          this.emit("typing", { groupId, from, on: !!env.on });
        break;
      case "task": {
        const task = { taskId: env.taskId, from, to: env.to, title: env.title, input: env.input, status: "pending", createdAt: inner.created_at, updatedAt: inner.created_at };
        g.tasks[task.taskId] = task;
        const msg = { id: inner.id, groupId, from, ts: inner.created_at, type: "task", text: env.title + (env.input ? `

${env.input}` : ""), taskId: env.taskId, mentions: [env.to] };
        this.record(g, msg, from !== this.pubkey && env.to === this.pubkey);
        break;
      }
      case "task_update": {
        const task = g.tasks[env.taskId];
        if (!task || from !== task.to && from !== task.from)
          return;
        task.status = env.status;
        task.output = env.output;
        task.updatedAt = inner.created_at;
        const msg = { id: inner.id, groupId, from, ts: inner.created_at, type: "task_update", text: `${env.status}${env.output ? ": " + env.output : ""}`, taskId: env.taskId, mentions: [task.from] };
        this.record(g, msg, from !== this.pubkey && task.from === this.pubkey);
        break;
      }
      case "presence":
        if (env.status === "offline")
          delete g.presence[from];
        if (env.card)
          g.cards[from] = { ...env.card, kind: member.kind };
        if (env.attestation && checkAttestation(env.attestation, from) && !member.attestation) {
          member.attestation = env.attestation;
          member.owner = env.attestation.pubkey;
        }
        this.changed("presence");
        break;
      case "state":
        if (!g.roster.admins.includes(from))
          return;
        if (env.epoch !== g.epoch || env.roster.version <= g.roster.version)
          return;
        if (!env.roster.members[this.pubkey])
          return this.dropGroup(groupId, "You were removed from the group");
        g.roster = env.roster;
        this.changed("roster");
        break;
      case "leave":
        if (this.isAdmin(groupId) && from !== this.pubkey)
          this.removeMember(groupId, from, "left");
        break;
    }
  }
  record(g, msg, forMe) {
    g.history.push(msg);
    if (g.history.length > HISTORY_LIMIT)
      g.history.splice(0, g.history.length - HISTORY_LIMIT);
    this.changed("message");
    this.emit("message", { groupId: g.id, message: msg, forMe });
  }
  system(groupId, text) {
    const g = this.state.groups[groupId];
    if (!g)
      return;
    this.record(g, { id: "sys-" + randomHex(8), groupId, from: "", ts: now(), type: "system", text }, false);
  }
  onInbox(inner, env) {
    const from = inner.pubkey;
    switch (env.type) {
      case "join_req":
        return this.onJoinReq(from, env);
      case "agent_join":
        return this.onAgentJoin(from, env);
      case "key":
        return this.onKey(from, env);
      case "deny": {
        const p = this.state.pendingJoins[env.reqId];
        if (!p || p.link.admin !== from && !(p.admins ?? []).some((a) => a.pubkey === from))
          return;
        p.status = "denied";
        this.emit("notice", { level: "warn", text: `Join to “${p.link.name}” denied: ${env.reason}` });
        this.changed("join-denied");
        return;
      }
      case "sync_req": {
        const g = this.state.groups[env.groupId];
        if (!g || !g.roster.admins.includes(this.pubkey))
          return;
        const m = g.roster.members[from];
        if (m)
          this.sendInbox(from, m.inbox, { type: "key", groupId: g.id, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster });
        return;
      }
      case "removed": {
        const g = this.state.groups[env.groupId];
        if (g && g.roster.admins.includes(from))
          this.dropGroup(g.id, "You were removed from the group");
        return;
      }
      case "pair_req": {
        const offer = this.state.pairOffers[env.pairId];
        if (!offer || offer.secret !== env.secret || offer.expiresAt < now())
          return;
        delete this.state.pairOffers[env.pairId];
        const label = offer.label || env.label || "agent";
        const att = attest(this.sk, from, label, this.name);
        this.state.agents[from] = { pubkey: from, label, inbox: env.inbox, client: env.client, attestation: att, pairedAt: now() };
        this.sendInbox(from, env.inbox, { type: "pair_ok", pairId: env.pairId, attestation: att });
        this.emit("notice", { level: "info", text: `Paired agent “${label}”` });
        this.changed("paired");
        return;
      }
      case "pair_ok": {
        const owner = this.state.owner;
        if (!owner || owner.pubkey !== from || !checkAttestation(env.attestation, this.pubkey))
          return;
        owner.attestation = env.attestation;
        this.emit("notice", { level: "info", text: `Paired with owner ${owner.name}` });
        this.changed("paired");
        this.beacon();
        return;
      }
      case "approve_req": {
        const agent = this.state.agents[from];
        if (!agent)
          return;
        const a = {
          reqId: env.reqId,
          kind: "agent-join",
          createdAt: now(),
          groupId: "",
          groupName: env.groupName,
          requester: { pubkey: from, name: agent.label, kind: "agent", inbox: agent.inbox, owner: this.pubkey, card: env.card }
        };
        this.state.approvals[env.reqId] = a;
        this.emit("approval", a);
        this.changed("approval");
        return;
      }
      case "approve_res": {
        const p = this.state.pendingJoins[env.reqId];
        if (!p || !this.state.owner || from !== this.state.owner.pubkey || p.status !== "awaiting-owner")
          return;
        if (env.ok) {
          p.status = "awaiting-admin";
          this.sendJoinReq(env.reqId, p.link);
          this.emit("notice", { level: "info", text: `Owner approved joining “${p.link.name}”` });
        } else {
          p.status = "denied";
          this.emit("notice", { level: "warn", text: `Owner declined joining “${p.link.name}”` });
        }
        this.changed("approval");
        return;
      }
    }
  }
  onJoinReq(from, env) {
    const inv = this.state.invites[env.inviteId];
    if (!inv || inv.secret !== env.secret)
      return;
    const g = this.state.groups[inv.groupId];
    if (!g || !this.isAdmin(g.id))
      return;
    if (g.roster.members[from]) {
      this.sendInbox(from, g.roster.members[from].inbox, { type: "key", groupId: g.id, reqId: env.reqId, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster });
      return;
    }
    if (inv.expiresAt < now() || inv.singleUse && inv.uses > 0) {
      this.sendInbox(from, env.inbox, { type: "deny", reqId: env.reqId, reason: "invite expired or already used" });
      return;
    }
    const att = checkAttestation(env.attestation, from);
    const requester = {
      pubkey: from,
      name: String(env.name).slice(0, 64),
      kind: env.kind === "human" ? "human" : "agent",
      inbox: env.inbox,
      owner: att?.owner,
      attestation: att ? env.attestation : undefined,
      card: env.card
    };
    inv.uses++;
    if (inv.autoAdmit) {
      this.admit(g.id, requester, env.reqId);
    } else {
      if (this.state.approvals[env.reqId])
        return;
      const a = { reqId: env.reqId, kind: "join", createdAt: now(), groupId: g.id, groupName: g.roster.name, requester, inviteId: inv.inviteId };
      this.state.approvals[env.reqId] = a;
      this.emit("approval", a);
      this.changed("approval");
    }
  }
  onAgentJoin(from, env) {
    const g = this.state.groups[env.groupId];
    if (!g || !this.isAdmin(g.id))
      return;
    const existing = g.roster.members[from];
    if (existing) {
      this.sendInbox(from, existing.inbox, { type: "key", groupId: g.id, reqId: env.reqId, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster });
      return;
    }
    const att = checkAttestation(env.attestation, from);
    const owner = att ? g.roster.members[att.owner] : undefined;
    if (!att || !owner || owner.kind !== "human") {
      this.sendInbox(from, env.inbox, { type: "deny", reqId: env.reqId, reason: "the agent’s owner is not a member of this council" });
      return;
    }
    if (g.roster.allowMemberAgents === false) {
      this.sendInbox(from, env.inbox, { type: "deny", reqId: env.reqId, reason: "this council does not accept members’ agents" });
      return;
    }
    this.admit(g.id, { pubkey: from, name: String(env.name).slice(0, 64), kind: "agent", inbox: env.inbox, owner: att.owner, attestation: env.attestation, card: env.card }, env.reqId);
  }
  onKey(from, env) {
    const roster = env.roster;
    if (!roster?.members?.[this.pubkey] || !roster.admins.includes(from))
      return;
    const pendingEntry = env.reqId ? this.state.pendingJoins[env.reqId] : undefined;
    const groupId = env.groupId;
    const pendingAdmins = pendingEntry ? [pendingEntry.link.admin, ...(pendingEntry.admins ?? []).map((a) => a.pubkey)] : [];
    if (pendingEntry && (!pendingAdmins.includes(from) || pendingEntry.link.groupId !== groupId))
      return;
    const existing = this.state.groups[groupId];
    if (!existing && !pendingEntry && !Object.values(this.state.groups).some((x) => x.roster.members[from]))
      return;
    if (existing) {
      if (!existing.roster.admins.includes(from))
        return;
      if (env.epoch < existing.epoch)
        return;
      if (env.epoch === existing.epoch && roster.version < existing.roster.version)
        return;
      if (env.epoch > existing.epoch)
        existing.prevKey = { epoch: existing.epoch, key: existing.key, until: now() + 600 };
      existing.epoch = env.epoch;
      existing.key = env.key;
      existing.roster = roster;
      existing.relays = env.relays?.length ? env.relays : existing.relays;
    } else {
      this.state.groups[groupId] = {
        id: groupId,
        relays: env.relays?.length ? env.relays : pendingEntry.link.relays,
        epoch: env.epoch,
        key: env.key,
        roster,
        cards: {},
        presence: {},
        tasks: {},
        history: [],
        joinedAt: now()
      };
      this.system(groupId, `You joined “${roster.name}”`);
    }
    if (env.reqId)
      delete this.state.pendingJoins[env.reqId];
    this.resubscribe();
    this.changed("key");
    if (!existing)
      this.beacon();
  }
  dropGroup(groupId, why) {
    const g = this.state.groups[groupId];
    if (!g)
      return;
    delete this.state.groups[groupId];
    this.emit("notice", { level: "warn", text: `${why}: “${g.roster.name}”`, groupId });
    this.resubscribe();
    this.changed("removed");
  }
  async publish(outer, rec) {
    this.emit("raw", { id: outer.id, ts: Date.now(), dir: "out", outer, ...rec });
    return this.pool.publish(outer);
  }
  async sendGroup(groupId, env) {
    const g = this.state.groups[groupId];
    if (!g)
      throw new KurultayError(`Unknown group ${groupId}`);
    const inner = signInner(this.sk, env, ["g", groupId]);
    this.state.seen[inner.id] = now();
    const outer = wrapGroup(inner, g.key);
    this.onGroup(groupId, inner, env);
    await this.publish(outer, { channel: "group", groupId, inner, env });
    return inner;
  }
  async sendInbox(to, inbox, env) {
    const inner = signInner(this.sk, env, ["p", to]);
    this.state.seen[inner.id] = now();
    const outer = wrapInbox(inner, to, inbox);
    await this.publish(outer, { channel: "inbox", inner, env });
    return inner;
  }
  guardSpeech(groupId) {
    const g = this.state.groups[groupId];
    if (!g)
      throw new KurultayError(`Unknown group ${groupId}`);
    if (g.roster.muted.includes(this.pubkey))
      throw new KurultayError("You are muted in this group");
    if (g.roster.paused && this.kind === "agent")
      throw new KurultayError("The group is paused by a moderator; agents cannot speak until it is resumed");
    const limit = this.kind === "agent" ? this.limits.agentSendPerMinute : this.limits.humanSendPerMinute;
    if (!this.rateOk(this.sendLog, groupId, limit))
      throw new KurultayError(`Rate limit: at most ${limit} messages per minute per group. Wait before sending again.`);
    return g;
  }
  async send(groupId, text, opts = {}) {
    this.guardSpeech(groupId);
    if (utf8(text).length > MAX_TEXT_BYTES)
      throw new KurultayError(`Message too large (max ${MAX_TEXT_BYTES} bytes)`);
    const mentions = this.resolveMentions(groupId, [...opts.mentions ?? [], ...this.extractMentions(text)]);
    const inner = await this.sendGroup(groupId, { type: "chat", text, mentions, thread: opts.thread });
    return inner.id;
  }
  async sendTask(groupId, to, title, input) {
    this.guardSpeech(groupId);
    const [target] = this.resolveMentions(groupId, [to]);
    if (!target || target === "all")
      throw new KurultayError(`Unknown member ${to}`);
    const taskId = randomHex(8);
    await this.sendGroup(groupId, { type: "task", taskId, to: target, title, input });
    return taskId;
  }
  async updateTask(groupId, taskId, status, output) {
    const g = this.guardSpeech(groupId);
    const task = g.tasks[taskId];
    if (!task)
      throw new KurultayError(`Unknown task ${taskId}`);
    if (task.to !== this.pubkey && task.from !== this.pubkey)
      throw new KurultayError("Only the assignee or requester can update a task");
    await this.sendGroup(groupId, { type: "task_update", taskId, status, output });
  }
  async typing(groupId, on) {
    if (!this.state.groups[groupId])
      return;
    await this.sendGroup(groupId, { type: "typing", on });
  }
  extractMentions(text) {
    return [...text.matchAll(/(?:^|[^\w@])@([\w#.\-]+(?:@[\w.\-]+)?)/g)].map((m) => m[1].replace(/[.\-]+$/, ""));
  }
  resolveMentions(groupId, refs) {
    const g = this.state.groups[groupId];
    if (!g)
      return [];
    const out = new Set;
    const members = Object.values(g.roster.members);
    for (const raw of refs) {
      const r = raw.replace(/^@/, "").trim();
      if (!r)
        continue;
      if (r === "all" || r === "here") {
        out.add("all");
        continue;
      }
      const lower = r.toLowerCase();
      const short = members.filter((m) => m.name.toLowerCase().split("@")[0] === lower);
      const hit = members.find((m) => m.pubkey === r) ?? members.find((m) => m.name.toLowerCase() === lower) ?? (short.length === 1 ? short[0] : undefined) ?? members.find((m) => m.pubkey.startsWith(lower) && lower.length >= 6);
      if (hit)
        out.add(hit.pubkey);
    }
    return [...out];
  }
  isAdmin(groupId) {
    return !!this.state.groups[groupId]?.roster.admins.includes(this.pubkey);
  }
  me() {
    return {
      pubkey: this.pubkey,
      name: this.name,
      kind: this.kind,
      inbox: this.state.inbox,
      role: "admin",
      owner: this.state.owner?.attestation ? this.state.owner.pubkey : undefined,
      attestation: this.state.owner?.attestation,
      joinedAt: now()
    };
  }
  createGroup(name, opts = {}) {
    const id = randomHex(16);
    const g = {
      id,
      relays: opts.relays?.length ? opts.relays : this.baseRelays,
      epoch: 0,
      key: randomHex(32),
      roster: { version: 1, name, dm: !!opts.dm, admins: [this.pubkey], members: { [this.pubkey]: this.me() }, paused: false, muted: [] },
      cards: { [this.pubkey]: this.card },
      presence: {},
      tasks: {},
      history: [],
      joinedAt: now()
    };
    this.state.groups[id] = g;
    this.resubscribe();
    this.system(id, `Group “${name}” created`);
    this.changed("group-created");
    return g;
  }
  createInvite(groupId, opts = {}) {
    const g = this.state.groups[groupId];
    if (!g)
      throw new KurultayError(`Unknown group ${groupId}`);
    if (!this.isAdmin(groupId))
      throw new KurultayError("Only admins can invite");
    const inviteId = randomHex(8);
    const secret = randomHex(16);
    const expiresAt = now() + (opts.ttlSeconds ?? 86400);
    this.state.invites[inviteId] = { inviteId, groupId, secret, autoAdmit: opts.autoAdmit ?? true, singleUse: opts.singleUse ?? false, expiresAt, uses: 0 };
    this.changed("invite");
    const link = { t: "invite", groupId, name: g.roster.name, relays: g.relays, admin: this.pubkey, adminInbox: this.state.inbox, inviteId, secret, expiresAt };
    return encodeInvite(link, this.appUrl);
  }
  async redeem(input) {
    const link = decodeLink(input);
    if (link.expiresAt < now())
      throw new KurultayError("This link has expired");
    if (link.t === "pair")
      return this.pairWith(link);
    if (this.state.groups[link.groupId])
      return { kind: "invite", status: "already-member", name: link.name };
    const reqId = randomHex(8);
    const viaOwner = this.kind === "agent" && !!this.state.owner?.attestation;
    this.state.pendingJoins[reqId] = { reqId, link, status: viaOwner ? "awaiting-owner" : "awaiting-admin", createdAt: now() };
    this.pool.setRelays(this.allRelays().concat(link.relays));
    if (viaOwner) {
      const o = this.state.owner;
      await this.sendInbox(o.pubkey, o.inbox, { type: "approve_req", reqId, groupName: link.name, admin: link.admin, card: this.card });
    } else {
      await this.sendJoinReq(reqId, link);
    }
    this.changed("join-pending");
    return { kind: "invite", status: this.state.pendingJoins[reqId].status, reqId, name: link.name };
  }
  async sendJoinReq(reqId, link) {
    const p = this.state.pendingJoins[reqId];
    if (p?.via === "ticket") {
      const att = this.state.owner?.attestation;
      if (!att)
        return;
      await Promise.all((p.admins ?? [{ pubkey: link.admin, inbox: link.adminInbox }]).map((a) => this.sendInbox(a.pubkey, a.inbox, { type: "agent_join", groupId: link.groupId, reqId, name: this.name, inbox: this.state.inbox, attestation: att, card: this.card })));
      return;
    }
    await this.sendInbox(link.admin, link.adminInbox, {
      type: "join_req",
      reqId,
      inviteId: link.inviteId,
      secret: link.secret,
      name: this.name,
      kind: this.kind,
      inbox: this.state.inbox,
      owner: this.state.owner?.attestation ? this.state.owner.pubkey : undefined,
      attestation: this.state.owner?.attestation,
      card: this.card
    });
  }
  retryPending() {
    this.lastRetry = Date.now();
    const t = now();
    for (const p of Object.values(this.state.pendingJoins)) {
      if (p.status !== "awaiting-admin")
        continue;
      if (p.link.expiresAt < t || p.via !== "ticket" && t - p.createdAt > 3600) {
        delete this.state.pendingJoins[p.reqId];
        continue;
      }
      this.sendJoinReq(p.reqId, p.link);
    }
    const o = this.state.owner;
    if (o && !o.attestation && o.pending)
      this.sendPairReq();
  }
  admit(groupId, req, reqId) {
    const g = this.state.groups[groupId];
    if (!g)
      return;
    g.roster.members[req.pubkey] = {
      pubkey: req.pubkey,
      name: this.uniqueName(g, req.name),
      kind: req.kind,
      inbox: req.inbox,
      role: "member",
      owner: req.owner,
      attestation: req.attestation,
      joinedAt: now()
    };
    if (req.card)
      g.cards[req.pubkey] = { ...req.card, kind: req.kind };
    g.roster.version++;
    this.sendInbox(req.pubkey, req.inbox, { type: "key", groupId: g.id, reqId, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster });
    this.sendGroup(groupId, { type: "state", roster: g.roster, epoch: g.epoch });
    this.system(groupId, `${g.roster.members[req.pubkey].name} joined`);
  }
  uniqueName(g, name) {
    const taken = new Set(Object.values(g.roster.members).map((m) => m.name.toLowerCase()));
    const base = name.replace(/\s+/g, "-") || "peer";
    if (!taken.has(base.toLowerCase()))
      return base;
    for (let i = 2;; i++)
      if (!taken.has(`${base}-${i}`.toLowerCase()))
        return `${base}-${i}`;
  }
  async addKnownMember(groupId, pubkey) {
    const g = this.state.groups[groupId];
    if (!g || !this.isAdmin(groupId))
      throw new KurultayError("Only admins can add members");
    const m = Object.values(this.state.groups).map((x) => x.roster.members[pubkey]).find(Boolean);
    if (!m)
      throw new KurultayError("Unknown peer: no shared group");
    this.admit(groupId, { pubkey, name: m.name, kind: m.kind, inbox: m.inbox, owner: m.owner, attestation: m.attestation }, randomHex(8));
  }
  async openDM(pubkey) {
    const existing = Object.values(this.state.groups).find((g) => g.roster.dm && g.roster.members[pubkey] && Object.keys(g.roster.members).length === 2);
    if (existing)
      return existing.id;
    const peer = Object.values(this.state.groups).map((x) => x.roster.members[pubkey]).find(Boolean);
    if (!peer)
      throw new KurultayError("Unknown peer");
    const g = this.createGroup(`${this.name} ↔ ${peer.name}`, { dm: true });
    await this.addKnownMember(g.id, pubkey);
    return g.id;
  }
  async approve(reqId, ok) {
    const a = this.state.approvals[reqId];
    if (!a)
      throw new KurultayError("Unknown approval request");
    delete this.state.approvals[reqId];
    if (a.kind === "agent-join") {
      await this.sendInbox(a.requester.pubkey, a.requester.inbox, { type: "approve_res", reqId, ok });
    } else if (ok) {
      this.admit(a.groupId, a.requester, reqId);
    } else {
      await this.sendInbox(a.requester.pubkey, a.requester.inbox, { type: "deny", reqId, reason: "declined by admin" });
    }
    this.changed("approval");
  }
  async removeMember(groupId, pubkey, why = "removed") {
    const g = this.state.groups[groupId];
    if (!g || !this.isAdmin(groupId))
      throw new KurultayError("Only admins can remove members");
    const m = g.roster.members[pubkey];
    if (!m)
      return;
    delete g.roster.members[pubkey];
    g.roster.admins = g.roster.admins.filter((a) => a !== pubkey);
    g.roster.muted = g.roster.muted.filter((a) => a !== pubkey);
    g.roster.version++;
    g.prevKey = { epoch: g.epoch, key: g.key, until: now() + 120 };
    g.epoch++;
    g.key = randomHex(32);
    this.resubscribe();
    await Promise.all([
      this.sendInbox(pubkey, m.inbox, { type: "removed", groupId }),
      ...Object.values(g.roster.members).filter((x) => x.pubkey !== this.pubkey).map((x) => this.sendInbox(x.pubkey, x.inbox, { type: "key", groupId: g.id, relays: g.relays, epoch: g.epoch, key: g.key, roster: g.roster }))
    ]);
    this.system(groupId, `${m.name} ${why} — group key rotated to epoch ${g.epoch}`);
    this.changed("removed-member");
  }
  async moderate(groupId, action, target) {
    const g = this.state.groups[groupId];
    if (!g || !this.isAdmin(groupId))
      throw new KurultayError("Only admins can moderate");
    const r = g.roster;
    if (action === "pause")
      r.paused = true;
    if (action === "resume")
      r.paused = false;
    if (action === "allow-agents")
      r.allowMemberAgents = true;
    if (action === "deny-agents")
      r.allowMemberAgents = false;
    if (action === "mute" && target && !r.muted.includes(target))
      r.muted.push(target);
    if (action === "unmute" && target)
      r.muted = r.muted.filter((x) => x !== target);
    if (action === "promote" && target && r.members[target] && !r.admins.includes(target)) {
      r.admins.push(target);
      r.members[target].role = "admin";
    }
    r.version++;
    await this.sendGroup(groupId, { type: "state", roster: r, epoch: g.epoch });
    const who = target ? r.members[target]?.name ?? target.slice(0, 8) : "";
    this.system(groupId, { pause: "Agents paused by moderator", resume: "Agents resumed", mute: `${who} muted`, unmute: `${who} unmuted`, promote: `${who} is now an admin`, "allow-agents": "Members may now bring their own agents", "deny-agents": "Members can no longer bring their own agents" }[action]);
  }
  async leave(groupId) {
    const g = this.state.groups[groupId];
    if (!g)
      return;
    if (Object.keys(g.roster.members).length > 1)
      await this.sendGroup(groupId, { type: "leave" }).catch(() => {});
    delete this.state.groups[groupId];
    this.resubscribe();
    this.changed("left");
  }
  async renameGroup(groupId, name) {
    const g = this.state.groups[groupId];
    if (!g || !this.isAdmin(groupId))
      throw new KurultayError("Only admins can rename");
    g.roster.name = name;
    g.roster.version++;
    await this.sendGroup(groupId, { type: "state", roster: g.roster, epoch: g.epoch });
    this.changed("renamed");
  }
  syncAll() {
    for (const g of Object.values(this.state.groups)) {
      for (const admin of g.roster.admins) {
        if (admin === this.pubkey)
          continue;
        const m = g.roster.members[admin];
        if (m)
          this.sendInbox(admin, m.inbox, { type: "sync_req", groupId: g.id, epoch: g.epoch });
      }
    }
  }
  beacon() {
    this.lastPresence = Date.now();
    const att = this.state.owner?.attestation;
    for (const id of Object.keys(this.state.groups)) {
      this.sendGroup(id, { type: "presence", status: "online", card: this.card, attestation: att }).catch(() => {});
    }
  }
  setCard(card) {
    this.card = { ...this.card, ...card, kind: this.kind };
    this.beacon();
  }
  createTicket(groupIds) {
    if (this.kind !== "human")
      throw new KurultayError("Only people can create agent tickets");
    const seed = randomHex(32);
    const ticketId = randomHex(6);
    const agents = AGENT_HOSTS.map((host) => ({ host, ...deriveAgent(seed, host) }));
    const att = attestMany(this.sk, agents.map((a) => ({ pk: a.pk, label: a.host })), this.name);
    const groups = groupIds.map((id) => this.state.groups[id]).filter(Boolean).map((g) => ({
      groupId: g.id,
      name: g.roster.name,
      relays: g.relays,
      admins: g.roster.admins.map((pk) => ({ pubkey: pk, inbox: g.roster.members[pk]?.inbox })).filter((a) => !!a.inbox)
    }));
    const tickets = this.state.tickets ??= {};
    tickets[ticketId] = { ticketId, createdAt: now(), groups: groups.map((g) => g.groupId), agents: Object.fromEntries(agents.map((a) => [a.pk, a.host])) };
    for (const a of agents)
      this.state.agents[a.pk] = { pubkey: a.pk, label: a.host, inbox: a.inbox, attestation: att, pairedAt: now() };
    this.changed("ticket");
    const ticket = { t: "ticket", v: 1, id: ticketId, seed, owner: { pubkey: this.pubkey, name: this.name, inbox: this.state.inbox, relays: this.baseRelays }, att, groups };
    return encodeTicket(ticket);
  }
  ticketProgress(ticketId) {
    const t = this.state.tickets?.[ticketId];
    if (!t)
      return [];
    const out = [];
    for (const gid of t.groups) {
      const g = this.state.groups[gid];
      if (!g)
        continue;
      for (const pk of Object.keys(t.agents))
        if (g.roster.members[pk])
          out.push({ pubkey: pk, host: t.agents[pk], name: g.roster.members[pk].name, groupId: gid });
    }
    return out;
  }
  static fromTicket(ticket, host, existing) {
    const a = deriveAgent(ticket.seed, host);
    const state = existing && existing.inbox === a.inbox ? existing : { ...emptyState(), inbox: a.inbox };
    state.owner = { pubkey: ticket.owner.pubkey, name: ticket.owner.name, inbox: ticket.owner.inbox, relays: ticket.owner.relays, attestation: ticket.att };
    for (const g of ticket.groups) {
      if (state.groups[g.groupId] || !g.admins.length)
        continue;
      if (Object.values(state.pendingJoins).some((p) => p.link.groupId === g.groupId))
        continue;
      const reqId = randomHex(8);
      state.pendingJoins[reqId] = {
        reqId,
        via: "ticket",
        admins: g.admins,
        status: "awaiting-admin",
        createdAt: now(),
        link: { t: "invite", groupId: g.groupId, name: g.name, relays: g.relays, admin: g.admins[0].pubkey, adminInbox: g.admins[0].inbox, inviteId: "", secret: "", expiresAt: now() + 30 * 86400 }
      };
    }
    return { sk: a.sk, pubkey: a.pk, state };
  }
  createPairCode(label, ttlSeconds = 900) {
    const pairId = randomHex(8);
    const secret = randomHex(16);
    const expiresAt = now() + ttlSeconds;
    this.state.pairOffers[pairId] = { pairId, secret, label, expiresAt };
    this.changed("pair-offer");
    const link = { t: "pair", owner: this.pubkey, name: this.name, inbox: this.state.inbox, relays: this.baseRelays, pairId, secret, expiresAt };
    return encodePair(link);
  }
  async pairWith(link) {
    if (this.kind !== "agent")
      throw new KurultayError("Only agents pair with an owner");
    this.state.owner = { pubkey: link.owner, name: link.name, inbox: link.inbox, relays: link.relays, pending: { pairId: link.pairId, secret: link.secret } };
    this.pool.setRelays(this.allRelays());
    await this.sendPairReq();
    this.changed("pairing");
    return { kind: "pair", status: "awaiting-owner", name: link.name };
  }
  async sendPairReq() {
    const o = this.state.owner;
    if (!o?.pending)
      return;
    await this.sendInbox(o.pubkey, o.inbox, { type: "pair_req", pairId: o.pending.pairId, secret: o.pending.secret, label: this.name, client: this.card.client, inbox: this.state.inbox });
  }
  async unpairAgent(pubkey) {
    delete this.state.agents[pubkey];
    this.changed("unpaired");
  }
  groups() {
    return Object.values(this.state.groups).sort((a, b) => (b.history.at(-1)?.ts ?? b.joinedAt) - (a.history.at(-1)?.ts ?? a.joinedAt));
  }
  member(groupId, pubkey) {
    const g = this.state.groups[groupId];
    const m = g?.roster.members[pubkey];
    if (!g || !m)
      return;
    const att = checkAttestation(m.attestation, pubkey);
    const isMe = pubkey === this.pubkey;
    return {
      pubkey,
      name: m.name,
      kind: m.kind,
      role: g.roster.admins.includes(pubkey) ? "admin" : "member",
      online: isMe ? this.started : now() - (g.presence[pubkey] ?? 0) < ONLINE_WINDOW,
      isMe,
      muted: g.roster.muted.includes(pubkey),
      card: g.cards[pubkey],
      verified: att ? { owner: att.owner, ownerName: att.ownerName, label: att.label } : null
    };
  }
  members(groupId) {
    const g = this.state.groups[groupId];
    if (!g)
      return [];
    return Object.keys(g.roster.members).map((pk) => this.member(groupId, pk)).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }
  displayName(groupId, pubkey) {
    if (!pubkey)
      return "kurultay";
    const v = this.member(groupId, pubkey);
    if (!v)
      return pubkey.slice(0, 8);
    return v.name;
  }
}
// debug.ts
var owner = new Kurultay({ sk: newSecretKey(), name: "tolga", kind: "human", storage: new MemoryStorage });
owner.on("frame", (f) => {
  const t = f.data[0];
  if (t !== "EVENT" || f.dir === "in")
    console.log("OWNER", f.dir, new URL(f.relay).host, JSON.stringify(f.data).slice(0, 160));
});
await owner.start();
await new Promise((r) => setTimeout(r, 3000));
var g = owner.createGroup("dbg");
var t = decodeTicket(owner.createTicket([g.id]));
await new Promise((r) => setTimeout(r, 1500));
var { sk, state } = Kurultay.fromTicket(t, "codex");
var st = new MemoryStorage;
st.save(state);
var agent = new Kurultay({ sk, name: "codex@vm", kind: "agent", storage: st, relays: t.owner.relays });
agent.on("frame", (f) => {
  const ty = f.data[0];
  if (ty !== "REQ")
    console.log("AGENT", f.dir, new URL(f.relay).host, JSON.stringify(f.data).slice(0, 160));
});
await agent.start();
var dl = Date.now() + 20000;
while (!agent.state.groups[g.id] && Date.now() < dl)
  await new Promise((r) => setTimeout(r, 300));
console.log("RESULT joined=", !!agent.state.groups[g.id]);
process.exit(0);
