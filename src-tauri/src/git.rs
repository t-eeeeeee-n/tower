//! git worktree を作ってセッションを分ける。同じリポジトリで並列に作業してもファイルが衝突しない。

use std::path::{Path, PathBuf};
use std::process::Command;

/// Git Bash の bash.exe と同じ場所にある git.exe を優先する（GUI アプリの PATH に git が無いことがある）
pub fn git_program(shell: &str) -> PathBuf {
    let sibling = Path::new(shell).with_file_name(if cfg!(windows) { "git.exe" } else { "git" });
    if sibling.is_file() {
        sibling
    } else {
        PathBuf::from("git")
    }
}

pub(crate) fn git(program: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    git_raw(program, dir, args).map(|s| s.trim().to_string())
}

/// 出力の前後の空白を削らない版（`git status --porcelain` は行頭の空白に意味がある）
pub(crate) fn git_raw(program: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    // 日本語のファイル名を \343\201... のようにエスケープさせない。
    // core.fsmonitor はリポジトリの設定から任意のコマンドを実行させられるので、Tower が自動で呼ぶ git では無効にする。
    // Tower が呼ぶ git は通信を必要としない。部分クローンの自動取得や ext:: のような通信方式で
    // リポジトリの設定からコマンドを動かされないよう、通信はすべて禁止する。
    // protocol.<name>.allow は protocol.allow より優先され、リポジトリの設定でも書けるので、方式ごとにも禁止する
    // （コマンドラインの -c は、同じ名前のリポジトリの設定より優先される）
    cmd.args(["-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never"]);
    for p in ["ext", "file", "ssh", "git", "http", "https"] {
        cmd.arg("-c").arg(format!("protocol.{p}.allow=never"));
    }
    cmd.env("GIT_NO_LAZY_FETCH", "1");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: GUI アプリから呼ぶとコンソールウィンドウが一瞬開くのを防ぐ
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("git を実行できませんでした: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `<リポジトリ名>-<ブランチ名>` の worktree をリポジトリの隣に作り、そのパスを返す。
/// ブランチが無ければ現在の HEAD から作る。
pub fn create_worktree(program: &Path, cwd: &str, branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    git(program, Path::new(cwd), &["check-ref-format", "--branch", branch])
        .map_err(|_| format!("ブランチ名として使えません: {branch}"))?;
    let root = git(program, Path::new(cwd), &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("Git リポジトリではありません: {cwd}"))?;
    let root = PathBuf::from(root);
    let repo = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let suffix: String = branch.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect();
    let dir = root.parent().unwrap_or(&root).join(format!("{repo}-{suffix}"));
    if dir.exists() {
        return Err(format!("フォルダが既にあります: {}", dir.display()));
    }
    let dir_str = dir.to_string_lossy().into_owned();
    let exists = git(program, &root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if exists {
        git(program, &root, &["worktree", "add", &dir_str, branch])?;
    } else {
        git(program, &root, &["worktree", "add", "-b", branch, &dir_str])?;
    }
    Ok(if cfg!(windows) { dir_str.replace('/', "\\") } else { dir_str })
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Head {
    /// ブランチ名。ブランチに乗っていない（detached）ときはコミットの先頭 7 文字
    pub branch: String,
    /// git worktree で作った作業フォルダの中か
    pub worktree: bool,
    /// 作業フォルダのいちばん上
    pub root: String,
    /// worktree のときの元のフォルダ
    pub origin: Option<Origin>,
}

/// worktree の元のフォルダ（`git worktree list` の先頭）と、そのフォルダの今のブランチ。
/// git はどのブランチから作ったかを残さないので、これは作った元ではなく、取り込むときの取り込み先
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Origin {
    pub root: String,
    pub branch: String,
}

/// 信頼していないフォルダの .git に書かれた場所にも従うので、ローカルのドライブ（`C:\…`）と相対パスだけを辿る。
/// \\server\share を読みにいくと、Windows がサインインの情報（NTLM）を相手に送ってしまう。
/// 文字列の頭で見分けると `\/server/share` のように区切りを混ぜた書き方をすり抜けるので、
/// Rust が解釈した結果の部品で見る（\\?\UNC\… や \\.\… も Prefix が Disk ではないので弾かれる）
pub(crate) fn local_target(text: &str) -> Option<PathBuf> {
    use std::path::{Component, Prefix};
    let path = PathBuf::from(text);
    let mut parts = path.components();
    match parts.next() {
        // C:foo はそのドライブの今のフォルダからの相対なので、C:\ の形だけを許す
        Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)) && matches!(parts.next(), Some(Component::RootDir)) => {}
        Some(Component::Prefix(_)) => return None,
        // Windows の \foo はドライブの指定が無い（\??\… の NT の名前空間もこの形になる）
        Some(Component::RootDir) if cfg!(windows) => return None,
        _ => {}
    }
    Some(path)
}

fn branch_of(head: &str) -> String {
    let head = head.trim();
    match head.strip_prefix("ref: refs/heads/") {
        Some(b) => b.to_string(),
        None => head.chars().take(7).collect(),
    }
}

/// `..` を取り除く（commondir は `../..` のような相対パスで書かれる）。ファイルには触らない
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

fn origin(git_dir: &Path) -> Option<Origin> {
    let common = local_target(read_small(&git_dir.join("commondir"))?.trim())?;
    let common = lexical(&git_dir.join(common));
    // git が作る worktree の git_dir は <元の .git>/worktrees/<名前>。それ以外を指していたら従わない
    if !lexical(git_dir).starts_with(common.join("worktrees")) {
        return None;
    }
    // bare リポジトリから作った worktree には、元のフォルダが無い
    if common.file_name()? != ".git" {
        return None;
    }
    let branch = branch_of(&read_small(&common.join("HEAD"))?);
    Some(Origin { root: common.parent()?.to_string_lossy().into_owned(), branch })
}

/// `.git` を読むだけでブランチを調べる。git を動かさないので、信頼していないフォルダでも使える
pub fn head(cwd: &Path) -> Option<Head> {
    let (root, dot_git) = cwd.ancestors().find_map(|d| {
        let g = d.join(".git");
        g.exists().then(|| (d.to_path_buf(), g))
    })?;
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = read_small(&dot_git)?;
        let target = local_target(text.trim().strip_prefix("gitdir:")?.trim())?;
        if target.is_absolute() { target } else { root.join(target) }
    };
    // サブモジュールも .git がファイルなので、worktree の印の commondir があるかで見分ける
    let worktree = git_dir.join("commondir").is_file();
    let branch = branch_of(&read_small(&git_dir.join("HEAD"))?);
    let origin = if worktree { origin(&git_dir) } else { None };
    Some(Head { branch, worktree, root: root.to_string_lossy().into_owned(), origin })
}

/// .git や HEAD は数十バイトなので、それより大きいものや普通のファイルでないものは読まない
fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

#[derive(serde::Serialize, Debug)]
pub struct WorktreeState {
    pub branch: String,
    /// 元の作業フォルダ（git worktree list の最初のもの）
    pub main: String,
    /// 元の作業フォルダのブランチ
    pub main_branch: String,
    /// 未コミットの変更があるか
    pub dirty: bool,
    /// 元のブランチに入っていないコミットの数
    pub ahead: usize,
}

/// 呼び出し側は、信頼したフォルダかどうかと files::repo_filter を確かめてから呼ぶこと（status や merge は filter などを動かす）
pub fn worktree_state(program: &Path, dir: &Path) -> Result<WorktreeState, String> {
    let list = git(program, dir, &["worktree", "list", "--porcelain"])?;
    let main = list.lines().next().and_then(|l| l.strip_prefix("worktree ")).ok_or("worktree の一覧を読めませんでした")?;
    let main = PathBuf::from(main);
    let branch = git(program, dir, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err("ブランチに乗っていない worktree です".into());
    }
    let main_branch = git(program, &main, &["branch", "--show-current"])?;
    let dirty = !git_raw(program, dir, &["status", "--porcelain", "--ignore-submodules=all"])?.trim().is_empty();
    let ahead = git(program, dir, &["rev-list", "--count", &format!("{main_branch}..{branch}")])?.parse().unwrap_or(0);
    Ok(WorktreeState { branch, main: main.to_string_lossy().into_owned(), main_branch, dirty, ahead })
}

/// worktree のブランチを元の作業フォルダのブランチに取り込む。競合したら取り込みをやめて元に戻す
pub fn merge_worktree(program: &Path, dir: &Path) -> Result<(), String> {
    let st = worktree_state(program, dir)?;
    let main = Path::new(&st.main);
    if !git_raw(program, main, &["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"])?.trim().is_empty() {
        return Err(format!("元のフォルダ（{}）に未コミットの変更があるので、取り込めません", st.main));
    }
    if let Err(e) = git(program, main, &["merge", "--no-edit", &st.branch]) {
        let _ = git(program, main, &["merge", "--abort"]);
        return Err(format!("{} に取り込めなかったので、取り込みをやめました（競合など）: {e}", st.main_branch));
    }
    Ok(())
}

/// worktree を消す。未コミットの変更があれば git が断る（--force は付けない）。
/// delete_branch のときは、取り込み済みのブランチだけ消す（-d は取り込まれていないブランチを断る）
pub fn remove_worktree(program: &Path, dir: &Path, delete_branch: bool) -> Result<(), String> {
    let st = worktree_state(program, dir)?;
    let main = Path::new(&st.main);
    let dir_str = dir.to_string_lossy();
    // セッションを閉じた直後は、終わりかけのプロセスがフォルダを握っていて消せないことがある
    let mut last = Ok(String::new());
    for _ in 0..5 {
        last = git(program, main, &["worktree", "remove", &dir_str]);
        if last.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    last.map_err(|e| format!("worktree を削除できませんでした: {e}"))?;
    if delete_branch {
        git(program, main, &["branch", "-d", &st.branch]).map_err(|e| format!("worktree は削除しましたが、ブランチ {} は消せませんでした: {e}", st.branch))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_worktree_next_to_repo() {
        let base = std::env::temp_dir().join(format!("tower-git-{}", std::process::id()));
        let repo = base.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        let program = PathBuf::from("git");
        git(&program, &repo, &["init", "-q"]).unwrap();
        git(&program, &repo, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]).unwrap();

        let dir = create_worktree(&program, &repo.to_string_lossy(), "feature/x").unwrap();
        assert!(Path::new(&dir).ends_with("app-feature-x"), "{dir}");
        assert!(Path::new(&dir).join(".git").exists());
        assert_eq!(git(&program, Path::new(&dir), &["branch", "--show-current"]).unwrap(), "feature/x");

        // 同じ名前はフォルダが衝突するのでエラー
        assert!(create_worktree(&program, &repo.to_string_lossy(), "feature/x").is_err());
        assert!(create_worktree(&program, &repo.to_string_lossy(), "bad..name").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }


    #[test]
    fn head_ignores_network_gitdir() {
        let base = std::env::temp_dir().join(format!("tower-git-unc-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join(".git"), r"gitdir: \\attacker\share\x").unwrap();
        assert_eq!(head(&base), None);
        std::fs::write(base.join(".git"), "gitdir: //attacker/share/x\n").unwrap();
        assert_eq!(head(&base), None);
        for bad in [r"\/attacker/share/x", r"/\attacker\share\x", r"\\?\UNC\attacker\share\x", r"\\.\pipe\x", r"\??\UNC\attacker\share", r"\x", "C:x"] {
            if cfg!(windows) {
                assert!(local_target(bad).is_none(), "{bad}");
            }
        }
        assert!(local_target(r"C:\repo\.git\worktrees\a").is_some());
        assert!(local_target("../.git/worktrees/a").is_some());
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn merges_and_removes_worktree() {
        let base = std::env::temp_dir().join(format!("tower-git-merge-{}", std::process::id()));
        let repo = base.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        let program = PathBuf::from("git");
        let commit = |dir: &Path, msg: &str| {
            git(&program, dir, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", msg]).unwrap();
        };
        git(&program, &repo, &["init", "-q", "-b", "main"]).unwrap();
        commit(&repo, "init");

        let head_main = head(&repo.join("sub")).unwrap();
        assert_eq!((head_main.branch.as_str(), head_main.worktree), ("main", false));

        let dir = PathBuf::from(create_worktree(&program, &repo.to_string_lossy(), "feature/y").unwrap());
        let h = head(&dir).unwrap();
        assert_eq!((h.branch.as_str(), h.worktree), ("feature/y", true));
        let origin = h.origin.unwrap();
        // 一時フォルダは 8.3 形式の短い名前（RUNNER~1 など）になることがあり、git は長い名前で書くので、実際の場所で比べる
        let real = |p: &Path| std::fs::canonicalize(p).unwrap();
        assert_eq!((real(Path::new(&origin.root)), origin.branch.as_str()), (real(&repo), "main"));
        assert_eq!(head_main.origin, None);

        commit(&dir, "work");
        std::fs::write(dir.join("new.txt"), "x").unwrap();
        let st = worktree_state(&program, &dir).unwrap();
        assert_eq!((st.main_branch.as_str(), st.ahead, st.dirty), ("main", 1, true));
        // 未コミットの変更がある worktree は消さない
        assert!(remove_worktree(&program, &dir, true).is_err());
        std::fs::remove_file(dir.join("new.txt")).unwrap();

        // 取り込んでいないブランチは -d で消せない
        assert!(remove_worktree(&program, &dir, true).is_err());
        assert!(!dir.exists(), "worktree 自体は消える");
        assert!(git(&program, &repo, &["rev-parse", "--verify", "--quiet", "refs/heads/feature/y"]).is_ok());

        let dir = PathBuf::from(create_worktree(&program, &repo.to_string_lossy(), "feature/y").unwrap());
        merge_worktree(&program, &dir).unwrap();
        assert_eq!(worktree_state(&program, &dir).unwrap().ahead, 0);
        remove_worktree(&program, &dir, true).unwrap();
        assert!(git(&program, &repo, &["rev-parse", "--verify", "--quiet", "refs/heads/feature/y"]).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }
}
