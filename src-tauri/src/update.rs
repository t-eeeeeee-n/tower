//! 新しい版をインストールしたあとの再起動。
//! インストーラは動いている tower.exe を tower.old<番号>.exe に移して新しいものを置く（windows/installer-hooks.nsh）。
//! トレイに常駐していると古い版が動き続け、もう一度起動しても単一起動の仕組みで古い版が前に出るだけなので、ここで再起動を勧める。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const AFTER_EXIT: &str = "--after-exit";

fn stamp(path: &Path) -> Option<(u64, SystemTime)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// 起動したときの実行ファイル。同じ場所のファイルが入れ替わっていたら、新しい版が入ったとみなす
pub struct Launched {
    path: PathBuf,
    stamp: Option<(u64, SystemTime)>,
}

impl Launched {
    pub fn now() -> Self {
        let path = std::env::current_exe().unwrap_or_default();
        let stamp = stamp(&path);
        Launched { path, stamp }
    }

    fn replaced(&self) -> bool {
        self.stamp.is_some() && stamp(&self.path) != self.stamp
    }
}

/// 2 回目の起動を受けたとき。新しい版が入っていれば、再起動するか聞く
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, launched: &Launched) {
    crate::tray::show_main(app);
    if !launched.replaced() {
        return;
    }
    let handle = app.clone();
    let path = launched.path.clone();
    app.dialog()
        .message("新しいバージョンの Tower がインストールされています。\n動いているセッションをすべて終了して、新しいバージョンで起動し直しますか？\n（セッションは「前回の N 件を再開」で開き直せます）")
        .title("Tower を更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("再起動".into(), "あとで".into()))
        .show(move |ok| {
            if ok {
                restart(&handle, &path);
            }
        });
}

fn restart<R: Runtime>(app: &AppHandle<R>, path: &Path) {
    // 新しい版は、この版が終わるのを待ってから立ち上がる（wait_previous）
    match std::process::Command::new(path).arg(AFTER_EXIT).arg(std::process::id().to_string()).spawn() {
        Ok(_) => app.exit(0),
        Err(e) => {
            app.dialog()
                .message(format!("新しいバージョンを起動できませんでした: {e}"))
                .title("Tower を更新")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    }
}

/// 再起動で立ち上げられたときは、古い版が終わるまで待つ。
/// 待たないと、単一起動の仕組みで古い版に引き継がれて、こちらが終わってしまう
pub fn wait_previous() {
    let mut args = std::env::args().skip_while(|a| a != AFTER_EXIT).skip(1);
    let Some(pid) = args.next().and_then(|p| p.parse::<u32>().ok()) else { return };
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !process.is_null() {
            WaitForSingleObject(process, 15_000);
            CloseHandle(process);
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// インストーラが脇に移した古い実行ファイルを消す。インストーラも次の回に消すが、
/// 古い版がトレイで動いている間は消せずに残るので、新しい版の起動時にも消す
pub fn remove_old_binaries() {
    let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        if is_old_binary(&entry.file_name().to_string_lossy()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// installer-hooks.nsh が付ける名前（tower.old<番号>.exe と uninstall.old<番号>.exe）だけを古いものとみなす
fn is_old_binary(name: &str) -> bool {
    ["tower.old", "uninstall.old"].iter().any(|p| {
        name.strip_prefix(p)
            .and_then(|rest| rest.strip_suffix(".exe"))
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
    })
}

#[cfg(test)]
mod tests {
    use super::is_old_binary;

    #[test]
    fn matches_only_moved_aside_binaries() {
        assert!(is_old_binary("tower.old0.exe"));
        assert!(is_old_binary("uninstall.old12.exe"));
        assert!(!is_old_binary("tower.exe"));
        assert!(!is_old_binary("tower.old.exe"));
        assert!(!is_old_binary("tower.oldx.exe"));
        assert!(!is_old_binary("tower.old0.exe.bak"));
    }
}
