//! タスクトレイへの常駐。ウィンドウを閉じてもセッションを動かし続け、終了はトレイのメニューから行う。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

const TRAY_ID: &str = "main";

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>, has_live: impl Fn() -> bool + Send + Sync + 'static) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Tower を開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Tower")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => quit_app(app, has_live()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn quit_app<R: Runtime>(app: &AppHandle<R>, has_live: bool) {
    if !has_live {
        app.exit(0);
        return;
    }
    show_main(app);
    let handle = app.clone();
    app.dialog()
        .message("動いているセッションをすべて終了して、Tower を閉じます。")
        .title("Tower を終了")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("終了する".into(), "キャンセル".into()))
        .show(move |ok| {
            if ok {
                handle.exit(0);
            }
        });
}

pub fn set_waiting<R: Runtime>(app: &AppHandle<R>, count: usize) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tip = if count > 0 { format!("Tower（入力待ち {count} 件）") } else { "Tower".into() };
        let _ = tray.set_tooltip(Some(tip));
    }
}

/// ウィンドウを閉じても終了しないことを、初めて隠したときに一度だけ知らせる
pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join("tray-notice-shown");
    if marker.exists() {
        return;
    }
    let _ = std::fs::write(&marker, "");
    let _ = app
        .notification()
        .builder()
        .title("Tower はタスクトレイで動いています")
        .body("セッションは閉じずに動かし続けます。終了するときは、トレイのアイコンを右クリックして「終了」を選んでください。")
        .show();
}
