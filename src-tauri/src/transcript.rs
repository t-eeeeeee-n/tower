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
    /// 予定のツール（TodoWrite・TaskCreate・TaskUpdate）の入力。会話の表示が予定の一覧を組み立てる
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todo: Option<Value>,
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
    /// reset のとき、読みはじめた位置（行の頭）。前の会話を読み足すときは、ここより前から読み直す
    pub start: u64,
    /// reset のとき、表示しきれなかった前の会話があるか（ファイルの途中から読んだか、limit で古いものを捨てたか）
    pub more: bool,
    /// 読んだところまでの最後の行の uuid。次に続きを読むときに渡すと、巻き戻し（枝分かれ）に気づける
    pub tip: Option<String>,
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
    out.sort_by_key(|a| std::cmp::Reverse(a.modified));
    out
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Shell {
    /// Claude Code が付けるタスクの ID（出力ファイルの名前にもなる）
    pub id: String,
    pub tool_use_id: String,
    pub description: String,
    pub command: String,
    /// running / completed / failed / killed / stopped。終わった知らせが記録に無いあいだは running
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
/// 呼び出し（tool_use）・始まった知らせ（toolUseResult.backgroundTaskId）・終わった知らせ（<task-notification>）・
/// TaskStop の結果（toolUseResult.task_id）を
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
    let stop = has("Successfully stopped task");
    if !(call || started || notice || stop) {
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
    // TaskStop で止めたシェルには、終わった知らせが記録に残らない
    if stop && v.get("type").and_then(Value::as_str) == Some("user") && str_at("/toolUseResult/message").starts_with("Successfully stopped task") {
        let task = str_at("/toolUseResult/task_id");
        if let Some(s) = scan.shells.iter_mut().find(|s| s.id == task) {
            s.status = "killed".into();
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
/// 本体の記録に混ざっている古い版のものは読み飛ばす。
/// `from` を渡すと、その位置（の次の行の頭）から読み直す（前の会話を読み足すとき）。
/// `tip` は前回の Chunk の tip。続きに、それにつながらない発言があれば、巻き戻されたとみなして読み直す
pub fn read(current: Option<PathBuf>, known: Option<String>, offset: u64, limit: Option<usize>, sidechain: bool, from: Option<u64>, tip: Option<String>) -> Result<Chunk, String> {
    let Some(path) = current else {
        return Ok(Chunk { path: None, offset: 0, reset: true, entries: Vec::new(), start: 0, more: false, tip: None });
    };
    let path_str = path.to_string_lossy().into_owned();
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        // 起動直後は、最初の発言まで記録ファイルが作られない
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Chunk { path: Some(path_str), offset: 0, reset: true, entries: Vec::new(), start: 0, more: false, tip: None });
        }
        Err(e) => return Err(format!("会話の記録を開けませんでした: {e}")),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let reset = from.is_some() || known.as_deref() != Some(path_str.as_str()) || offset > len;
    let (start, skip_partial) = match from {
        Some(f) => (f.min(len), f.min(len) > 0),
        None if !reset => (offset, false),
        None if len > INITIAL_TAIL => (len - INITIAL_TAIL, true),
        None => (0, false),
    };
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take(len - start).read_to_end(&mut buf).map_err(|e| e.to_string())?;

    // 書きかけの最後の行は次に回す
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let begin = if skip_partial { buf[..end].iter().position(|&b| b == b'\n').map_or(end, |i| i + 1) } else { 0 };
    let mut lines: Vec<Value> = buf[begin..end]
        .split(|&b| b == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|v| sidechain || !v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false))
        .collect();
    if !reset && branched(&lines, tip.as_deref()) {
        return read(Some(path), None, 0, limit, sidechain, None, None);
    }
    if reset {
        lines = current_branch(lines);
    }
    if start + begin as u64 == 0 {
        if let Some(prefix) = lines.first().and_then(|first| fork_prefix(&path, first, 0)) {
            lines.splice(0..0, prefix);
        }
    }
    let new_tip = lines.iter().rev().find_map(|v| uuid(v)).map(String::from).or(tip);
    let mut entries: Vec<Entry> = lines.iter().flat_map(entries_of).collect();
    let dropped = limit.map_or(0, |limit| entries.len().saturating_sub(limit));
    entries.drain(..dropped);
    let head = start + begin as u64;
    Ok(Chunk { path: Some(path_str), offset: start + end as u64, reset, entries, start: head, more: head > 0 || dropped > 0, tip: new_tip })
}

/// Codex で前のメッセージを書き直すと、会話は新しい記録ファイルに分かれる。分かれた記録は分かれる前の行を持たず、
/// 最初の session_meta に元の記録の ID と、元の記録のどの行（ordinal）の手前で分かれたかだけを持つ
fn forked_from(first: &Value) -> Option<(&str, u64)> {
    if first.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let p = first.get("payload")?;
    Some((p.get("forked_from_id")?.as_str()?, p.get("forked_from_ordinal_exclusive")?.as_u64()?))
}

const FORK_DEPTH: usize = 8;

/// 分かれた記録の前に置く、元の記録の分かれる前の行（元の記録がさらに分かれたものなら、その元もたどる）
fn fork_prefix(path: &Path, first: &Value, depth: usize) -> Option<Vec<Value>> {
    let (id, before) = forked_from(first)?;
    if depth >= FORK_DEPTH {
        return None;
    }
    let file = codex_file(sessions_root(path)?, id)?;
    let text = std::fs::read_to_string(&file).ok()?;
    let mut lines: Vec<Value> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("ordinal").and_then(Value::as_u64).is_some_and(|o| o < before))
        .collect();
    if let Some(prefix) = lines.first().and_then(|f| fork_prefix(&file, f, depth + 1)) {
        lines.splice(0..0, prefix);
    }
    Some(lines)
}

/// Codex の記録は `sessions/年/月/日/rollout-…-<ID>.jsonl` に置かれる
fn sessions_root(path: &Path) -> Option<&Path> {
    let root = path.ancestors().nth(4)?;
    (root.file_name()? == "sessions").then_some(root)
}

/// 日のフォルダ（新しい順）
pub(crate) fn day_dirs(root: &Path) -> Vec<PathBuf> {
    let mut days: Vec<PathBuf> = read_dirs(root).iter().flat_map(|y| read_dirs(y)).flat_map(|m| read_dirs(&m)).collect();
    days.sort();
    days.reverse();
    days
}

pub(crate) fn jsonl_in(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
}

fn read_dirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()
}

fn codex_file(root: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("-{id}.jsonl");
    day_dirs(root).iter().flat_map(|d| jsonl_in(d)).find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(&name)))
}

fn first_line(path: &Path) -> Option<Value> {
    use std::io::BufRead;
    let mut line = String::new();
    std::io::BufReader::new(std::fs::File::open(path).ok()?).read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

/// Codex の会話 path から分かれた記録のうち、いちばん新しいもの。書き直したあとの会話を追うのに使う。
/// 分かれた記録は書き直した日に作られるので、新しい日から 2 日分だけ探す
pub fn codex_fork(path: &Path) -> Option<PathBuf> {
    let id = first_line(path)?.pointer("/payload/id")?.as_str()?.to_string();
    let mut found: Vec<PathBuf> = day_dirs(sessions_root(path)?)
        .iter()
        .take(2)
        .flat_map(|d| jsonl_in(d))
        .filter(|p| first_line(p).as_ref().and_then(forked_from).is_some_and(|(from, _)| from == id))
        .collect();
    found.sort();
    found.pop()
}

fn uuid(v: &Value) -> Option<&str> {
    v.get("uuid").and_then(Value::as_str)
}

/// 親の行。要約（compact）の区切りは親を持たないので、元の親（logicalParentUuid）をたどる
fn parent(v: &Value) -> Option<&str> {
    v.get("parentUuid").and_then(Value::as_str).or_else(|| v.get("logicalParentUuid").and_then(Value::as_str))
}

/// 人が書いた発言（ツールの結果やメタ情報ではない）。画像を付けた発言は中身が配列になる
fn is_prompt(v: &Value) -> bool {
    let content = v.pointer("/message/content");
    let written = match content {
        Some(Value::String(_)) => true,
        Some(Value::Array(items)) => {
            !items.is_empty() && items.iter().all(|i| i.get("type").and_then(Value::as_str) != Some("tool_result"))
        }
        _ => false,
    };
    v.get("type").and_then(Value::as_str) == Some("user") && written && !v.get("isMeta").and_then(Value::as_bool).unwrap_or(false)
}

/// 続きの行に、それまでの最後の行（tip）につながらない発言があるか。
/// 巻き戻すと、記録の行は消えずに残ったまま、次の発言が戻った先の行を親にして書き足される（Claude Code）。
/// ツールの結果は呼び出しの行を親にするので、すぐ前の行が親とは限らない。発言だけで確かめる
fn branched(lines: &[Value], tip: Option<&str>) -> bool {
    let mut last = tip.map(String::from);
    for v in lines {
        let Some(id) = uuid(v) else { continue };
        if is_prompt(v) && last.is_some() && parent(v) != last.as_deref() {
            return true;
        }
        last = Some(id.to_string());
    }
    false
}

/// 巻き戻しで捨てられた枝を除き、今の会話の行だけを残す。最後の行から親をたどった行と、
/// そこから発言以外の行だけでつながる行（並列に呼んだツールの結果など、たどった道から外れる行）を残す。
/// 捨てられた枝は発言から始まるので、ここで外れる。uuid の無い行（Codex など）はそのまま残す
fn current_branch(lines: Vec<Value>) -> Vec<Value> {
    let by_id: std::collections::HashMap<&str, &Value> = lines.iter().filter_map(|v| Some((uuid(v)?, v))).collect();
    let mut on = std::collections::HashSet::new();
    let mut at = lines.iter().rev().find_map(|v| uuid(v));
    while let Some(id) = at {
        if !on.insert(id.to_string()) {
            break;
        }
        at = by_id.get(id).and_then(|v| parent(v));
    }
    if on.is_empty() {
        return lines;
    }
    // 記録は古い順なので、親は子より前に出てくる。前から 1 回なめれば、つながる行をすべて拾える
    let mut keep = Vec::with_capacity(lines.len());
    for v in lines {
        let Some(id) = uuid(&v).map(String::from) else {
            keep.push(v);
            continue;
        };
        if on.contains(&id) || (!is_prompt(&v) && parent(&v).is_some_and(|p| on.contains(p))) {
            on.insert(id);
            keep.push(v);
        }
    }
    keep
}

fn entries_of(v: &Value) -> Vec<Entry> {
    if v.get("isMeta").and_then(Value::as_bool).unwrap_or(false) {
        return Vec::new();
    }
    // 文脈が足りなくなったときの要約（compact）は人の発言として残るが、Claude Code が書いたものなので区切りだけを出す
    if v.get("isCompactSummary").and_then(Value::as_bool).unwrap_or(false) {
        let mut e = entry(Kind::Command, "会話を要約して続けています（compact）".into());
        e.at = v.get("timestamp").and_then(Value::as_str).map(String::from);
        return vec![e];
    }
    if v.get("type").and_then(Value::as_str) == Some("response_item") {
        return v.get("payload").map(codex_entries).unwrap_or_default();
    }
    let content = v.pointer("/message/content");
    let mut entries = match (v.get("type").and_then(Value::as_str), content) {
        (Some("user"), Some(Value::String(s))) => user_text(s).into_iter().collect(),
        (Some("user"), Some(Value::Array(blocks))) => merge_user_images(blocks.iter().filter_map(user_block).collect()),
        (Some("assistant"), Some(Value::Array(blocks))) => blocks.iter().filter_map(assistant_block).collect(),
        // 作業中に送った指示は、区切りで渡されると user の行ではなく queued_command として残る（Claude Code）
        (Some("attachment"), _) if v.pointer("/attachment/type").and_then(Value::as_str) == Some("queued_command")
            && v.pointer("/attachment/origin/kind").and_then(Value::as_str) == Some("human") =>
        {
            v.pointer("/attachment/prompt").and_then(Value::as_str).and_then(user_text).into_iter().collect()
        }
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
            vec![Entry { kind: Kind::Tool, text, tool: Some(name), id: call_id(p), error: false, images: Vec::new(), at: None, outcome: None, change: None, todo: None }]
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
            vec![Entry { kind: Kind::Result, text: truncate(text.trim(), MAX_RESULT), tool: None, id: call_id(p), error: false, images: Vec::new(), at: None, outcome: None, change: None, todo: None }]
        }
        _ => Vec::new(),
    }
}

fn entry(kind: Kind, text: String) -> Entry {
    Entry { kind, text, tool: None, id: None, error: false, images: Vec::new(), at: None, outcome: None, change: None, todo: None }
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
            Some(Entry { kind: Kind::Result, text: truncate(text.trim(), MAX_RESULT), tool: None, id, error, images, at: None, outcome: None, change: None, todo: None })
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

/// 予定を書くツール。古い版は TodoWrite で一覧ごと、今の版は TaskCreate / TaskUpdate で 1 件ずつ書く
const TODO_TOOLS: &[&str] = &["TodoWrite", "TaskCreate", "TaskUpdate"];

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
            let todo = TODO_TOOLS.contains(&name.as_str()).then(|| b.get("input").cloned()).flatten();
            Some(Entry { kind: Kind::Tool, text, tool: Some(name), id, error: false, images: Vec::new(), at: None, outcome: None, change: None, todo })
        }
        _ => None,
    }
}

/// ツールの入力のうち、何をしようとしているかが一番わかる 1 項目
fn tool_summary(input: &Value) -> String {
    // 質問（AskUserQuestion）は、入力の JSON ではなく最初の問いの文を出す
    if let Some(q) = input.pointer("/questions/0/question").and_then(Value::as_str) {
        return truncate(q.trim(), MAX_TOOL_INPUT);
    }
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
        // 作業中に送って区切りで渡された指示は出し、裏のシェルの知らせは出さない
        let queued = |prompt: &str, kind: &str| json!({"type":"attachment","attachment":{"type":"queued_command","prompt":prompt,"commandMode":"prompt","origin":{"kind":kind}}});
        assert_eq!(kinds(queued("こっちも直して", "human")), vec![(Kind::User, "こっちも直して".into())]);
        assert!(kinds(queued("<task-notification>x</task-notification>", "task-notification")).is_empty());
        // compact の要約は自分の発言として出さず、区切りにする
        let summary = json!({"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"content":"This session is being continued from a previous conversation..."}});
        assert_eq!(kinds(summary), vec![(Kind::Command, "会話を要約して続けています（compact）".into())]);

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
        assert_eq!(texts(read(Some(main.clone()), None, 0, None, false, None, None).unwrap()), ["本体"]);
        let list = subagents(&main);
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].id.as_str(), list[0].description.as_str(), list[0].tool_use_id.as_deref()), ("a1", "調査", Some("toolu_1")));
        let path = subagent_path(&main, "a1").unwrap();
        assert_eq!(texts(read(Some(path), None, 0, None, true, None, None).unwrap()), ["調べて"]);
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

        // TaskStop で止めたものは、終わった知らせが無くても止まったとみなす
        let stop = |task: &str| json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"{}"}]},
            "toolUseResult":{"message":format!("Successfully stopped task: {task} (npm run dev)"),"task_id":task,"task_type":"local_bash"}});
        std::fs::OpenOptions::new().append(true).open(&main).unwrap().write_all(lines(&[done("b1", "completed"), stop("b2")]).as_bytes()).unwrap();
        assert_eq!(shells(&main).iter().map(|s| s.status.as_str()).collect::<Vec<_>>(), ["killed", "completed"]);
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
        let first = read(Some(path.clone()), None, 0, None, false, None, None).unwrap();
        assert!(first.reset);
        assert_eq!(first.entries.len(), 1);

        std::fs::write(&path, format!("{}{}", line("一"), line("二"))).unwrap();
        let next = read(Some(path.clone()), first.path.clone(), first.offset, None, false, None, None).unwrap();
        assert!(!next.reset);
        assert_eq!(next.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), vec!["二"]);

        let other = read(Some(path.clone()), Some("other.jsonl".into()), next.offset, Some(1), false, None, None).unwrap();
        assert!(other.reset);
        assert_eq!(other.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), vec!["二"]);
        // limit で古いものを捨てたら、前の会話があることを知らせる
        assert!(other.more && other.start == 0);
        assert!(!first.more);

        // 前の会話を読み足すときは、渡した位置の次の行の頭から読み直す
        std::fs::write(&path, format!("{}{}{}", line("一"), line("二"), line("三"))).unwrap();
        let from_mid = read(Some(path.clone()), first.path.clone(), next.offset, None, false, Some(3), None).unwrap();
        assert!(from_mid.reset && from_mid.more);
        assert_eq!(from_mid.start, line("一").len() as u64);
        assert_eq!(from_mid.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), vec!["二", "三"]);
        let all = read(Some(path.clone()), first.path.clone(), next.offset, None, false, Some(0), None).unwrap();
        assert!(!all.more);
        assert_eq!(all.entries.len(), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn todo_tools_keep_their_input() {
        let v = json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"t1","name":"TaskCreate","input":{"subject":"テストを書く","description":"…"}},
            {"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"a.ts"}}
        ]}});
        let e = entries_of(&v);
        assert_eq!(e[0].todo, Some(json!({"subject":"テストを書く","description":"…"})));
        assert_eq!(e[1].todo, None);
    }

    #[test]
    fn follows_the_current_branch_after_rewind() {
        let dir = std::env::temp_dir().join(format!("tower-branch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let user = |id: &str, parent: Option<&str>, t: &str| json!({"type":"user","uuid":id,"parentUuid":parent,"message":{"content":t}});
        let say = |id: &str, parent: &str, t: &str| json!({"type":"assistant","uuid":id,"parentUuid":parent,"message":{"content":[{"type":"text","text":t}]}});
        let call = |id: &str, parent: &str, tool: &str| json!({"type":"assistant","uuid":id,"parentUuid":parent,"message":{"content":[{"type":"tool_use","id":tool,"name":"Read","input":{"file_path":tool}}]}});
        let result = |id: &str, parent: &str, tool: &str| json!({"type":"user","uuid":id,"parentUuid":parent,"message":{"content":[{"type":"tool_result","tool_use_id":tool,"content":"ok"}]}});
        let lines = |vs: &[Value]| vs.iter().map(|v| format!("{v}\n")).collect::<String>();
        // 並列に呼んだツールの結果（r1 は c1 を親にする）も残す
        let first = [user("u1", None, "一つ目"), call("c1", "u1", "a"), call("c2", "c1", "b"), result("r1", "c1", "a"), result("r2", "c2", "b"), say("a1", "r2", "はい1"),
            user("u2", Some("a1"), "二つ目"), say("a2", "u2", "はい2")];
        std::fs::write(&path, lines(&first)).unwrap();
        let texts = |c: &Chunk| c.entries.iter().filter(|e| matches!(e.kind, Kind::User | Kind::Assistant)).map(|e| e.text.clone()).collect::<Vec<_>>();
        let a = read(Some(path.clone()), None, 0, None, false, None, None).unwrap();
        assert_eq!(texts(&a), ["一つ目", "はい1", "二つ目", "はい2"]);
        assert_eq!(a.entries.iter().filter(|e| e.kind == Kind::Result).count(), 2);
        assert_eq!(a.tip.as_deref(), Some("a2"));

        // 「二つ目」を巻き戻して、「はい1」の次に書き直した
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(lines(&[user("u3", Some("a1"), "二つ目（直した）"), say("a3", "u3", "はい3")]).as_bytes()).unwrap();
        let b = read(Some(path.clone()), a.path.clone(), a.offset, None, false, None, a.tip.clone()).unwrap();
        assert!(b.reset);
        assert_eq!(texts(&b), ["一つ目", "はい1", "二つ目（直した）", "はい3"]);

        // ふつうに続けたときは読み直さない
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(lines(&[user("u4", Some("a3"), "三つ目")]).as_bytes()).unwrap();
        let c = read(Some(path.clone()), b.path.clone(), b.offset, None, false, None, b.tip.clone()).unwrap();
        assert!(!c.reset);
        assert_eq!(texts(&c), ["三つ目"]);

        // 画像を付けて書き直したときも、捨てた枝を除く
        let image = json!({"type":"user","uuid":"u5","parentUuid":"a3","message":{"content":[{"type":"image","source":{}},{"type":"text","text":"画像つき"}]}});
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(lines(&[image, say("a5", "u5", "はい5")]).as_bytes()).unwrap();
        let d = read(Some(path.clone()), c.path.clone(), c.offset, None, false, None, c.tip.clone()).unwrap();
        assert!(d.reset);
        assert!(!texts(&d).contains(&"三つ目".to_string()), "{:?}", texts(&d));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn codex_fork_reads_the_lines_before_the_fork() {
        let root = std::env::temp_dir().join(format!("tower-codex-fork-{}", std::process::id())).join("sessions");
        let day = root.join("2026").join("11").join("05");
        std::fs::create_dir_all(&day).unwrap();
        let meta = |o: u64, id: &str, from: Option<(&str, u64)>| {
            let mut p = json!({"id": id});
            if let Some((f, before)) = from {
                p["forked_from_id"] = json!(f);
                p["forked_from_ordinal_exclusive"] = json!(before);
            }
            json!({"ordinal": o, "type": "session_meta", "payload": p})
        };
        let msg = |o: u64, role: &str, t: &str| {
            let kind = if role == "user" { "input_text" } else { "output_text" };
            json!({"ordinal": o, "type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": kind, "text": t}]}})
        };
        let lines = |vs: &[Value]| vs.iter().map(|v| format!("{v}
")).collect::<String>();
        let parent = day.join("rollout-2026-11-05T11-09-07-aaa.jsonl");
        std::fs::write(&parent, lines(&[meta(0, "aaa", None), msg(1, "user", "first"), msg(2, "assistant", "1"), msg(3, "user", "second"), msg(4, "assistant", "2")])).unwrap();
        let fork = day.join("rollout-2026-11-05T11-11-39-bbb.jsonl");
        std::fs::write(&fork, lines(&[meta(3, "bbb", Some(("aaa", 3))), msg(4, "user", "second again")])).unwrap();

        assert_eq!(codex_fork(&parent), Some(fork.clone()));
        assert_eq!(codex_fork(&fork), None);
        let c = read(Some(fork.clone()), None, 0, None, false, None, None).unwrap();
        let texts: Vec<_> = c.entries.iter().filter(|e| matches!(e.kind, Kind::User | Kind::Assistant)).map(|e| e.text.clone()).collect();
        assert_eq!(texts, ["first", "1", "second again"]);
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
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
