#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

struct LocalHost {
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    sequence: AtomicU64,
}
impl LocalHost {
    fn start(app: &tauri::App) -> Result<Self, Box<dyn std::error::Error>> {
        let resources = app.path().resource_dir()?;
        let node = std::env::var_os("TURNSU_DESKTOP_NODE").map(std::path::PathBuf::from).unwrap_or_else(|| resources.join("node"));
        let entry = std::env::var_os("TURNSU_DESKTOP_HOST").map(std::path::PathBuf::from).unwrap_or_else(|| resources.join("local-agent-host/entry.mjs"));
        let data = std::env::var_os("TURNSU_DESKTOP_STATE").map(std::path::PathBuf::from).unwrap_or(app.path().app_data_dir()?);
        let mut child = Command::new(node).arg(entry).arg(data).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let input = child.stdin.take().ok_or("host stdin unavailable")?;
        let output = child.stdout.take().ok_or("host stdout unavailable")?;
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> = Arc::new(Mutex::new(HashMap::new()));
        let readers = pending.clone(); let handle = app.handle().clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(event) = message.get("event") { let _ = handle.emit("local-host-event", event); }
                else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(reply) = readers.lock().unwrap().remove(&id) {
                        let result = match message.get("error").and_then(Value::as_str) { Some(e) => Err(e.to_string()), None => Ok(message["result"].clone()) };
                        let _ = reply.send(result);
                    }
                }
            }
            for (_, reply) in readers.lock().unwrap().drain() { let _ = reply.send(Err("本地服务已停止。请重新打开 Turnsu；已保存的任务仍在本机。".into())); }
            let _ = handle.emit("local-host-event", json!({"type":"disconnected"}));
        });
        Ok(Self { input: Mutex::new(input), child: Mutex::new(child), pending, sequence: AtomicU64::new(0) })
    }
    async fn request(&self, method: String, args: Value) -> Result<Value, String> {
        if method == "shutdown" { return Err("不支持此操作。".into()); }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (send, receive) = oneshot::channel(); self.pending.lock().unwrap().insert(id, send);
        let wire = json!({"id":id,"method":method,"args":args}).to_string() + "\n";
        if self.input.lock().unwrap().write_all(wire.as_bytes()).is_err() {
            self.pending.lock().unwrap().remove(&id); return Err("本地服务连接已断开。".into());
        }
        match tokio::time::timeout(Duration::from_secs(100), receive).await {
            Ok(Ok(value)) => value,
            _ => { self.pending.lock().unwrap().remove(&id); Err("操作尚未确认，请重新打开会话核对结果。".into()) }
        }
    }
    fn shutdown(&self) {
        let _ = self.input.lock().unwrap().write_all(b"{\"method\":\"shutdown\"}\n");
        let mut child = self.child.lock().unwrap();
        for _ in 0..20 { if matches!(child.try_wait(), Ok(Some(_))) { return; } std::thread::sleep(Duration::from_millis(50)); }
        let _ = child.kill(); let _ = child.wait();
    }
}
#[tauri::command]
async fn local_command(window: tauri::WebviewWindow, host: tauri::State<'_, LocalHost>, method: String, args: Value) -> Result<Value, String> {
    if window.label() != "main" || method == "project.open" { return Err("请通过打开项目选择文件夹。".into()); }
    host.request(method, args).await
}
#[tauri::command]
async fn open_project(app: tauri::AppHandle, window: tauri::WebviewWindow, host: tauri::State<'_, LocalHost>) -> Result<Value, String> {
    if window.label() != "main" { return Err("不允许此窗口选择项目。".into()); }
    let folder = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title("打开本地项目").blocking_pick_folder()).await.map_err(|_| "无法打开文件选择器。")?;
    match folder { Some(path) => host.request("project.open".into(), json!({"path":path.to_string()})).await, None => Ok(Value::Null) }
}
#[tauri::command]
async fn open_cloud_authorization(window: tauri::WebviewWindow, host: tauri::State<'_, LocalHost>) -> Result<(), String> {
    if window.label() != "main" { return Err("不允许此窗口登录。".into()); }
    // The URL comes from the host's active PKCE exchange, never from renderer input.
    let result = host.request("cloud.authorization".into(), json!({})).await?;
    let url = result["url"].as_str().ok_or("授权已结束，请重新连接。")?;
    let status = Command::new("/usr/bin/open").arg(url).status().map_err(|_| "无法打开默认浏览器。")?;
    if !status.success() { return Err("无法打开默认浏览器。".into()); }
    Ok(())
}
fn main() {
    let app = tauri::Builder::default().plugin(tauri_plugin_dialog::init())
        .setup(|app| { app.manage(LocalHost::start(app)?); Ok(()) })
        .invoke_handler(tauri::generate_handler![local_command, open_project, open_cloud_authorization])
        .build(tauri::generate_context!()).expect("Unable to start Turnsu Desktop");
    app.run(|handle, event| { if matches!(event, tauri::RunEvent::Exit) { handle.state::<LocalHost>().shutdown(); } });
}
