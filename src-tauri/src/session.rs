use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Runtime};

use crate::hooks::Endpoint;
use crate::job::Job;

#[derive(Clone, Copy, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// bashだけが動いている（Claude Code未起動、または終了後）
    Shell,
    /// Claude Code起動中
    Starting,
    /// 応答完了・次の指示待ち
    Idle,
    /// 作業中
    Running,
    /// 承認や入力を待っている
    Waiting,
    /// プロセス終了
    Exited,
}

#[derive(Clone, Serialize)]
pub struct StatusInfo {
    pub status: Status,
    pub since: u64,
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created: u64,
    /// Claude Code を起動したセッションか（前回のセッションを再開するときに使う）
    pub claude: bool,
    #[serde(flatten)]
    pub state: StatusInfo,
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    id: String,
    #[serde(flatten)]
    state: StatusInfo,
}

#[derive(Serialize)]
pub struct Peek {
    pub id: String,
    pub lines: Vec<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 仮想端末の状態と、表示中なら出力の送り先
struct Term {
    parser: vt100::Parser,
    sink: Option<Channel<String>>,
    /// UTF-8の途中で切れたバイト（日本語が読み込みの境界で割れることがある）
    carry: Vec<u8>,
}

impl Term {
    fn decode(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut rest: &[u8] = &buf;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&rest[..valid]) });
                    match e.error_len() {
                        // 末尾が文字の途中 → 次の読み込みと結合する
                        None => {
                            self.carry = rest[valid..].to_vec();
                            break;
                        }
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + len..];
                        }
                    }
                }
            }
        }
        out
    }
}

pub struct Session {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created: u64,
    pub claude: bool,
    pub root_pid: Option<u32>,
    state: Arc<Mutex<StatusInfo>>,
    term: Arc<Mutex<Term>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    _job: Option<Job>,
}

impl Session {
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            created: self.created,
            claude: self.claude,
            state: self.state.lock().unwrap().clone(),
        }
    }
}

pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
}

/// Git Bash の bash.exe を探す（git-bash.exe はminttyが起動するので使わない）
pub fn find_shell() -> ShellSpec {
    if cfg!(windows) {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for var in ["CC_DECK_BASH", "CLAUDE_CODE_GIT_BASH_PATH"] {
            if let Ok(p) = std::env::var(var) {
                candidates.push(PathBuf::from(p));
            }
        }
        for var in ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                let base = PathBuf::from(base);
                candidates.push(base.join("Git").join("bin").join("bash.exe"));
                candidates.push(base.join("Programs").join("Git").join("bin").join("bash.exe"));
            }
        }
        for c in candidates {
            if c.is_file() {
                return ShellSpec {
                    program: c.to_string_lossy().into_owned(),
                    args: vec!["--login".into(), "-i".into()],
                };
            }
        }
        // 見つからなければPATH上のbashに賭ける
        ShellSpec { program: "bash.exe".into(), args: vec!["--login".into(), "-i".into()] }
    } else {
        ShellSpec { program: "bash".into(), args: vec!["-i".into()] }
    }
}

pub struct Manager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    active: Mutex<Option<String>>,
    next_id: AtomicU64,
    pub hooks_settings: PathBuf,
    /// hooks の受信口。開けなかったときは None（状態表示が無効になるだけで、セッションは動く）
    pub hook: Option<Endpoint>,
    pub shell: ShellSpec,
}

impl Manager {
    pub fn new(hooks_settings: PathBuf, hook: Option<Endpoint>) -> Self {
        Manager {
            sessions: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            next_id: AtomicU64::new(1),
            hooks_settings,
            hook,
            shell: find_shell(),
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("セッション {id} が見つかりません"))
    }

    pub fn all(&self) -> Vec<Arc<Session>> {
        let mut v: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        v.sort_by_key(|s| s.created);
        v
    }

    pub fn create<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        name: String,
        cwd: String,
        run_claude: bool,
        resume: bool,
    ) -> Result<SessionInfo, String> {
        if !Path::new(&cwd).is_dir() {
            return Err(format!("フォルダが見つかりません: {cwd}"));
        }
        let id = format!("s{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (rows, cols) = (30u16, 120u16);

        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTYを開けませんでした: {e}"))?;

        let mut cmd = CommandBuilder::new(&self.shell.program);
        cmd.args(&self.shell.args);
        cmd.cwd(&cwd);
        cmd.env("DASH_SESSION_ID", &id);
        if let Some(hook) = &self.hook {
            cmd.env("DASH_HOOK_PORT", hook.port.to_string());
            cmd.env("DASH_HOOK_TOKEN", &hook.token);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Git Bash の --login がホームに cd しないようにする
        cmd.env("CHERE_INVOKING", "1");
        // CC Deck 自体が Claude Code の中から起動されると、親セッションの目印が引き継がれ、
        // 中の Claude Code が子セッション扱いになって会話を保存しない（--continue で再開できない）
        for var in [
            "CLAUDECODE",
            "CLAUDE_PID",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_SESSION_ATTENDED",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
        ] {
            cmd.env_remove(var);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("{} を起動できませんでした: {e}", self.shell.program))?;
        drop(pair.slave);

        let root_pid = child.process_id();
        let job = match root_pid.map(Job::for_process) {
            Some(Ok(j)) => Some(j),
            Some(Err(e)) => {
                eprintln!("[cc-deck] Job Object を作れませんでした: {e}");
                None
            }
            None => None,
        };

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
        let killer = child.clone_killer();

        let initial = if run_claude { Status::Starting } else { Status::Shell };
        let state = Arc::new(Mutex::new(StatusInfo { status: initial, since: now_ms(), message: None }));
        let term = Arc::new(Mutex::new(Term {
            parser: vt100::Parser::new(rows, cols, 0),
            sink: None,
            carry: Vec::new(),
        }));

        // 出力の読み取り：常に仮想端末へ流し、表示中のときだけフロントへ送る
        {
            let term = term.clone();
            let writer = writer.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let mut t = term.lock().unwrap();
                    t.parser.process(&buf[..n]);
                    let text = t.decode(&buf[..n]);
                    // ConPTY は起動時などにカーソル位置を問い合わせ、応答まで出力を止める。
                    // 表示中なら xterm.js が答えるので、誰も表示していないときだけ代わりに答える。
                    if t.sink.is_none() && contains(&buf[..n], b"\x1b[6n") {
                        let (row, col) = t.parser.screen().cursor_position();
                        let reply = format!("\x1b[{};{}R", row + 1, col + 1);
                        let mut w = writer.lock().unwrap();
                        let _ = w.write_all(reply.as_bytes());
                        let _ = w.flush();
                    }
                    if !text.is_empty() {
                        if let Some(sink) = &t.sink {
                            if sink.send(text).is_err() {
                                t.sink = None;
                            }
                        }
                    }
                }
            });
        }

        // 終了検知：ConPTYでは読み取りがEOFにならないことがあるため、プロセスの終了を待つ
        {
            let state = state.clone();
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                let _ = child.wait();
                let info = {
                    let mut s = state.lock().unwrap();
                    *s = StatusInfo { status: Status::Exited, since: now_ms(), message: None };
                    s.clone()
                };
                let _ = app.emit("session-status", StatusEvent { id, state: info });
            });
        }

        if run_claude {
            let settings = self.hooks_settings.to_string_lossy().replace('\\', "/");
            let start = format!("claude --settings '{settings}'");
            // 再開する会話が無いと --continue は終了コード 1 で終わるので、そのときは新しく始める
            let line = if resume {
                format!("claude --continue --settings '{settings}' || {start}\r")
            } else {
                format!("{start}\r")
            };
            let mut w = writer.lock().unwrap();
            let _ = w.write_all(line.as_bytes());
            let _ = w.flush();
        }

        let session = Arc::new(Session {
            id: id.clone(),
            name,
            cwd,
            created: now_ms(),
            claude: run_claude,
            root_pid,
            state,
            term,
            writer,
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            _job: job,
        });
        let info = session.info();
        self.sessions.lock().unwrap().insert(id, session);
        Ok(info)
    }

    /// 表示するセッションを切り替え、現在の画面を返す。以降の出力は channel に流れる。
    pub fn attach(&self, id: &str, cols: u16, rows: u16, channel: Channel<String>) -> Result<String, String> {
        let session = self.get(id)?;
        {
            let mut active = self.active.lock().unwrap();
            if let Some(prev) = active.take() {
                if let Ok(prev) = self.get(&prev) {
                    prev.term.lock().unwrap().sink = None;
                }
            }
            *active = Some(id.to_string());
        }
        // 同じロックの中でサイズ合わせ・画面取得・送り先設定を行うので、出力の取りこぼしや重複が起きない
        let mut t = session.term.lock().unwrap();
        resize_locked(&session, &mut t, cols, rows);
        let snapshot = t.parser.screen().state_formatted();
        t.sink = Some(channel);
        Ok(String::from_utf8_lossy(&snapshot).into_owned())
    }

    /// 全セッションの画面末尾（空行を除いた最後の max_lines 行）を返す
    pub fn peek(&self, max_lines: usize) -> Vec<Peek> {
        self.all()
            .iter()
            .map(|s| {
                let t = s.term.lock().unwrap();
                let screen = t.parser.screen();
                let (_, cols) = screen.size();
                let mut rows: Vec<String> = screen.rows(0, cols).map(|r| r.trim_end().to_string()).collect();
                while rows.last().is_some_and(|r| r.is_empty()) {
                    rows.pop();
                }
                let start = rows.len().saturating_sub(max_lines);
                Peek { id: s.id.clone(), lines: rows.split_off(start) }
            })
            .collect()
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let session = self.get(id)?;
        let mut w = session.writer.lock().unwrap();
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get(id)?;
        let mut t = session.term.lock().unwrap();
        resize_locked(&session, &mut t, cols, rows);
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let session = self.sessions.lock().unwrap().remove(id);
        if let Some(s) = session {
            let _ = s.killer.lock().unwrap().kill();
            s.term.lock().unwrap().sink = None;
            let mut active = self.active.lock().unwrap();
            if active.as_deref() == Some(id) {
                *active = None;
            }
            // s が破棄されると Job のハンドルが閉じられ、子孫プロセスもまとめて終了する
        }
        Ok(())
    }

    /// hooks から届いたイベントで状態を更新する
    pub fn apply_hook<R: Runtime>(&self, app: &AppHandle<R>, id: &str, event: &str, message: Option<String>) {
        let Ok(session) = self.get(id) else { return };
        let next = match event {
            "session_start" | "stop" => Status::Idle,
            "user_prompt_submit" | "pre_tool_use" => Status::Running,
            "notification" => Status::Waiting,
            "session_end" => Status::Shell,
            _ => return,
        };
        let info = {
            let mut s = session.state.lock().unwrap();
            if s.status == Status::Exited {
                return;
            }
            let message = if next == Status::Waiting { message } else { None };
            if s.status == next && s.message == message {
                return;
            }
            *s = StatusInfo { status: next, since: now_ms(), message };
            s.clone()
        };
        let _ = app.emit("session-status", StatusEvent { id: id.to_string(), state: info });
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn resize_locked(session: &Session, t: &mut Term, cols: u16, rows: u16) {
    let (cols, rows) = (cols.max(10), rows.max(4));
    let (cur_rows, cur_cols) = t.parser.screen().size();
    if cur_rows == rows && cur_cols == cols {
        return;
    }
    t.parser.screen_mut().set_size(rows, cols);
    let _ = session
        .master
        .lock()
        .unwrap()
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
}

#[cfg(test)]
mod tests {
    use super::Term;

    #[test]
    fn utf8_split_across_reads() {
        let mut t = Term { parser: vt100::Parser::new(24, 80, 0), sink: None, carry: Vec::new() };
        let bytes = "日本語テキスト".as_bytes();
        let mut out = String::new();
        // 1バイトずつ届いても文字化けしない
        for b in bytes {
            out.push_str(&t.decode(std::slice::from_ref(b)));
        }
        assert_eq!(out, "日本語テキスト");
        assert!(t.carry.is_empty());
    }
}
