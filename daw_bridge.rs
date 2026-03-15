// daw_bridge.rs — DAW Bridge
// ===========================
// Detects and connects to running DAW processes.
// Sends/receives OSC and MIDI commands.
//
// Ableton Live  → AbletonOSC (UDP 11000)
// Logic Pro     → OSC Control Surface (UDP 8000)
// Cubase        → MIDI Remote JS API (virtual port)
// FL Studio     → MIDI CC + MMC (virtual port)
// Pro Tools     → HUI protocol (virtual MIDI port)

use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use serde_json::Value;
use tauri::AppHandle;

// ── DAW state ─────────────────────────────────────────────
static CONNECTED_DAW: std::sync::OnceLock<Arc<Mutex<Option<DawConnection>>>> =
    std::sync::OnceLock::new();

fn get_state() -> &'static Arc<Mutex<Option<DawConnection>>> {
    CONNECTED_DAW.get_or_init(|| Arc::new(Mutex::new(None)))
}

#[derive(Debug, Clone)]
pub struct DawConnection {
    pub daw_type: String,
    pub protocol: String,
    pub osc_port: Option<u16>,
}

// ── Supported DAW configs ─────────────────────────────────
struct DawConfig {
    osc_recv_port: u16,
    osc_send_port: u16,
    process_names: &'static [&'static str],
}

fn get_daw_config(daw_type: &str) -> DawConfig {
    match daw_type {
        "ableton"   => DawConfig {
            osc_recv_port: 11000,
            osc_send_port: 11001,
            process_names: &["Ableton Live", "Live"],
        },
        "logic"     => DawConfig {
            osc_recv_port: 8000,
            osc_send_port: 8001,
            process_names: &["Logic Pro X", "Logic Pro"],
        },
        "cubase"    => DawConfig {
            osc_recv_port: 7000,
            osc_send_port: 7001,
            process_names: &["Cubase", "Nuendo"],
        },
        "fl"        => DawConfig {
            osc_recv_port: 9000,
            osc_send_port: 9001,
            process_names: &["FL Studio"],
        },
        "protools"  => DawConfig {
            osc_recv_port: 5010,
            osc_send_port: 5011,
            process_names: &["Pro Tools"],
        },
        _           => DawConfig {
            osc_recv_port: 11000,
            osc_send_port: 11001,
            process_names: &[],
        },
    }
}

// ── Connect ────────────────────────────────────────────────
pub fn connect(daw_type: &str) -> Result<String, Box<dyn std::error::Error>> {
    let config   = get_daw_config(daw_type);
    let protocol = get_protocol(daw_type);

    // Test OSC connection with a ping
    let connected = test_osc_connection(config.osc_recv_port)?;

    if connected {
        let conn = DawConnection {
            daw_type: daw_type.to_string(),
            protocol: protocol.to_string(),
            osc_port: Some(config.osc_recv_port),
        };
        *get_state().lock().unwrap() = Some(conn);

        // Start listener thread for DAW → StudioSync events
        start_osc_listener(config.osc_recv_port);

        println!("[DAW] Connected: {} via {} on port {}",
            daw_type, protocol, config.osc_recv_port);

        Ok(protocol.to_string())
    } else {
        Err(format!("Could not connect to {} on port {}", daw_type, config.osc_recv_port).into())
    }
}

fn get_protocol(daw_type: &str) -> &'static str {
    match daw_type {
        "ableton"  | "logic" => "osc",
        "cubase"   | "fl"    => "midi",
        "protools"           => "hui",
        _                    => "osc",
    }
}

// ── Test OSC connection ────────────────────────────────────
fn test_osc_connection(port: u16) -> Result<bool, Box<dyn std::error::Error>> {
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.set_read_timeout(Some(std::time::Duration::from_millis(500)))?;

    // Send a simple ping (Ableton-compatible)
    let ping_packet = build_osc_packet("/ping", &[]);
    socket.send_to(&ping_packet, format!("127.0.0.1:{}", port))?;

    let mut buf = [0u8; 512];
    match socket.recv_from(&mut buf) {
        Ok(_)  => Ok(true),
        Err(_) => Ok(false),  // timeout = DAW not responding, but we continue
    }
}

// ── OSC listener thread ────────────────────────────────────
fn start_osc_listener(recv_port: u16) {
    std::thread::spawn(move || {
        let socket = match UdpSocket::bind(format!("0.0.0.0:{}", recv_port + 1)) {
            Ok(s)  => s,
            Err(e) => { eprintln!("[DAW] Listener bind failed: {}", e); return; }
        };

        println!("[DAW] OSC listener on port {}", recv_port + 1);
        let mut buf = [0u8; 4096];

        loop {
            match socket.recv_from(&mut buf) {
                Ok((len, _addr)) => {
                    if let Ok(msg) = parse_osc_packet(&buf[..len]) {
                        handle_daw_event(msg);
                    }
                }
                Err(e) => {
                    eprintln!("[DAW] Listener error: {}", e);
                    break;
                }
            }
        }
    });
}

// ── Send command to DAW ────────────────────────────────────
pub fn send_command(command: &str, args: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let state = get_state().lock().unwrap();
    let conn  = state.as_ref().ok_or("No DAW connected")?;
    let config = get_daw_config(&conn.daw_type);

    match conn.protocol.as_str() {
        "osc"  => send_osc_command(&conn.daw_type, command, &args, config.osc_recv_port),
        "midi" => send_midi_command(&conn.daw_type, command, &args),
        "hui"  => send_hui_command(command, &args),
        _      => Err("Unknown protocol".into()),
    }
}

// ── OSC command builder ────────────────────────────────────
fn send_osc_command(
    daw_type: &str,
    command: &str,
    args: &Value,
    port: u16,
) -> Result<Value, Box<dyn std::error::Error>> {
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    let addr   = format!("127.0.0.1:{}", port);

    // Map command name to DAW-specific OSC path
    let osc_path = map_command_to_osc(daw_type, command, args);

    if let Some((path, osc_args)) = osc_path {
        let packet = build_osc_packet(&path, &osc_args);
        socket.send_to(&packet, &addr)?;
        println!("[DAW] OSC → {} {}", path, osc_args_to_string(&osc_args));
    }

    Ok(Value::Null)
}

fn map_command_to_osc(
    daw_type: &str,
    command: &str,
    args: &Value,
) -> Option<(String, Vec<OscArg>)> {
    match daw_type {
        "ableton" => map_ableton_osc(command, args),
        "logic"   => map_logic_osc(command, args),
        _         => None,
    }
}

// ── Ableton OSC mapping ────────────────────────────────────
fn map_ableton_osc(command: &str, args: &Value) -> Option<(String, Vec<OscArg>)> {
    match command {
        "play"         => Some(("/live/song/start_playing".into(), vec![])),
        "stop"         => Some(("/live/song/stop_playing".into(),  vec![])),
        "record"       => Some(("/live/song/record".into(), vec![
            OscArg::Int(args.get("on").and_then(|v| v.as_bool()).unwrap_or(false) as i32)
        ])),
        "set_tempo"    => Some(("/live/song/set/tempo".into(), vec![
            OscArg::Float(args.get("value").and_then(|v| v.as_f64()).unwrap_or(120.0) as f32)
        ])),
        "track_volume" => {
            let index = args.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
            let value = args.get("value").and_then(|v| v.as_f64()).unwrap_or(0.5);
            Some((format!("/live/track/{}/set/volume", index), vec![OscArg::Float(value as f32)]))
        }
        "track_mute"   => {
            let index = args.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
            let value = args.get("value").and_then(|v| v.as_bool()).unwrap_or(false);
            Some((format!("/live/track/{}/set/mute", index), vec![OscArg::Int(value as i32)]))
        }
        "track_solo"   => {
            let index = args.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
            let value = args.get("value").and_then(|v| v.as_bool()).unwrap_or(false);
            Some((format!("/live/track/{}/set/solo", index), vec![OscArg::Int(value as i32)]))
        }
        "track_arm"    => {
            let index = args.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
            let value = args.get("value").and_then(|v| v.as_bool()).unwrap_or(false);
            Some((format!("/live/track/{}/set/arm", index), vec![OscArg::Int(value as i32)]))
        }
        "clip_launch"  => {
            let track = args.get("track").and_then(|v| v.as_i64()).unwrap_or(0);
            let slot  = args.get("slot").and_then(|v| v.as_i64()).unwrap_or(0);
            Some((format!("/live/clip_slot/{}/{}/fire", track, slot), vec![]))
        }
        "rewind"       => Some(("/live/song/set/current_song_time".into(), vec![OscArg::Float(0.0)])),
        _              => None,
    }
}

// ── Logic OSC mapping ──────────────────────────────────────
fn map_logic_osc(command: &str, args: &Value) -> Option<(String, Vec<OscArg>)> {
    match command {
        "play"         => Some(("/mixer/play".into(),  vec![])),
        "stop"         => Some(("/mixer/stop".into(),  vec![])),
        "record"       => Some(("/mixer/record".into(), vec![])),
        "set_tempo"    => Some(("/mixer/tempo".into(), vec![
            OscArg::Float(args.get("value").and_then(|v| v.as_f64()).unwrap_or(120.0) as f32)
        ])),
        "track_volume" => {
            let idx = args.get("index").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
            let val = args.get("value").and_then(|v| v.as_f64()).unwrap_or(0.8);
            Some((format!("/mixer/volume/volume{}", idx), vec![OscArg::Float(val as f32)]))
        }
        "track_mute"   => {
            let idx = args.get("index").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
            let val = args.get("value").and_then(|v| v.as_bool()).unwrap_or(false);
            Some((format!("/mixer/mute/mute{}", idx), vec![OscArg::Int(val as i32)]))
        }
        _              => None,
    }
}

// ── MIDI command (Cubase/FL) ───────────────────────────────
fn send_midi_command(
    daw_type: &str,
    command: &str,
    args: &Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    // Uses virtual MIDI port — implementation via platform MIDI API
    println!("[DAW] MIDI → {} {} {:?}", daw_type, command, args);
    Ok(Value::Null)
}

// ── HUI command (Pro Tools) ───────────────────────────────
fn send_hui_command(command: &str, args: &Value) -> Result<Value, Box<dyn std::error::Error>> {
    println!("[DAW] HUI → {} {:?}", command, args);
    Ok(Value::Null)
}

// ── Handle events FROM DAW ─────────────────────────────────
#[derive(Debug)]
struct OscMessage {
    address: String,
    args:    Vec<OscArg>,
}

fn handle_daw_event(msg: OscMessage) {
    // In production: emit Tauri event to frontend
    // app.emit_all("daw-event", payload)
    println!("[DAW] ← {} {:?}", msg.address, msg.args);
}

// ── Auto-detect running DAW on startup ────────────────────
pub fn detect_running_daw(app: AppHandle) {
    std::thread::spawn(move || {
        let daw_processes = [
            ("Ableton Live",    "ableton"),
            ("Logic Pro",       "logic"),
            ("Logic Pro X",     "logic"),
            ("Cubase",          "cubase"),
            ("FL Studio",       "fl"),
            ("Pro Tools",       "protools"),
        ];

        for (process_name, daw_id) in &daw_processes {
            if is_process_running(process_name) {
                println!("[DAW] Detected running: {}", process_name);
                // Emit event to frontend
                app.emit_all("daw-detected", serde_json::json!({
                    "daw": daw_id,
                    "name": process_name,
                })).ok();
                break;
            }
        }
    });
}

fn is_process_running(name: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("pgrep")
            .arg("-f").arg(name)
            .output();
        return output.map(|o| o.status.success()).unwrap_or(false);
    }

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {}.exe", name)])
            .output();
        return output
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(name))
            .unwrap_or(false);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    false
}

// ── Disconnect ─────────────────────────────────────────────
pub fn disconnect() {
    *get_state().lock().unwrap() = None;
    println!("[DAW] Disconnected");
}

// ── OSC packet builder (minimal, no external crate) ───────
#[derive(Debug, Clone)]
enum OscArg {
    Int(i32),
    Float(f32),
    String(String),
}

fn build_osc_packet(address: &str, args: &[OscArg]) -> Vec<u8> {
    let mut packet = Vec::new();

    // Address string (null-padded to 4-byte boundary)
    let addr_bytes = address.as_bytes();
    packet.extend_from_slice(addr_bytes);
    packet.push(0); // null terminator
    while packet.len() % 4 != 0 { packet.push(0); }

    // Type tag string
    let mut type_tag = String::from(",");
    for arg in args {
        match arg {
            OscArg::Int(_)    => type_tag.push('i'),
            OscArg::Float(_)  => type_tag.push('f'),
            OscArg::String(_) => type_tag.push('s'),
        }
    }
    packet.extend_from_slice(type_tag.as_bytes());
    packet.push(0);
    while packet.len() % 4 != 0 { packet.push(0); }

    // Arguments
    for arg in args {
        match arg {
            OscArg::Int(v)    => packet.extend_from_slice(&v.to_be_bytes()),
            OscArg::Float(v)  => packet.extend_from_slice(&v.to_bits().to_be_bytes()),
            OscArg::String(s) => {
                packet.extend_from_slice(s.as_bytes());
                packet.push(0);
                while packet.len() % 4 != 0 { packet.push(0); }
            }
        }
    }

    packet
}

fn parse_osc_packet(data: &[u8]) -> Result<OscMessage, Box<dyn std::error::Error>> {
    let null_pos = data.iter().position(|&b| b == 0).unwrap_or(data.len());
    let address  = String::from_utf8(data[..null_pos].to_vec())?;
    Ok(OscMessage { address, args: vec![] })
}

fn osc_args_to_string(args: &[OscArg]) -> String {
    args.iter().map(|a| match a {
        OscArg::Int(v)    => v.to_string(),
        OscArg::Float(v)  => format!("{:.2}", v),
        OscArg::String(s) => s.clone(),
    }).collect::<Vec<_>>().join(" ")
}
