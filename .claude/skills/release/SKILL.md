---
name: release
description: Tower を GitHub でリリースするタイミングかどうかを、前回のタグからの変更・CI・確かめ具合から判断し、版番号を提案する。了承されたら版上げ・コミット・タグ作成まで行い、push は確認してから行う。「リリースして」「リリースしたい」「出していい？」「版を上げて」「タグを打って」「リリースのタイミング」などと言われたときに使う。また main に push した直後（ユーザーが push した結果を見たときを含む）は、このスキルの「push のあとの提案」に従って、リリースするか一言だけ提案する。
---

# Tower のリリース

リリースは `v` で始まるタグを push すると `.github/workflows/release.yml` が作る。
下書きを経ずにそのまま公開されるので、タグを push したら取り消しが面倒になる。判断と確認はタグの前に済ませる。

## 1. 材料を集める

```bash
git fetch --tags origin
last=$(git describe --tags --abbrev=0)
git status --short                          # 空であること
git rev-parse --abbrev-ref HEAD             # main であること
git rev-list --left-right --count origin/main...HEAD   # 0 0 であること（push 済み）
git log --format='%h %s' "$last"..HEAD
git diff --stat "$last"..HEAD
gh run list --commit "$(git rev-parse HEAD)" --limit 5   # CI の結果
```

前回のタグ以降にコミットが無ければ、「出すものがありません」と伝えて終わる。

## 2. 判断する

コミットを次の 3 つに分けて見る。

- **機能**：使う人から見て、できることが増えた・変わった
- **修正**：公開済みの版にある不具合を直した
- **内部**：CI・README・リファクタ・テストだけ（使う人からは見えない）

**出してよい**：機能か修正があり、次の「待つ理由」が無い。
公開済みの版の不具合を直したものは、ほかの変更を待たずに早めに出す方がよい。

**待つ理由**（1 つでもあれば、出すのは勧めない）

- CI が失敗している、またはまだ終わっていない
- 内部の変更しかない
- 機能の途中で、使えない・中途半端な状態の画面がある
- 新しい機能を、インストーラで入れた実際のアプリでまだ試していない。
  コミットや会話から分からなければ、ユーザーに「入れて試しましたか？」と聞く

**伝えておくこと**（待つ理由ではない）

- `src-tauri/src/hooks.rs` で hook の中身が変わった：Codex で「Hooks need review」がもう一度出る
- 設定や保存データ（localStorage・`%APPDATA%\dev.tower.app` のファイル）の形が変わった：前の版の設定が引き継がれるか

## 3. 版番号を決める

1.0 になるまでは次のとおりにする。

- 機能が 1 つでもある：真ん中を上げて、最後を 0 にする（0.2.3 → 0.3.0）
- 修正と内部の変更だけ：最後を上げる（0.2.0 → 0.2.1）

## 4. 提案する

次の形で短く伝え、出すかどうかをユーザーに決めてもらう。

```
前回（v0.2.0）からの変更
- 機能: …
- 修正: …
- 内部: …（数だけでよい）

判断: 出してよい / 待った方がよい（理由）
版: v0.3.0（機能があるため）
伝えておくこと: …
```

## 5. 了承されたら、版を上げる

版番号は 5 か所にある。すべて同じにする（ずれていると release.yml が止まる）。

```bash
v=0.3.0
npm version "$v" --no-git-tag-version        # package.json と package-lock.json
node -e 'const f="src-tauri/tauri.conf.json",fs=require("fs");const s=fs.readFileSync(f,"utf8");fs.writeFileSync(f,s.replace(/"version": "[^"]+"/,`"version": "${process.argv[1]}"`))' "$v"
sed -i "0,/^version = \".*\"/s//version = \"$v\"/" src-tauri/Cargo.toml
(cd src-tauri && cargo update -p tower-app --offline)   # Cargo.lock
git diff --stat   # 5 ファイルが変わっていること
```

コミットとタグは、これまでの形（v0.2.0）に合わせる。
コミットの件名は版番号だけにし、タグは注釈なしの軽量タグにする。

```bash
git commit -am "v$v

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag "v$v"
```

## 6. push する（必ず確認してから）

push するとそのまま公開されるので、実行の前にもう一度ユーザーに確認する。

```bash
git push origin main "v$v"
```

権限のチェックで止められたら、回避しようとせず、ユーザーに次のように打ってもらう。
`! git push origin main v0.3.0`

push したら、リリースのワークフローを見届けて結果を伝える。

```bash
gh run list --workflow release.yml --limit 1
gh run watch <run-id> --exit-status
gh release view "v$v" --json url,assets --jq '.url, .assets[].name'
```

失敗したら、どのステップで止まったか（`gh run view <run-id> --log-failed`）を伝える。
タグを消して打ち直すかどうかは、ユーザーに決めてもらう。

## push のあとの提案

main に push したあと（ユーザーが `!` で push したときも）は、手順 1 のうち次の 2 つだけを見る。

- 前回のタグからのコミット
- CI の結果

機能か修正があれば、次の 1 行だけ添える。
「前回のリリース（v0.2.0）から機能の追加があります。リリースしますか？」

次のときは提案しない。

- 内部の変更しかない
- 同じ会話で、すでに「まだ出さない」と言われた

提案だけにとどめ、ユーザーが答えるまで手順 2 以降には進まない。
