//! セッションのフォルダのファイル一覧・中身・Git の変更を読む（表示専用で、書き込みはしない）。
//! パスは常にセッションのフォルダからの相対パスで受け取り、フォルダの外は読ませない。

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
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    /// セッションのフォルダからの相対パス（区切りは /）
    pub path: String,
    /// M（変更）・A（追加）・D（削除）・R（名前の変更）・?（Git 管理外）
    pub status: String,
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

pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<Entry>, String> {
    let dir = resolve(root, rel)?;
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{rel} を開けません: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name() != ".git")
        .map(|e| Entry {
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
fn repo_filter(program: &Path, root: &Path) -> Option<String> {
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
    let none = |blocked| Changes { changes: Vec::new(), blocked };
    // status のパスはリポジトリのルートからの相対なので、セッションのフォルダがサブフォルダならその分を取り除く
    let Ok(prefix) = git(program, root, &["rev-parse", "--show-prefix"]) else { return none(None) };
    if let Some(reason) = repo_filter(program, root) {
        return none(Some(reason));
    }
    // サブモジュールの中は設定が別なので、上の確認が効かない。中までは調べない
    let args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all", "--", "."];
    let Ok(out) = git_raw(program, root, &args) else { return none(None) };
    Changes { changes: parse_status(&out, &prefix), blocked: None }
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
        result.push(Change { path: path.to_string(), status: status.into() });
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

        let names: Vec<_> = list_dir(&base, "").unwrap().into_iter().map(|e| (e.name, e.dir)).collect();
        assert_eq!(names[0], ("src".into(), true), "フォルダが先で、.git は出さない: {names:?}");
        assert!(!names.iter().any(|(n, _)| n == ".git"));

        assert_eq!(read_file(&base, "src/a.txt").unwrap().text.as_deref(), Some("one\ntwo\n"));
        assert!(read_file(&base, "bin.dat").unwrap().binary);

        let mut ch = changes(&program, &base).changes;
        ch.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(ch, vec![
            Change { path: "bin.dat".into(), status: "?".into() },
            Change { path: "src/a.txt".into(), status: "M".into() },
            Change { path: "新規.txt".into(), status: "?".into() },
        ]);
        // サブフォルダをセッションのフォルダにしたときは、そこからの相対パスになる
        assert_eq!(changes(&program, &base.join("src")).changes, vec![Change { path: "a.txt".into(), status: "M".into() }]);

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
