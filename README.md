# Tower

複数のコーディングエージェント（Claude Code / Codex / GitHub Copilot CLI / Antigravity CLI）のセッションを 1 つのウィンドウで並列に管理する Windows 用デスクトップアプリです。
左のサイドバーで各セッションの状態（作業中・入力待ち・完了）とメモリ使用量を確認し、右のターミナルで操作します。

## 必要なもの

1. **Rust**（1.90 以上）: https://rustup.rs からインストールし、`rustup default stable-msvc` を実行
2. **Visual Studio Build Tools**: 「C++ によるデスクトップ開発」ワークロードを選択してインストール
3. **Node.js** 20 以上
4. **Git for Windows**（Git Bash）
5. 使いたいエージェント（Git Bash から起動できる状態）

| エージェント | コマンド | 状態の取り方 |
| --- | --- | --- |
| Claude Code | `claude` | hooks |
| Codex | `codex` | hooks（初回だけ Codex の画面で信頼の承認が必要） |
| GitHub Copilot CLI | `copilot`（1.0 以降） | hooks |
| Antigravity CLI | `agy` | 画面の様子から推測（部分対応） |

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
インストールせずに使うなら `src-tauri/target/release/tower.exe` を直接起動しても動きます。

## 使い方

「＋」またはCtrl+Shift+Nでフォルダと起動するエージェントを選ぶと、そのフォルダで Git Bash が起動し、続けてエージェントが立ち上がります。

| キー | 動作 |
| --- | --- |
| Ctrl+Shift+N | 新しいセッション |
| Ctrl+0 | 一覧画面 / 直前のセッションへ切り替え |
| Ctrl+1〜9 | サイドバーの番号のセッションへ切り替え |
| Ctrl+Shift+A | 次の入力待ちセッションへ移動 |
| Ctrl+Shift+C / V | コピー / 貼り付け（Ctrl+C はエージェントの中断に使うため） |
| Ctrl+Shift+W | 表示中のセッションを閉じる |

一覧画面（サイドバーの「一覧」または Ctrl+0）では、全セッションの状態と画面の末尾をカードで並べて表示します。入力待ちのカードには選択肢のボタンが出るほか、各カードの入力欄から 1 行の指示を送れます。カードをクリックするとそのセッションのターミナルに切り替わります。

裏のセッションが入力待ちになると、タスクバーのアイコンが点滅し、ウィンドウタイトルに件数が出て、Windows の通知も表示されます。20 秒以上かかった作業が終わったときも通知します。表示中のセッションをウィンドウで見ているときは通知しません。通知をクリックすると、そのセッションに切り替わります（画面に出ている間のクリックのみ。通知センターからのクリックでは切り替わりません）。

新しいセッションのダイアログで「新しい worktree で作る」を選ぶと、リポジトリの隣に `リポジトリ名-ブランチ名` のフォルダを `git worktree add` で作り、そこでセッションを起動します。同じリポジトリで複数のエージェントを並列に動かしてもファイルが衝突しません。セッションを閉じても worktree は削除しないので、不要になったら `git worktree remove` で消してください。

アプリを起動したときにセッションが無ければ、前回開いていたセッションを「前回の N 件を再開」でまとめて開き直せます。各エージェントの「直前の会話を再開」で起動し（`claude --continue`、`codex resume --last`、`copilot --continue`、`agy --continue`）、再開する会話が無ければ新しく始めます。

### Codex を初めて使うとき

Codex は新しい hook を承認するまで動かしません。Tower で最初に Codex を起動すると「Hooks need review」と表示されるので、「Trust all and continue」を選んでください（Tower の hook だけが一覧に出ます）。承認するまで状態は画面の様子からの推測になります。

## 仕組み

- **ターミナル**: Rust の `portable-pty` で ConPTY 経由で `bash.exe --login -i` を起動します。`git-bash.exe` は mintty を開いてしまうため使いません。Git Bash の場所は自動で探しますが、環境変数 `TOWER_BASH` で明示できます。
- **表示**: xterm.js のインスタンスは 1 つだけです。各セッションの出力は Rust 側の仮想端末（`vt100` クレート）に常に流しておき、切り替え時はその画面状態を xterm.js に描き直します。裏のセッションの出力はフロントエンドに送らないので、セッション数が増えても UI の負荷は増えません。一覧画面は、開いている間だけ 1 秒ごとに各仮想端末の末尾 12 行を取得します（`peek_sessions`）。
- **状態表示（hooks）**: 各エージェントの hooks が `curl` でアプリにイベントを送り、アプリがサイドバーの状態に反映します。受信口は起動のたびに空いているポートで開き、ポート番号とランダムなトークンをセッションの環境変数（`DASH_HOOK_PORT` / `DASH_HOOK_TOKEN`）で渡します。トークンの無いリクエストやブラウザからのリクエストは受け付けません。hook の入力のうち送るのは Claude Code と Copilot CLI の通知（入力待ち）の内容だけで、実行するコマンドやファイルの内容は送りません。hooks の設定ファイルにはポートもトークンも書かないので、Tower の外で起動したエージェントでは何もしません。
  - **Claude Code**: `claude --settings <hooks設定>` で起動します。設定は `%APPDATA%\dev.tower.app\hooks-settings.json` に書き出すもので、`~/.claude/settings.json` は変更しません。
  - **Codex**: `codex -p tower` で起動し、`~/.codex/tower.config.toml`（プロファイル）を利用者の設定の上に重ねます。Codex はこのファイルにフォルダの信頼などを書き足すので、Tower は `[[hooks.…]]` のテーブルだけを更新し、それ以外は残します。
  - **Copilot CLI**: `~/.copilot/hooks/tower.json` を置きます。
  - Codex と Copilot CLI のファイルは、それぞれの設定フォルダ（`~/.codex`、`~/.copilot`）があるときだけ Tower の起動時に書き出し、既存の設定ファイルは変更しません。
- **状態表示（画面からの推測）**: hooks を使えない Antigravity CLI と、hooks のイベントがまだ届いていないセッションは、画面の変化と内容から状態を推測します。画面が動いていれば作業中、3 秒止まれば完了、画面の下のほうに承認を求める文言（「Do you want to」「1. Yes」など）があれば入力待ちとみなします。
- **プロセス管理**: 各セッションの bash.exe を Windows の Job Object に入れています。セッションを閉じたとき（またはアプリを終了したとき）、エージェントや MCP サーバーを含む子孫プロセスがまとめて終了します。
- **メモリ表示**: 2.5 秒ごとに bash.exe 以下のプロセスツリーのメモリを合計して表示します。

## 現時点の制限

- セッションを切り替えると、ターミナルには「現在の画面」だけが復元され、それより上のスクロール履歴は戻りません。
- アプリを終了すると、全セッションが終了します（Job Object の仕様）。次回の起動時に「前回の N 件を再開」で開き直せます。
- Antigravity CLI の状態は推測なので、入力待ち・完了の判定は目安です。
- WSL 上のエージェントには対応していません。

## うまく動かないとき

- **状態が変わらない・おかしい**: サイドバー下部にエラーが出ていないか確認してください。Git Bash で `curl` が使えるかも確認してください。
  - Codex: 「Hooks need review」で信頼を承認したか確認してください（`/hooks` でも確認できます）。
  - Copilot CLI: `copilot --version` が 1.0 以降か確認してください。古い場合は `npm i -g @github/copilot` で更新します。
- **bash が起動しない**: 環境変数 `TOWER_BASH` に `C:\Program Files\Git\bin\bash.exe` のようなフルパスを設定してください。
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
  agent.rs           エージェントの種類、起動・再開コマンド、画面からの状態の推測
  session.rs         PTY・仮想端末・状態の管理
  hooks.rs           hooks 設定の生成と受信サーバー
  job.rs             Windows Job Object
  memory.rs          メモリ使用量の集計
  notify.rs          Windows の通知
  git.rs             git worktree の作成
```
