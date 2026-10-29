//! エージェントの会話の記録（Claude Code は ~/.claude/projects/<dir>/<session>.jsonl、Codex は
//! ~/.codex/sessions/…/rollout-*.jsonl）を読んで、画面に出す形に縮める。
//! 記録の形式は公開された仕様ではないので、知らない種類の行は読み飛ばし、読めない行があっても止めない。

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// 初めて開くときに読む末尾の大きさ。長い会話の記録は数十 MB になるので、全部は読まない
const INITIAL_TAIL: u64 = 2 << 20;
const MAX_TEXT: usize = 4000;
const MAX_RESULT: usize = 400;
const MAX_TOOL_INPUT: usize = 200;
/// base64 の文字数。これより大きい画像は、表示が重くなるので出さない（スクリーンショットは数百 KB ほど）
const MAX_IMAGE: usize = 4 << 20;
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    User,
    Assistant,
    Command,
    Tool,
    Result,
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub kind: Kind,
    pub text: String,
    pub tool: Option<String>,
    /// ツールの呼び出しと結果を結び付ける ID
    pub id: Option<String>,
    pub error: bool,
    /// 貼り付けた画像や、ツールが読んだ画像（data URL）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// 記録の時刻（ISO 8601）。依頼ごとにかかった時間を出すのに使う
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// ツールの結果の要約（「42 行」「3 件」など）。結果の行だけに付く
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// ファイルを変えたツールの結果の、変えたファイルと増えた行・減った行
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change: Option<Change>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    pub added: usize,
    pub removed: usize,
}

#[derive(Serialize)]
pub struct Chunk {
    /// 今の記録ファイル。まだ SessionStart が届いていなければ None
    pub path: Option<String>,
    /// 次に読むときに渡す位置（読んだ最後の改行の次）
    pub offset: u64,
    /// 呼び出し側が持っている表示を捨てて、entries だけにする
    pub reset: bool,
    pub entries: Vec<Entry>,
}

pub fn path_from_hook(body: &str) -> Option<PathBuf> {
    let v: Value = serde_json::from_str(body.trim_start_matches('\u{feff}')).ok()?;
    let path = PathBuf::from(v.get("transcript_path")?.as_str()?);
    (path.is_absolute() && path.extension().is_some_and(|e| e == "jsonl")).then_some(path)
}

#[derive(Serialize, Debug)]
pub struct Subagent {
    pub id: String,
    /// 呼び出したときの説明（Agent ツールの description）
    pub description: String,
    pub agent_type: Option<String>,
    /// 本体の会話で、このサブエージェントを呼び出した Agent ツールの呼び出しの ID
    pub tool_use_id: Option<String>,
    /// 記録ファイルを最後に書き換えた時刻（UNIX 時間のミリ秒）。作業中かどうかの目安に使う
    pub modified: u64,
}

/// Claude Code は、サブエージェントの会話を本体の記録の隣の `<セッションID>/subagents/agent-<ID>.jsonl` に残し、
/// 呼び出しの説明を `agent-<ID>.meta.json` に書く（どちらも公開された仕様ではない）
fn subagent_dir(main: &Path) -> PathBuf {
    main.with_extension("").join("subagents")
}

/// ID は英数字だけを受け付け、本体の記録の隣のフォルダの外を指させない
pub fn subagent_path(main: &Path, agent: &str) -> Result<PathBuf, String> {
    if agent.is_empty() || !agent.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("サブエージェントの ID として使えません: {agent}"));
    }
    Ok(subagent_dir(main).join(format!("agent-{agent}.jsonl")))
}

/// 新しく書き換えられた順。Codex など、サブエージェントの記録が無ければ空
pub fn subagents(main: &Path) -> Vec<Subagent> {
    let Ok(dir) = std::fs::read_dir(subagent_dir(main)) else { return Vec::new() };
    let mut out: Vec<Subagent> = dir
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_prefix("agent-")?.strip_suffix(".jsonl")?;
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
                return None;
            }
            let modified = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            let meta: Value = std::fs::read(e.path().with_extension("meta.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            let text = |k: &str| meta.get(k).and_then(Value::as_str).map(String::from);
            Some(Subagent {
                id: id.to_string(),
                description: text("description").unwrap_or_default(),
                agent_type: text("agentType"),
                tool_use_id: text("toolUseId"),
                modified,
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Shell {
    /// Claude Code が付けるタスクの ID（出力ファイルの名前にもなる）
    pub id: String,
    pub tool_use_id: String,
    pub description: String,
    pub command: String,
    /// running / completed / failed / killed。終わった知らせが記録に無いあいだは running
    pub status: String,
    /// 呼び出しの記録の時刻（ISO 8601）
    pub started: String,
    #[serde(skip)]
    output: Option<String>,
}

#[derive(Default)]
struct ShellScan {
    offset: u64,
    /// まだ結果の届いていない、裏で動かす Bash の呼び出し（ID → 説明・コマンド・時刻）
    calls: HashMap<String, (String, String, String)>,
    shells: Vec<Shell>,
}

/// 記録は長いと数十 MB になるので、前回読んだところから先だけを読む
static SHELL_SCANS: OnceLock<Mutex<HashMap<PathBuf, ShellScan>>> = OnceLock::new();
/// 初めて読むときに見る末尾の大きさ。これより前に始めたシェルは、もう終わっているとみなす
const SHELL_INITIAL_TAIL: u64 = 16 << 20;
const SHELL_OUTPUT_TAIL: u64 = 64 << 10;

/// Claude Code が裏で動かすシェル（Bash の run_in_background）。新しく始めた順。
/// 呼び出し（tool_use）・始まった知らせ（toolUseResult.backgroundTaskId）・終わった知らせ（<task-notification>）を
/// 本体の記録から拾う（どれも公開された仕様ではない）。サブエージェントが動かしたものは数えない
pub fn shells(main: &Path) -> Vec<Shell> {
    let scans = SHELL_SCANS.get_or_init(Default::default);
    let mut scans = scans.lock().unwrap_or_else(|e| e.into_inner());
    let scan = scans.entry(main.to_path_buf()).or_default();
    scan_shells(main, scan);
    scan.shells.iter().rev().cloned().collect()
}

fn scan_shells(main: &Path, scan: &mut ShellScan) {
    let Ok(mut file) = std::fs::File::open(main) else { return };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return };
    if len < scan.offset {
        *scan = ShellScan::default();
    }
    let fresh = scan.offset == 0;
    let start = if fresh { len.saturating_sub(SHELL_INITIAL_TAIL) } else { scan.offset };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if file.take(len - start).read_to_end(&mut buf).is_err() {
        return;
    }
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let begin = if fresh && start > 0 { buf[..end].iter().position(|&b| b == b'\n').map_or(end, |i| i + 1) } else { 0 };
    for line in buf[begin..end].split(|&b| b == b'\n') {
        shell_line(line, scan);
    }
    scan.offset = start + end as u64;
}

fn shell_line(line: &[u8], scan: &mut ShellScan) {
    let has = |s: &str| line.windows(s.len()).any(|w| w == s.as_bytes());
    let (call, started, notice) = (has("\"run_in_background\":true"), has("\"backgroundTaskId\""), has("<task-notification>"));
    if !(call || started || notice) {
        return;
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
    if v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
        return;
    }
    let str_at = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    if call && v.get("type").and_then(Value::as_str) == Some("assistant") {
        for b in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
            let input = b.get("input");
            let background = input.and_then(|i| i.get("run_in_background")).and_then(Value::as_bool).unwrap_or(false);
            if b.get("type").and_then(Value::as_str) != Some("tool_use") || b.get("name").and_then(Value::as_str) != Some("Bash") || !background {
                continue;
            }
            let field = |k: &str| input.and_then(|i| i.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
            let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            scan.calls.insert(id, (field("description"), field("command"), str_at("/timestamp")));
        }
    }
    if started {
        let Some(task) = v.pointer("/toolUseResult/backgroundTaskId").and_then(Value::as_str) else { return };
        let block = v.pointer("/message/content/0");
        let tool_use_id = block.and_then(|b| b.get("tool_use_id")).and_then(Value::as_str).unwrap_or("").to_string();
        let text = block.and_then(|b| b.get("content")).and_then(Value::as_str).unwrap_or("");
        let output = text
            .split_once("Output is being written to: ")
            .and_then(|(_, rest)| rest.find(".output").map(|i| rest[..i + ".output".len()].to_string()));
        let (description, command, started) = scan.calls.remove(&tool_use_id).unwrap_or_default();
        if !scan.shells.iter().any(|s| s.id == task) {
            scan.shells.push(Shell {
                id: task.to_string(),
                tool_use_id,
                description,
                command,
                status: "running".into(),
                started: if started.is_empty() { str_at("/timestamp") } else { started },
                output,
            });
        }
    }
    if notice {
        // 知らせは待ち行列への出し入れ（queue-operation）と、会話への差し込み（queued_command）の両方に残る。
        // ツールの結果の文章に紛れた同じ文字列（記録を grep した結果など）は拾わない
        let text = match v.get("type").and_then(Value::as_str) {
            Some("queue-operation") => str_at("/content"),
            Some("attachment") => str_at("/attachment/prompt"),
            _ => return,
        };
        if !text.starts_with("<task-notification>") {
            return;
        }
        let tag = |name: &str| {
            let open = format!("<{name}>");
            let close = format!("</{name}>");
            let (_, rest) = text.split_once(&open)?;
            rest.split_once(&close).map(|(inner, _)| inner.trim().to_string())
        };
        if let (Some(task), Some(status)) = (tag("task-id"), tag("status")) {
            if let Some(s) = scan.shells.iter_mut().find(|s| s.id == task) {
                s.status = status;
            }
        }
    }
}

#[derive(Serialize)]
pub struct ShellOutput {
    pub text: String,
    /// 長いので末尾だけを返した
    pub truncated: bool,
}

pub fn shell_output(main: &Path, task: &str) -> Result<ShellOutput, String> {
    let shell = shells(main).into_iter().find(|s| s.id == task).ok_or("このシェルの記録が見つかりません")?;
    // 記録に書かれた場所なので、ローカルのドライブにある、このタスクの出力ファイルだけを開く
    let path = shell
        .output
        .as_deref()
        .and_then(crate::git::local_target)
        .filter(|p| p.is_absolute() && p.file_name().is_some_and(|n| n.to_string_lossy() == format!("{task}.output")))
        .ok_or("このシェルの出力の場所が分かりません")?;
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ShellOutput { text: String::new(), truncated: false }),
        Err(e) => return Err(format!("シェルの出力を開けませんでした: {e}")),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(SHELL_OUTPUT_TAIL);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let begin = if start > 0 { buf.iter().position(|&b| b == b'\n').map_or(0, |i| i + 1) } else { 0 };
    Ok(ShellOutput { text: String::from_utf8_lossy(&buf[begin..]).into_owned(), truncated: start > 0 })
}

/// `known` は呼び出し側が読んでいたファイルで、今のファイルと違えば最初から（長ければ末尾から）読み直す。
/// `limit` を渡すと、新しい方からその数だけ返す（呼び出し側が表示しきれない分を送らないため）。
/// `sidechain` はサブエージェントの記録を読むとき。サブエージェントの行には isSidechain が付いていて、
/// 本体の記録に混ざっている古い版のものは読み飛ばす
pub fn read(current: Option<PathBuf>, known: Option<String>, offset: u64, limit: Option<usize>, sidechain: bool) -> Result<Chunk, String> {
    let Some(path) = current else {
        return Ok(Chunk { path: None, offset: 0, reset: true, entries: Vec::new() });
    };
    let path_str = path.to_string_lossy().into_owned();
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        // 起動直後は、最初の発言まで記録ファイルが作られない
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Chunk { path: Some(path_str), offset: 0, reset: true, entries: Vec::new() });
        }
        Err(e) => return Err(format!("会話の記録を開けませんでした: {e}")),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let reset = known.as_deref() != Some(path_str.as_str()) || offset > len;
    let (start, skip_partial) = if !reset {
        (offset, false)
    } else if len > INITIAL_TAIL {
        (len - INITIAL_TAIL, true)
    } else {
        (0, false)
    };
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take(len - start).read_to_end(&mut buf).map_err(|e| e.to_string())?;

    // 書きかけの最後の行は次に回す
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let begin = if skip_partial { buf[..end].iter().position(|&b| b == b'\n').map_or(end, |i| i + 1) } else { 0 };
    let mut entries: Vec<Entry> = buf[begin..end]
        .split(|&b| b == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|v| sidechain || !v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false))
        .flat_map(|v| entries_of(&v))
        .collect();
    if let Some(limit) = limit {
        entries.drain(..entries.len().saturating_sub(limit));
    }
    Ok(Chunk { path: Some(path_str), offset: start + end as u64, reset, entries })
}

fn entries_of(v: &Value) -> Vec<Entry> {
    if v.get("isMeta").and_then(Value::as_bool).unwrap_or(false) {
        return Vec::new();
    }
    if v.get("type").and_then(Value::as_str) == Some("response_item") {
        return v.get("payload").map(codex_entries).unwrap_or_default();
    }
    let content = v.pointer("/message/content");
    let mut entries = match (v.get("type").and_then(Value::as_str), content) {
        (Some("user"), Some(Value::String(s))) => user_text(s).into_iter().collect(),
        (Some("user"), Some(Value::Array(blocks))) => merge_user_images(blocks.iter().filter_map(user_block).collect()),
        (Some("assistant"), Some(Value::Array(blocks))) => blocks.iter().filter_map(assistant_block).collect(),
        _ => Vec::new(),
    };
    let at = v.get("timestamp").and_then(Value::as_str);
    // toolUseResult は行ごとに 1 つで、その行の tool_result（1 つだけ）の詳しい結果
    let detail = v.get("toolUseResult").filter(|t| t.is_object());
    for e in &mut entries {
        e.at = at.map(String::from);
        if let (Kind::Result, Some(d)) = (&e.kind, detail) {
            (e.outcome, e.change) = outcome_of(d);
        }
    }
    entries
}

/// Claude Code の toolUseResult から、結果の短い要約と、ファイルの変更を作る。
/// ツールの名前は結果の行に無いので、項目の形で見分ける（どれも公開された仕様ではない）
fn outcome_of(d: &Value) -> (Option<String>, Option<Change>) {
    let num = |k: &str| d.get(k).and_then(Value::as_u64);
    let text = |k: &str| d.get(k).and_then(Value::as_str);
    if d.get("backgroundTaskId").is_some() || d.get("isAsync").and_then(Value::as_bool) == Some(true) {
        return (Some("裏で実行".into()), None);
    }
    if let Some(lines) = d.pointer("/file/numLines").and_then(Value::as_u64) {
        return (Some(format!("{lines} 行")), None);
    }
    if let Some(path) = text("filePath") {
        let (mut added, mut removed) = (0, 0);
        for hunk in d.get("structuredPatch").and_then(Value::as_array).into_iter().flatten() {
            for l in hunk.get("lines").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                match l.as_bytes().first() {
                    Some(b'+') => added += 1,
                    Some(b'-') => removed += 1,
                    _ => {}
                }
            }
        }
        // 新しく作ったファイルは差分が空で、中身がすべて増えた行になる
        if text("type") == Some("create") {
            added = text("content").map_or(0, |c| c.lines().count());
        }
        let change = Change { path: path.to_string(), added, removed };
        return (Some(format!("+{added} −{removed}")), Some(change));
    }
    if let Some(files) = num("numFiles") {
        let n = if text("mode") == Some("content") { num("numLines").unwrap_or(files) } else { files };
        return (Some(format!("{n} 件")), None);
    }
    if let Some(ms) = num("totalDurationMs") {
        return (Some(format!("{}秒", ms / 1000)), None);
    }
    if d.get("stdout").is_some() {
        if d.get("interrupted").and_then(Value::as_bool) == Some(true) {
            return (Some("中断".into()), None);
        }
        let lines = text("stdout").map_or(0, |s| s.lines().count());
        return (Some(if lines == 0 { "完了".into() } else { format!("出力 {lines} 行") }), None);
    }
    (None, None)
}

/// Codex の記録（~/.codex/sessions/…/rollout-*.jsonl）の行。会話そのものは response_item に入っていて、
/// event_msg は同じ内容の通知なので読まない
fn codex_entries(p: &Value) -> Vec<Entry> {
    let text_of = |p: &Value| -> String {
        p.get("content")
            .and_then(Value::as_array)
            .map(|parts| parts.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    };
    let call_id = |p: &Value| p.get("call_id").and_then(Value::as_str).map(String::from);
    match p.get("type").and_then(Value::as_str) {
        Some("message") => match p.get("role").and_then(Value::as_str) {
            // 先頭に差し込まれる AGENTS.md と <environment_context> は人の発言ではない
            Some("user") => {
                let text = text_of(p);
                if text.trim_start().starts_with("# AGENTS.md instructions") {
                    return Vec::new();
                }
                user_text(&text).into_iter().collect()
            }
            Some("assistant") => {
                let text = text_of(p);
                let text = text.trim();
                if text.is_empty() { Vec::new() } else { vec![entry(Kind::Assistant, truncate(text, MAX_TEXT))] }
            }
            _ => Vec::new(),
        },
        Some(kind @ ("function_call" | "custom_tool_call")) => {
            let name = p.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let raw = p.get(if kind == "function_call" { "arguments" } else { "input" }).and_then(Value::as_str).unwrap_or("");
            let text = match serde_json::from_str::<Value>(raw) {
                Ok(v @ Value::Object(_)) => tool_summary(&v),
                _ => truncate(raw.trim(), MAX_TOOL_INPUT),
            };
            vec![Entry { kind: Kind::Tool, text, tool: Some(name), id: call_id(p), error: false, images: Vec::new(), at: None, outcome: None, change: None }]
        }
        Some("function_call_output" | "custom_tool_call_output") => {
            let text = match p.get("output") {
                // 古い版は {"output": …, "metadata": …} を文字列にして入れていた
                Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
                    Ok(Value::Object(o)) => o.get("output").and_then(Value::as_str).unwrap_or(s).to_string(),
                    _ => s.clone(),
                },
                Some(v) => v.get("content").and_then(Value::as_str).map(String::from).unwrap_or_else(|| v.to_string()),
                None => String::new(),
            };
            vec![Entry { kind: Kind::Result, text: truncate(text.trim(), MAX_RESULT), tool: None, id: call_id(p), error: false, images: Vec::new(), at: None, outcome: None, change: None }]
        }
        _ => Vec::new(),
    }
}

fn entry(kind: Kind, text: String) -> Entry {
    Entry { kind, text, tool: None, id: None, error: false, images: Vec::new(), at: None, outcome: None, change: None }
}

/// 人が打った発言。スラッシュコマンドは名前だけにし、Claude Code が差し込むタグ付きの文は出さない
fn user_text(s: &str) -> Option<Entry> {
    if let Some(name) = between(s, "<command-name>", "</command-name>") {
        let args = between(s, "<command-args>", "</command-args>").unwrap_or("").trim();
        let text = if args.is_empty() { name.to_string() } else { format!("{name} {args}") };
        return Some(entry(Kind::Command, text));
    }
    let s = without_paste_tags(s);
    let s = s.trim();
    (!s.is_empty() && !s.starts_with('<')).then(|| entry(Kind::User, truncate(s, MAX_TEXT)))
}

/// Claude Code は、貼り付けた文章を記録では `<pasted_content id="…">` と `</pasted_content id="…">` の行で囲む。
/// エージェントに渡す目印で、利用者が書いたものではないので、表示では囲みの行だけを取り除く
fn without_paste_tags(s: &str) -> String {
    let is_tag = |l: &str| {
        let l = l.trim();
        l.len() < 64 && (l.starts_with("<pasted_content") || l.starts_with("</pasted_content")) && l.ends_with('>')
    };
    s.lines().filter(|l| !is_tag(l)).collect::<Vec<_>>().join("\n")
}

/// 画像のブロック（`{"type":"image","source":{"type":"base64",…}}`）を、表示にそのまま使える data URL にする。
/// 表示に使うのは img 要素だけだが、SVG は避けて写真・スクリーンショットの形式に限る
fn image_url(b: &Value) -> Result<String, &'static str> {
    let source = b.get("source").ok_or("[画像]")?;
    let media = source.get("media_type").and_then(Value::as_str).unwrap_or("");
    let data = source.get("data").and_then(Value::as_str).filter(|_| source.get("type").and_then(Value::as_str) == Some("base64"));
    match data {
        Some(_) if !IMAGE_TYPES.contains(&media) => Err("[画像]"),
        Some(d) if d.len() > MAX_IMAGE => Err("[画像（大きいので表示しません）]"),
        Some(d) if d.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')) => Ok(format!("data:{media};base64,{d}")),
        _ => Err("[画像]"),
    }
}

fn user_block(b: &Value) -> Option<Entry> {
    match b.get("type")?.as_str()? {
        "text" => user_text(b.get("text")?.as_str()?),
        "image" => Some(match image_url(b) {
            Ok(url) => Entry { images: vec![url], ..entry(Kind::User, String::new()) },
            Err(text) => entry(Kind::User, text.into()),
        }),
        "tool_result" => {
            let mut images = Vec::new();
            let text = match b.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|p| match p.get("type").and_then(Value::as_str) {
                        Some("image") => match image_url(p) {
                            Ok(url) => {
                                images.push(url);
                                None
                            }
                            Err(text) => Some(text),
                        },
                        _ => p.get("text").and_then(Value::as_str),
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            let error = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let id = b.get("tool_use_id").and_then(Value::as_str).map(String::from);
            Some(Entry { kind: Kind::Result, text: truncate(text.trim(), MAX_RESULT), tool: None, id, error, images, at: None, outcome: None, change: None })
        }
        _ => None,
    }
}

/// 貼り付けた画像は、発言の文と別のブロックで記録されるので、同じ発言の吹き出しにまとめる
fn merge_user_images(entries: Vec<Entry>) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::with_capacity(entries.len());
    for e in entries {
        if let (Kind::User, true, Some(prev)) = (&e.kind, e.text.is_empty(), out.last_mut()) {
            if prev.kind == Kind::User {
                prev.images.extend(e.images);
                continue;
            }
        }
        out.push(e);
    }
    out
}

fn assistant_block(b: &Value) -> Option<Entry> {
    match b.get("type")?.as_str()? {
        "text" => {
            let s = b.get("text")?.as_str()?.trim();
            (!s.is_empty()).then(|| entry(Kind::Assistant, truncate(s, MAX_TEXT)))
        }
        "tool_use" => {
            let name = b.get("name")?.as_str()?.to_string();
            let text = tool_summary(b.get("input").unwrap_or(&Value::Null));
            let id = b.get("id").and_then(Value::as_str).map(String::from);
            Some(Entry { kind: Kind::Tool, text, tool: Some(name), id, error: false, images: Vec::new(), at: None, outcome: None, change: None })
        }
        _ => None,
    }
}

/// ツールの入力のうち、何をしようとしているかが一番わかる 1 項目
fn tool_summary(input: &Value) -> String {
    const KEYS: &[&str] = &["command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill"];
    let text = KEYS
        .iter()
        .find_map(|k| match input.get(*k)? {
            Value::String(s) => Some(s.clone()),
            // Codex の shell は ["powershell", "-Command", "…"] のように配列で渡す
            Value::Array(parts) => parts.last().and_then(Value::as_str).map(String::from),
            _ => None,
        })
        .unwrap_or_else(|| if input.is_null() { String::new() } else { input.to_string() });
    truncate(text.trim(), MAX_TOOL_INPUT)
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = s.find(open)? + open.len();
    let len = s[start..].find(close)?;
    Some(&s[start..start + len])
}

fn truncate(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn kinds(v: Value) -> Vec<(Kind, String)> {
        entries_of(&v).into_iter().map(|e| (e.kind, e.text)).collect()
    }

    #[test]
    fn hook_path_must_be_absolute_jsonl() {
        assert!(path_from_hook(r#"{"transcript_path":"C:\\Users\\a\\.claude\\projects\\x\\s.jsonl"}"#).is_some());
        assert!(path_from_hook(r#"{"transcript_path":"relative.jsonl"}"#).is_none());
        assert!(path_from_hook(r#"{"transcript_path":"C:\\Windows\\win.ini"}"#).is_none());
        assert!(path_from_hook("not json").is_none());
    }

    #[test]
    fn tool_outcomes() {
        let o = |d: Value| outcome_of(&d);
        assert_eq!(o(json!({"type":"text","file":{"filePath":"a.css","numLines":42}})).0.as_deref(), Some("42 行"));
        let edit = o(json!({"filePath":"src/a.css","structuredPatch":[{"lines":[" x","-old","+new","+more"]}]}));
        assert_eq!(edit, (Some("+2 −1".into()), Some(Change { path: "src/a.css".into(), added: 2, removed: 1 })));
        let create = o(json!({"type":"create","filePath":"b.ts","content":"1\n2\n3\n","structuredPatch":[]}));
        assert_eq!(create.1.map(|c| (c.added, c.removed)), Some((3, 0)));
        assert_eq!(o(json!({"mode":"files_with_matches","numFiles":3,"filenames":[]})).0.as_deref(), Some("3 件"));
        assert_eq!(o(json!({"mode":"content","numFiles":0,"numLines":7})).0.as_deref(), Some("7 件"));
        assert_eq!(o(json!({"stdout":"ok\nok\n","stderr":"","interrupted":false})).0.as_deref(), Some("出力 2 行"));
        assert_eq!(o(json!({"stdout":"","stderr":"","backgroundTaskId":"b1"})).0.as_deref(), Some("裏で実行"));
        assert_eq!(o(json!({"skill":"x"})), (None, None));

        let line = json!({"type":"user","timestamp":"2026-10-29T01:00:00Z","toolUseResult":{"file":{"numLines":5}},
            "message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"…"}]}});
        let e = entries_of(&line);
        assert_eq!((e[0].outcome.as_deref(), e[0].at.as_deref()), (Some("5 行"), Some("2026-10-29T01:00:00Z")));
    }

    #[test]
    fn images_in_messages_and_results() {
        let img = |media: &str, data: &str| json!({"type":"image","source":{"type":"base64","media_type":media,"data":data}});
        let v = json!({"type":"user","message":{"content":[{"type":"text","text":"スクショ\n[Image #1]"}, img("image/png", "iVBORw0K"), img("image/svg+xml", "PHN2Zz4=")]}});
        let e = entries_of(&v);
        assert_eq!(e.len(), 2);
        assert_eq!((e[0].text.as_str(), e[0].images.as_slice()), ("スクショ\n[Image #1]", &["data:image/png;base64,iVBORw0K".to_string()][..]));
        // SVG は出さず、文字で置き換える
        assert_eq!((e[1].text.as_str(), e[1].images.len()), ("[画像]", 0));

        let r = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[img("image/jpeg", "/9j/4AAQ"), img("image/png", "bad\"data")]}]}});
        let e = entries_of(&r);
        assert_eq!((e[0].text.as_str(), e[0].images.as_slice()), ("[画像]", &["data:image/jpeg;base64,/9j/4AAQ".to_string()][..]));
    }

    #[test]
    fn user_messages() {
        let cmd = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>";
        assert_eq!(kinds(json!({"type":"user","message":{"content":cmd}})), vec![(Kind::Command, "/model opus".into())]);
        assert_eq!(kinds(json!({"type":"user","message":{"content":"直して"}})), vec![(Kind::User, "直して".into())]);
        assert!(kinds(json!({"type":"user","message":{"content":"<local-command-stdout></local-command-stdout>"}})).is_empty());
        assert!(kinds(json!({"type":"user","isMeta":true,"message":{"content":"meta"}})).is_empty());

        // 貼り付けの囲みの行は出さない。貼り付けだけの発言も、囲みで始まるからといって消さない
        let pasted = "\n\n<pasted_content id=\"2225\">\n# 依頼\n直して\n</pasted_content id=\"2225\">\n";
        assert_eq!(kinds(json!({"type":"user","message":{"content":pasted}})), vec![(Kind::User, "# 依頼\n直して".into())]);
        let mixed = "これを見て\n<pasted_content id=\"ab12\">\nerror: x\n</pasted_content id=\"ab12\">";
        assert_eq!(kinds(json!({"type":"user","message":{"content":mixed}})), vec![(Kind::User, "これを見て\nerror: x".into())]);
    }

    #[test]
    fn subagent_transcripts() {
        let dir = std::env::temp_dir().join(format!("tower-subagents-{}", std::process::id()));
        let sub = dir.join("s").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let main = dir.join("s.jsonl");
        let line = |t: &str, side: bool| format!("{}\n", json!({"type":"user","isSidechain":side,"message":{"content":t}}));
        std::fs::write(&main, format!("{}{}", line("本体", false), line("古い版のサブ", true))).unwrap();
        std::fs::write(sub.join("agent-a1.jsonl"), line("調べて", true)).unwrap();
        std::fs::write(sub.join("agent-a1.meta.json"), r#"{"description":"調査","agentType":"Explore","toolUseId":"toolu_1"}"#).unwrap();
        std::fs::write(sub.join("agent-bad id.jsonl"), "").unwrap();

        let texts = |c: Chunk| c.entries.into_iter().map(|e| e.text).collect::<Vec<_>>();
        assert_eq!(texts(read(Some(main.clone()), None, 0, None, false).unwrap()), ["本体"]);
        let list = subagents(&main);
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].id.as_str(), list[0].description.as_str(), list[0].tool_use_id.as_deref()), ("a1", "調査", Some("toolu_1")));
        let path = subagent_path(&main, "a1").unwrap();
        assert_eq!(texts(read(Some(path), None, 0, None, true).unwrap()), ["調べて"]);
        assert!(subagent_path(&main, "../s").is_err());
        assert!(subagent_path(&main, "").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn background_shells() {
        let dir = std::env::temp_dir().join(format!("tower-shells-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tasks")).unwrap();
        let main = dir.join("s.jsonl");
        let out = |id: &str| dir.join("tasks").join(format!("{id}.output"));
        std::fs::write(out("b1"), "building\n[exited with code 0]\n").unwrap();
        let call = |id: &str, desc: &str| json!({"type":"assistant","timestamp":"2026-10-28T01:00:00Z","message":{"content":[
            {"type":"tool_use","id":id,"name":"Bash","input":{"command":"npm run build","description":desc,"run_in_background":true}}]}});
        let began = |tool: &str, task: &str| json!({"type":"user","timestamp":"2026-10-28T01:00:01Z","message":{"content":[
            {"type":"tool_result","tool_use_id":tool,"content":format!("Command running in background with ID: {task}. Output is being written to: {}. You will be notified.", out(task).display())}]},
            "toolUseResult":{"backgroundTaskId":task}});
        let done = |task: &str, status: &str| json!({"type":"attachment","attachment":{"type":"queued_command",
            "prompt":format!("<task-notification>\n<task-id>{task}</task-id>\n<status>{status}</status>\n</task-notification>")}});
        let lines = |vs: &[Value]| vs.iter().map(|v| format!("{v}\n")).collect::<String>();
        // ツールの結果に紛れた知らせの文字列は拾わない
        let grep = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"<task-notification><task-id>b2</task-id><status>failed</status>"}]}});
        std::fs::write(&main, lines(&[call("t1", "ビルド"), began("t1", "b1"), call("t2", "サーバー"), began("t2", "b2"), grep])).unwrap();

        let list = shells(&main);
        assert_eq!(list.iter().map(|s| (s.id.as_str(), s.status.as_str())).collect::<Vec<_>>(), [("b2", "running"), ("b1", "running")]);
        assert_eq!((list[1].description.as_str(), list[1].command.as_str()), ("ビルド", "npm run build"));

        std::fs::OpenOptions::new().append(true).open(&main).unwrap().write_all(lines(&[done("b1", "completed")]).as_bytes()).unwrap();
        assert_eq!(shells(&main)[1].status, "completed");
        assert_eq!(shell_output(&main, "b1").unwrap().text, "building\n[exited with code 0]\n");
        assert!(shell_output(&main, "zz").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn assistant_and_tools() {
        let v = json!({"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"..."},
            {"type":"text","text":"見ます"},
            {"type":"tool_use","name":"Bash","input":{"command":"ls","description":"一覧"}}
        ]}});
        let e = entries_of(&v);
        assert_eq!(e.len(), 2);
        assert_eq!((&e[1].kind, e[1].tool.as_deref(), e[1].text.as_str()), (&Kind::Tool, Some("Bash"), "ls"));
        let r = json!({"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"err"}],"is_error":true}]}});
        let e = entries_of(&r);
        assert!(e[0].error && e[0].kind == Kind::Result && e[0].text == "err");
    }

    #[test]
    fn reads_only_complete_lines_and_resumes() {
        let dir = std::env::temp_dir().join(format!("tower-transcript-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let line = |t: &str| format!("{}\n", json!({"type":"user","message":{"content":t}}));
        std::fs::write(&path, format!("{}{}", line("一"), r#"{"type":"user","mess"#)).unwrap();
        let first = read(Some(path.clone()), None, 0, None, false).unwrap();
        assert!(first.reset);
        assert_eq!(first.entries.len(), 1);

        std::fs::write(&path, format!("{}{}", line("一"), line("二"))).unwrap();
        let next = read(Some(path.clone()), first.path.clone(), first.offset, None, false).unwrap();
        assert!(!next.reset);
        assert_eq!(next.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), vec!["二"]);

        let other = read(Some(path.clone()), Some("other.jsonl".into()), next.offset, Some(1), false).unwrap();
        assert!(other.reset);
        assert_eq!(other.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), vec!["二"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_lines() {
        let item = |p: Value| json!({"type":"response_item","payload":p});
        assert!(kinds(item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>…"}]}))).is_empty());
        assert!(kinds(item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for C:/x"}]}))).is_empty());
        assert!(kinds(item(json!({"type":"message","role":"developer","content":[{"type":"input_text","text":"sys"}]}))).is_empty());
        assert_eq!(kinds(item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"直して"}]}))), vec![(Kind::User, "直して".into())]);
        assert_eq!(kinds(item(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}))), vec![(Kind::Assistant, "OK".into())]);
        assert!(kinds(json!({"type":"event_msg","payload":{"type":"agent_message","message":"OK"}})).is_empty());

        let call = entries_of(&item(json!({"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"powershell\",\"-Command\",\"ls\"]}"})));
        assert_eq!((call[0].tool.as_deref(), call[0].text.as_str(), call[0].id.as_deref()), (Some("shell"), "ls", Some("c1")));
        let custom = entries_of(&item(json!({"type":"custom_tool_call","name":"exec","call_id":"c2","input":"tools.exec_command({cmd:\"ls\"})"})));
        assert_eq!(custom[0].text, "tools.exec_command({cmd:\"ls\"})");
        let out = entries_of(&item(json!({"type":"function_call_output","call_id":"c1","output":"{\"output\":\"a.txt\",\"metadata\":{}}"})));
        assert_eq!((out[0].kind == Kind::Result, out[0].text.as_str(), out[0].id.as_deref()), (true, "a.txt", Some("c1")));
    }

    #[test]
    fn truncates_by_chars() {
        assert_eq!(truncate("あいうえお", 3), "あいう…");
        assert_eq!(truncate("abc", 3), "abc");
    }
}
