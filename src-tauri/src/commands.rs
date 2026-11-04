//! 会話の入力欄で「/」を打ったときに出す、Claude Code のカスタムコマンドとスキル。
//! 置き場所は Claude Code の決まり（プロジェクトとユーザーの `.claude/commands/**/*.md` と `.claude/skills/*/SKILL.md`）。
//! プラグインのものは読まない。

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct Command {
    pub name: String,
    pub description: String,
    /// project / user
    pub source: &'static str,
}

const MAX_DESCRIPTION: usize = 120;
/// サブフォルダ（名前の `:` 区切り）をたどる深さ
const MAX_DEPTH: usize = 4;

pub fn list(cwd: &Path, home: Option<&Path>) -> Vec<Command> {
    let mut out = Vec::new();
    let roots = [(cwd.join(".claude"), "project")].into_iter().chain(home.map(|h| (h.join(".claude"), "user")));
    for (root, source) in roots {
        collect_commands(&root.join("commands"), "", 0, source, &mut out);
        collect_skills(&root.join("skills"), source, &mut out);
    }
    // 同じ名前はプロジェクトのものを使う（Claude Code と同じ）
    let mut seen = std::collections::HashSet::new();
    out.retain(|c| seen.insert(c.name.clone()));
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn collect_commands(dir: &Path, prefix: &str, depth: usize, source: &'static str, out: &mut Vec<Command>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else { continue };
        if path.is_dir() {
            if depth < MAX_DEPTH {
                collect_commands(&path, &format!("{prefix}{stem}:"), depth + 1, source, out);
            }
        } else if path.extension().and_then(|x| x.to_str()) == Some("md") {
            let text = read_head(&path);
            let description = front_matter(&text, "description").unwrap_or_else(|| first_line(&text));
            out.push(Command { name: format!("{prefix}{stem}"), description: clip(&description), source });
        }
    }
}

fn collect_skills(dir: &Path, source: &'static str, out: &mut Vec<Command>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let file: PathBuf = e.path().join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let text = read_head(&file);
        if front_matter(&text, "user-invocable").as_deref() == Some("false") {
            continue;
        }
        let name = front_matter(&text, "name").unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
        let description = front_matter(&text, "description").unwrap_or_default();
        out.push(Command { name, description: clip(&description), source });
    }
}

/// 説明は先頭にあるので、大きなファイルでも頭だけを読む
fn read_head(path: &Path) -> String {
    use std::io::Read;
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(16 << 10).read_to_end(&mut buf);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// `---` で囲んだ先頭の YAML から、1 行で書かれた key の値を取る（複数行の値は読まない）
fn front_matter(text: &str, key: &str) -> Option<String> {
    let body = text.trim_start_matches('\u{feff}').strip_prefix("---")?;
    let end = body.find("\n---")?;
    body[..end].lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
        (k.trim() == key && !v.is_empty() && v != "|" && v != ">").then(|| v.to_string())
    })
}

fn first_line(text: &str) -> String {
    let body = text.trim_start_matches('\u{feff}');
    let body = body.strip_prefix("---").and_then(|b| b.find("\n---").map(|i| &b[i + 4..])).unwrap_or(body);
    body.lines().map(|l| l.trim().trim_start_matches('#').trim()).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

fn clip(s: &str) -> String {
    match s.char_indices().nth(MAX_DESCRIPTION) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_commands_and_skills() {
        let base = std::env::temp_dir().join(format!("tower-cmds-{}", std::process::id()));
        let (proj, home) = (base.join("proj"), base.join("home"));
        let write = |p: PathBuf, s: &str| {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, s).unwrap();
        };
        write(proj.join(".claude/commands/deploy.md"), "---\ndescription: 本番に出す\n---\n手順");
        write(proj.join(".claude/commands/db/reset.md"), "# DB を作り直す\n");
        write(proj.join(".claude/skills/release/SKILL.md"), "---\nname: release\ndescription: \"リリースする\"\n---\n");
        write(proj.join(".claude/skills/hidden/SKILL.md"), "---\nname: hidden\nuser-invocable: false\n---\n");
        write(home.join(".claude/commands/deploy.md"), "---\ndescription: ユーザーの方\n---\n");
        write(home.join(".claude/skills/notify/SKILL.md"), "---\ndescription: |\n  複数行\n---\n");

        let got: Vec<_> = list(&proj, Some(&home)).into_iter().map(|c| (c.name, c.description, c.source)).collect();
        assert_eq!(
            got,
            [
                ("db:reset".to_string(), "DB を作り直す".to_string(), "project"),
                ("deploy".into(), "本番に出す".into(), "project"),
                ("notify".into(), "".into(), "user"),
                ("release".into(), "リリースする".into(), "project"),
            ]
        );
        std::fs::remove_dir_all(&base).ok();
    }
}
