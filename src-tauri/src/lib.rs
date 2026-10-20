pub mod agent;
mod files;
mod git;
mod trust;
pub mod hooks;
mod job;
pub mod memory;
mod notify;
pub mod session;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager as _, State};

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
fn peek_sessions(state: State<'_, App>, lines: usize) -> Vec<session::Peek> {
    state.manager.peek(lines)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
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
            resize_session,
            kill_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tower");
}
