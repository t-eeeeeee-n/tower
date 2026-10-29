//! セッションのフォルダのファイル一覧・中身・Git の変更を読む（表示専用で、書き込みはしない）。
//! パスは常にセッションのフォルダからの相対パスで受け取り、フォルダの外は読ませない。

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::git::{git, git_raw};

/// 1 つのフォルダに表示する項目の上限（node_modules などを開いたときに固まらないように）
const MAX_ENTRIES: usize = 2000;
/// 表示するファイルの大きさの上限
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    /// .gitignore などで Git の管理から外れている
    pub ignored: bool,
}

#[derive(Serialize)]
pub struct FileContent {
    pub text: Option<String>,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Serialize)]
pub struct Changes {
    pub changes: Vec<Change>,
    /// 安全のため Git を呼ばなかったときの理由
    pub blocked: Option<String>,
    /// 利用者がこのフォルダで Git の表示を許可しているか。許可していなければ Git は呼ばない
    pub trusted: bool,
}

impl Changes {
    pub fn untrusted() -> Self {
        Changes { changes: Vec::new(), blocked: None, trusted: false }
    }

    /// Git を使っていないフォルダ（表示するものが無いので、信頼の確認も出さない）
    pub fn no_repo() -> Self {
        Changes { changes: Vec::new(), blocked: None, trusted: true }
    }
}

/// フォルダかその親に .git（フォルダ、または worktree の .git ファイル）があるか。git は実行しない
pub fn in_repo(root: &Path) -> bool {
    root.canonicalize().is_ok_and(|p| p.ancestors().any(|d| d.join(".git").exists()))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    /// セッションのフォルダからの相対パス（区切りは /）
    pub path: String,
    /// M（変更）・A（追加）・D（削除）・R（名前の変更）・?（Git 管理外）
    pub status: String,
    /// コミット済みの状態から増えた行・減った行。Git 管理外やバイナリのファイルは None
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// `rel` を `root` の中のパスに解決する。`..` や絶対パスで外に出るものは拒否する
fn checked(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("フォルダの外は開けません: {rel}"));
    }
    Ok(root.join(rel_path))
}

/// 実在するパスについて、シンボリックリンクやジャンクションでフォルダの外を指していないかも確かめる
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = checked(root, rel)?;
    let canon_root = root.canonicalize().map_err(|e| format!("フォルダを開けません: {e}"))?;
    let canon = path.canonicalize().map_err(|e| format!("{rel} を開けません: {e}"))?;
    if !canon.starts_with(&canon_root) {
        return Err(format!("フォルダの外は開けません: {rel}"));
    }
    Ok(canon)
}

/// フォルダの直下で、.gitignore・.git/info/exclude・利用者の全体の除外設定に当たらない項目の名前。
/// git を実行せずにファイルを読むだけなので、信頼していないフォルダでも使える
fn not_ignored(dir: &Path) -> HashSet<OsString> {
    ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .ignore(false)
        .parents(true)
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.depth() == 1)
        .map(|e| e.file_name().to_os_string())
        .collect()
}

pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<Entry>, String> {
    let dir = resolve(root, rel)?;
    let kept = not_ignored(&dir);
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{rel} を開けません: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name() != ".git")
        .map(|e| Entry {
            ignored: !kept.contains(&e.file_name()),
            name: e.file_name().to_string_lossy().into_owned(),
            dir: e.file_type().is_ok_and(|t| t.is_dir()),
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    entries.truncate(MAX_ENTRIES);
    Ok(entries)
}

pub fn read_file(root: &Path, rel: &str) -> Result<FileContent, String> {
    let path = resolve(root, rel)?;
    let size = std::fs::metadata(&path).map_err(|e| format!("{rel} を開けません: {e}"))?.len();
    if size > MAX_FILE_BYTES {
        return Ok(FileContent { text: None, size, binary: false, too_large: true });
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{rel} を読めません: {e}"))?;
    // 先頭に NUL を含むものはバイナリとみなす（Git と同じ判定）
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(FileContent { text: None, size, binary: true, too_large: false });
    }
    Ok(FileContent { text: Some(String::from_utf8_lossy(&bytes).into_owned()), size, binary: false, too_large: false })
}

/// リポジトリ自身の設定（.git/config と、そこから読み込むファイル）に filter のコマンドがあれば、その理由を返す。
///
/// filter（clean / smudge / process）は git status や git diff の途中で実行される。Tower はパネルを開いている間
/// git を自動で呼ぶので、他人が用意した .git を含むフォルダ（zip で受け取ったものなど）を開いただけで
/// コマンドが実行されないよう、そういうリポジトリでは git を呼ばない。
/// 利用者の全体設定（~/.gitconfig の Git LFS など）は利用者自身が入れたものなので対象にしない。
/// 設定を読むだけの git config は filter を実行しない。
pub(crate) fn repo_filter(program: &Path, root: &Path) -> Option<String> {
    let out = match git(program, root, &["config", "--show-scope", "--includes", "--get-regexp", r"^filter\..*\.(clean|smudge|process)$"]) {
        Ok(out) => out,
        // 該当する設定が無いときは、何も出力せずに終了コード 1 で終わる
        Err(e) if e.is_empty() => return None,
        // 古い Git（--show-scope が無い）などで確かめられないときは、安全側に倒して呼ばない
        Err(e) => return Some(format!("Git の設定を確認できないため、変更の表示を止めています: {e}")),
    };
    let key = out
        .lines()
        .filter_map(|l| l.split_once(char::is_whitespace))
        .find(|(scope, _)| !matches!(*scope, "global" | "system"))
        .and_then(|(_, rest)| rest.split_whitespace().next())?
        .to_string();
    Some(format!("このリポジトリの設定に Git の filter（{key}）があるため、安全のため変更の表示を止めています"))
}

/// フォルダの中の Git の変更。Git リポジトリでなければ空。
pub fn changes(program: &Path, root: &Path) -> Changes {
    let none = |blocked| Changes { changes: Vec::new(), blocked, trusted: true };
    // status のパスはリポジトリのルートからの相対なので、セッションのフォルダがサブフォルダならその分を取り除く
    let Ok(prefix) = git(program, root, &["rev-parse", "--show-prefix"]) else { return none(None) };
    if let Some(reason) = repo_filter(program, root) {
        return none(Some(reason));
    }
    // サブモジュールの中は設定が別なので、上の確認が効かない。中までは調べない
    let args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", "--", "."];
    let Ok(out) = git_raw(program, root, &args) else { return none(None) };
    let mut changes = parse_status(&out, &prefix);
    // まだコミットが無いリポジトリでは HEAD が無く失敗するので、そのときは行数を出さない
    let numstat = ["diff", "--numstat", "-z", "--relative", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."];
    if let Ok(out) = git_raw(program, root, &numstat) {
        let counts = parse_numstat(&out);
        for c in &mut changes {
            if let Some(&(a, r)) = counts.get(c.path.as_str()) {
                (c.added, c.removed) = (Some(a), Some(r));
            }
        }
    }
    Changes { changes, blocked: None, trusted: true }
}

/// `git diff --numstat -z` の出力。名前の変更は「増 減 (空)」の後に元の名前と新しい名前が続く。
/// バイナリのファイルは増減が - なので数えない
fn parse_numstat(out: &str) -> std::collections::HashMap<&str, (u32, u32)> {
    let mut result = std::collections::HashMap::new();
    let mut records = out.split('\0');
    while let Some(rec) = records.next() {
        let mut parts = rec.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let path = if path.is_empty() {
            records.next();
            records.next().unwrap_or("")
        } else {
            path
        };
        if let (Ok(a), Ok(r)) = (a.parse(), r.parse()) {
            result.insert(path, (a, r));
        }
    }
    result
}

/// 名前で探すときに見る項目の上限（大きなフォルダで固まらないように）
const MAX_SCAN: usize = 50_000;
const MAX_FOUND: usize = 200;

/// フォルダの中から、相対パスに `query` を含むファイルを探す（大文字と小文字は区別しない）。
/// .gitignore などで外れているもの（node_modules など）は探さない。名前に含むものを先に、浅いものを先に並べる
pub fn find_files(root: &Path, query: &str) -> Result<Vec<String>, String> {
    let q = query.trim().to_lowercase().replace('\\', "/");
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let base = root.canonicalize().map_err(|e| format!("フォルダを開けません: {e}"))?;
    let mut found: Vec<(bool, usize, String)> = ignore::WalkBuilder::new(&base)
        .hidden(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .take(MAX_SCAN)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter_map(|e| {
            let rel = e.path().strip_prefix(&base).ok()?.to_string_lossy().replace('\\', "/");
            let lower = rel.to_lowercase();
            if !lower.contains(&q) {
                return None;
            }
            let name_hit = lower.rsplit('/').next().is_some_and(|n| n.contains(&q));
            Some((!name_hit, rel.matches('/').count(), rel))
        })
        .collect();
    found.sort();
    Ok(found.into_iter().take(MAX_FOUND).map(|(_, _, rel)| rel).collect())
}

/// エクスプローラーで開く。ファイルなら入っているフォルダを開いてそのファイルを選び、フォルダならそのフォルダを開く
pub fn reveal(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve(root, rel)?;
    // canonicalize は \\?\C:\… や \\?\UNC\server\share\… の形を返すが、エクスプローラーはこの形を開けない
    let full = path.to_string_lossy();
    let shown = match full.strip_prefix(r"\\?\UNC\") {
        Some(unc) => format!(r"\\{unc}"),
        None => full.strip_prefix(r"\\?\").unwrap_or(&full).to_string(),
    };
    // 下で引用符ごとコマンド行に入れるので、引用符を閉じられる文字は通さない。
    // Windows のファイル名に " は使えないが、念のため弾く
    if shown.chars().any(|c| c == '"' || c.is_control()) {
        return Err(format!("この名前はエクスプローラーで開けません: {rel}"));
    }
    let mut cmd = std::process::Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /select, の後ろは引用符ごと 1 つの引数として渡す（std の引用の付け方だとエクスプローラーが読めない）
        if path.is_dir() {
            cmd.raw_arg(format!("\"{shown}\""));
        } else {
            cmd.raw_arg(format!("/select,\"{shown}\""));
        }
    }
    #[cfg(not(windows))]
    cmd.arg(&shown);
    // エクスプローラーは開けても終了コード 1 を返すことがあるので、起動できたかだけを見る
    cmd.spawn().map(drop).map_err(|e| format!("エクスプローラーを開けませんでした: {e}"))
}

fn parse_status(out: &str, prefix: &str) -> Vec<Change> {
    let mut result = Vec::new();
    let mut records = out.split('\0').filter(|r| r.len() > 3);
    while let Some(rec) = records.next() {
        let (xy, path) = rec.split_at(3);
        let xy = xy.trim();
        // 名前の変更とコピーは、次の要素が元の名前
        if xy.contains('R') || xy.contains('C') {
            records.next();
        }
        let status = match xy {
            "??" => "?",
            s if s.contains('D') => "D",
            s if s.contains('A') => "A",
            s if s.contains('R') => "R",
            _ => "M",
        };
        let path = path.strip_prefix(prefix).unwrap_or(path);
        result.push(Change { path: path.to_string(), status: status.into(), added: None, removed: None });
    }
    result
}

/// コミット済みの状態（HEAD）からの差分。まだコミットが無いリポジトリでは索引からの差分。
/// Git 管理外のファイルは空になる（画面側で全行を追加として表示する）。
pub fn diff(program: &Path, root: &Path, rel: &str) -> Result<String, String> {
    // 削除されたファイルの差分も見たいので、実在の確認（canonicalize）はしない
    checked(root, rel)?;
    if let Some(reason) = repo_filter(program, root) {
        return Err(reason);
    }
    // 外部の差分ツールや textconv（.gitattributes で指定されたコマンド）を動かさない
    let opts = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    let with_head: Vec<&str> = opts.iter().copied().chain(["HEAD", "--", rel]).collect();
    let without: Vec<&str> = opts.iter().copied().chain(["--", rel]).collect();
    git_raw(program, root, &with_head).or_else(|_| git_raw(program, root, &without))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_the_folder() {
        let root = std::env::temp_dir();
        assert!(checked(&root, "src/main.rs").is_ok());
        assert!(checked(&root, "").is_ok());
        assert!(checked(&root, "../secret").is_err());
        assert!(checked(&root, "a/../../secret").is_err());
        assert!(checked(&root, if cfg!(windows) { "C:\\Windows" } else { "/etc" }).is_err());
    }

    #[test]
    fn automatic_git_never_uses_transports() {
        // ext:: は通信の代わりにコマンドを実行する方式。リポジトリの設定で許可されていても、Tower が呼ぶ git では使えない
        let base = std::env::temp_dir().join(format!("tower-transport-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let program = PathBuf::from("git");
        git(&program, &base, &["init", "-q"]).unwrap();
        git(&program, &base, &["config", "protocol.ext.allow", "always"]).unwrap();
        let marker = base.join("transport-ran");
        let url = format!("ext::sh -c touch% {}", marker.to_string_lossy().replace('\\', "/"));
        assert!(git_raw(&program, &base, &["ls-remote", &url]).is_err());
        assert!(!marker.exists(), "通信方式のコマンドが実行された");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parses_porcelain_status() {
        let out = " M sub/a.rs\0?? sub/new.txt\0R  sub/b.rs\0sub/old.rs\0D  sub/gone.rs\0A  sub/add.rs\0";
        let got = parse_status(out, "sub/");
        let want = [("a.rs", "M"), ("new.txt", "?"), ("b.rs", "R"), ("gone.rs", "D"), ("add.rs", "A")];
        assert_eq!(got.len(), want.len());
        for (c, (p, s)) in got.iter().zip(want) {
            assert_eq!((c.path.as_str(), c.status.as_str()), (p, s));
        }
    }

    #[test]
    fn parses_numstat() {
        // 名前の変更は「増 減 (空)」の後に元の名前と新しい名前。バイナリは「- -」
        let out = "3\t1\tsrc/a.rs\0002\t0\t\0old.rs\0new.rs\0-\t-\timg.png\0";
        let got = parse_numstat(out);
        assert_eq!(got.get("src/a.rs"), Some(&(3, 1)));
        assert_eq!(got.get("new.rs"), Some(&(2, 0)));
        assert_eq!(got.get("img.png"), None);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn finds_files_by_name() {
        let base = std::env::temp_dir().join(format!("tower-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src/deep")).unwrap();
        std::fs::create_dir_all(base.join("build")).unwrap();
        for f in ["src/main.ts", "src/deep/main_test.ts", "mainly.md", "build/main.js", "other.txt"] {
            std::fs::write(base.join(f), "").unwrap();
        }
        // ignore は .git が無いと .gitignore を読まないので、.ignore で外す
        std::fs::write(base.join(".ignore"), "build/\n").unwrap();
        let got = find_files(&base, "MAIN").unwrap();
        // 名前に含むものを先に、浅いものを先に。外したフォルダの中は探さない
        assert_eq!(got, ["mainly.md", "src/main.ts", "src/deep/main_test.ts"]);
        assert_eq!(find_files(&base, "deep/").unwrap(), ["src/deep/main_test.ts"]);
        assert!(find_files(&base, "  ").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn marks_gitignored_entries() {
        let base = std::env::temp_dir().join(format!("tower-ignored-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("dist")).unwrap();
        std::fs::create_dir_all(base.join("src")).unwrap();
        git(&PathBuf::from("git"), &base, &["init", "-q"]).unwrap();
        std::fs::write(base.join(".gitignore"), "dist/\n*.log\n").unwrap();
        std::fs::write(base.join("app.log"), "").unwrap();
        std::fs::write(base.join("src/.gitignore"), "gen.ts\n").unwrap();
        std::fs::write(base.join("src/gen.ts"), "").unwrap();
        std::fs::write(base.join("src/main.ts"), "").unwrap();

        let ignored = |rel: &str| -> Vec<(String, bool)> {
            list_dir(&base, rel).unwrap().into_iter().map(|e| (e.name, e.ignored)).collect()
        };
        assert_eq!(ignored(""), [
            ("dist".into(), true), ("src".into(), false), (".gitignore".into(), false), ("app.log".into(), true),
        ]);
        // 親フォルダの .gitignore も効く
        assert_eq!(ignored("src"), [(".gitignore".into(), false), ("gen.ts".into(), true), ("main.ts".into(), false)]);

        // Git を使っていないフォルダでは .gitignore があっても印を付けない
        std::fs::remove_dir_all(base.join(".git")).unwrap();
        assert!(ignored("").iter().all(|(_, i)| !i));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn lists_reads_and_diffs_a_repo() {
        let base = std::env::temp_dir().join(format!("tower-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src")).unwrap();
        let program = PathBuf::from("git");
        git(&program, &base, &["init", "-q"]).unwrap();
        std::fs::write(base.join("src/a.txt"), "one\n").unwrap();
        git(&program, &base, &["add", "."]).unwrap();
        git(&program, &base, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"]).unwrap();
        std::fs::write(base.join("src/a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(base.join("新規.txt"), "x").unwrap();
        std::fs::write(base.join("bin.dat"), [0u8, 1, 2]).unwrap();

        assert!(in_repo(&base) && in_repo(&base.join("src")), "リポジトリの中のサブフォルダも対象");
        let plain = std::env::temp_dir().join(format!("tower-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!in_repo(&plain), "Git を使っていないフォルダ");
        let _ = std::fs::remove_dir_all(&plain);

        let names: Vec<_> = list_dir(&base, "").unwrap().into_iter().map(|e| (e.name, e.dir)).collect();
        assert_eq!(names[0], ("src".into(), true), "フォルダが先で、.git は出さない: {names:?}");
        assert!(!names.iter().any(|(n, _)| n == ".git"));

        assert_eq!(read_file(&base, "src/a.txt").unwrap().text.as_deref(), Some("one\ntwo\n"));
        assert!(read_file(&base, "bin.dat").unwrap().binary);

        let mut ch = changes(&program, &base).changes;
        ch.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(ch, vec![
            Change { path: "bin.dat".into(), status: "?".into(), added: None, removed: None },
            Change { path: "src/a.txt".into(), status: "M".into(), added: Some(1), removed: Some(0) },
            Change { path: "新規.txt".into(), status: "?".into(), added: None, removed: None },
        ]);
        // サブフォルダをセッションのフォルダにしたときは、そこからの相対パスになる
        assert_eq!(changes(&program, &base.join("src")).changes, vec![Change { path: "a.txt".into(), status: "M".into(), added: Some(1), removed: Some(0) }]);

        let d = diff(&program, &base, "src/a.txt").unwrap();
        assert!(d.lines().any(|l| l == "+two"), "{d}");

        // リポジトリの設定に仕込まれた fsmonitor のコマンドは、自動で呼ぶ git status では動かない
        let marker = base.join("fsmonitor-ran");
        let hook = format!("sh -c 'touch \"{}\"'", marker.to_string_lossy().replace('\\', "/"));
        git(&program, &base, &["config", "core.fsmonitor", &hook]).unwrap();
        let _ = changes(&program, &base);
        assert!(!marker.exists(), "fsmonitor が実行された");
        git(&program, &base, &["config", "--unset", "core.fsmonitor"]).unwrap();

        // リポジトリの設定に filter のコマンドがあれば、status も diff も呼ばない
        let marker = base.join("filter-ran");
        let filter = format!("sh -c 'touch \"{}\"; cat'", marker.to_string_lossy().replace('\\', "/"));
        git(&program, &base, &["config", "filter.evil.clean", &filter]).unwrap();
        std::fs::write(base.join(".gitattributes"), "*.txt filter=evil
").unwrap();
        let blocked = changes(&program, &base);
        assert!(blocked.changes.is_empty() && blocked.blocked.as_deref().is_some_and(|r| r.contains("filter.evil.clean")));
        assert!(diff(&program, &base, "src/a.txt").is_err());
        assert!(!marker.exists(), "filter が実行された");
        assert!(diff(&program, &base, "../x").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }
}
