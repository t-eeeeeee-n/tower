//! Windows のトースト通知。クリックされたら通知元のセッションを前面に出す。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
pub struct Notifier {
    next_id: AtomicI32,
    targets: Mutex<HashMap<i32, String>>,
    last: Mutex<Option<String>>,
}

impl Notifier {
    pub fn show<R: Runtime>(&self, app: &AppHandle<R>, session: &str, title: &str, body: &str) -> Result<(), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.targets.lock().unwrap().insert(id, session.to_string());
        *self.last.lock().unwrap() = Some(session.to_string());
        app.notification().builder().id(id).title(title).body(body).show().map_err(|e| e.to_string())
    }
}

/// 通知のクリックを `notification-open`（セッションID）としてフロントへ送る。
/// Windows ではトーストが画面に出ている間のクリックしか届かない（アクションセンターからは届かない）。
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        let notifier = handle.state::<Notifier>();
        // クリックされた通知の中身はプラットフォームによっては報告されないので、そのときは最後の通知を使う
        let session = action
            .notification()
            .and_then(|n| notifier.targets.lock().unwrap().get(&n.id()).cloned())
            .or_else(|| notifier.last.lock().unwrap().clone());
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        if let Some(session) = session {
            let _ = handle.emit("notification-open", session);
        }
    });
}
