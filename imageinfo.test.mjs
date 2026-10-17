import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImage } from './imageinfo.js';

const bytes = (...a) => Uint8Array.from(a.flat(Infinity));
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >> 8) & 255];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const str = (s) => [...s].map((c) => c.charCodeAt(0));

test('PNG の寸法', () => {
  const b = bytes(0x89, str('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, be32(13), str('IHDR'), be32(4000), be32(3000), 8, 2, 0, 0, 0);
  assert.deepEqual(sniffImage(b), { type: 'png', width: 4000, height: 3000 });
});
test('PNG: 巨大画素数もそのまま報告（呼び出し側で弾く）', () => {
  const b = bytes(0x89, str('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, be32(13), str('IHDR'), be32(60000), be32(60000), 8, 2, 0, 0, 0);
  assert.equal(sniffImage(b).width * sniffImage(b).height, 3.6e9);
});
test('JPEG: APPn を読み飛ばして SOF から寸法を取得', () => {
  const app1 = [0xff, 0xe1, ...[0x01, 0x00], ...new Array(254).fill(0)];
  const sof = [0xff, 0xc2, 0x00, 0x11, 8, 0x0b, 0xc0, 0x0f, 0xc0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const b = bytes(0xff, 0xd8, [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)], app1, sof, [0xff, 0xda, 0, 8]);
  assert.deepEqual(sniffImage(b), { type: 'jpeg', width: 4032, height: 3008 });
});
test('JPEG: SOF の前に SOS が来る壊れたファイルは null', () => {
  assert.equal(sniffImage(bytes(0xff, 0xd8, [0xff, 0xda, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});
test('GIF / BMP', () => {
  assert.deepEqual(sniffImage(bytes(str('GIF89a'), le16(640), le16(480), 0, 0, 0, 0)), { type: 'gif', width: 640, height: 480 });
  const bmp = new Uint8Array(40); bmp.set([0x42, 0x4d]); bmp.set(le32(800), 18); bmp.set(le32((-600) >>> 0), 22);
  assert.deepEqual(sniffImage(bmp), { type: 'bmp', width: 800, height: 600 });
});
test('WebP: VP8X / VP8 / VP8L', () => {
  const head = (fourcc) => [str('RIFF'), le32(100), str('WEBP'), str(fourcc)];
  const x = bytes(head('VP8X'), le32(10), [0, 0, 0, 0], [0x0f, 0x0f, 0], [0xff, 0x0b, 0], new Array(8).fill(0));
  // 幅=1+0x000f0f, 高さ=1+0x000bff
  assert.deepEqual(sniffImage(x), { type: 'webp', width: 1 + 0x0f0f, height: 1 + 0x0bff });
  const l = new Uint8Array(40); l.set(head('VP8L').flat()); l[20] = 0x2f; l.set(le32((1023) | (767 << 14)), 21);
  assert.deepEqual(sniffImage(l), { type: 'webp', width: 1024, height: 768 });
  const v = new Uint8Array(40); v.set(head('VP8 ').flat()); v.set(le16(320), 26); v.set(le16(240), 28);
  assert.deepEqual(sniffImage(v), { type: 'webp', width: 320, height: 240 });
});
test('SVG / HTML / スクリプト / 空 / 短すぎるデータは null（拡張子偽装を弾く）', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')), null);
  assert.equal(sniffImage(enc('<!doctype html><script>alert(1)</script>')), null);
  assert.equal(sniffImage(enc('GIF')), null);
  assert.equal(sniffImage(new Uint8Array(0)), null);
  assert.equal(sniffImage(null), null);
  assert.equal(sniffImage(new Uint8Array(64)), null);
});
test('ゼロ寸法は null', () => {
  assert.equal(sniffImage(bytes(0x89, str('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, be32(13), str('IHDR'), be32(0), be32(10), 8, 2, 0, 0, 0)), null);
});
