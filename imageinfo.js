// 画像ファイルの先頭バイトから、種類と画素数を安全に判定する（デコード前の検査用）。
// ・拡張子や MIME は信用しない（SVG/HTML 等の偽装を弾く）
// ・巨大画素数の「画像爆弾」をデコード前に弾く
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; };
const ok = (type, width, height) => (width > 0 && height > 0 ? { type, width, height } : null);

/** @param {Uint8Array} b ファイル先頭（推奨: 1MB） @returns {{type:string,width:number,height:number}|null} */
export function sniffImage(b) {
  if (!b || b.length < 12) return null;
  // PNG
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
    return ok('png', u32be(b, 16), u32be(b, 20));
  }
  // JPEG（SOF マーカーまで走査）
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m === 0xd9 || m === 0xda) return null;
      const len = u16be(b, o + 2);
      if (len < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok('jpeg', u16be(b, o + 7), u16be(b, o + 5));
      o += 2 + len;
    }
    return null;
  }
  // GIF
  if (b.length >= 10 && ascii(b, 0, 4) === 'GIF8') return ok('gif', u16le(b, 6), u16le(b, 8));
  // BMP
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return ok('bmp', u32le(b, 18), Math.abs(u32le(b, 22) | 0));
  // WebP
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const t = ascii(b, 12, 4);
    if (t === 'VP8X') return ok('webp', 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    if (t === 'VP8 ') return ok('webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (t === 'VP8L' && b[20] === 0x2f) { const v = u32le(b, 21); return ok('webp', 1 + (v & 0x3fff), 1 + ((v >>> 14) & 0x3fff)); }
  }
  return null;
}
