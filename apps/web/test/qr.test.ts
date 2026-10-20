/**
 * The QR encoder behind the Doorbell's phone link (src/lib/qr.ts), held against the standard's own
 * numbers (ISO/IEC 18004: capacities, the format and version codes, the Annex I Reed-Solomon
 * example), and read back: every symbol it draws is decoded here module by module, its format
 * information checked, each block's error correction checked, and its bytes compared with the text.
 * (The symbols were also decoded by two independent readers, jsQR and ZXing, outside the
 * repository.)
 */
import { describe, expect, it } from "vitest";
import {
  alignmentPositions,
  blockLayout,
  dataCodewords,
  dataOrder,
  encodeQr,
  formatBits,
  functionPatterns,
  masks,
  qrPath,
  rsDivisor,
  rsRemainder,
  versionBits,
  type QrCode,
  type QrEcc,
} from "~/lib/qr";
import { ringLink } from "~/models/money";

const BELL = "0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb";
const LINK = "ethereum:0xFd5ab7E03E8554210Faa3cCd3b9D47C622fffcCb@1/ring";

/** Reads a symbol back: the format bits, the data codewords block by block, and the byte-mode text. */
function decode(code: QrCode): { ecc: QrEcc; mask: number; text: string; blocksOk: boolean } {
  const m = code.modules;
  const size = code.size;
  // The first copy of the format information, around the top-left finder.
  const bitAt = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  let format = 0;
  for (let i = 0; i <= 5; i++) format |= bitAt(8, i) << i;
  format |= bitAt(8, 7) << 6;
  format |= bitAt(8, 8) << 7;
  format |= bitAt(7, 8) << 8;
  for (let i = 9; i < 15; i++) format |= bitAt(14 - i, 8) << i;
  // The second copy must say the same.
  let second = 0;
  for (let i = 0; i < 8; i++) second |= bitAt(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= bitAt(8, size - 15 + i) << i;
  expect(second).toBe(format);
  const found = (["L", "M", "Q", "H"] as const).flatMap((ecc) =>
    Array.from({ length: 8 }, (_, mask) => ({ ecc, mask })).filter(
      (c) => formatBits(c.ecc, c.mask) === format,
    ),
  );
  expect(found).toHaveLength(1);
  const { ecc, mask } = found[0]!;

  const version = (size - 17) / 4;
  const { reserved } = functionPatterns(version);
  const bits = dataOrder(version, reserved).map(([x, y]) => m[y]![x] !== masks(mask, x, y));
  const raw: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    raw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | (b ? 1 : 0), 0));

  // De-interleave: the short blocks first, each one data codeword shorter than the long ones.
  const { blocks: count, eccPerBlock } = blockLayout(version, ecc);
  const total = raw.length;
  const shortBlocks = count - (total % count);
  const shortLength = Math.floor(total / count);
  const blocks: number[][] = Array.from({ length: count }, () => []);
  let k = 0;
  for (let i = 0; i < shortLength + 1; i++) {
    for (let j = 0; j < count; j++) {
      if (i === shortLength - eccPerBlock && j < shortBlocks) continue;
      blocks[j]!.push(raw[k++]!);
    }
  }
  // Each block's error correction is the remainder of its data, so the block divides exactly.
  const divisor = rsDivisor(eccPerBlock);
  const blocksOk = blocks.every((block) => {
    const data = block.slice(0, block.length - eccPerBlock);
    return rsRemainder(data, divisor).join() === block.slice(-eccPerBlock).join();
  });
  const data = blocks.flatMap((block) => block.slice(0, block.length - eccPerBlock));
  expect(data).toHaveLength(dataCodewords(version, ecc));

  // Byte mode: 0100, a length of 8 bits (16 from version 10), then the bytes.
  const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
  const read = (from: number, length: number) =>
    stream.slice(from, from + length).reduce((a, b) => (a << 1) | b, 0);
  expect(read(0, 4)).toBe(0b0100);
  const lengthBits = version <= 9 ? 8 : 16;
  const length = read(4, lengthBits);
  const bytes = Array.from({ length }, (_, i) => read(4 + lengthBits + i * 8, 8));
  return { ecc, mask, text: new TextDecoder().decode(new Uint8Array(bytes)), blocksOk };
}

describe("the QR encoder, against the standard", () => {
  it("knows each version's capacity", () => {
    expect(dataCodewords(1, "L")).toBe(19);
    expect(dataCodewords(1, "H")).toBe(9);
    expect(dataCodewords(3, "M")).toBe(44);
    expect(dataCodewords(4, "M")).toBe(64);
    expect(dataCodewords(7, "M")).toBe(124);
    expect(dataCodewords(10, "H")).toBe(122);
    expect(dataCodewords(40, "L")).toBe(2956);
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(4)).toEqual([6, 26]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
  });

  it("writes the format and version codes the standard tabulates", () => {
    expect(formatBits("L", 0)).toBe(0b111011111000100);
    expect(formatBits("M", 0)).toBe(0b101010000010010);
    expect(formatBits("Q", 0)).toBe(0b011010101011111);
    expect(formatBits("H", 0)).toBe(0b001011010001001);
    expect(formatBits("M", 5)).toBe(0b100000011001110);
    expect(versionBits(7)).toBe(0b000111110010010100);
    expect(versionBits(40)).toBe(0b101000110001101001);
  });

  it("computes Reed-Solomon codewords as Annex I's worked example does", () => {
    const data = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
    ];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
    ]);
  });

  it.each([
    ["the Doorbell's link", LINK],
    ["a short text", "HELLO WORLD"],
    ["a page of the site", "https://web-production-a7c148.up.railway.app/rules/new#doorbell"],
    ["a long text, past version 9", "x".repeat(300)],
    ["text in more than one script", "Doorbell, 25 rings: ring 50 hires. Ü ő 日本"],
  ])("draws %s so that it reads back, at every level", (_, text) => {
    for (const ecc of ["L", "M", "Q", "H"] as const) {
      const code = encodeQr(text, ecc);
      expect(code.size).toBe(code.version * 4 + 17);
      const read = decode(code);
      expect(read).toEqual({ ecc, mask: code.mask, text, blocksOk: true });
    }
  });
});

describe("the Doorbell's phone link", () => {
  it("is the EIP-681 request for ring() on mainnet, checksummed whatever case it is given in", () => {
    expect(ringLink(BELL)).toBe(LINK);
    expect(ringLink(BELL.toLowerCase())).toBe(LINK);
  });

  it("fits a version 4 symbol at level M, drawn as rectangles inside its quiet zone", () => {
    const code = encodeQr(LINK, "M");
    expect(code.version).toBe(4);
    expect(code.size).toBe(33);
    const path = qrPath(code, 4);
    const rects = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
    expect(rects.map((r) => r[0]).join("")).toBe(path);
    let dark = 0;
    for (const [, x, y, run, back] of rects) {
      expect(run).toBe(back);
      expect(Number(x)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeGreaterThanOrEqual(4);
      expect(Number(x) + Number(run)).toBeLessThanOrEqual(33 + 4);
      expect(Number(y)).toBeLessThan(33 + 4);
      dark += Number(run);
    }
    expect(dark).toBe(code.modules.flat().filter(Boolean).length);
  });
});
