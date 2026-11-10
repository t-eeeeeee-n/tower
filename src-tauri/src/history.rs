//! フォルダごとの過去の会話の一覧。新しいセッションをその会話の続きから開くのに使う。
//! どちらの記録の置き場所と形式も公開された仕様ではないので、読めないファイルは飛ばす。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::transcript::{self, Kind};

/// 題名と最初の発言を探すために読む先頭の大きさ。記録は数十 MB になることがあるので全部は読まない
const HEAD: u64 = 1 << 20;
const MAX_LIST: usize = 200;
const MAX_PROMPT: usize = 300;

#[derive(Serialize, Debug)]
pub struct Past {
    pub agent: &'static str,
    /// 再開に渡す会話の ID
    pub id: String,
    /// Claude Code が付けた題名（/rename で付けたものがあればそちら）
    pub title: Option<String>,
    pub prompt: String,
    /// 記録ファイルを最後に書き換えた時刻（UNIX 時間のミリ秒）
    pub modified: u64,
}

/// Claude Code は会話を `<設定のフォルダ>/projects/<フォルダのパスの英数字以外を - にした名前>/<ID>.jsonl` に残す
fn claude_dir(root: &Path, cwd: &str) -> PathBuf {
    root.join("projects").join(cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>())
}

/// 新しい順。Codex の記録は日付のフォルダに全部のプロジェクトの分が混ざっているので、先頭の行の作業フォルダで選ぶ
pub fn list(cwd: &str, claude_root: Option<&Path>, codex_root: Option<&Path>) -> Vec<Past> {
    let mut out: Vec<Past> = Vec::new();
    if let Some(root) = claude_root {
        out.extend(transcript::jsonl_in(&claude_dir(root, cwd)).filter_map(|p| claude_past(&p)));
    }
    if let Some(root) = codex_root {
        let want = same_dir_key(cwd);
        let mut found = 0;
        for day in transcript::day_dirs(&root.join("sessions")) {
            for p in transcript::jsonl_in(&day) {
                if let Some(x) = codex_past(&p, &want) {
                    out.push(x);
                    found += 1;
                }
            }
            if found >= MAX_LIST {
                break;
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out.truncate(MAX_LIST);
    out
}

/// 再開に渡す ID として使えるか。起動のコマンドに入れるので、英数字とハイフン・下線だけを受け付ける
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn same_dir_key(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn modified_ms(path: &Path) -> Option<u64> {
    Some(std::fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// 先頭の HEAD バイトのうち、改行で終わっている行
fn head_lines(path: &Path) -> Vec<String> {
    let mut buf = Vec::new();
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    if file.take(HEAD).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    lines.pop();
    lines
}

fn first_prompt(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .filter(|l| l.contains("\"user\"") || l.contains("queued_command"))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .flat_map(|v| transcript::entries_of(&v))
        .find(|e| e.kind == Kind::User && !e.text.trim().is_empty())
        .map(|e| e.text.chars().take(MAX_PROMPT).collect())
}

fn claude_past(path: &Path) -> Option<Past> {
    let lines = head_lines(path);
    let mut ai_title = None;
    let mut custom_title = None;
    for l in lines.iter().filter(|l| l.contains("-title\"")) {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        let text = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
        match v.get("type").and_then(Value::as_str) {
            Some("ai-title") => ai_title = text("aiTitle").or(ai_title),
            Some("custom-title") => custom_title = text("customTitle").or(custom_title),
            _ => {}
        }
    }
    Some(Past {
        agent: "claude",
        id: path.file_stem()?.to_str()?.to_string(),
        title: custom_title.or(ai_title),
        // 発言の無い会話（起動しただけ・コマンドだけ）は、続きから開く意味が無いので出さない
        prompt: first_prompt(&lines)?,
        modified: modified_ms(path)?,
    })
}

fn codex_past(path: &Path, want: &str) -> Option<Past> {
    let meta = transcript::first_line(path)?;
    let payload = meta.get("payload")?;
    if same_dir_key(payload.get("cwd")?.as_str()?) != want {
        return None;
    }
    Some(Past {
        agent: "codex",
        id: payload.get("id")?.as_str()?.to_string(),
        title: None,
        prompt: first_prompt(&head_lines(path))?,
        modified: modified_ms(path)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_claude_and_codex_conversations_for_the_folder() {
        let root = std::env::temp_dir().join(format!("tower-history-{}", std::process::id()));
        let cwd = r"C:\work\my app";
        let claude = root.join("claude");
        let dir = claude_dir(&claude, cwd);
        assert!(dir.ends_with("C--work-my-app"));
        std::fs::create_dir_all(&dir).unwrap();
        let line = |v: Value| format!("{v}\n");
        std::fs::write(
            dir.join("aaa-111.jsonl"),
            [
                line(json!({"type":"user","isMeta":true,"message":{"content":"<command-name>/model</command-name>"}})),
                line(json!({"type":"ai-title","aiTitle":"自動の題名"})),
                line(json!({"type":"user","message":{"content":"最初の指示"}})),
                line(json!({"type":"custom-title","customTitle":"付けた題名"})),
            ]
            .concat(),
        )
        .unwrap();
        std::fs::write(dir.join("empty.jsonl"), line(json!({"type":"ai-title","aiTitle":"x"}))).unwrap();

        let codex = root.join("codex");
        let day = codex.join("sessions").join("2026").join("11").join("10");
        std::fs::create_dir_all(&day).unwrap();
        let rollout = |cwd: &str, id: &str| {
            [
                line(json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}})),
                line(json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex の指示"}]}})),
            ]
            .concat()
        };
        std::fs::write(day.join("rollout-1.jsonl"), rollout("c:/work/my app/", "ccc-333")).unwrap();
        std::fs::write(day.join("rollout-2.jsonl"), rollout(r"C:\other", "ddd-444")).unwrap();

        let got: Vec<_> = list(cwd, Some(&claude), Some(&codex)).into_iter().map(|p| (p.agent, p.id, p.title, p.prompt)).collect();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.contains(&("claude", "aaa-111".into(), Some("付けた題名".into()), "最初の指示".into())));
        assert!(got.contains(&("codex", "ccc-333".into(), None, "codex の指示".into())));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ids_safe_for_the_launch_line() {
        assert!(valid_id("3bbf1d02-8657-445b-a299-e20974cca34a"));
        assert!(!valid_id("x; rm -rf /"));
        assert!(!valid_id(""));
    }
}
