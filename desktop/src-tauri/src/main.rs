#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::UpdaterExt;

const APP_DIR_NAME: &str = "Airouter";
const RUNTIME_DIR_NAME: &str = "airouter";
const CONFIG_FILE: &str = "openai.json";
const CONFIG_TEMPLATE_FILE: &str = "openai.json.example";
const DEPENDENCY_MARKER_FILE: &str = ".airouter-dependencies.sha256";
const PID_FILE: &str = "openai.pid";
const LOG_FILE: &str = "openai.log";
const DEFAULT_PORT: u16 = 3009;
const CHATGPT_LOGIN_URL: &str = "https://chatgpt.com/";
const AUTH_SESSION_REQUEST_FILE: &str = "airouter.auth-session.request.json";
const AUTH_SESSION_WINDOW_LABEL_PREFIX: &str = "auth-session-";
const PORT_KILL_WAIT_TIMEOUT_MS: u64 = 2_500;
const PORT_FORCE_KILL_WAIT_TIMEOUT_MS: u64 = 800;
const PORT_KILL_POLL_INTERVAL_MS: u64 = 100;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    running: bool,
    pid: Option<u32>,
    port: Option<u16>,
    has_config: bool,
    config_valid: bool,
    admin_url: Option<String>,
    runtime_dir: String,
    message: String,
    logs: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckResponse {
    available: bool,
    current_version: String,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    state: String,
    downloaded: u64,
    content_length: Option<u64>,
    percent: Option<u8>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ConfigShape {
    port: Option<Value>,
    auth_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitialConfigRequest {
    service_port: Option<Value>,
    proxy_enabled: bool,
    proxy_port: Option<Value>,
    apikey_enabled: bool,
    apikey: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthSessionRequest {
    action: String,
    job_id: Option<String>,
    login_url: Option<String>,
    callback_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAuthSessionCallback {
    callback_url: String,
    payload: String,
}

fn app_data_root() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|dir| dir.join(APP_DIR_NAME).join(RUNTIME_DIR_NAME))
        .ok_or_else(|| "无法定位系统应用数据目录".to_string())
}

fn resource_airouter_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resolver = app.path();
    let resource_dir = resolver
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录: {error}"))?;

    let candidates = [
        resource_dir.join("resources").join("airouter"),
        resource_dir.join("airouter"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("airouter"),
    ];

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "找不到 airouter bundled resources".to_string())
}

fn node_target_name() -> Result<&'static str, String> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("node-aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Ok("node-x86_64-apple-darwin")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok("node-x86_64-pc-windows-msvc.exe")
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Ok("node-aarch64-pc-windows-msvc.exe")
    } else {
        Err("当前系统架构暂未内置 Node.js".to_string())
    }
}

fn node_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resolver = app.path();
    let resource_dir = resolver
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录: {error}"))?;
    let current_exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let target_name = node_target_name()?;

    let mut candidates = vec![
        resource_dir.join("binaries").join("node"),
        resource_dir.join("binaries").join("node.exe"),
        resource_dir.join("binaries").join(target_name),
        resource_dir.join("node"),
        resource_dir.join("node.exe"),
        resource_dir.join(target_name),
        manifest_dir.join("binaries").join("node"),
        manifest_dir.join("binaries").join("node.exe"),
        manifest_dir.join("binaries").join(target_name),
    ];

    if let Some(exe_dir) = current_exe_dir {
        candidates.push(exe_dir.join("node"));
        candidates.push(exe_dir.join("node.exe"));
        candidates.push(exe_dir.join(target_name));
        candidates.push(exe_dir.join("binaries").join("node"));
        candidates.push(exe_dir.join("binaries").join("node.exe"));
        candidates.push(exe_dir.join("binaries").join(target_name));
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| format!("找不到 bundled Node.js sidecar: {target_name}"))
}

fn copy_dir_if_missing(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Ok(());
    }

    let parent = destination
        .parent()
        .ok_or_else(|| format!("无法定位目标父目录: {}", destination.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;

    copy_dir_recursive(source, destination).map_err(|error| {
        format!(
            "复制运行资源失败 {} -> {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn copy_entry_replace(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        if destination.is_dir() {
            fs::remove_dir_all(destination)
                .map_err(|error| format!("无法清理目录 {}: {error}", destination.display()))?;
        } else {
            fs::remove_file(destination)
                .map_err(|error| format!("无法清理文件 {}: {error}", destination.display()))?;
        }
    }

    if source.is_dir() {
        copy_dir_recursive(source, destination).map_err(|error| {
            format!(
                "同步目录失败 {} -> {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
    } else if source.is_file() {
        let parent = destination
            .parent()
            .ok_or_else(|| format!("无法定位目标父目录: {}", destination.display()))?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
        fs::copy(source, destination).map_err(|error| {
            format!(
                "同步文件失败 {} -> {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
    }

    Ok(())
}

fn files_have_same_contents(left: &Path, right: &Path) -> bool {
    match (fs::read(left), fs::read(right)) {
        (Ok(left_contents), Ok(right_contents)) => left_contents == right_contents,
        _ => false,
    }
}

fn replace_dir_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("无法定位目标父目录: {}", destination.display()))?;
    let directory_name = destination
        .file_name()
        .ok_or_else(|| format!("无法定位目标目录名: {}", destination.display()))?
        .to_string_lossy();
    let staging = parent.join(format!(".{directory_name}.airouter-new"));
    let backup = parent.join(format!(".{directory_name}.airouter-old"));

    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("无法清理依赖临时目录 {}: {error}", staging.display()))?;
    }
    if backup.exists() {
        if destination.exists() {
            fs::remove_dir_all(&backup)
                .map_err(|error| format!("无法清理依赖备份目录 {}: {error}", backup.display()))?;
        } else {
            fs::rename(&backup, destination).map_err(|error| {
                format!(
                    "无法恢复依赖备份目录 {} -> {}: {error}",
                    backup.display(),
                    destination.display()
                )
            })?;
        }
    }

    copy_dir_recursive(source, &staging).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        format!(
            "无法准备依赖目录 {} -> {}: {error}",
            source.display(),
            staging.display()
        )
    })?;

    if destination.exists() {
        fs::rename(destination, &backup).map_err(|error| {
            let _ = fs::remove_dir_all(&staging);
            format!(
                "无法备份依赖目录 {} -> {}: {error}",
                destination.display(),
                backup.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&staging, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "无法启用新依赖目录 {} -> {}: {error}",
            staging.display(),
            destination.display()
        ));
    }

    if backup.exists() {
        if let Err(error) = fs::remove_dir_all(&backup) {
            eprintln!("Airouter Desktop dependency backup cleanup failed: {error}");
        }
    }

    Ok(())
}

fn sync_runtime_resources(source: &Path, destination: &Path) -> Result<(), String> {
    let source_lock = source.join("package-lock.json");
    let destination_lock = destination.join("package-lock.json");
    let source_modules = source.join("node_modules");
    let destination_modules = destination.join("node_modules");
    let source_dependency_marker = source_modules.join(DEPENDENCY_MARKER_FILE);
    let destination_dependency_marker = destination_modules.join(DEPENDENCY_MARKER_FILE);
    if !source_dependency_marker.is_file() {
        return Err(format!(
            "bundled node_modules 缺少依赖完整性标记 {}",
            source_dependency_marker.display()
        ));
    }
    let should_sync_dependencies = !destination_modules.exists()
        || !files_have_same_contents(&source_dependency_marker, &destination_dependency_marker);

    for entry in fs::read_dir(source)
        .map_err(|error| format!("无法读取资源目录 {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("无法读取资源条目: {error}"))?;
        let file_name = entry.file_name();
        let file_name_text = file_name.to_string_lossy();
        let target = destination.join(&file_name);

        if file_name_text == "node_modules" || file_name_text == "package-lock.json" {
            continue;
        }

        copy_entry_replace(&entry.path(), &target)?;
    }

    if should_sync_dependencies {
        replace_dir_atomically(&source_modules, &destination_modules)?;
    }
    copy_entry_replace(&source_lock, &destination_lock)?;

    Ok(())
}

fn ensure_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let runtime_dir = app_data_root()?;
    let resources = resource_airouter_dir(app)?;

    if !runtime_dir.exists() {
        copy_dir_if_missing(&resources, &runtime_dir)?;
    } else {
        sync_runtime_resources(&resources, &runtime_dir)?;
    }

    let config_path = runtime_dir.join(CONFIG_FILE);
    let template_path = runtime_dir.join(CONFIG_TEMPLATE_FILE);
    if !config_path.exists() && !template_path.exists() {
        return Err(format!("运行目录缺少配置模板 {}", template_path.display()));
    }

    Ok(runtime_dir)
}

fn read_pid(runtime_dir: &Path) -> Option<u32> {
    let raw = fs::read_to_string(runtime_dir.join(PID_FILE)).ok()?;
    raw.trim().parse::<u32>().ok()
}

fn process_exists(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
                ),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn parse_port(value: Option<Value>) -> Option<u16> {
    match value? {
        Value::Number(number) => number.as_u64().and_then(|port| u16::try_from(port).ok()),
        Value::String(text) => text.trim().parse::<u16>().ok(),
        _ => None,
    }
}

fn parse_initial_port(value: Option<Value>, fallback: u16, label: &str) -> Result<u16, String> {
    match value {
        None => Ok(fallback),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(fallback),
        Some(value) => {
            let port = parse_port(Some(value))
                .ok_or_else(|| format!("{label}必须是 1-65535 之间的端口号"))?;
            if port == 0 {
                Err(format!("{label}必须是 1-65535 之间的端口号"))
            } else {
                Ok(port)
            }
        }
    }
}

fn build_initial_config_value(
    template_raw: &str,
    request: InitialConfigRequest,
) -> Result<Map<String, Value>, String> {
    let parsed: Value = serde_json::from_str(template_raw)
        .map_err(|error| format!("openai.json.example 解析失败: {error}"))?;
    let mut config = parsed
        .as_object()
        .cloned()
        .ok_or_else(|| "openai.json.example 必须是 JSON 对象".to_string())?;

    let service_port = parse_initial_port(request.service_port, DEFAULT_PORT, "服务端口")?;
    config.insert("port".to_string(), Value::from(service_port));

    if request.proxy_enabled {
        let proxy_port = parse_initial_port(request.proxy_port, 7890, "代理端口")?;
        config.insert("proxy_port".to_string(), Value::from(proxy_port));
    } else {
        config.remove("proxy_port");
    }

    if request.apikey_enabled {
        let apikey = request
            .apikey
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "启用入口 apikey 时必须提供 apikey".to_string())?;
        config.insert("apikeys".to_string(), Value::from(vec![apikey]));
    } else {
        config.insert("apikeys".to_string(), Value::from(Vec::<String>::new()));
    }

    config.remove("type");
    Ok(config)
}

fn write_initial_config(runtime_dir: &Path, request: InitialConfigRequest) -> Result<(), String> {
    let config_path = runtime_dir.join(CONFIG_FILE);
    if config_path.exists() {
        return Err("openai.json 已存在，无需初始化".to_string());
    }

    let template_path = runtime_dir.join(CONFIG_TEMPLATE_FILE);
    let template_raw = fs::read_to_string(&template_path)
        .map_err(|error| format!("无法读取配置模板 {}: {error}", template_path.display()))?;
    let config = build_initial_config_value(&template_raw, request)?;
    let rendered = serde_json::to_string_pretty(&Value::Object(config))
        .map_err(|error| format!("无法生成 openai.json: {error}"))?;
    fs::write(&config_path, format!("{rendered}\n"))
        .map_err(|error| format!("无法写入 {}: {error}", config_path.display()))
}

fn read_config(runtime_dir: &Path) -> Result<ConfigShape, String> {
    let raw = fs::read_to_string(runtime_dir.join(CONFIG_FILE))
        .map_err(|error| format!("无法读取 openai.json: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("openai.json 解析失败: {error}"))
}

fn configured_port(runtime_dir: &Path) -> Result<u16, String> {
    let config = read_config(runtime_dir)?;
    Ok(parse_port(config.port).unwrap_or(DEFAULT_PORT))
}

fn build_admin_url(port: u16, auth_token: Option<&str>) -> String {
    let base = format!("http://localhost:{port}/admin/configs");
    match auth_token.filter(|token| !token.trim().is_empty()) {
        Some(token) => format!("{base}?auth_token={token}&desktop_app=1"),
        None => format!("{base}?desktop_app=1"),
    }
}

fn is_runtime_web_host(host: Option<&str>) -> bool {
    matches!(
        host,
        Some("localhost")
            | Some("127.0.0.1")
            | Some("[::1]")
            | Some("::1")
            | Some("tauri.localhost")
    )
}

#[cfg(test)]
fn is_local_admin_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
        )
}

fn should_keep_in_app(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https") && is_runtime_web_host(url.host_str())
}

fn open_external_url(url: &tauri::Url) {
    if !matches!(url.scheme(), "http" | "https") || should_keep_in_app(url) {
        return;
    }

    let url = url.to_string();
    thread::spawn(move || {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "start", "", &url]);
            command
        };

        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("open");
            command.arg(&url);
            command
        };

        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let mut command = {
            let mut command = Command::new("xdg-open");
            command.arg(&url);
            command
        };

        let _ = command.stdout(Stdio::null()).stderr(Stdio::null()).status();
    });
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("URL 编码不完整".to_string());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|error| format!("URL 编码无效: {error}"))?;
            let value =
                u8::from_str_radix(hex, 16).map_err(|error| format!("URL 编码无效: {error}"))?;
            output.push(value);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(output).map_err(|error| format!("URL 编码 UTF-8 无效: {error}"))
}

fn post_auth_session_callback(callback_url: &str, payload: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(callback_url)
        .map_err(|error| format!("AuthSession 回调地址无效: {error}"))?;
    if parsed.scheme() != "http" {
        return Err("AuthSession 回调只允许 http".to_string());
    }
    if !matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    ) {
        return Err("AuthSession 回调只允许本机地址".to_string());
    }

    let host = parsed.host_str().unwrap_or("localhost");
    let port = parsed.port().unwrap_or(80);
    let mut path = parsed.path().to_string();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }

    let body = payload.as_bytes();
    let mut stream = std::net::TcpStream::connect((host, port))
        .map_err(|error| format!("连接 AuthSession 回调失败: {error}"))?;
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: text/plain;charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| format!("写入 AuthSession 回调失败: {error}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("读取 AuthSession 回调响应失败: {error}"))?;
    if response.starts_with("HTTP/1.1 2") || response.starts_with("HTTP/1.0 2") {
        Ok(())
    } else {
        let status = response.lines().next().unwrap_or("无响应状态");
        Err(format!("AuthSession 回调失败: {status}"))
    }
}

fn deliver_auth_session_to_main(app: &AppHandle, payload: &str) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(payload)
        .map_err(|error| format!("AuthSession payload JSON 无效: {error}"))?;
    let ok = parsed.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok || parsed.get("session").is_none() {
        return Err("AuthSession payload 不完整".to_string());
    }

    if let Some(window) = app.get_webview_window("main") {
        window
            .eval(&format!(
                "window.AirouterReceiveAuthSession && window.AirouterReceiveAuthSession({});",
                parsed
            ))
            .map_err(|error| format!("主窗口回填 AuthSession 失败: {error}"))?;
    }

    Ok(())
}

fn close_auth_session_window_on_main_thread(app: &AppHandle, label: String) {
    let app = app.clone();
    if let Err(error) = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }) {
        eprintln!("Airouter AuthSession close dispatch failed: {error}");
    }
}

fn auth_session_probe_script(callback_url: &str) -> String {
    let callback_url_json =
        serde_json::to_string(callback_url).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
(() => {{
  const callbackUrl = {callback_url_json};
  const sessionUrl = 'https://chatgpt.com/api/auth/session';
  const validOrigins = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
  if (!validOrigins.has(window.location.origin) || window.__airouterAuthSessionProbeStarted) {{
    return;
  }}
  window.__airouterAuthSessionProbeStarted = true;
  window.__airouterAuthSessionProbeAttempts = 0;
  window.__airouterAuthSessionProbeInFlight = false;
  window.__airouterAuthSessionLastReady = 0;

  function setStatus(text) {{
    let el = document.getElementById('__airouter_auth_session_status');
    if (!el) {{
      el = document.createElement('div');
      el.id = '__airouter_auth_session_status';
      el.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:14px',
        'z-index:2147483647',
        'max-width:420px',
        'padding:10px 12px',
        'border-radius:8px',
        'background:rgba(0,0,0,.76)',
        'color:#fff',
        'font:12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'box-shadow:0 8px 24px rgba(0,0,0,.25)',
        'white-space:pre-wrap'
      ].join(';');
      document.documentElement.appendChild(el);
    }}
    el.textContent = text;
  }}

  function postReport(message) {{
    fetch(callbackUrl, {{
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: {{ 'content-type': 'text/plain;charset=UTF-8' }},
      body: JSON.stringify({{ ok: false, message }})
    }}).catch(() => {{}});
  }}

  function pageText() {{
    return (document.body && document.body.innerText ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
  }}

  function buttonText(element) {{
    return (element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  }}

  function clickCookieBannerButton() {{
    if (window.__airouterCookieBannerClicked) {{
      return false;
    }}

    const directButton = document.querySelector('#onetrust-accept-btn-handler, button#accept-recommended-btn-handler');
    if (directButton) {{
      window.__airouterCookieBannerClicked = true;
      directButton.click();
      return true;
    }}

    const candidates = [...document.querySelectorAll('button, [role="button"]')];
    const cookieButton = candidates.find((button) => {{
      const text = buttonText(button);
      return /^(接受全部|全部接受|同意|我同意|允许所有|Accept all|Allow all|I agree|Agree|Got it|OK)$/i.test(text);
    }});
    if (cookieButton && /cookie|cookies|隐私|privacy|consent|同意/.test(pageText())) {{
      window.__airouterCookieBannerClicked = true;
      cookieButton.click();
      return true;
    }}
    return false;
  }}

  function clickInitialLoginButton() {{
    if (document.querySelector('input[type="email"], input[name="email"], input[autocomplete="one-time-code"], input[inputmode="numeric"]')) {{
      return false;
    }}
    if (window.location.pathname.includes('/auth') || window.location.pathname.includes('/login')) {{
      return false;
    }}
    if (isLoggedInHtmlReady()) {{
      return false;
    }}
    if (window.__airouterInitialLoginClickAttempts >= 3) {{
      return false;
    }}
    if (window.__airouterInitialLoginLastClickAt && Date.now() - window.__airouterInitialLoginLastClickAt < 1500) {{
      return false;
    }}

    const candidates = [...document.querySelectorAll('a, button, [role="button"]')];
    const loginButton = candidates.find((item) => {{
      const text = buttonText(item);
      const href = item.getAttribute('href') || '';
      return /^(登录|Log in|Login|Sign in)$/i.test(text) || /\/(auth\/)?login/.test(href);
    }});
    if (!loginButton) {{
      return false;
    }}

    window.__airouterInitialLoginClickAttempts = (window.__airouterInitialLoginClickAttempts || 0) + 1;
    window.__airouterInitialLoginLastClickAt = Date.now();
    loginButton.click();
    return true;
  }}

  function dismissPostLoginGuide() {{
    const buttons = [...document.querySelectorAll('button')];
    const startButton = buttons.find((button) => /好的[，, ]*开始吧|开始吧|继续/.test(buttonText(button)));
    if (startButton && /入门技巧|请核实你的信息|尽管问/.test(pageText())) {{
      startButton.click();
      return true;
    }}
    return false;
  }}

  function isLoginStillInProgress() {{
    const text = pageText();
    const hasEmailInput = !!document.querySelector('input[type="email"], input[name="email"]');
    const hasOtpInput = !!document.querySelector('input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    const loginButtons = [...document.querySelectorAll('button,a')]
      .some((item) => /^(登录|免费注册|使用 Google 账户继续|使用 Apple 账户继续|使用电话号码继续|继续)$/.test((item.innerText || item.textContent || '').trim()));
    return hasEmailInput
      || hasOtpInput
      || loginButtons
      || /登录或注册|检查你的收件箱|验证码|电子邮件地址|重新发送电子邮件|获取为你量身定制的回复/.test(text);
  }}

  function isLoggedInHtmlReady() {{
    const text = pageText();
    if (isLoginStillInProgress()) {{
      return false;
    }}

    const hasProfileMenu = [...document.querySelectorAll('button')]
      .some((button) => /个人资料|账户菜单|打开.*菜单|升级/.test(button.getAttribute('aria-label') || '') || /免费版|Plus|Pro|Team|Enterprise/.test(button.innerText || ''));
    const hasComposer = !!document.querySelector('textarea, [contenteditable="true"], [data-testid*="composer"], form textarea')
      || /尽管问|发送消息|Message ChatGPT|Ask anything|我们先从哪里开始/.test(text);
    const hasLoggedInSidebar = /新对话|新聊天|搜索聊天|搜索对话|历史聊天记录/.test(text);
    const hasPostLoginGuide = /入门技巧|请勿共享敏感信息|请核实你的信息|好的[，, ]*开始吧/.test(text);
    return hasPostLoginGuide || (hasComposer && (hasProfileMenu || hasLoggedInSidebar));
  }}

  function submitByTauriNavigation(payload) {{
    const nativePayload = encodeURIComponent(JSON.stringify({{ callbackUrl, payload }}));
    window.location.href = 'airouter-auth-session://callback#' + nativePayload;
    window.setTimeout(() => {{
      window.close();
    }}, 300);
  }}

  function submitSession(session) {{
    const payload = JSON.stringify({{ ok: true, session }});
    setStatus('Airouter: 正在使用 Tauri 原生回填 AuthSession...');
    submitByTauriNavigation(payload);
    return new Promise(() => {{}});
  }}

  function parseSessionCandidate(candidate) {{
    if (typeof candidate === 'string') {{
      candidate = JSON.parse(candidate);
    }}
    if (candidate && candidate.accessToken && candidate.account && candidate.account.id) {{
      return candidate;
    }}
    return null;
  }}

  async function submitSessionFromApiPage() {{
    if (window.location.pathname !== '/api/auth/session') {{
      return false;
    }}
    const raw = (document.body && document.body.innerText ? document.body.innerText : '').trim();
    if (!raw) {{
      setStatus('Airouter: AuthSession 页面还在加载...');
      return true;
    }}
    try {{
      const session = parseSessionCandidate(raw);
      if (session) {{
        setStatus('Airouter: 已从 AuthSession 页面读取 JSON，正在回填...');
        await submitSession(session);
        setStatus('Airouter: 已回填 AuthSession。');
        window.close();
      }} else {{
        const parsed = JSON.parse(raw);
        const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).join(',') : typeof parsed;
        const message = 'Airouter: AuthSession 页面返回不完整，字段: ' + keys;
        setStatus(message);
        postReport(message);
      }}
    }} catch (err) {{
      const message = 'Airouter: AuthSession 页面 JSON 解析失败：' + (err && err.message ? err.message : String(err));
      setStatus(message);
      postReport(message);
    }}
    return true;
  }}

  function openRawSessionPage(reason) {{
    if (window.location.pathname === '/api/auth/session') {{
      return;
    }}
    setStatus(reason + '\nAirouter: 正在打开 AuthSession 原始页面重试...');
    window.location.href = sessionUrl + '?airouter=' + Date.now();
  }}

  async function probeAuthSession() {{
    try {{
      if (await submitSessionFromApiPage()) {{
        return;
      }}
      if (clickCookieBannerButton()) {{
        setStatus('Airouter: 已关闭 cookie 提示，正在准备登录...');
        return;
      }}
      if (clickInitialLoginButton()) {{
        setStatus('Airouter: 已打开 ChatGPT 登录入口，请继续完成登录。');
        return;
      }}
      if (dismissPostLoginGuide()) {{
        setStatus('Airouter: 已检测到登录后引导，正在关闭引导...');
        return;
      }}
      if (!isLoggedInHtmlReady()) {{
        const message = 'Airouter: 等待 ChatGPT 登录完成，当前页面还不是登录后主界面。';
        setStatus(message);
        return;
      }}
      if (!window.__airouterAuthSessionLastReady) {{
        window.__airouterAuthSessionLastReady = Date.now();
        setStatus('Airouter: 已检测到登录成功页面，等待 ChatGPT 初始化登录态...');
        return;
      }}
      if (Date.now() - window.__airouterAuthSessionLastReady < 1500) {{
        setStatus('Airouter: 已检测到登录成功页面，等待 ChatGPT 初始化登录态...');
        return;
      }}
      if (window.__airouterAuthSessionProbeInFlight) {{
        return;
      }}
      if (window.__airouterAuthSessionProbeAttempts >= 6) {{
        const message = 'Airouter: 已确认登录成功，但多次读取 AuthSession 未返回完整 JSON，请稍后重新点击 App 自动获取。';
        setStatus(message);
        postReport(message);
        return;
      }}
      window.__airouterAuthSessionProbeInFlight = true;
      window.__airouterAuthSessionProbeAttempts += 1;
      setStatus('Airouter: 正在读取 ChatGPT AuthSession...');
      const response = await fetch(sessionUrl, {{
        credentials: 'include',
        cache: 'no-store',
        headers: {{
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }}
      }});
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.toLowerCase().includes('application/json')) {{
        const message = 'Airouter: session 未就绪，HTTP ' + response.status + ', content-type: ' + (contentType || '空');
        setStatus(message);
        postReport(message);
        return;
      }}
      const session = await response.json();
      const validSession = parseSessionCandidate(session);
      if (!validSession) {{
        const keys = session && typeof session === 'object' ? Object.keys(session).join(',') : typeof session;
        const message = 'Airouter: session 返回不完整，字段: ' + keys;
        setStatus(message);
        postReport(message);
        if (session && typeof session === 'object' && Object.keys(session).length === 1 && session.WARNING_BANNER) {{
          if (window.__airouterAuthSessionProbeAttempts >= 3) {{
            openRawSessionPage(message);
          }}
        }}
        return;
      }}
      setStatus('Airouter: 已读取 AuthSession，正在回填...');
      await submitSession(validSession);
      setStatus('Airouter: 已回填 AuthSession。');
      window.close();
    }} catch (err) {{
      const message = 'Airouter: 自动读取失败：' + (err && err.message ? err.message : String(err));
      setStatus(message);
      postReport(message);
    }} finally {{
      window.__airouterAuthSessionProbeInFlight = false;
    }}
  }}

  window.setInterval(probeAuthSession, 1000);
  window.addEventListener('load', probeAuthSession);
  new MutationObserver(() => {{
    window.clearTimeout(window.__airouterAuthSessionMutationTimer);
    window.__airouterAuthSessionMutationTimer = window.setTimeout(probeAuthSession, 250);
  }}).observe(document.documentElement, {{ childList: true, subtree: true, characterData: true }});
  probeAuthSession();
}})();
"#
    )
}

fn open_auth_session_window_inner(
    app: &AppHandle,
    request: AuthSessionRequest,
) -> Result<(), String> {
    if request.action != "open_auth_session" {
        return Err("未知 AuthSession 请求".to_string());
    }

    let login_url = request.login_url.as_deref().unwrap_or(CHATGPT_LOGIN_URL);
    let parsed_url = tauri::Url::parse(login_url)
        .map_err(|error| format!("AuthSession 登录地址无效: {error}"))?;
    if !matches!(
        parsed_url.host_str(),
        Some("chatgpt.com") | Some("chat.openai.com")
    ) {
        return Err("AuthSession 登录地址必须是 ChatGPT".to_string());
    }
    let label_suffix = request
        .job_id
        .as_deref()
        .unwrap_or("window")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>();
    let label = format!("{AUTH_SESSION_WINDOW_LABEL_PREFIX}{label_suffix}");
    let callback_url = request.callback_url.clone();

    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed_url))
        .title("ChatGPT 登录")
        .inner_size(1120.0, 820.0)
        .resizable(true)
        .incognito(true)
        .initialization_script(auth_session_probe_script(&request.callback_url))
        .build()
        .map_err(|error| format!("无法打开 AuthSession WebView: {error}"))?
        .on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let callback_url = callback_url.clone();
                thread::spawn(move || {
                    let payload = serde_json::json!({
                        "ok": false,
                        "cancelled": true,
                        "message": "ChatGPT 登录窗口已关闭"
                    })
                    .to_string();
                    let _ = post_auth_session_callback(&callback_url, &payload);
                });
            }
        });

    Ok(())
}

fn start_auth_session_request_watcher(app: AppHandle) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(500));
            let Ok(runtime_dir) = app_data_root() else {
                continue;
            };
            let request_file = runtime_dir.join(AUTH_SESSION_REQUEST_FILE);
            if !request_file.exists() {
                continue;
            }

            let raw = fs::read_to_string(&request_file).unwrap_or_default();
            let _ = fs::remove_file(&request_file);
            let request = match serde_json::from_str::<AuthSessionRequest>(&raw) {
                Ok(request) => request,
                Err(error) => {
                    eprintln!("Airouter AuthSession request parse failed: {error}");
                    continue;
                }
            };
            let app_for_main = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = open_auth_session_window_inner(&app_for_main, request) {
                    eprintln!("Airouter AuthSession WebView failed: {error}");
                }
            }) {
                eprintln!("Airouter AuthSession dispatch failed: {error}");
            }
        }
    });
}

fn admin_url_for_runtime(runtime_dir: &Path) -> Result<String, String> {
    let config = read_config(runtime_dir)?;
    let port = parse_port(config.port).unwrap_or(DEFAULT_PORT);
    Ok(build_admin_url(port, config.auth_token.as_deref()))
}

fn tail_text(path: &Path, limit: usize) -> String {
    let Ok(raw) = fs::read_to_string(path) else {
        return "暂无日志".to_string();
    };

    let max = limit.max(1);
    let mut lines = raw.lines().rev().take(max).collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

fn parse_lsof_pid_output(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

fn listening_pids_for_port(port: u16) -> Result<Vec<u32>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("无法检查端口 {port} 占用: {error}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("检查端口 {port} 占用失败: {stderr}"));
        }

        return Ok(parse_windows_netstat_pid_output(
            &String::from_utf8_lossy(&output.stdout),
            port,
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("lsof")
            .arg(format!("-tiTCP:{port}"))
            .arg("-sTCP:LISTEN")
            .arg("-n")
            .arg("-P")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("无法检查端口 {port} 占用: {error}"))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Ok(parse_lsof_pid_output(&stdout));
        }

        if output.stdout.is_empty() {
            return Ok(Vec::new());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("检查端口 {port} 占用失败: {stderr}"))
    }
}

#[cfg(any(target_os = "windows", test))]
fn address_uses_port(address: &str, port: u16) -> bool {
    let suffix = format!(":{port}");
    address.trim().ends_with(&suffix)
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_netstat_pid_output(output: &str, port: u16) -> Vec<u32> {
    let mut pids = Vec::new();

    for line in output.lines() {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 5 || !columns[0].eq_ignore_ascii_case("TCP") {
            continue;
        }

        if !columns[3].eq_ignore_ascii_case("LISTENING") || !address_uses_port(columns[1], port) {
            continue;
        }

        if let Ok(pid) = columns[4].parse::<u32>() {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }

    pids
}

fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    let started_at = Instant::now();

    while process_exists(pid) {
        if started_at.elapsed() >= timeout {
            return false;
        }

        thread::sleep(Duration::from_millis(PORT_KILL_POLL_INTERVAL_MS));
    }

    true
}

fn signal_pid(pid: u32, signal: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T"]);
        if signal == "KILL" {
            command.arg("/F");
        }

        let status = command
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|error| format!("无法终止 PID {pid}: {error}"))?;

        return if status.success() {
            Ok(())
        } else {
            Err(format!("无法终止 PID {pid}"))
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("kill")
            .arg(format!("-{signal}"))
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .map_err(|error| format!("无法发送 {signal} 到 PID {pid}: {error}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("无法发送 {signal} 到 PID {pid}"))
        }
    }
}

fn terminate_pid(pid: u32) -> Result<(), String> {
    if !process_exists(pid) {
        return Ok(());
    }

    let _ = signal_pid(pid, "TERM");
    if wait_for_pid_exit(pid, Duration::from_millis(PORT_KILL_WAIT_TIMEOUT_MS)) {
        return Ok(());
    }

    let _ = signal_pid(pid, "KILL");
    if wait_for_pid_exit(pid, Duration::from_millis(PORT_FORCE_KILL_WAIT_TIMEOUT_MS)) {
        return Ok(());
    }

    Err(format!("PID {pid} 占用端口且无法终止"))
}

fn kill_port_listeners(port: u16) -> Result<Vec<u32>, String> {
    let pids = listening_pids_for_port(port)?;
    for pid in &pids {
        terminate_pid(*pid)?;
    }
    Ok(pids)
}

fn status_for_runtime(runtime_dir: PathBuf) -> ServiceStatus {
    let pid = read_pid(&runtime_dir);
    let running = pid.map(process_exists).unwrap_or(false);
    let has_config = runtime_dir.join(CONFIG_FILE).exists();
    let logs = tail_text(&runtime_dir.join(LOG_FILE), 160);

    let mut port = None;
    let mut admin_url = None;
    let mut config_valid = false;
    let mut message = if running {
        "服务运行中".to_string()
    } else {
        "服务未运行".to_string()
    };

    if has_config {
        match read_config(&runtime_dir) {
            Ok(config) => {
                config_valid = true;
                let selected_port = configured_port(&runtime_dir).unwrap_or(DEFAULT_PORT);
                port = Some(selected_port);
                admin_url = Some(build_admin_url(selected_port, config.auth_token.as_deref()));
            }
            Err(error) => {
                message = error;
            }
        }
    } else {
        message = "运行目录中缺少 openai.json".to_string();
    }

    ServiceStatus {
        running,
        pid,
        port,
        has_config,
        config_valid,
        admin_url,
        runtime_dir: runtime_dir.display().to_string(),
        message,
        logs,
    }
}

fn run_service_command(app: &AppHandle, action: &str) -> Result<(), String> {
    let runtime_dir = ensure_runtime(app)?;
    let node = node_sidecar_path(app)?;

    if action == "start" || action == "restart" {
        let port = configured_port(&runtime_dir)?;
        let _ = kill_port_listeners(port)?;
    }

    let mut command = Command::new(node);
    command.current_dir(&runtime_dir).arg("run.js");
    if action != "start" {
        command.arg(action);
    }
    command.env("AIROUTER_FORCE_INTERACTIVE", "0");
    command.env("RUN_STARTUP_CHECK_DELAY_MS", "1500");
    command.env("RUN_STARTUP_LOG_WAIT_MS", "800");
    command.env("RUN_STOP_WAIT_TIMEOUT_MS", "2500");
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let output = command
        .output()
        .map_err(|error| format!("执行服务命令失败: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!("服务命令失败: {stdout}{stderr}"))
}

fn navigate_main_to_admin(app: &AppHandle) -> Result<(), String> {
    let runtime_dir = ensure_runtime(app)?;
    let admin_url = admin_url_for_runtime(&runtime_dir)?;
    let parsed = tauri::Url::parse(&admin_url).map_err(|error| format!("管理地址无效: {error}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;

    window
        .set_title("Airouter")
        .map_err(|error| format!("无法更新窗口标题: {error}"))?;
    window
        .navigate(parsed)
        .map_err(|error| format!("无法打开配置页面: {error}"))?;
    Ok(())
}

fn start_and_show_config_page(app: &AppHandle) -> Result<ServiceStatus, String> {
    run_service_command(app, "start")?;
    navigate_main_to_admin(app)?;
    let runtime_dir = ensure_runtime(app)?;
    Ok(status_for_runtime(runtime_dir))
}

fn stop_service_quietly(app: &AppHandle) {
    if let Err(error) = run_service_command(app, "stop") {
        eprintln!("Airouter Desktop stop failed: {error}");
    }
}

#[tauri::command]
fn get_status(app: AppHandle) -> Result<ServiceStatus, String> {
    let runtime_dir = ensure_runtime(&app)?;
    Ok(status_for_runtime(runtime_dir))
}

#[tauri::command]
fn start_service(app: AppHandle) -> Result<ServiceStatus, String> {
    run_service_command(&app, "start")?;
    get_status(app)
}

#[tauri::command]
fn stop_service(app: AppHandle) -> Result<ServiceStatus, String> {
    run_service_command(&app, "stop")?;
    get_status(app)
}

#[tauri::command]
fn restart_service(app: AppHandle) -> Result<ServiceStatus, String> {
    run_service_command(&app, "restart")?;
    get_status(app)
}

#[tauri::command]
fn show_config_page(app: AppHandle) -> Result<ServiceStatus, String> {
    start_and_show_config_page(&app)
}

#[tauri::command]
fn initialize_config(
    app: AppHandle,
    request: InitialConfigRequest,
) -> Result<ServiceStatus, String> {
    let runtime_dir = ensure_runtime(&app)?;
    write_initial_config(&runtime_dir, request)?;
    Ok(status_for_runtime(runtime_dir))
}

#[tauri::command]
fn read_recent_logs(app: AppHandle, limit: Option<usize>) -> Result<String, String> {
    let runtime_dir = ensure_runtime(&app)?;
    Ok(tail_text(&runtime_dir.join(LOG_FILE), limit.unwrap_or(160)))
}

#[tauri::command]
fn open_admin_window(app: AppHandle) -> Result<(), String> {
    navigate_main_to_admin(&app)
}

#[tauri::command]
fn open_admin_in_browser(app: AppHandle) -> Result<(), String> {
    let status = get_status(app.clone())?;
    let url = status
        .admin_url
        .ok_or_else(|| "管理地址不可用，请先检查配置".to_string())?;
    let result = Command::new("open")
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|error| format!("无法打开浏览器: {error}"))?;

    if result.success() {
        Ok(())
    } else {
        Err("系统 open 命令打开浏览器失败".to_string())
    }
}

#[tauri::command]
fn reveal_runtime_dir(app: AppHandle) -> Result<(), String> {
    let runtime_dir = ensure_runtime(&app)?;
    let result = Command::new("open")
        .arg(runtime_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|error| format!("无法在 Finder 中打开运行目录: {error}"))?;

    if result.success() {
        Ok(())
    } else {
        Err("系统 open 命令打开运行目录失败".to_string())
    }
}

fn update_error(error: impl std::fmt::Display) -> String {
    format!("检查或安装更新失败: {error}")
}

fn emit_update_progress(
    app: &AppHandle,
    state: &str,
    downloaded: u64,
    content_length: Option<u64>,
    message: impl Into<String>,
) {
    let percent = content_length
        .filter(|total| *total > 0)
        .map(|total| ((downloaded.saturating_mul(100) / total).min(100)) as u8);
    let _ = app.emit(
        "airouter-update-progress",
        UpdateProgress {
            state: state.to_string(),
            downloaded,
            content_length,
            percent,
            message: message.into(),
        },
    );
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResponse, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app.updater().map_err(update_error)?;
    let update = updater.check().await.map_err(update_error)?;

    Ok(match update {
        Some(update) => UpdateCheckResponse {
            available: true,
            current_version,
            version: Some(update.version),
            date: update.date.map(|date| date.to_string()),
            body: update.body,
        },
        None => UpdateCheckResponse {
            available: false,
            current_version,
            version: None,
            date: None,
            body: None,
        },
    })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(update_error)?;
    let update = updater
        .check()
        .await
        .map_err(update_error)?
        .ok_or_else(|| "当前没有可安装的更新".to_string())?;

    let downloaded = Arc::new(AtomicU64::new(0));
    let progress_app = app.clone();
    let finished_app = app.clone();
    let progress_downloaded = Arc::clone(&downloaded);
    let finished_downloaded = Arc::clone(&downloaded);
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let current = progress_downloaded
                    .fetch_add(chunk_length as u64, Ordering::Relaxed)
                    .saturating_add(chunk_length as u64);
                emit_update_progress(
                    &progress_app,
                    "downloading",
                    current,
                    content_length,
                    "正在下载更新",
                );
            },
            move || {
                let current = finished_downloaded.load(Ordering::Relaxed);
                emit_update_progress(&finished_app, "installing", current, None, "正在安装更新");
            },
        )
        .await
        .map_err(update_error)?;

    let downloaded = downloaded.load(Ordering::Relaxed);
    emit_update_progress(&app, "ready", downloaded, None, "更新已安装，正在重启");
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("external-link")
                .on_navigation(|webview, url| {
                    if url.scheme() == "airouter-auth-session" {
                        let app = webview.app_handle().clone();
                        let label = webview.label().to_string();
                        let url = url.clone();
                        thread::spawn(move || {
                            let callback = (|| {
                                let encoded = url
                                    .fragment()
                                    .ok_or_else(|| "AuthSession 原生回调缺少 payload".to_string())?;
                                let decoded = percent_decode(encoded)?;
                                serde_json::from_str::<NativeAuthSessionCallback>(&decoded)
                                    .map_err(|error| format!("AuthSession 原生回调 JSON 无效: {error}"))
                            })();

                            match callback {
                                Ok(callback) => {
                                    let post_result = post_auth_session_callback(&callback.callback_url, &callback.payload);
                                    let deliver_result = deliver_auth_session_to_main(&app, &callback.payload);
                                    if post_result.is_ok() || deliver_result.is_ok() {
                                        close_auth_session_window_on_main_thread(&app, label);
                                    } else {
                                        if let Err(error) = post_result {
                                            eprintln!("Airouter AuthSession native HTTP callback failed: {error}");
                                        }
                                        if let Err(error) = deliver_result {
                                            eprintln!("Airouter AuthSession native main-window callback failed: {error}");
                                        }
                                    }
                                }
                                Err(error) => {
                                    eprintln!("Airouter AuthSession native callback failed: {error}");
                                }
                            }
                        });
                        return false;
                    }

                    if webview.label().starts_with(AUTH_SESSION_WINDOW_LABEL_PREFIX) {
                        return matches!(url.scheme(), "http" | "https");
                    }

                    if should_keep_in_app(url) || !matches!(url.scheme(), "http" | "https") {
                        true
                    } else {
                        open_external_url(url);
                        false
                    }
                })
                .build(),
        )
        .setup(|app| {
            start_auth_session_request_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle().clone();
                stop_service_quietly(&app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_service,
            stop_service,
            restart_service,
            show_config_page,
            initialize_config,
            open_admin_window,
            open_admin_in_browser,
            reveal_runtime_dir,
            check_for_updates,
            install_update,
            read_recent_logs
        ])
        .build(tauri::generate_context!())
        .expect("error while building Airouter Desktop");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_service_quietly(app_handle);
        }
    });
}

fn main() {
    run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_admin_url_with_auth_token() {
        assert_eq!(
            build_admin_url(3009, Some("auth_abc")),
            "http://localhost:3009/admin/configs?auth_token=auth_abc&desktop_app=1"
        );
    }

    #[test]
    fn builds_admin_url_without_empty_auth_token() {
        assert_eq!(
            build_admin_url(3009, Some("")),
            "http://localhost:3009/admin/configs?desktop_app=1"
        );
    }

    #[test]
    fn parses_numeric_and_string_ports() {
        assert_eq!(parse_port(Some(Value::from(3010))), Some(3010));
        assert_eq!(parse_port(Some(Value::from("3011"))), Some(3011));
        assert_eq!(parse_port(Some(Value::from("bad"))), None);
    }

    #[test]
    fn reads_configured_port_from_runtime_config() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join(CONFIG_FILE), r#"{"port":"31888"}"#).expect("write config");
        assert_eq!(
            configured_port(temp.path()).expect("configured port"),
            31888
        );
    }

    #[test]
    fn configured_port_falls_back_to_default_when_missing() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join(CONFIG_FILE), r#"{}"#).expect("write config");
        assert_eq!(
            configured_port(temp.path()).expect("configured port"),
            DEFAULT_PORT
        );
    }

    #[test]
    fn builds_initial_config_from_template_with_proxy_and_apikey() {
        let request = InitialConfigRequest {
            service_port: Some(Value::from("3017")),
            proxy_enabled: true,
            proxy_port: Some(Value::from("8899")),
            apikey_enabled: true,
            apikey: Some("sk-airouter-test".to_string()),
        };

        let config = build_initial_config_value(
            r#"{"type":"token","apikeys":[],"port":3009,"proxy_port":7890,"configs":[]}"#,
            request,
        )
        .expect("build initial config");

        assert_eq!(config.get("type"), None);
        assert_eq!(config.get("port"), Some(&Value::from(3017)));
        assert_eq!(config.get("proxy_port"), Some(&Value::from(8899)));
        assert_eq!(
            config.get("apikeys"),
            Some(&Value::from(vec!["sk-airouter-test"]))
        );
        assert_eq!(
            config.get("configs"),
            Some(&Value::from(Vec::<Value>::new()))
        );
    }

    #[test]
    fn builds_initial_config_without_proxy_or_apikey() {
        let request = InitialConfigRequest {
            service_port: Some(Value::from("3009")),
            proxy_enabled: false,
            proxy_port: Some(Value::from("8899")),
            apikey_enabled: false,
            apikey: Some("sk-airouter-unused".to_string()),
        };

        let config = build_initial_config_value(
            r#"{"apikeys":["old"],"port":3010,"proxy_port":7890,"configs":[]}"#,
            request,
        )
        .expect("build initial config");

        assert_eq!(config.get("port"), Some(&Value::from(3009)));
        assert_eq!(config.get("proxy_port"), None);
        assert_eq!(
            config.get("apikeys"),
            Some(&Value::from(Vec::<Value>::new()))
        );
    }

    #[test]
    fn rejects_invalid_initial_config_ports() {
        let request = InitialConfigRequest {
            service_port: Some(Value::from("70000")),
            proxy_enabled: true,
            proxy_port: Some(Value::from("8899")),
            apikey_enabled: false,
            apikey: None,
        };

        let error =
            build_initial_config_value(r#"{"configs":[]}"#, request).expect_err("invalid port");

        assert!(error.contains("服务端口"));
    }

    #[test]
    fn parses_lsof_pid_output() {
        assert_eq!(
            parse_lsof_pid_output("123\n 456 \nnot-a-pid\n789\n"),
            vec![123, 456, 789]
        );
    }

    #[test]
    fn parses_windows_netstat_pid_output() {
        let output = r#"
  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3009           0.0.0.0:0              LISTENING       1234
  TCP    [::]:3009              [::]:0                 LISTENING       1234
  TCP    127.0.0.1:3010         0.0.0.0:0              LISTENING       9999
"#;

        assert_eq!(parse_windows_netstat_pid_output(output, 3009), vec![1234]);
    }

    #[test]
    fn keeps_tauri_localhost_navigation_inside_the_app() {
        let url = tauri::Url::parse("http://tauri.localhost/").expect("tauri localhost url");
        assert!(should_keep_in_app(&url));
        assert!(!is_local_admin_url(&url));
    }

    #[test]
    fn release_windows_build_uses_gui_subsystem() {
        let source = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join("main.rs"),
        )
        .expect("read main.rs");

        assert!(source.contains("windows_subsystem = \"windows\""));
    }

    #[test]
    fn macos_bundle_enables_node_jit_entitlement() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let tauri_config =
            fs::read_to_string(manifest_dir.join("tauri.conf.json")).expect("read tauri config");
        let entitlements =
            fs::read_to_string(manifest_dir.join("entitlements.plist")).expect("read entitlements");

        assert!(tauri_config.contains(r#""entitlements": "entitlements.plist""#));
        assert!(entitlements.contains("<key>com.apple.security.cs.allow-jit</key>"));
        assert!(entitlements.contains("<true/>"));
    }

    #[test]
    fn syncs_runtime_dependencies_when_integrity_marker_is_missing() {
        let source = tempfile::tempdir().expect("source tempdir");
        let destination = tempfile::tempdir().expect("destination tempdir");
        fs::write(source.path().join("package-lock.json"), "same-lock").expect("source lock");
        fs::write(destination.path().join("package-lock.json"), "same-lock")
            .expect("destination lock");
        fs::create_dir_all(source.path().join("node_modules").join("new-dependency"))
            .expect("source dependency");
        fs::write(
            source
                .path()
                .join("node_modules")
                .join(DEPENDENCY_MARKER_FILE),
            "new-marker",
        )
        .expect("source dependency marker");
        fs::write(
            source
                .path()
                .join("node_modules")
                .join("new-dependency")
                .join("index.js"),
            "module.exports = true;",
        )
        .expect("source dependency file");
        fs::create_dir_all(
            destination
                .path()
                .join("node_modules")
                .join("old-dependency"),
        )
        .expect("destination dependency");

        sync_runtime_resources(source.path(), destination.path()).expect("sync resources");

        assert!(
            destination
                .path()
                .join("node_modules")
                .join("new-dependency")
                .join("index.js")
                .exists()
        );
        assert!(
            !destination
                .path()
                .join("node_modules")
                .join("old-dependency")
                .exists()
        );
        assert_eq!(
            fs::read_to_string(destination.path().join("package-lock.json")).expect("synced lock"),
            "same-lock"
        );
    }

    #[test]
    fn keeps_runtime_dependencies_when_integrity_marker_is_unchanged() {
        let source = tempfile::tempdir().expect("source tempdir");
        let destination = tempfile::tempdir().expect("destination tempdir");
        fs::write(source.path().join("package-lock.json"), "same-lock").expect("source lock");
        fs::write(destination.path().join("package-lock.json"), "same-lock")
            .expect("destination lock");
        fs::create_dir_all(
            source
                .path()
                .join("node_modules")
                .join("bundled-dependency"),
        )
        .expect("source dependency");
        fs::write(
            source
                .path()
                .join("node_modules")
                .join(DEPENDENCY_MARKER_FILE),
            "same-marker",
        )
        .expect("source dependency marker");
        fs::create_dir_all(
            destination
                .path()
                .join("node_modules")
                .join("runtime-marker"),
        )
        .expect("runtime marker");
        fs::write(
            destination
                .path()
                .join("node_modules")
                .join(DEPENDENCY_MARKER_FILE),
            "same-marker",
        )
        .expect("destination dependency marker");

        sync_runtime_resources(source.path(), destination.path()).expect("sync resources");

        assert!(
            destination
                .path()
                .join("node_modules")
                .join("runtime-marker")
                .exists()
        );
        assert!(
            !destination
                .path()
                .join("node_modules")
                .join("bundled-dependency")
                .exists()
        );
    }

    #[test]
    fn tails_last_lines() {
        let temp = tempfile::tempdir().expect("tempdir");
        let log = temp.path().join("openai.log");
        fs::write(&log, "a\nb\nc\nd\n").expect("write log");
        assert_eq!(tail_text(&log, 2), "c\nd");
    }
}
