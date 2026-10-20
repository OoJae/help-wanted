/**
 * A QR code encoder, small and with no dependency, for the one kind of text the site encodes: a
 * link a phone's wallet can open (an EIP-681 `ethereum:` link). It follows ISO/IEC 18004: byte
 * mode, versions 1 to 40, Reed-Solomon error correction over GF(256), and the mask the standard's
 * penalty rules choose. The server draws the result as an SVG path, so the code is in the HTML and
 * needs no script and no other host.
 *
 * The layout and the tables follow Project Nayuki's QR Code generator (MIT), written again here for
 * byte mode only.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrCode {
  version: number;
  ecc: QrEcc;
  mask: number;
  /** Modules per side, without the quiet zone. */
  size: number;
  /** `modules[y][x]`, true for a dark module. */
  modules: boolean[][];
}

const ECC_ROW: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two bits the format information carries for each level. */
const ECC_FORMAT: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index 0 of each row is padding; versions are 1 to 40.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30,
    28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];

const ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16,
    17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28,
    29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35,
    38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42,
    45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

/** How many modules of a version carry data and error correction (everything but the patterns). */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** How many 8-bit data codewords a version holds at a level, after its error correction. */
export function dataCodewords(version: number, ecc: QrEcc): number {
  const row = ECC_ROW[ecc];
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[row]![version]! * ERROR_CORRECTION_BLOCKS[row]![version]!
  );
}

/** The error-correction layout of a version at a level: blocks, and codewords of correction each. */
export function blockLayout(version: number, ecc: QrEcc): { blocks: number; eccPerBlock: number } {
  const row = ECC_ROW[ecc];
  return {
    blocks: ERROR_CORRECTION_BLOCKS[row]![version]!,
    eccPerBlock: ECC_CODEWORDS_PER_BLOCK[row]![version]!,
  };
}

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1, the field QR codes use. */
export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed-Solomon generator polynomial of a degree, highest coefficient first and the leading 1 left out. */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords of one block: the remainder of its data divided by the generator. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] = result[i]! ^ gfMultiply(coefficient, factor);
    });
  }
  return result;
}

/** The centres of a version's alignment patterns along one axis. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** The 15 format bits for a level and a mask, with their BCH code and the standard's XOR mask. */
export function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (version 7 and up), with their BCH code. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** Whether mask `mask` inverts the module at column x, row y. */
export function masks(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

const bit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

/** The data codewords for a text in byte mode, padded to the version's capacity. */
function dataFor(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** The data split into blocks, each with its error correction, then interleaved as the symbol stores them. */
export function interleave(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const { blocks: count, eccPerBlock } = blockLayout(version, ecc);
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = count - (raw % count);
  const shortLength = Math.floor(raw / count);
  const divisor = rsDivisor(eccPerBlock);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < count; i++) {
    const block = data.slice(k, k + shortLength - eccPerBlock + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const correction = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push([...block, ...correction]);
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      // The short blocks' placeholder byte is not stored.
      if (i !== shortLength - eccPerBlock || j >= shortBlocks) out.push(block[i]!);
    });
  }
  return out;
}

/** The modules every symbol of a version has whatever it says, and which modules they are. */
export function functionPatterns(version: number): { modules: boolean[][]; reserved: boolean[][] } {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    reserved[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((cx, i) => {
    align.forEach((cy, j) => {
      // The three corners already hold a finder pattern.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  // The format areas, reserved now and written once the mask is chosen, and the one dark module.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }
  set(8, size - 8, true);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  return { modules, reserved };
}

/** Every module that is not a pattern, in the order the codewords' bits fill them: two-wide columns, zigzag. */
export function dataOrder(version: number, reserved: readonly (readonly boolean[])[]): [number, number][] {
  const size = version * 4 + 17;
  const order: [number, number][] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y]![x]) order.push([x, y]);
      }
    }
  }
  return order;
}

/** Writes the 15 format bits in both of their places. */
function drawFormat(modules: boolean[][], ecc: QrEcc, mask: number): void {
  const size = modules.length;
  const bits = formatBits(ecc, mask);
  for (let i = 0; i <= 5; i++) modules[i]![8] = bit(bits, i);
  modules[7]![8] = bit(bits, 6);
  modules[8]![8] = bit(bits, 7);
  modules[8]![7] = bit(bits, 8);
  for (let i = 9; i < 15; i++) modules[8]![14 - i] = bit(bits, i);
  for (let i = 0; i < 8; i++) modules[8]![size - 1 - i] = bit(bits, i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i]![8] = bit(bits, i);
  modules[size - 8]![8] = true;
}

/** The standard's penalty for a finished symbol: lower is easier to read. */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    // Runs of five or more of one colour; the finder-like 1:1:3:1:1 pattern with four light on a side.
    const runs: number[] = [];
    let colour = get(0);
    let length = 0;
    for (let i = 0; i < size; i++) {
      if (get(i) === colour) length++;
      else {
        runs.push(length);
        colour = get(i);
        length = 1;
      }
    }
    runs.push(length);
    for (const run of runs) if (run >= 5) score += 3 + (run - 5);
    // The light border outside the symbol counts as light for the finder test. `lengths` alternates
    // light, dark, light, ... from a light run, so a run at an even index is light.
    const lengths = get(0) ? [4, ...runs] : [runs[0]! + 4, ...runs.slice(1)];
    const end = lengths.length - 1;
    if (end % 2 === 0) lengths[end] = lengths[end]! + 4;
    else lengths.push(4);
    for (let i = 1; i + 4 < lengths.length; i += 2) {
      const n = lengths[i]!;
      if (lengths[i + 1] === n && lengths[i + 2] === 3 * n && lengths[i + 3] === n && lengths[i + 4] === n) {
        const before = lengths[i - 1]!;
        const after = lengths[i + 5] ?? 0;
        if (before >= 4 * n || after >= 4 * n) score += 40;
      }
    }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y]![x]!);
  for (let x = 0; x < size; x++) line((y) => modules[y]![x]!);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encodes a text (as UTF-8 bytes) in the smallest version that holds it at the level asked for. */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 40 && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version, ecc) * 8)
    version++;
  if (version > 40) throw new Error("the text is too long for a QR code");
  const codewords = interleave(dataFor(bytes, version, ecc), version, ecc);
  const { modules: base, reserved } = functionPatterns(version);
  const order = dataOrder(version, reserved);
  const place = (mask: number): boolean[][] => {
    const modules = base.map((row) => [...row]);
    order.forEach(([x, y], i) => {
      const value = i < codewords.length * 8 ? bit(codewords[i >>> 3]!, 7 - (i & 7)) : false;
      modules[y]![x] = value !== masks(mask, x, y);
    });
    drawFormat(modules, ecc, mask);
    return modules;
  };
  let best = { mask: 0, modules: place(0), score: Infinity };
  for (let mask = 0; mask < 8; mask++) {
    const modules = place(mask);
    const score = penalty(modules);
    if (score < best.score) best = { mask, modules, score };
  }
  return { version, ecc, mask: best.mask, size: base.length, modules: best.modules };
}

/**
 * The dark modules as one SVG path in module units, offset by a quiet zone of `border` modules:
 * each run of dark modules in a row is one rectangle.
 */
export function qrPath(code: QrCode, border = 4): string {
  const parts: string[] = [];
  code.modules.forEach((row, y) => {
    for (let x = 0; x < code.size; x++) {
      if (!row[x]) continue;
      let run = 1;
      while (x + run < code.size && row[x + run]) run++;
      parts.push(`M${x + border} ${y + border}h${run}v1h-${run}z`);
      x += run - 1;
    }
  });
  return parts.join("");
}
