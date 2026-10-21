pub mod agent;
mod files;
mod git;
mod trust;
pub mod hooks;
mod job;
pub mod memory;
mod notify;
pub mod session;
mod theme;
mod tray;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _, State, WindowEvent};

use agent::Agent;
use session::{Manager, SessionInfo};

struct App {
    manager: Arc<Manager>,
    hooks_error: Mutex<Option<String>>,
    trust: trust::Trust,
}

#[derive(Serialize)]
struct Config {
    shell: String,
    hook_port: Option<u16>,
    hooks_error: Option<String>,
    hooks_settings: String,
}

#[tauri::command]
fn get_config(state: State<'_, App>) -> Config {
    Config {
        shell: state.manager.shell.program.clone(),
        hook_port: state.manager.hook.as_ref().map(|h| h.port),
        hooks_error: state.hooks_error.lock().unwrap().clone(),
        hooks_settings: state.manager.hooks_settings.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
fn mintty_config(state: State<'_, App>) -> theme::Mintty {
    theme::load(&state.manager.shell.program)
}

#[tauri::command]
fn list_sessions(state: State<'_, App>) -> Vec<SessionInfo> {
    state.manager.all().iter().map(|s| s.info()).collect()
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<'_, App>,
    name: String,
    cwd: String,
    agent: Agent,
    resume: bool,
) -> Result<SessionInfo, String> {
    state.manager.create(&app, name, cwd, agent, resume)
}

fn session_root(state: &App, id: &str) -> Result<std::path::PathBuf, String> {
    Ok(std::path::PathBuf::from(&state.manager.get(id)?.cwd))
}

#[tauri::command]
fn list_dir(state: State<'_, App>, id: String, path: String) -> Result<Vec<files::Entry>, String> {
    files::list_dir(&session_root(&state, &id)?, &path)
}

#[tauri::command]
fn read_file(state: State<'_, App>, id: String, path: String) -> Result<files::FileContent, String> {
    files::read_file(&session_root(&state, &id)?, &path)
}

#[tauri::command]
fn git_changes(state: State<'_, App>, id: String) -> Result<files::Changes, String> {
    let root = session_root(&state, &id)?;
    if !files::in_repo(&root) {
        return Ok(files::Changes::no_repo());
    }
    if !state.trust.contains(&root) {
        return Ok(files::Changes::untrusted());
    }
    Ok(files::changes(&git::git_program(&state.manager.shell.program), &root))
}

#[tauri::command]
fn git_diff(state: State<'_, App>, id: String, path: String) -> Result<String, String> {
    let root = session_root(&state, &id)?;
    if !state.trust.contains(&root) {
        return Err("このフォルダは信頼していないので、Git の差分は表示しません".into());
    }
    files::diff(&git::git_program(&state.manager.shell.program), &root, &path)
}

#[tauri::command]
fn trust_folder(state: State<'_, App>, id: String) -> Result<(), String> {
    state.trust.add(&session_root(&state, &id)?)
}

#[tauri::command]
fn installed_agents() -> Vec<Agent> {
    agent::installed()
}

#[tauri::command]
fn create_worktree(state: State<'_, App>, cwd: String, branch: String) -> Result<String, String> {
    let dir = git::create_worktree(&git::git_program(&state.manager.shell.program), &cwd, &branch)?;
    // 信頼したフォルダから作った worktree は、同じリポジトリなので信頼済みにする
    if state.trust.contains(std::path::Path::new(&cwd)) {
        state.trust.add(std::path::Path::new(&dir))?;
    }
    Ok(dir)
}

#[tauri::command]
fn notify(app: AppHandle, notifier: State<'_, notify::Notifier>, id: String, title: String, body: String) -> Result<(), String> {
    notifier.show(&app, &id, &title, &body)
}

#[tauri::command]
fn attach_session(
    state: State<'_, App>,
    id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<String>,
) -> Result<String, String> {
    state.manager.attach(&id, cols, rows, on_output)
}

#[tauri::command]
fn peek_sessions(state: State<'_, App>, lines: usize, known: std::collections::HashMap<String, u64>) -> Vec<session::Peek> {
    state.manager.peek(lines, &known)
}

#[tauri::command]
fn rename_session(state: State<'_, App>, id: String, name: String) -> Result<(), String> {
    state.manager.rename(&id, &name)
}

#[tauri::command]
fn set_scrollback(state: State<'_, App>, lines: usize) {
    state.manager.set_scrollback(lines);
}

#[tauri::command]
fn write_session(state: State<'_, App>, id: String, data: String) -> Result<(), String> {
    state.manager.write(&id, &data)
}

#[tauri::command]
fn resize_session(state: State<'_, App>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.manager.resize(&id, cols, rows)
}

#[tauri::command]
fn kill_session(state: State<'_, App>, id: String) -> Result<(), String> {
    state.manager.kill(&id)
}

/// xterm.js は画像を貼り付けられないので、クリップボードの画像を一時フォルダに保存し、その場所をエージェントに渡す
#[tauri::command]
fn save_pasted_image(bytes: Vec<u8>, mime: String) -> Result<String, String> {
    // Claude Code などが読める形式だけ受け付ける
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return Err(format!("この形式の画像は貼り付けられません（{mime}）")),
    };
    let dir = std::env::temp_dir().join("tower-images");
    std::fs::create_dir_all(&dir).map_err(|e| format!("画像を保存できませんでした: {e}"))?;
    let path = dir.join(format!("paste-{}.{ext}", session::now_ms()));
    std::fs::write(&path, bytes).map_err(|e| format!("画像を保存できませんでした: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_tray_waiting(app: AppHandle, count: usize) {
    tray::set_waiting(&app, count);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 2 つ目の Tower を起動すると、セッションも hooks の受信口も別々になってしまうので、トレイにいる方を前に出す
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let settings_path = dir.join("hooks-settings.json");
            let mut hooks_error = None;
            if let Err(e) = hooks::write_settings(&settings_path) {
                hooks_error = Some(format!("hooks設定を書き込めませんでした: {e}"));
            }
            let agent_errors = hooks::write_agent_hooks();
            if !agent_errors.is_empty() {
                hooks_error = Some(agent_errors.join("\n"));
            }
            let bound = hooks::bind().map_err(|e| hooks_error = Some(e)).ok();
            let manager = Arc::new(Manager::new(settings_path, bound.as_ref().map(|(_, ep)| ep.clone())));
            if let Some((server, endpoint)) = bound {
                hooks::serve(server, endpoint, app.handle().clone(), manager.clone());
            }
            memory::start(app.handle().clone(), manager.clone());
            let trust = trust::Trust::load(dir.join("trusted-folders.json"));
            app.manage(App { manager, hooks_error: Mutex::new(hooks_error), trust });
            app.manage(notify::Notifier::default());
            notify::init(app.handle());
            let state = app.state::<App>();
            let manager = state.manager.clone();
            tray::init(app.handle(), move || manager.has_live())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 動いているセッションがあるときは終了せずトレイに隠れる。無ければそのまま終了する
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<App>().manager.has_live() {
                    api.prevent_close();
                    tray::hide_main(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_waiting,
            save_pasted_image,
            get_config,
            mintty_config,
            list_sessions,
            create_session,
            create_worktree,
            installed_agents,
            list_dir,
            read_file,
            git_changes,
            git_diff,
            trust_folder,
            notify,
            attach_session,
            peek_sessions,
            write_session,
            set_scrollback,
            rename_session,
            resize_session,
            kill_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tower");
}
