//! セッションで起動するコーディングエージェントの種類と、起動・再開のコマンド。

use serde::{Deserialize, Serialize};

use crate::session::Status;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    /// bash だけ
    Shell,
    Claude,
    Codex,
    Copilot,
    Antigravity,
}

impl Agent {
    /// bash に入力する起動コマンド。`claude_settings` は Claude Code に渡す hooks 設定のパス。
    /// 再開は、再開する会話が無いと失敗する（終了コード 1）ので、そのときは新しく始める。
    pub fn launch_line(self, claude_settings: &str, resume: bool) -> Option<String> {
        let (start, cont) = match self {
            Agent::Shell => return None,
            Agent::Claude => (
                format!("claude --settings '{claude_settings}'"),
                format!("claude --continue --settings '{claude_settings}'"),
            ),
            // tower プロファイル（hooks::codex_profile）を利用者の設定の上に重ねる
            Agent::Codex => ("codex -p tower".into(), "codex -p tower resume --last".into()),
            Agent::Copilot => ("copilot".into(), "copilot --continue".into()),
            Agent::Antigravity => ("agy".into(), "agy --continue".into()),
        };
        Some(if resume { format!("{cont} || {start}\r") } else { format!("{start}\r") })
    }

    /// hooks を使えないので、画面の内容から状態を推測するか
    pub fn infers_status(self) -> bool {
        self == Agent::Antigravity
    }
}

/// 画面の変化が止まってから「完了」とみなすまでの時間
pub const IDLE_AFTER_MS: u64 = 3000;

/// 画面の内容から状態を推測する。`quiet_ms` は画面が最後に変わってからの時間。
/// 承認を求める文言が画面の下のほうにあれば入力待ち、画面が動いていれば作業中、止まっていれば完了とみなす。
pub fn infer_status(screen: &str, quiet_ms: u64) -> Status {
    let tail: Vec<String> = screen
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(12)
        .map(|l| l.to_lowercase())
        .collect();
    let asking = tail.iter().any(|l| {
        let l = l.trim_start_matches(|c: char| c.is_whitespace() || "│❯›>".contains(c));
        l.contains("do you want to")
            || l.contains("(y/n)")
            || l.contains("[y/n]")
            || l.starts_with("1. yes")
            || l.starts_with("1. allow")
            || l.starts_with("allow once")
            || l.contains("do you trust")
            // 選択肢の確定方法の案内（Claude Code・Codex・Copilot CLI・Antigravity CLI の確認画面に出る）
            || l.contains("enter to confirm")
            || l.contains("enter confirm")
            || l.contains("press enter to continue")
            || l.contains("confirm with number keys")
    });
    if asking {
        Status::Waiting
    } else if quiet_ms < IDLE_AFTER_MS {
        Status::Running
    } else {
        Status::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_falls_back_to_new_session() {
        assert_eq!(Agent::Copilot.launch_line("", true).unwrap(), "copilot --continue || copilot\r");
        assert_eq!(Agent::Codex.launch_line("", false).unwrap(), "codex -p tower\r");
        assert!(Agent::Shell.launch_line("", true).is_none());
    }

    #[test]
    fn infers_status_from_screen() {
        let asking = "● Run npm test?\n\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n";
        assert_eq!(infer_status(asking, 60_000), Status::Waiting);
        // 番号の無い選択肢（Claude Code のフォルダの信頼確認）
        let trust = " ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n";
        assert_eq!(infer_status(trust, 60_000), Status::Waiting);
        // Antigravity CLI のフォルダの信頼確認と、コマンド実行の承認
        let agy_trust = "Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n  ↑/↓ Navigate · enter Confirm\n";
        assert_eq!(infer_status(agy_trust, 60_000), Status::Waiting);
        let agy_run = "Run this command?\n> 1. Yes, run command\n  4. No, cancel\n  ↑/↓ Navigate · tab Amend\nesc to cancel\n";
        assert_eq!(infer_status(agy_run, 60_000), Status::Waiting);
        // 入力欄だけの待機画面は完了
        let agy_idle = "  OK\n────────\n>\n────────\n? for shortcuts      Gemini 3.8 Flash · high\n";
        assert_eq!(infer_status(agy_idle, 10_000), Status::Idle);
        assert_eq!(infer_status("✻ Working… (12s)\n", 500), Status::Running);
        assert_eq!(infer_status("Done.\n> \n", 10_000), Status::Idle);
        // 承認の文言が画面のずっと上にあるだけなら入力待ちではない
        let old = format!("Do you want to proceed?\n{}", "line\n".repeat(20));
        assert_eq!(infer_status(&old, 10_000), Status::Idle);
    }
}
