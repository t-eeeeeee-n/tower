use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_FILE: u64 = 64 * 1024;

#[derive(Serialize)]
pub struct Mintty {
    /// 名前順。同じ名前は利用者のフォルダのものを優先する
    themes: Vec<Theme>,
    /// mintty が読む順に連結した設定ファイル（後の行ほど優先）
    config: String,
}

#[derive(Serialize)]
struct Theme {
    name: String,
    text: String,
}

fn git_root(shell: &str) -> Option<PathBuf> {
    Path::new(shell).ancestors().skip(1).find(|d| d.join("usr/share/mintty").is_dir()).map(Path::to_path_buf)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// 優先度の低い順に並べたフォルダからテーマを読む
fn read_themes(dirs: &[PathBuf]) -> Vec<Theme> {
    let mut found = BTreeMap::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if let Some(text) = read_small(&e.path()) {
                found.insert(name, text);
            }
        }
    }
    found.into_iter().map(|(name, text)| Theme { name, text }).collect()
}

/// Git Bash（mintty）のテーマと設定を読む。
/// 探す場所と順番は mintty のマニュアルの「Configuration」「Resource files」に合わせている。
pub fn load(shell: &str) -> Mintty {
    let root = git_root(shell);
    let home = home();
    let appdata = std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("mintty"));

    let mut config_files = Vec::new();
    config_files.extend(root.as_ref().map(|r| r.join("etc/minttyrc")));
    config_files.extend(appdata.as_ref().map(|d| d.join("config")));
    config_files.extend(home.as_ref().map(|h| h.join(".config/mintty/config")));
    config_files.extend(home.as_ref().map(|h| h.join(".minttyrc")));
    let config = config_files.iter().filter_map(|p| read_small(p)).collect::<Vec<_>>().join("\n");

    let mut theme_dirs = Vec::new();
    theme_dirs.extend(root.as_ref().map(|r| r.join("usr/share/mintty/themes")));
    theme_dirs.extend(appdata.as_ref().map(|d| d.join("themes")));
    theme_dirs.extend(home.as_ref().map(|h| h.join(".config/mintty/themes")));
    theme_dirs.extend(home.as_ref().map(|h| h.join(".mintty/themes")));

    Mintty { themes: read_themes(&theme_dirs), config }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_themes_override_bundled_ones() {
        let base = std::env::temp_dir().join(format!("tower-themes-{}", std::process::id()));
        let (bundled, user) = (base.join("bundled"), base.join("user"));
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(bundled.join("nord"), "Black=0,0,0").unwrap();
        std::fs::write(bundled.join("xterm"), "Black=1,1,1").unwrap();
        std::fs::write(user.join("nord"), "Black=9,9,9").unwrap();
        std::fs::write(user.join("huge"), vec![b'#'; MAX_FILE as usize + 1]).unwrap();

        let themes = read_themes(&[bundled, user, base.join("missing")]);
        let got: Vec<_> = themes.iter().map(|t| (t.name.as_str(), t.text.as_str())).collect();
        assert_eq!(got, [("nord", "Black=9,9,9"), ("xterm", "Black=1,1,1")]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn finds_git_root_from_bash() {
        let base = std::env::temp_dir().join(format!("tower-mintty-root-{}", std::process::id()));
        std::fs::create_dir_all(base.join("usr/share/mintty")).unwrap();
        std::fs::create_dir_all(base.join("bin")).unwrap();
        assert_eq!(git_root(&base.join("bin/bash.exe").to_string_lossy()), Some(base.clone()));
        assert_eq!(git_root(&base.join("usr/bin/bash.exe").to_string_lossy()), Some(base.clone()));
        let _ = std::fs::remove_dir_all(&base);
    }
}
