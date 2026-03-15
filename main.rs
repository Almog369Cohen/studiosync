// StudioSync Desktop — Tauri App
// ================================
// This is the PRO tier desktop app.
// Free tier = web only (browser).
// Pro tier  = this app (Host only).
//
// What this does that the browser CANNOT:
//   1. Virtual Audio Device (CoreAudio / WASAPI)
//   2. Full screen capture + mouse/keyboard injection
//   3. DAW control via OSC/MIDI without browser permissions
//   4. System tray — runs in background while you work in DAW
//   5. Auto-start with DAW detection

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem, WindowBuilder, WindowUrl,
};
use std::sync::{Arc, Mutex};

mod audio;
mod screen;
mod daw_bridge;
mod virtual_device;
mod ipc;

// ── Global app state ──────────────────────────────────────
#[derive(Default)]
pub struct AppState {
    pub session_code:    Option<String>,
    pub audio_streaming: bool,
    pub screen_sharing:  bool,
    pub daw_connected:   bool,
    pub daw_type:        Option<String>,
    pub peer_count:      u32,
    pub tier:            Tier,
}

#[derive(Default, PartialEq)]
pub enum Tier {
    #[default]
    Free,
    Pro,
}

// ── Tauri Commands (called from frontend JS via invoke) ───
#[tauri::command]
async fn start_audio_capture(
    device_name: Option<String>,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<String, String> {
    let device = device_name.unwrap_or_else(|| "StudioSync Virtual".to_string());
    
    match audio::start_capture(&device) {
        Ok(stream_id) => {
            state.lock().unwrap().audio_streaming = true;
            Ok(stream_id)
        }
        Err(e) => Err(format!("Audio capture failed: {}", e))
    }
}

#[tauri::command]
async fn stop_audio_capture(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    audio::stop_capture();
    state.lock().unwrap().audio_streaming = false;
    Ok(())
}

#[tauri::command]
async fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    audio::list_devices().map_err(|e| e.to_string())
}

#[tauri::command]
async fn install_virtual_device() -> Result<String, String> {
    virtual_device::install()
        .map(|_| "StudioSync Virtual Audio Device installed".to_string())
        .map_err(|e| format!("Install failed: {}", e))
}

#[tauri::command]
async fn check_virtual_device() -> Result<bool, String> {
    Ok(virtual_device::is_installed())
}

#[tauri::command]
async fn start_screen_capture(
    window_title: Option<String>,
) -> Result<(), String> {
    screen::start_capture(window_title.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn inject_mouse_event(
    kind: String,
    x: f64,
    y: f64,
    button: Option<u8>,
) -> Result<(), String> {
    screen::inject_mouse(&kind, x, y, button)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn inject_key_event(
    kind: String,
    key: String,
    modifiers: ipc::KeyModifiers,
) -> Result<(), String> {
    screen::inject_key(&kind, &key, modifiers)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_daw(
    daw_type: String,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<String, String> {
    match daw_bridge::connect(&daw_type) {
        Ok(protocol) => {
            let mut s = state.lock().unwrap();
            s.daw_connected = true;
            s.daw_type = Some(daw_type);
            Ok(protocol)
        }
        Err(e) => Err(e.to_string())
    }
}

#[tauri::command]
async fn send_daw_command(
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    daw_bridge::send_command(&command, args)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_session_info(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.lock().unwrap();
    Ok(serde_json::json!({
        "code":           s.session_code,
        "audioStreaming": s.audio_streaming,
        "screenSharing":  s.screen_sharing,
        "dawConnected":   s.daw_connected,
        "dawType":        s.daw_type,
        "peerCount":      s.peer_count,
        "tier":           if s.tier == Tier::Pro { "pro" } else { "free" },
    }))
}

#[tauri::command]
async fn check_subscription() -> Result<serde_json::Value, String> {
    // In production: call our API to validate subscription
    // POST https://api.studiosync.io/subscription/validate
    // Returns: { valid: bool, plan: "pro"|"team", expiresAt: timestamp }
    Ok(serde_json::json!({
        "valid": true,
        "plan":  "pro",
        "features": ["audio_driver", "screen_share", "remote_control", "recording"]
    }))
}

// ── Audio Device struct ───────────────────────────────────
#[derive(serde::Serialize)]
pub struct AudioDevice {
    pub id:          String,
    pub name:        String,
    pub is_virtual:  bool,
    pub is_input:    bool,
    pub sample_rate: u32,
    pub channels:    u16,
}

// ── System Tray ───────────────────────────────────────────
fn build_tray() -> SystemTray {
    let open     = CustomMenuItem::new("open",    "פתח StudioSync");
    let session  = CustomMenuItem::new("session", "סשן פעיל: ---");
    let quit     = CustomMenuItem::new("quit",    "סגור");

    let menu = SystemTrayMenu::new()
        .add_item(open)
        .add_item(session)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);

    SystemTray::new().with_menu(menu)
}

fn handle_tray_event(app: &tauri::AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::DoubleClick { .. } => {
            if let Some(win) = app.get_window("main") {
                win.show().ok();
                win.set_focus().ok();
            }
        }
        SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
            "open" => {
                if let Some(win) = app.get_window("main") {
                    win.show().ok();
                }
            }
            "quit" => {
                audio::stop_capture();
                daw_bridge::disconnect();
                std::process::exit(0);
            }
            _ => {}
        },
        _ => {}
    }
}

// ── Main ──────────────────────────────────────────────────
fn main() {
    let state = Arc::new(Mutex::new(AppState::default()));

    tauri::Builder::default()
        .manage(state)
        .system_tray(build_tray())
        .on_system_tray_event(handle_tray_event)
        .invoke_handler(tauri::generate_handler![
            start_audio_capture,
            stop_audio_capture,
            list_audio_devices,
            install_virtual_device,
            check_virtual_device,
            start_screen_capture,
            inject_mouse_event,
            inject_key_event,
            connect_daw,
            send_daw_command,
            get_session_info,
            check_subscription,
        ])
        .setup(|app| {
            // On startup: check for DAW process running
            daw_bridge::detect_running_daw(app.app_handle());

            // Hide window from dock on Mac (tray-only mode)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .on_window_event(|event| {
            // Minimize to tray instead of closing
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().ok();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("StudioSync failed to start");
}
