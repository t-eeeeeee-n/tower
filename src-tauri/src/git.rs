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
}
