// 起動前に動く小さな防御スクリプト（クラシックスクリプト。app.js が読み込めない状況でも働く）
// 1) クリックジャッキング対策: 他サイトの iframe 内なら、操作画面を出さず「別タブで開く」案内だけを表示
// 2) 起動失敗の検知: app.js が4秒以内に起動しなければ、原因の案内を表示（file:// で開いた場合など）
(function () {
  var root = document.documentElement;
  var framed = false;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }

  if (framed) {
    root.style.visibility = 'hidden';
    document.addEventListener('DOMContentLoaded', function () {
      document.body.textContent = '';
      var box = document.createElement('div');
      box.className = 'frame-blocked';
      box.setAttribute('role', 'alert');
      box.textContent = 'このページは他のサイトの中では利用できません。安全のため、下のリンクから直接開いてください。';
      var link = document.createElement('a');
      link.href = location.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '新しいタブで開く';
      box.appendChild(document.createElement('br'));
      box.appendChild(link);
      document.body.appendChild(box);
      root.style.visibility = 'visible';
    });
    return;
  }

  setTimeout(function () {
    if (root.getAttribute('data-ready')) return;
    var el = document.getElementById('boot-error');
    if (!el) return;
    el.textContent = 'アプリを起動できませんでした。ファイルを直接開いている場合は動作しません。GitHub Pages などで公開するか、簡易サーバー（例: python3 -m http.server）経由で開いてください。';
    el.hidden = false;
  }, 4000);
})();
