// ipc.rs — IPC Types shared between Rust ↔ JS
// =============================================
// All structs here are serializable via serde.
// These are the "contracts" between frontend and backend.

use serde::{Deserialize, Serialize};

// ── Key modifiers (sent from JS RemoteControl) ─────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyModifiers {
    pub ctrl:  bool,
    pub shift: bool,
    pub alt:   bool,
    pub meta:  bool,
}

impl Default for KeyModifiers {
    fn default() -> Self {
        Self { ctrl: false, shift: false, alt: false, meta: false }
    }
}

// ── Mouse event from remote ────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MouseEvent {
    pub kind:   String,   // "mousemove" | "mousedown" | "mouseup" | "scroll" | "dblclick"
    pub x:      f64,      // normalized 0.0–1.0
    pub y:      f64,
    pub button: Option<u8>, // 0=left, 1=middle, 2=right
    pub dx:     Option<f64>, // scroll delta
    pub dy:     Option<f64>,
}

// ── Keyboard event from remote ─────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEvent {
    pub kind:      String,       // "keydown" | "keyup"
    pub key:       String,       // "a", "Space", "ArrowLeft", etc.
    pub code:      String,       // "KeyA", "Space", etc.
    pub modifiers: KeyModifiers,
}

// ── DAW command ────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DawCommand {
    pub action: String,
    pub target: Option<String>,   // track name/index
    pub value:  Option<f64>,
    pub param:  Option<String>,
}

// ── Session event (emitted to frontend) ───────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub kind:    String,
    pub payload: serde_json::Value,
    pub ts:      u64,
}

// ── Peer info ──────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id:        String,
    pub name:      String,
    pub role:      String,   // "host" | "collaborator" | "listener"
    pub latency:   u32,
    pub connected: bool,
}

// ── Audio stream config ────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    pub device_id:   String,
    pub sample_rate: u32,
    pub channels:    u16,
    pub bit_depth:   u16,
    pub codec:       String,   // "opus" | "pcm"
    pub bitrate:     u32,      // kbps
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            device_id:   "default".to_string(),
            sample_rate: 48000,
            channels:    2,
            bit_depth:   24,
            codec:       "opus".to_string(),
            bitrate:     256,
        }
    }
}

// ── Screen capture config ──────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenConfig {
    pub fps:    u32,
    pub width:  u32,
    pub height: u32,
    pub codec:  String,   // "h264" | "h265" | "vp9"
    pub cursor: bool,
}

impl Default for ScreenConfig {
    fn default() -> Self {
        Self {
            fps:    30,
            width:  1920,
            height: 1080,
            codec:  "h264".to_string(),
            cursor: true,
        }
    }
}

// ── Subscription info ──────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub valid:      bool,
    pub plan:       String,    // "free" | "pro" | "team"
    pub expires_at: Option<u64>,
    pub features:   Vec<String>,
}

impl Default for Subscription {
    fn default() -> Self {
        Self {
            valid:      false,
            plan:       "free".to_string(),
            expires_at: None,
            features:   vec![],
        }
    }
}
