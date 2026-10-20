//! Git の変更を自動で表示してよいフォルダ（利用者が許可したもの）の記録。
//!
//! Git はリポジトリの設定によってコマンドを実行することがあり、Tower はファイルパネルを開いている間
//! git を自動で呼ぶ。知られている抜け道は git.rs と files.rs で塞いでいるが、それで全部とは限らないので、
//! 利用者が許可したフォルダでだけ git を呼ぶ（VS Code のワークスペースの信頼と同じ考え方）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Trust {
    file: PathBuf,
    folders: Mutex<BTreeSet<String>>,
}

/// 同じフォルダを同じ文字列にする（Windows はパスの大文字・小文字を区別しない）
fn key(path: &Path) -> Option<String> {
    let canon = path.canonicalize().ok()?.to_string_lossy().into_owned();
    Some(if cfg!(windows) { canon.to_lowercase() } else { canon })
}

impl Trust {
    pub fn load(file: PathBuf) -> Self {
        let folders = std::fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice::<BTreeSet<String>>(&b).ok())
            .unwrap_or_default();
        Trust { file, folders: Mutex::new(folders) }
    }

    pub fn contains(&self, path: &Path) -> bool {
        key(path).is_some_and(|k| self.folders.lock().unwrap().contains(&k))
    }

    pub fn add(&self, path: &Path) -> Result<(), String> {
        let k = key(path).ok_or_else(|| format!("フォルダが見つかりません: {}", path.display()))?;
        let mut folders = self.folders.lock().unwrap();
        if folders.insert(k) {
            if let Some(dir) = self.file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let json = serde_json::to_vec_pretty(&*folders).map_err(|e| e.to_string())?;
            std::fs::write(&self.file, json).map_err(|e| format!("信頼したフォルダを保存できませんでした: {e}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_trusted_folders() {
        let base = std::env::temp_dir().join(format!("tower-trust-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (repo, other) = (base.join("Repo"), base.join("other"));
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let file = base.join("trusted-folders.json");

        let trust = Trust::load(file.clone());
        assert!(!trust.contains(&repo));
        trust.add(&repo).unwrap();
        assert!(trust.contains(&repo));
        assert!(!trust.contains(&other), "許可したフォルダだけが対象");
        assert!(!trust.contains(&repo.join("missing")), "存在しないパスは信頼しない");
        if cfg!(windows) {
            assert!(trust.contains(&base.join("repo")), "大文字・小文字の違いは同じフォルダ");
        }

        // 次に起動したときも覚えている
        assert!(Trust::load(file).contains(&repo));
        let _ = std::fs::remove_dir_all(&base);
    }
}
