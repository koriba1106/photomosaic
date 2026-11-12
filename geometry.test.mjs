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

test('normalizeRect: 順不同・はみ出しは画像内に収め、不正値/小さすぎ/写真の外は null', () => {
  assert.deepEqual(g.normalizeRect({ x: 50, y: 60 }, { x: 10, y: 20 }, 200, 100), { x: 10, y: 20, w: 40, h: 40 });
  assert.deepEqual(g.normalizeRect({ x: -30, y: -30 }, { x: 40, y: 50 }, 200, 100), { x: 0, y: 0, w: 40, h: 50 });
  assert.deepEqual(g.normalizeRect({ x: 150, y: 50 }, { x: 400, y: 400 }, 200, 100), { x: 150, y: 50, w: 50, h: 50 });
  assert.equal(g.normalizeRect({ x: 300, y: 300 }, { x: 400, y: 400 }, 200, 100), null);        // 写真の外
  assert.equal(g.normalizeRect({ x: 10, y: 10 }, { x: 15, y: 40 }, 200, 100), null);            // 小さすぎる
  assert.equal(g.normalizeRect({ x: NaN, y: 0 }, { x: 40, y: 50 }, 200, 100), null);
  assert.equal(g.normalizeRect({ x: 0, y: 0 }, { x: Infinity, y: 50 }, 200, 100), null);
  assert.equal(g.normalizeRect(null, { x: 1, y: 1 }, 200, 100), null);
  assert.equal(g.normalizeRect({ x: 0, y: 0 }, { x: 50, y: 50 }, 0, 100), null);
  const r = g.normalizeRect({ x: 10.4, y: 10.6 }, { x: 60.2, y: 70.9 }, 200, 100);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h));
});

test('hitRect: 最小面積優先・小さい枠にも最低限の当たり判定・外れは -1', () => {
  const view = { s: 1, tx: 0, ty: 0 };
  const rects = [{ x: 0, y: 0, w: 200, h: 200 }, { x: 80, y: 80, w: 40, h: 40 }, { x: 400, y: 400, w: 4, h: 4 }];
  assert.equal(g.hitRect(rects, { x: 100, y: 100 }, view), 1);        // 入れ子は小さい方
  assert.equal(g.hitRect(rects, { x: 10, y: 10 }, view), 0);
  assert.equal(g.hitRect(rects, { x: 402, y: 402 }, view), 2);
  assert.equal(g.hitRect(rects, { x: 420, y: 420 }, view), 2);        // 4px 枠でも 44px 四方で当たる
  assert.equal(g.hitRect(rects, { x: 600, y: 600 }, view), -1);
  assert.equal(g.hitRect([], { x: 1, y: 1 }, view), -1);
  assert.equal(g.hitRect(rects, { x: NaN, y: 1 }, view), -1);
  const zoomed = { s: 4, tx: -300, ty: -300 };                         // 拡大・移動後の画面座標でも正しい
  assert.equal(g.hitRect(rects, { x: 100 * 4 - 300, y: 100 * 4 - 300 }, zoomed), 1);
});

test('MAX_MANUAL は妥当な正の整数', () => {
  assert.ok(Number.isInteger(g.MAX_MANUAL) && g.MAX_MANUAL >= 50 && g.MAX_MANUAL <= 1000);
});

// テスト用の合成画像生成ヘルパー（車体＋ナンバープレート文字描画）
function makeTestImage(W, H, bgRGB = [55, 62, 72]) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = bgRGB[0];
    data[i * 4 + 1] = bgRGB[1];
    data[i * 4 + 2] = bgRGB[2];
    data[i * 4 + 3] = 255;
  }
  const fillRect = (x0, y0, rw, rh, rgb) => {
    const xEnd = Math.min(W, Math.round(x0 + rw)), yEnd = Math.min(H, Math.round(y0 + rh));
    for (let y = Math.max(0, Math.round(y0)); y < yEnd; y++) {
      for (let x = Math.max(0, Math.round(x0)); x < xEnd; x++) {
        const p = (y * W + x) * 4;
        data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2];
      }
    }
  };
  // ナンバープレート（上段：分類番号、下段：4桁ナンバー＋ハイフン）を描画
  const drawPlate = (px, py, pw, ph, plateRGB = [245, 248, 245], charRGB = [18, 65, 35]) => {
    fillRect(px, py, pw, ph, plateRGB);
    // 上段の小文字群（地域名・分類番号）
    const topY = py + ph * 0.16, topH = Math.max(2, ph * 0.20);
    for (const rx of [0.22, 0.33, 0.48, 0.57, 0.66]) {
      fillRect(px + pw * rx, topY, Math.max(2, pw * 0.055), topH, charRGB);
    }
    // 下段の4桁数字（2本の縦ストローク＋横バーを持つ数字パターン）とハイフン
    const botY = py + ph * 0.45, botH = Math.max(4, ph * 0.42);
    const sw = Math.max(1.5, pw * 0.032), dw = Math.max(4, pw * 0.13);
    const digitsX = [0.10, 0.22, 0.40, 0.63, 0.80]; // ひらがな + 4桁
    digitsX.forEach((dx, idx) => {
      const x = px + pw * dx;
      if (idx === 0) {
        fillRect(x, botY + botH * 0.2, sw * 1.4, botH * 0.6, charRGB);
      } else {
        // 数字の左右の縦画と上・中・下の横画
        fillRect(x, botY, sw, botH, charRGB);
        fillRect(x + dw - sw, botY, sw, botH, charRGB);
        fillRect(x, botY, dw, Math.max(1, botH * 0.18), charRGB);
        fillRect(x, botY + botH * 0.42, dw, Math.max(1, botH * 0.18), charRGB);
        fillRect(x, botY + botH * 0.82, dw, Math.max(1, botH * 0.18), charRGB);
      }
    });
    // ハイフン
    fillRect(px + pw * 0.55, botY + botH * 0.42, Math.max(2, pw * 0.05), Math.max(1.5, botH * 0.18), charRGB);
  };
  return { data, width: W, height: H, fillRect, drawPlate };
}

test('detectPlates: 白ナンバー・黄色ナンバー（軽）・緑ナンバー・大きいプレートを自動検出し、無関係な背景は誤検出しない', () => {
  // 1) 白ナンバー（普通車）
  const img1 = makeTestImage(320, 220, [50, 58, 70]);
  img1.drawPlate(110, 120, 80, 40, [245, 247, 245], [16, 62, 34]);
  const res1 = g.detectPlates(img1);
  assert.ok(res1.length >= 1, '白ナンバーを検出');
  assert.equal(res1[0].kind, 'plate');
  assert.ok(g.iou(res1[0], { x: 110, y: 120, w: 80, h: 40 }) > 0.35, `白ナンバーの位置が一致: ${JSON.stringify(res1[0])}`);

  // 2) 黄色ナンバー（軽自動車）
  const img2 = makeTestImage(320, 220, [40, 45, 52]);
  img2.drawPlate(90, 100, 92, 46, [242, 205, 30], [20, 20, 20]);
  const res2 = g.detectPlates(img2);
  assert.ok(res2.length >= 1, '黄色ナンバーを検出');
  assert.ok(g.iou(res2[0], { x: 90, y: 100, w: 92, h: 46 }) > 0.35, `黄色ナンバーの位置が一致: ${JSON.stringify(res2[0])}`);

  // 3) 緑ナンバー（事業用）
  const img3 = makeTestImage(320, 220, [180, 185, 190]);
  img3.drawPlate(100, 110, 88, 44, [20, 82, 48], [242, 246, 242]);
  const res3 = g.detectPlates(img3);
  assert.ok(res3.length >= 1, '緑ナンバーを検出');
  assert.ok(g.iou(res3[0], { x: 100, y: 110, w: 88, h: 44 }) > 0.35, `緑ナンバーの位置が一致: ${JSON.stringify(res3[0])}`);

  // 4) アップの大きなナンバープレート（ピラミッド縮小で検出）
  const img4 = makeTestImage(480, 320, [60, 65, 75]);
  img4.drawPlate(140, 110, 180, 90, [246, 248, 246], [15, 58, 30]);
  const res4 = g.detectPlates(img4);
  assert.ok(res4.length >= 1, '大きいナンバーも検出');
  assert.ok(g.iou(res4[0], { x: 140, y: 110, w: 180, h: 90 }) > 0.35, `大きいナンバーの位置が一致: ${JSON.stringify(res4[0])}`);

  // 5) ナンバーのない単色・グラデーション・赤ランプ・肌色領域では誤検出しない
  const blank = makeTestImage(320, 220, [70, 80, 95]);
  blank.fillRect(40, 60, 80, 40, [220, 30, 30]);   // 赤いテールランプ
  blank.fillRect(160, 60, 80, 80, [215, 160, 125]); // 肌色領域
  assert.equal(g.detectPlates(blank).length, 0, 'テールランプや肌色は誤検出しない');
});

test('expandFace: ナンバープレート枠（kind=plate）は縦横とも適度に拡張される', () => {
  const p = { x: 100, y: 100, w: 80, h: 40, kind: 'plate' };
  const r = g.expandFace(p, 1.6, 400, 300);
  assert.ok(r.w > 80 && r.w < 110 && r.h > 40 && r.h < 60, `適度な拡張: ${JSON.stringify(r)}`);
});
