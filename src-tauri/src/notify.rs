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
    pub fn show<R: Runtime>(&self, app: &AppHandle<R>, session: &str, title: &str, body: &str, sound: &str) -> Result<(), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.targets.lock().unwrap().insert(id, session.to_string());
        *self.last.lock().unwrap() = Some(session.to_string());
        toast(app, id, title, body, sound)
    }
}

/// 設定画面で選んだ音を聞かせる。クリックしても何も開かない（id 0 は通知元のセッションが無い）
pub fn test<R: Runtime>(app: &AppHandle<R>, sound: &str) -> Result<(), String> {
    toast(app, 0, "Tower", "通知の音のテスト", sound)
}

fn toast<R: Runtime>(app: &AppHandle<R>, id: i32, title: &str, body: &str, sound: &str) -> Result<(), String> {
    let mut b = app.notification().builder().id(id).title(title).body(body);
    // 音を指定しないと、Windows では notify-rust が音なし（<audio silent="true"/>）のトーストにする。
    // 知らない名前も音なしになる（tauri-winrt-notification の Sound に変換できないため）
    if !sound.is_empty() {
        b = b.sound(sound);
    }
    b.show().map_err(|e| e.to_string())
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
