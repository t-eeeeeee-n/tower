//! PTY・仮想端末・hooks受信の結合テスト（Tauriのモックランタイムで実行）
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tower_lib::{agent::Agent, hooks, session::Manager};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Listener;

/// bash の起動はウイルス対策ソフトの検査などで 5 秒以上かかることがあるので、待ち時間は長めにとる
fn wait_until(timeout_ms: u64, mut f: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(timeout_ms) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn session_end_to_end() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let dir = std::env::temp_dir().join("tower-test");
    let settings = dir.join("hooks-settings.json");
    hooks::write_settings(&settings).unwrap();
    let (server, endpoint) = hooks::bind().unwrap();
    let manager = Arc::new(Manager::new(settings.clone(), Some(endpoint.clone())));
    hooks::serve(server, endpoint.clone(), handle.clone(), manager.clone());

    let events: Arc<Mutex<Vec<String>>> = Arc::default();
    {
        let events = events.clone();
        handle.listen_any("session-status", move |e| events.lock().unwrap().push(e.payload().to_string()));
    }

    let info = manager.create(&handle, "test".into(), dir.to_string_lossy().into(), Agent::Shell, false).unwrap();
    let id = info.id.clone();

    let received: Arc<Mutex<String>> = Arc::default();
    let make_ch = || {
        let received = received.clone();
        Channel::<String>::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                let s: String = serde_json::from_str(&s).unwrap();
                received.lock().unwrap().push_str(&s);
            }
            Ok(())
        })
    };
    manager.attach(&id, 100, 30, make_ch()).unwrap();

    // ConPTY は起動時にカーソル位置を問い合わせ、応答まで出力を止める。アプリでは xterm.js が答える。
    if wait_until(3000, || received.lock().unwrap().contains("\x1b[6n")) {
        manager.write(&id, "\x1b[1;1R").unwrap();
    }

    // 日本語の出力と、セッションIDの環境変数
    manager.write(&id, "echo こんにちは-$DASH_SESSION_ID\r").unwrap();
    assert!(
        wait_until(15000, || received.lock().unwrap().contains(&format!("こんにちは-{id}"))),
        "出力が届かない: {:?}",
        received.lock().unwrap()
    );

    // 一覧画面用の末尾取得にも同じ出力が含まれる
    let peek = manager.peek(5);
    assert!(
        peek.iter().any(|p| p.id == id && p.lines.iter().any(|l| l.contains(&format!("こんにちは-{id}")))),
        "peek に無い"
    );

    // 別のチャンネルで再接続すると、スナップショットに画面が復元される
    let snap = manager.attach(&id, 100, 30, make_ch()).unwrap();
    assert!(snap.contains(&format!("こんにちは-{id}")), "スナップショットに無い: {snap:?}");

    // hooks設定に書かれたコマンドをそのまま実行して、状態が変わることを確認
    let cfg: serde_json::Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    let cmd = cfg["hooks"]["Notification"][0]["hooks"][0]["command"].as_str().unwrap();
    // Claude Code と同じく、コマンド全体の標準入力にJSONを渡す
    let script = dir.join("notify.sh");
    std::fs::write(&script, cmd).unwrap();
    manager
        .write(&id, &format!("echo '{{\"message\":\"Claude needs your permission to use Bash\"}}' | bash {}\r", bash_path(&script)))
        .unwrap();
    assert!(
        wait_until(15000, || {
            let st = serde_json::to_string(&manager.get(&id).unwrap().info()).unwrap();
            st.contains("\"waiting\"") && st.contains("permission")
        }),
        "waiting にならない: {:?}\n--- 端末出力 ---\n{}",
        events.lock().unwrap(),
        received.lock().unwrap()
    );
    // トークンが無い・違う・ブラウザからのリクエストは受け付けず、状態も変わらない
    let path = format!("/hook/{id}/stop");
    let bearer = format!("Bearer {}", endpoint.token);
    assert_eq!(post(endpoint.port, &path, &[]), 403);
    assert_eq!(post(endpoint.port, &path, &[("Authorization", "Bearer wrong")]), 403);
    assert_eq!(post(endpoint.port, &path, &[("Authorization", &bearer), ("Origin", "https://example.com")]), 403);
    assert!(serde_json::to_string(&manager.get(&id).unwrap().info()).unwrap().contains("\"waiting\""));

    let stop = cfg["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
    let script = dir.join("stop.sh");
    std::fs::write(&script, stop).unwrap();
    manager.write(&id, &format!("echo '{{}}' | bash {}\r", bash_path(&script))).unwrap();
    assert!(wait_until(15000, || serde_json::to_string(&manager.get(&id).unwrap().info()).unwrap().contains("\"idle\"")));

    // 表示していないセッションでも、ConPTY の問い合わせで止まらずに動く（前回のセッションの再開で使う）
    let bg = manager.create(&handle, "bg".into(), dir.to_string_lossy().into(), Agent::Shell, false).unwrap().id;
    manager.write(&bg, "echo 裏で動作-$DASH_SESSION_ID\r").unwrap();
    assert!(
        wait_until(15000, || manager
            .peek(10)
            .iter()
            .any(|p| p.id == bg && p.lines.iter().any(|l| l.contains(&format!("裏で動作-{bg}"))))),
        "表示していないセッションが動かない"
    );
    manager.kill(&bg).unwrap();

    // 閉じる
    manager.kill(&id).unwrap();
    assert!(manager.get(&id).is_err());
    println!("events: {:#?}", events.lock().unwrap());
}

/// 受信口に直接 POST して HTTP ステータスを返す
fn post(port: u16, path: &str, headers: &[(&str, &str)]) -> u16 {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    let mut res = String::new();
    s.read_to_string(&mut res).unwrap();
    res.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0)
}

/// bash に渡すパス。バックスラッシュはエスケープとして解釈されるので / にする
fn bash_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}
