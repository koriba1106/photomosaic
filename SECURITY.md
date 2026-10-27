# セキュリティと信頼性

## 想定する脅威と対策

| 脅威 | 対策 |
|---|---|
| 写真の外部流出 | 処理はすべてブラウザ内。CSP の `connect-src 'self'` で外部通信を遮断（コードが改ざんされても送信できない）。自作コードに通信 API を使わせず（同梱ファイルの検証用 `fetch` のみ）、テストで検査。画像を `localStorage` 等に保存しない |
| XSS・コード注入 | `innerHTML`/`eval`/`new Function`/`document.write` 不使用。CSP は `default-src 'none'`、`script-src 'self' 'wasm-unsafe-eval'`、`style-src 'self'`（インラインのスクリプト/スタイル/イベント属性なし）、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`。ユーザー由来の文字列は `textContent` のみで表示 |
| 悪意あるファイル（SVG/HTML の拡張子偽装、画像爆弾、壊れた画像） | 拡張子・MIMEは信用せず、先頭バイトで JPEG/PNG/WebP/GIF/BMP のみ許可。デコード**前**に画素数（上限1.2億）とファイルサイズ（上限100MB）を検査。SVG は拒否。壊れた画像は例外処理で拒否。保存名はサニタイズ |
| 同梱ライブラリ・モデルの改ざん／破損／古いキャッシュ | 外部CDNを使わず同梱。`face-api.js` は読み込み時に **SRI（SHA-384）** で検証し、不一致なら実行しない。モデルは読み込み前に **SHA-256** を照合し、不一致なら（キャッシュを取り直して再確認のうえ）使用を拒否。固定値は `integrity.js`、記録は `CHECKSUMS.sha256`、`npm test` が実ファイルとの一致を検査 |
| クリックジャッキング | 他サイトの iframe 内では操作画面を出さず、「新しいタブで開く」案内だけを表示（`guard.js`）。`app.js` も起動しない。HTTPヘッダーを設定できる環境では `_headers` の `frame-ancestors 'none'` を併用 |
| 検出失敗・例外でモザイクなしの画像が出る（プライバシー事故） | **安全側（fail-closed）**: 判定できない顔は「モザイク」、モザイクを適用できなかった場合は書き出しを中断、検出が未完了／失敗のまま保存するときは確認を表示し、確認画面に警告を明記。「モザイクなし」表示中でも保存は常にモザイク適用後 |
| 不要な情報の漏えい | `Referrer-Policy: no-referrer`。出力は canvas 再エンコードのため EXIF（位置情報・機種等）は含まれない。結果の Blob URL は画面を閉じる／離れる際に破棄 |
| Service Worker 経由のキャッシュ汚染・新旧ファイルの混在 | 同一オリジンの正常応答（200・`basic`）のみ保存。`skipWaiting` を使わず、次回起動時に切り替え。JS/CSS の取得失敗時に HTML を返さない（画面遷移のみ退避）。アプリ側からの「取り直し」要求に対応（自己修復） |
| 安全でない配信（http）での改ざん | http（localhost 以外）で開かれた場合は警告を表示。`file://` で開いた場合は起動できない旨を案内 |
| 手動モザイクの入力の悪用・暴走 | 枠の座標は有限値・整数・写真内に正規化（非数/無限大/極小/写真外は却下）。件数は300件まで。読み込み・書き出し中は編集操作を受け付けない（`inert`）。保存の二重実行を防止。枠の座標以外の文字列を画面に出さない |
| パラメータ悪用・内部状態の露出 | URL の `backend` は許可リスト方式。テスト用フック `window.__fm` は、手元（localhost 等）で `?debug` を付けた時だけ公開 |

## 実施した検証
- 自動テスト（`npm test`）33件（バージョン整合、手動モザイクの実装検査を含む）
- 実ブラウザ（ヘッドレス Chrome）での検証: 厳格な CSP 下で CSP 違反 0 件・外部通信 0 件、悪意あるファイル6種の拒否、`face-api.js` を1バイト改ざん／モデルを1バイト改ざんしたコピーでの拒否と警告付き保存、`getImageData` を故意に失敗させた際の書き出し中断（fail-closed、手動枠を含む）、手動追加（複数追加・タップ削除・戻す・全消去・再検出後の保持・写真外/はみ出しドラッグ・上限・ピンチとの競合・書き出し結果の画素検証）、検出エンジンが使えない状況でも手動枠だけでモザイク済み画像を保存できること、iframe（通常／sandbox）での遮断、`file://` での起動失敗案内、10種類の画面サイズでのレイアウト・タップ領域

## 制約（正直な注意）
- GitHub Pages では HTTP ヘッダーを設定できません。`frame-ancestors`・`X-Content-Type-Options`・`Permissions-Policy` 等はヘッダーが必要なため、`<meta>` で代替できない分は `guard.js` で緩和しています。完全に対応するなら Netlify / Cloudflare Pages に `_headers` を付けて配置してください。
- CSP の `'wasm-unsafe-eval'` は、顔検出ライブラリが起動時に行う WebAssembly 対応確認のために許可しています（JavaScript の eval は許可していません）。
- Trusted Types（`require-trusted-types-for`）や、CSS・JS 自体への SRI は採用していません（未検証のブラウザで動かなくなる恐れ、および `style.css` を利用者が編集できなくなるため）。
- 顔検出の漏れは「安全性」ではなく「精度」の問題ですが、プライバシー保護の用途では重要です。公開前に必ず目視確認してください。
- 実機の iPhone / Android での動作・速度は、私の環境では未確認です。
- GitHub アカウントには2要素認証を設定してください。

## 同梱ライブラリ
`face-api.js`・`ssd_mobilenetv1_model*` は [@vladmandic/face-api](https://www.npmjs.com/package/@vladmandic/face-api) 1.7.15（MIT）から無改変で取得。更新する場合は、`npm pack` で取得 → `sha256sum` を `CHECKSUMS.sha256` に、SHA-384/SHA-256 を `integrity.js` に反映 → `sw.js` の `VERSION` を上げる、の順で行ってください。取得時点の `npm audit` は脆弱性 0 件でした（既知の脆弱性がないことの保証ではありません）。

## 脆弱性の報告
GitHub の Security Advisories（Private vulnerability reporting）または Issue でお知らせください。
