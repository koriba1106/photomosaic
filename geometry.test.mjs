import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from './geometry.js';

test('tilePlan: 全域を覆い、重なりがあり、端を超えない', () => {
  for (const [W, H, T] of [[4032, 3024, 1024], [4032, 3024, 640], [1000, 700, 640], [3000, 500, 1024], [5000, 5000, 640]]) {
    const tiles = g.tilePlan(W, H, T, 0.25);
    const cov = new Uint8Array(Math.ceil(W / 8) * Math.ceil(H / 8));
    for (const t of tiles) {
      assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= W && t.y + t.h <= H, 'inside');
      assert.ok(t.w <= T && t.h <= T);
    }
    for (let y = 0; y < H; y += 8) for (let x = 0; x < W; x += 8)
      assert.ok(tiles.some((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h), `covered ${x},${y} (${W}x${H},T${T})`);
  }
  assert.equal(g.tilePlan(500, 400, 1024).length, 1);
});

test('tilePlan: 顔が overlap 以下なら必ず1タイルに完全に収まる', () => {
  const W = 4032, H = 3024, T = 1024, ov = 0.25, face = 250;
  const tiles = g.tilePlan(W, H, T, ov);
  for (let y = 0; y <= H - face; y += 37) for (let x = 0; x <= W - face; x += 41)
    assert.ok(tiles.some((t) => x >= t.x && y >= t.y && x + face <= t.x + t.w && y + face <= t.y + t.h), `${x},${y}`);
});

test('touchesInnerEdge: 内側境界のみ判定、画像端は除外', () => {
  const t = { x: 1000, y: 0, w: 1024, h: 1024 };
  assert.equal(g.touchesInnerEdge({ x: 1001, y: 100, w: 50, h: 50 }, t, 4000, 3000), true);
  assert.equal(g.touchesInnerEdge({ x: 1500, y: 0, w: 50, h: 50 }, t, 4000, 3000), false); // 上端は画像端
  assert.equal(g.touchesInnerEdge({ x: 1500, y: 500, w: 50, h: 50 }, t, 4000, 3000), false);
  assert.equal(g.touchesInnerEdge({ x: 1500, y: 980, w: 44, h: 44 }, t, 4000, 3000), true);
});

test('mergeBoxes: 重複は統合、隣接する別人は残す', () => {
  const a = { x: 100, y: 100, w: 100, h: 100, score: 0.9 };
  const dup = { x: 105, y: 102, w: 96, h: 98, score: 0.7 };
  const inner = { x: 120, y: 120, w: 50, h: 50, score: 0.6 };
  const neighbor = { x: 190, y: 100, w: 100, h: 100, score: 0.8 };
  const far = { x: 600, y: 600, w: 40, h: 40, score: 0.5 };
  const m = g.mergeBoxes([dup, a, inner, neighbor, far]);
  assert.equal(m.length, 3);
  assert.ok(m.includes(a) && m.includes(neighbor) && m.includes(far));
});

test('expandFace: 画像内に収まり、手動枠は拡張しない', () => {
  const f = { x: 10, y: 10, w: 100, h: 100 };
  const r = g.expandFace(f, 1.5, 200, 200);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 200 && r.y + r.h <= 200);
  assert.ok(r.w > 100);
  const m = g.expandFace({ x: 5.2, y: 6.7, w: 40, h: 30, manual: true }, 2, 100, 100);
  assert.deepEqual(m, { x: 5, y: 6, w: 41, h: 31 });
});

test('pointInPolygon: 凸・凹・右回り左回り', () => {
  const sq = g.rectPoly({ x: 0, y: 0 }, { x: 10, y: 10 });
  const sqRev = sq.slice().reverse();
  const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 4 }, { x: 0, y: 10 }];
  for (const p of [sq, sqRev]) {
    assert.ok(g.pointInPolygon(5, 5, p));
    assert.ok(!g.pointInPolygon(11, 5, p));
    assert.ok(!g.pointInPolygon(-1, 5, p));
  }
  assert.ok(g.pointInPolygon(5, 2, concave));
  assert.ok(!g.pointInPolygon(5, 8, concave));
});

test('coverage: 割合が正しい／複数領域の和集合', () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  const half = g.rectPoly({ x: 0, y: 0 }, { x: 50, y: 100 });
  assert.ok(Math.abs(g.coverage(r, [half]) - 0.5) < 0.04);
  assert.equal(g.coverage(r, []), 0);
  assert.equal(g.coverage(r, [g.rectPoly({ x: -10, y: -10 }, { x: 200, y: 200 })]), 1);
  const other = g.rectPoly({ x: 50, y: 0 }, { x: 100, y: 100 });
  assert.ok(g.coverage(r, [half, other]) > 0.97);
  assert.equal(g.coverage(r, [g.rectPoly({ x: 300, y: 300 }, { x: 400, y: 400 })]), 0);
});

test('cellGrid: 下限・上限・縦横比', () => {
  assert.deepEqual(g.cellGrid(300, 330, 8), { nx: 8, ny: 9 });
  assert.equal(g.cellGrid(6, 6, 8).nx, 2);
  assert.ok(g.cellGrid(1000, 100, 8).ny >= 2);
});

test('view: zoomAt はカーソル下の点を固定、fit は中央、clamp は画像を見失わない', () => {
  const v = g.fitView(4000, 3000, 400, 700, 0);
  assert.ok(Math.abs(v.s - 0.1) < 1e-9);
  assert.ok(Math.abs(v.tx) < 1e-9 && Math.abs(v.ty - (700 - 300) / 2) < 1e-9);
  const p = { x: 123, y: 321 };
  const before = g.toImage(v, p.x, p.y);
  const z = g.zoomAt(v, 3, p.x, p.y, 0.01, 8);
  const after = g.toImage(z, p.x, p.y);
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
  assert.equal(g.zoomAt(v, 1e6, 0, 0, 0.01, 8).s, 8);
  const c = g.clampView({ s: 1, tx: -99999, ty: 99999 }, 1000, 1000, 400, 700, 64);
  assert.equal(c.tx, 64 - 1000); assert.equal(c.ty, 700 - 64);
});

test('carryOverrides: 近い顔にだけ手動設定を引き継ぐ', () => {
  const old = [{ x: 0, y: 0, w: 100, h: 100, override: 'keep' }, { x: 500, y: 0, w: 100, h: 100, override: 'mosaic' }];
  const nu = [{ x: 4, y: 3, w: 98, h: 99, override: null }, { x: 900, y: 0, w: 100, h: 100, override: null }];
  g.carryOverrides(old, nu);
  assert.equal(nu[0].override, 'keep'); assert.equal(nu[1].override, null);
});

test('limitSize: 総画素・長辺の上限', () => {
  const a = g.limitSize(8000, 6000, 16e6, 8192);
  assert.ok(a.w * a.h <= 16e6 * 1.001 && a.scaled);
  const b = g.limitSize(4032, 3024, 16e6, 8192);
  assert.deepEqual(b, { w: 4032, h: 3024, scaled: false });
});
