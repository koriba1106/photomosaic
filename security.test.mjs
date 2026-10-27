import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const bin = (p) => fs.readFileSync(path.join(root, p));
const own = ['app.js', 'geometry.js', 'imageinfo.js', 'integrity.js', 'guard.js', 'sw.js'];

test('構成: すべてのファイルが同じディレクトリにある（サブフォルダなし）', () => {
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'node_modules');
  assert.deepEqual(dirs.map((d) => d.name), []);
});

test('信頼性: index.html / sw.js / manifest が参照するファイルが全て存在する', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|blob:|data:|#)/.test(u));
  const core = [...read('sw.js').match(/const CORE = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './');
  const heavy = [...read('sw.js').match(/const HEAVY = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const manifest = JSON.parse(read('manifest.webmanifest')).icons.map((i) => i.src);
  for (const f of new Set([...refs, ...core, ...heavy, ...manifest])) assert.ok(fs.existsSync(path.join(root, f)), `存在しない: ${f}`);
  for (const f of ['style.css', 'app.css', 'app.js', 'guard.js']) assert.ok(refs.includes(f), `index.html が ${f} を読み込んでいない`);
});

test('同梱ライブラリ・モデルのハッシュが記録値と一致（改ざん・差し替え検知）', () => {
  const lines = read('CHECKSUMS.sha256').trim().split('\n');
  assert.ok(lines.length >= 3);
  for (const line of lines) {
    const [hash, file] = line.split(/\s+/);
    assert.equal(crypto.createHash('sha256').update(bin(file)).digest('hex'), hash, file);
  }
});

test('実行時の完全性検証に使う固定値（integrity.js）が実ファイルと一致している', () => {
  const src = read('integrity.js');
  const sri = src.match(/'face-api\.js':\s*'(sha384-[^']+)'/)[1];
  assert.equal(sri, 'sha384-' + crypto.createHash('sha384').update(bin('face-api.js')).digest('base64'));
  for (const [, file, hex] of src.matchAll(/'([\w.\-]+\.(?:bin|json))':\s*'([0-9a-f]{64})'/g)) {
    assert.equal(crypto.createHash('sha256').update(bin(file)).digest('hex'), hex, file);
  }
  assert.ok(/s\.integrity\s*=/.test(read('app.js')), 'スクリプト読み込みで SRI を指定している');
});

test('自作コードに危険な API・永続保存がない', () => {
  const banned = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /\beval\s*\(/, /new\s+Function\b/, /document\.write/, /javascript:/i, /setTimeout\s*\(\s*['"`]/,
    /localStorage|sessionStorage|indexedDB|document\.cookie/];
  for (const f of own) for (const re of banned) assert.ok(!re.test(read(f)), `${f}: ${re}`);
});

test('外部ホストへ通信・参照しない（自作コード・HTML・CSS）', () => {
  for (const f of [...own, 'index.html', 'app.css', 'style.css', 'manifest.webmanifest']) {
    const hits = (read(f).match(/https?:\/\/[^\s"'`)]+/g) || []).filter((u) => !/^https?:\/\/(localhost|www\.w3\.org)/.test(u));
    assert.deepEqual(hits, [], f);
  }
  for (const f of ['app.js', 'geometry.js', 'imageinfo.js', 'guard.js']) assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/.test(read(f)), `${f} は通信 API を使わない`);
  const calls = (read('integrity.js').match(/fetch\s*\([^)]*\)/g) || []);
  assert.ok(calls.length >= 2 && calls.every((c) => /^fetch\(file,/.test(c)), 'integrity.js の fetch は同梱ファイル名のみ');
});

test('index.html: CSP・referrer 指定があり、インラインのスクリプト/スタイル/イベントがない', () => {
  const h = read('index.html');
  const csp = (h.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/) || [])[1];
  assert.ok(csp, 'CSP meta');
  for (const d of ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "img-src 'self' blob:"]) assert.ok(csp.includes(d), d);
  assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:/.test(csp.replace(/'wasm-unsafe-eval'/g, '')), 'unsafe-* ・ワイルドカード・外部ホストなし');
  assert.ok(h.indexOf('Content-Security-Policy') < h.indexOf('<script'), 'CSP は最初のスクリプトより前');
  assert.ok(/name="referrer"\s+content="no-referrer"/.test(h));
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(h), 'inline script');
  assert.ok(!/\son[a-z]+\s*=/i.test(h), 'inline handler');
  assert.ok(!/\sstyle\s*=/i.test(h), 'inline style');
  assert.ok(!/<style[\s>]/i.test(h), '<style> ブロック');
  for (const m of h.matchAll(/<a [^>]*target="_blank"[^>]*>/g)) assert.ok(/rel="noopener noreferrer"/.test(m[0]), m[0]);
  assert.equal(csp, (read('_headers').match(/Content-Security-Policy: ([^\n]+?)(?:; frame-ancestors 'none')?\n/) || [])[1], '_headers の CSP と meta の CSP が一致');
});

test('guard.js: iframe 内では操作画面を出さず、起動失敗を知らせる', () => {
  const g = read('guard.js');
  assert.ok(/window\.top\s*!==\s*window\.self/.test(g) && /frame-blocked/.test(g) && /rel\s*=\s*'noopener noreferrer'/.test(g));
  assert.ok(/data-ready/.test(g) && /boot-error/.test(g));
  assert.ok(/throw new Error\('framed'\)/.test(read('app.js')), 'app.js も iframe 内では起動しない');
  assert.ok(/data-ready/.test(read('app.js')));
});

test('Service Worker: 同一オリジンの正常応答のみ保存、skipWaiting なし、HTML を JS/CSS の代わりに返さない', () => {
  const s = read('sw.js');
  assert.ok(/origin\s*!==\s*location\.origin/.test(s));
  assert.ok(/res\.ok\s*&&\s*res\.status\s*===\s*200\s*&&\s*res\.type\s*===\s*'basic'/.test(s));
  assert.ok(!/self\.skipWaiting\s*\(/.test(s), 'skipWaiting を呼ばない（新旧ファイルの混在防止）');
  assert.ok(/req\.mode\s*===\s*'navigate'/.test(s));
  assert.ok(/req\.cache\s*===\s*'reload'/.test(s), '取り直し要求（自己修復）に対応');
});

test('リリース整合: package.json / app.js / sw.js / CHANGELOG のバージョンが一致', () => {
  const v = JSON.parse(read('package.json')).version;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.ok(read('app.js').includes(`const APP_VERSION = '${v}'`), 'app.js の APP_VERSION');
  assert.ok(read('sw.js').includes(`const VERSION = 'fm-${v}'`), 'sw.js の VERSION（古いキャッシュを確実に捨てるため）');
  assert.ok(read('CHANGELOG.md').includes(`## ${v}`), 'CHANGELOG に当該バージョンの項目');
});

test('手動モザイク: 件数上限・入力検証・安全側の書き出し・二重実行防止が実装されている', () => {
  const a = read('app.js');
  assert.ok(/G\.MAX_MANUAL/.test(a) && /G\.normalizeRect\(/.test(a) && /G\.hitRect\(/.test(a), '上限・正規化・当たり判定を使用');
  assert.ok(/mosaicTargets\(\)/.test(a.slice(a.indexOf('async function exportBlob'))), '書き出しは手動枠も対象');
  assert.ok(/if \(!S\.img \|\| S\.exporting\) return;/.test(a) && /S\.exporting = false/.test(a), '保存の二重実行防止');
  assert.ok(/el\.layout\.inert = on/.test(a), '処理中は編集操作をロック');
  assert.ok(/mosaic not applied/.test(a), '適用できなければ書き出しを中断（fail-closed）');
});
