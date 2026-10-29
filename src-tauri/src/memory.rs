//! セッションごとのメモリ使用量（bash.exe 以下のプロセスツリーの合計）と、裏で動いているシェルの数を定期的に通知する。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Runtime};

use crate::session::Manager;
use crate::transcript;

#[derive(Serialize, Clone)]
struct Usage {
    id: String,
    bytes: u64,
    processes: usize,
    /// エージェントが裏で動かしていて、まだ終わっていないシェルの数（Claude Code のみ）
    background: usize,
}

pub fn start<R: Runtime>(app: AppHandle<R>, manager: Arc<Manager>) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        loop {
            std::thread::sleep(Duration::from_millis(2500));
            let sessions = manager.all();
            if sessions.is_empty() {
                continue;
            }
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            for (pid, p) in sys.processes() {
                if let Some(parent) = p.parent() {
                    children.entry(parent).or_default().push(*pid);
                }
            }
            let usage: Vec<Usage> = sessions
                .iter()
                .map(|s| {
                    let (mut bytes, mut count) = (0u64, 0usize);
                    if let Some(root) = s.root_pid {
                        let mut stack = vec![Pid::from_u32(root)];
                        while let Some(pid) = stack.pop() {
                            if let Some(p) = sys.process(pid) {
                                bytes += p.memory();
                                count += 1;
                            }
                            if let Some(c) = children.get(&pid) {
                                stack.extend(c.iter().copied());
                            }
                        }
                    }
                    let background = manager
                        .transcript(&s.id)
                        .ok()
                        .flatten()
                        .map_or(0, |main| transcript::shells(&main).iter().filter(|x| x.status == "running").count());
                    Usage { id: s.id.clone(), bytes, processes: count, background }
                })
                .collect();
            let _ = app.emit("session-usage", usage);
        }
    });
}
