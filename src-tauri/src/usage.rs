//! エージェントごとの使用制限（5 時間の枠と 1 週間の枠の使用率と、リセットの時刻）。
//!
//! Claude Code はステータスラインのコマンドに渡す JSON の `rate_limits` に載せる
//! （https://code.claude.com/docs/en/statusline.md 。Pro・Max などの契約で、最初の応答のあとにだけ入る）。
//! Tower のセッションのステータスラインから受信口に送らせ、最後に見た値をファイルに残す。
//! Codex は会話の記録（`sessions/…/rollout-*.jsonl`）の token_count に `rate_limits` を書くので、新しい記録から読む。

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Window {
    /// 0〜100
    pub used: f64,
    /// Unix 時間（秒）
    pub resets_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Limits {
    pub five_hour: Option<Window>,
    pub week: Option<Window>,
}

#[derive(Serialize)]
pub struct Usage {
    pub claude: Option<Limits>,
    pub codex: Option<Limits>,
}

static CLAUDE_FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn init(app_dir: &Path) {
    let _ = CLAUDE_FILE.set(app_dir.join("usage-claude.json"));
}

pub fn read() -> Usage {
    let claude = CLAUDE_FILE.get().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok());
    let codex = crate::hooks::home_dir("CODEX_HOME", ".codex").and_then(|h| codex_limits(&h.join("sessions")));
    Usage { claude, codex }
}

/// ステータスラインの入力から使用率を取り出して残す。入力のほかの項目（作業フォルダやモデルなど）は捨てる。
/// 変わったら true
pub fn save_claude(body: &str) -> bool {
    let Some(limits) = claude_limits(body) else { return false };
    let Some(file) = CLAUDE_FILE.get() else { return false };
    let old: Option<Limits> = std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok());
    if old.as_ref() == Some(&limits) {
        return false;
    }
    std::fs::write(file, serde_json::to_vec(&limits).unwrap_or_default()).is_ok()
}

fn claude_limits(body: &str) -> Option<Limits> {
    let v: Value = serde_json::from_str(body.trim_start_matches('\u{feff}')).ok()?;
    let rl = v.get("rate_limits")?;
    let window = |k: &str| {
        let w = rl.get(k)?;
        Some(Window { used: w.get("used_percentage")?.as_f64()?, resets_at: epoch(w.get("resets_at")?)? })
    };
    let limits = Limits { five_hour: window("five_hour"), week: window("seven_day") };
    (limits.five_hour.is_some() || limits.week.is_some()).then_some(limits)
}

fn epoch(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

/// 新しい記録ほど新しい値なので、新しい日・新しいファイルから順に、使用率が書かれた最後の行を探す
const CODEX_FILES: usize = 12;
const CODEX_TAIL: u64 = 512 * 1024;

fn codex_limits(root: &Path) -> Option<Limits> {
    let mut files: Vec<PathBuf> = crate::transcript::day_dirs(root).iter().take(2).flat_map(|d| crate::transcript::jsonl_in(d)).collect();
    files.sort();
    files.iter().rev().take(CODEX_FILES).find_map(|f| codex_file_limits(f))
}

fn codex_file_limits(path: &Path) -> Option<Limits> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(CODEX_TAIL))).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    text.lines().rev().filter(|l| l.contains("\"rate_limits\"")).find_map(codex_line_limits)
}

fn codex_line_limits(line: &str) -> Option<Limits> {
    let v: Value = serde_json::from_str(line).ok()?;
    let rl = v.pointer("/payload/rate_limits").filter(|r| r.is_object())?;
    let mut limits = Limits::default();
    for key in ["primary", "secondary"] {
        let Some(w) = rl.get(key).filter(|w| w.is_object()) else { continue };
        let window = Window { used: w.get("used_percent")?.as_f64()?, resets_at: epoch(w.get("resets_at")?)? };
        // 枠の長さ（分）で見分ける。5 時間（300 分）と 1 週間（10080 分）
        match w.get("window_minutes").and_then(Value::as_u64) {
            Some(m) if m <= 24 * 60 => limits.five_hour = Some(window),
            Some(_) => limits.week = Some(window),
            None => {}
        }
    }
    (limits.five_hour.is_some() || limits.week.is_some()).then_some(limits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_rate_limits() {
        let body = r#"{"model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":38.5,"resets_at":1793862571},"seven_day":{"used_percentage":12,"resets_at":1794449371}}}"#;
        let l = claude_limits(body).unwrap();
        assert_eq!(l.five_hour, Some(Window { used: 38.5, resets_at: 1793862571 }));
        assert_eq!(l.week, Some(Window { used: 12.0, resets_at: 1794449371 }));
        // 片方の枠だけのこともある
        let only = claude_limits(r#"{"rate_limits":{"seven_day":{"used_percentage":3,"resets_at":1}}}"#).unwrap();
        assert!(only.five_hour.is_none() && only.week.is_some());
        assert!(claude_limits(r#"{"model":{}}"#).is_none());
    }

    #[test]
    fn codex_rate_limits_from_the_newest_rollout() {
        let root = std::env::temp_dir().join(format!("tower-usage-{}", std::process::id())).join("sessions");
        let day = root.join("2026").join("11").join("05");
        std::fs::create_dir_all(&day).unwrap();
        let line = |used: f64| {
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"limit_id":"codex","primary":{{"used_percent":{used},"window_minutes":300,"resets_at":100}},"secondary":{{"used_percent":1.0,"window_minutes":10080,"resets_at":200}}}}}}}}"#
            )
        };
        std::fs::write(day.join("rollout-2026-11-05T10-00-00-a.jsonl"), format!("{}\n{}\n", line(5.0), line(7.0))).unwrap();
        // 新しい記録に、まだ使用率が無い
        std::fs::write(day.join("rollout-2026-11-05T11-00-00-b.jsonl"), "{\"type\":\"session_meta\",\"payload\":{}}\n").unwrap();
        let l = codex_limits(&root).unwrap();
        assert_eq!(l.five_hour, Some(Window { used: 7.0, resets_at: 100 }));
        assert_eq!(l.week, Some(Window { used: 1.0, resets_at: 200 }));
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }
}
