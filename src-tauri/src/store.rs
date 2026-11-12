//! 画面の設定と一覧（見た目・通知・テンプレート・最近のプロジェクト・印など）を `~/.tower/settings.json` に残す。
//! WebView の localStorage は、WebView のデータを消したり入れ直したりすると消え、中身を見たり持ち運んだりもできないため。
//! 開発版（identifier が .dev で終わる）は `settings.dev.json` を使い、試した設定が普段の設定に混ざらないようにする。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};

static FILE: OnceLock<PathBuf> = OnceLock::new();
// 書き込みは「読んで 1 項目だけ変えて書く」なので、同時に来ても項目が消えないよう 1 つずつにする
static WRITE: Mutex<()> = Mutex::new(());

pub fn init(dev: bool) {
    if let Some(dir) = crate::hooks::home_dir("TOWER_HOME", ".tower") {
        let _ = FILE.set(dir.join(if dev { "settings.dev.json" } else { "settings.json" }));
    }
}

/// まだファイルが無ければ None（画面は localStorage の中身を移す）
pub fn load() -> Result<Option<Map<String, Value>>, String> {
    let file = FILE.get().ok_or("設定の置き場所が分かりません")?;
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice::<Map<String, Value>>(strip_bom(&bytes))
            .map(Some)
            .map_err(|e| format!("{} を読めませんでした: {e}", file.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} を読めませんでした: {e}", file.display())),
    }
}

/// value が None ならその項目を消す。いくつかまとめて変えられる
pub fn set(entries: Map<String, Value>) -> Result<(), String> {
    let file = FILE.get().ok_or("設定の置き場所が分かりません")?;
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load()?.unwrap_or_default();
    for (k, v) in entries {
        if v.is_null() {
            all.remove(&k);
        } else {
            all.insert(k, v);
        }
    }
    let text = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // 書いている途中で落ちても前の設定が壊れないよう、別のファイルに書いてから置き換える
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_one_entry_at_a_time_and_removes_null() {
        let dir = std::env::temp_dir().join(format!("tower-store-{}", std::process::id()));
        let _ = FILE.set(dir.join("settings.json"));
        assert_eq!(load().unwrap(), None);
        let map = |v: Value| v.as_object().unwrap().clone();
        set(map(json!({"appearance": {"theme": "tower"}, "logOpen": 1}))).unwrap();
        set(map(json!({"lastAgent": "claude", "logOpen": null}))).unwrap();
        let got = load().unwrap().unwrap();
        assert_eq!(Value::Object(got), json!({"appearance": {"theme": "tower"}, "lastAgent": "claude"}));
        std::fs::remove_dir_all(&dir).ok();
    }
}
