// 同梱ファイルの完全性検証。破損（途中切れ・古いキャッシュ）や差し替えを検知して、壊れた検出モデルで動かさない。
// ファイルを更新したら、下のハッシュも更新する（security.test.mjs が一致を検査する）。
export const SCRIPT_SRI = {
  'face-api.js': 'sha384-M5nePoB6/w/a9JhtegEibSLGiJy/+QMZZMfvcxjWVCQW/HPwrQ7i21V/Px/8AyVA'
};
export const ASSET_SHA256 = {
  'ssd_mobilenetv1_model.bin': '2835640602d53718aa6ae9a42896327eaa21beefed056c218d32ca7d79e1e2f8',
  'ssd_mobilenetv1_model-weights_manifest.json': '888f744dffbc84f5f060d1f8427d9742341943a2dfaaf9205d10029b7e7a2955'
};

export class IntegrityError extends Error {
  constructor(file) { super('integrity check failed: ' + file); this.name = 'IntegrityError'; this.file = file; }
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Of(file, cache) {
  const res = await fetch(file, { cache, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error('fetch failed: ' + file + ' ' + res.status);
  return hex(await crypto.subtle.digest('SHA-256', await res.arrayBuffer()));
}

/** 同梱ファイルのハッシュを確認。不一致なら一度だけキャッシュを破棄して取り直し、それでも違えば IntegrityError */
export async function verifyAsset(file) {
  const want = ASSET_SHA256[file];
  if (!want) throw new Error('unknown asset: ' + file);
  if (!(globalThis.crypto && crypto.subtle)) throw new Error('crypto.subtle unavailable（HTTPS が必要です）');
  if (await sha256Of(file, 'default') === want) return;
  if (await sha256Of(file, 'reload') === want) return;   // 古いキャッシュだった場合の自己修復
  throw new IntegrityError(file);
}

/** スクリプト読み込みが失敗したとき、キャッシュを更新して再試行できるようにする */
export async function refreshFile(file) {
  const res = await fetch(file, { cache: 'reload', credentials: 'omit', referrerPolicy: 'no-referrer' });
  await res.arrayBuffer();
}
