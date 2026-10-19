# CC Deck

複数の Claude Code セッションを 1 つのウィンドウで並列に管理する Windows 用デスクトップアプリです。
左のサイドバーで各セッションの状態（作業中・入力待ち・完了）とメモリ使用量を確認し、右のターミナルで操作します。

## 必要なもの

1. **Rust**（1.90 以上）: https://rustup.rs からインストールし、`rustup default stable-msvc` を実行
2. **Visual Studio Build Tools**: 「C++ によるデスクトップ開発」ワークロードを選択してインストール
3. **Node.js** 20 以上
4. **Git for Windows**（Git Bash）
5. **Claude Code**（Git Bash から `claude` で起動できる状態）

WebView2 は Windows 10/11 に標準で入っています。

## 起動

```bash
npm install
npm run tauri dev
```

初回は Rust の依存ビルドに数分かかります。

## 配布用ビルド

```bash
npm run tauri build
```

`src-tauri/target/release/bundle/nsis/` にインストーラ（.exe）、`bundle/msi/` に MSI ができます。
インストールせずに使うなら `src-tauri/target/release/cc-deck.exe` を直接起動しても動きます。

## 使い方

「＋」またはCtrl+Shift+Nでフォルダを選ぶと、そのフォルダで Git Bash が起動し、続けて Claude Code が立ち上がります。

| キー | 動作 |
| --- | --- |
| Ctrl+Shift+N | 新しいセッション |
| Ctrl+0 | 一覧画面 / 直前のセッションへ切り替え |
| Ctrl+1〜9 | サイドバーの番号のセッションへ切り替え |
| Ctrl+Shift+A | 次の入力待ちセッションへ移動 |
| Ctrl+Shift+C / V | コピー / 貼り付け（Ctrl+C は Claude Code の中断に使うため） |
| Ctrl+Shift+W | 表示中のセッションを閉じる |

一覧画面（サイドバーの「一覧」または Ctrl+0）では、全セッションの状態と画面の末尾をカードで並べて表示します。入力待ちのカードには選択肢のボタンが出るほか、各カードの入力欄から 1 行の指示を送れます。カードをクリックするとそのセッションのターミナルに切り替わります。

裏のセッションが入力待ちになると、タスクバーのアイコンが点滅し、ウィンドウタイトルに件数が出て、Windows の通知も表示されます。20 秒以上かかった作業が終わったときも通知します。表示中のセッションをウィンドウで見ているときは通知しません。通知をクリックすると、そのセッションに切り替わります（画面に出ている間のクリックのみ。通知センターからのクリックでは切り替わりません）。

新しいセッションのダイアログで「新しい worktree で作る」を選ぶと、リポジトリの隣に `リポジトリ名-ブランチ名` のフォルダを `git worktree add` で作り、そこでセッションを起動します。同じリポジトリで複数の Claude Code を並列に動かしてもファイルが衝突しません。セッションを閉じても worktree は削除しないので、不要になったら `git worktree remove` で消してください。

アプリを起動したときにセッションが無ければ、前回開いていたセッションを「前回の N 件を再開」でまとめて開き直せます。Claude Code を起動していたセッションは `claude --continue` で直前の会話から再開します。

## 仕組み

- **ターミナル**: Rust の `portable-pty` で ConPTY 経由で `bash.exe --login -i` を起動します。`git-bash.exe` は mintty を開いてしまうため使いません。Git Bash の場所は自動で探しますが、環境変数 `CC_DECK_BASH` で明示できます。
- **表示**: xterm.js のインスタンスは 1 つだけです。各セッションの出力は Rust 側の仮想端末（`vt100` クレート）に常に流しておき、切り替え時はその画面状態を xterm.js に描き直します。裏のセッションの出力はフロントエンドに送らないので、セッション数が増えても UI の負荷は増えません。一覧画面は、開いている間だけ 1 秒ごとに各仮想端末の末尾 12 行を取得します（`peek_sessions`）。
- **状態表示**: Claude Code を `claude --settings <hooks設定>` で起動します。hooks 設定はアプリが `%APPDATA%\dev.ccdeck.app\hooks-settings.json` に書き出すもので、`~/.claude/settings.json` は変更しません。各 hook は `curl` で `127.0.0.1:47800` にイベントを送り、アプリがサイドバーの状態に反映します。
- **プロセス管理**: 各セッションの bash.exe を Windows の Job Object に入れています。セッションを閉じたとき（またはアプリを終了したとき）、Claude Code や MCP サーバーを含む子孫プロセスがまとめて終了します。
- **メモリ表示**: 2.5 秒ごとに bash.exe 以下のプロセスツリーのメモリを合計して表示します。

## 現時点の制限

- セッションを切り替えると、ターミナルには「現在の画面」だけが復元され、それより上のスクロール履歴は戻りません。
- アプリを終了すると、全セッションが終了します（Job Object の仕様）。次回の起動時に「前回の N 件を再開」で開き直せます。
- hooks の受信ポート 47800 が他のアプリに使われていると、状態表示が無効になります（サイドバー下部に表示されます）。
- WSL 上の Claude Code には対応していません。

## うまく動かないとき

- **状態が「起動中」のまま変わらない**: サイドバー下部にエラーが出ていないか確認してください。Git Bash で `claude --settings` が使えるか（`claude --help`）、`curl` が使えるかも確認してください。
- **bash が起動しない**: 環境変数 `CC_DECK_BASH` に `C:\Program Files\Git\bin\bash.exe` のようなフルパスを設定してください。
- **日本語が豆腐になる**: ターミナルのフォントは Cascadia Mono → BIZ UDGothic → Consolas の順で使います。`src/main.ts` の `fontFamily` で変更できます。

## テスト

```bash
cd src-tauri
cargo test
```

PTY・仮想端末・hooks 受信を通しで確認する結合テスト（`tests/e2e.rs`）が含まれています。

## 構成

```
src/                 フロントエンド（TypeScript + xterm.js）
  main.ts            サイドバー、ターミナル、ショートカット
  style.css
src-tauri/src/
  lib.rs             Tauri コマンドの定義と起動処理
  session.rs         PTY・仮想端末・状態の管理
  hooks.rs           hooks 設定の生成と受信サーバー
  job.rs             Windows Job Object
  memory.rs          メモリ使用量の集計
  notify.rs          Windows の通知
  git.rs             git worktree の作成
```
