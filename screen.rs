// screen.rs — Screen Capture + Input Injection
// ==============================================
// Replaces AnyDesk/TeamViewer with our own layer.
// Host captures screen → streams via WebRTC video track.
// Remote sends mouse/keyboard → injected on host OS.
//
// Mac:  ScreenCaptureKit (macOS 12.3+) → H.264 → WebRTC
//       CGEventPost for mouse/keyboard injection
//
// Win:  Desktop Duplication API (DXGI) → H.264 → WebRTC
//       SendInput() for mouse/keyboard injection

use crate::ipc::KeyModifiers;

// ── Screen Capture ─────────────────────────────────────────
pub fn start_capture(window_title: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    return start_capture_mac(window_title);

    #[cfg(target_os = "windows")]
    return start_capture_win(window_title);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Screen capture not supported on this platform".into())
}

pub fn stop_capture() {
    #[cfg(target_os = "macos")]
    stop_capture_mac();

    #[cfg(target_os = "windows")]
    stop_capture_win();
}

// ── macOS: ScreenCaptureKit ────────────────────────────────
// No kext. Uses Apple's official API (macOS 12.3+).
// Requires: Screen Recording permission in System Settings.
// User grants once → saved. No workaround.
#[cfg(target_os = "macos")]
fn start_capture_mac(window_title: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    use objc2::runtime::NSObject;
    use objc2_foundation::{NSString, NSArray};

    println!("[Screen] ScreenCaptureKit starting: {:?}", window_title);

    // SCShareableContent.getShareableContent → pick display/window
    // SCStream with SCStreamConfiguration:
    //   width: 1920, height: 1080, minimumFrameInterval: 1/60
    //   pixelFormat: BGRA, preservesAspectRatio: true
    // SCStreamDelegate.didOutputSampleBuffer → CMSampleBuffer
    //   → VTCompressionSession (H.264) → NAL units
    //   → WebRTC video track via DataChannel or RTP

    // Permission check
    let authorized = check_screen_permission_mac();
    if !authorized {
        request_screen_permission_mac();
        return Err("Screen Recording permission required".into());
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn check_screen_permission_mac() -> bool {
    // CGPreflightScreenCaptureAccess()
    unsafe {
        let result: bool = msg_send![class!(NSObject), preflightScreenCaptureAccess];
        result
    }
}

#[cfg(target_os = "macos")]
fn request_screen_permission_mac() {
    // CGRequestScreenCaptureAccess() — opens System Settings
    println!("[Screen] Requesting Screen Recording permission...");
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn().ok();
}

#[cfg(target_os = "macos")]
fn stop_capture_mac() {
    println!("[Screen] ScreenCaptureKit stopped");
}

// ── Windows: Desktop Duplication API ──────────────────────
// Built into Windows 8+. Zero install. High performance.
// Captures GPU output directly — DAW UI included.
#[cfg(target_os = "windows")]
fn start_capture_win(window_title: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Graphics::Direct3D11::*;

    println!("[Screen] Desktop Duplication API starting: {:?}", window_title);

    // IDXGIFactory → EnumAdapters → EnumOutputs
    // IDXGIOutput1.DuplicateOutput → IDXGIOutputDuplication
    // AcquireNextFrame → IDXGIResource → ID3D11Texture2D
    // → CPU copy → H.264 encode (MFT or x264)
    // → WebRTC video track

    Ok(())
}

#[cfg(target_os = "windows")]
fn stop_capture_win() {
    println!("[Screen] Desktop Duplication stopped");
}

// ── Mouse Injection ────────────────────────────────────────
pub fn inject_mouse(
    kind: &str,
    x_norm: f64,   // 0.0 - 1.0 normalized
    y_norm: f64,
    button: Option<u8>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Convert normalized coords to screen pixels
    let (screen_w, screen_h) = get_screen_size();
    let x = (x_norm * screen_w as f64) as i32;
    let y = (y_norm * screen_h as f64) as i32;

    #[cfg(target_os = "macos")]
    return inject_mouse_mac(kind, x, y, button);

    #[cfg(target_os = "windows")]
    return inject_mouse_win(kind, x, y, button);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Mouse injection not supported".into())
}

#[cfg(target_os = "macos")]
fn inject_mouse_mac(kind: &str, x: i32, y: i32, button: Option<u8>) -> Result<(), Box<dyn std::error::Error>> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;
    use core_graphics::geometry::CGPoint;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)?;
    let point  = CGPoint { x: x as f64, y: y as f64 };

    let event_type = match kind {
        "mousemove" => CGEventType::MouseMoved,
        "mousedown" => if button == Some(2) { CGEventType::RightMouseDown } else { CGEventType::LeftMouseDown },
        "mouseup"   => if button == Some(2) { CGEventType::RightMouseUp   } else { CGEventType::LeftMouseUp   },
        "scroll"    => CGEventType::ScrollWheel,
        _ => return Ok(()),
    };

    let event = CGEvent::new_mouse_event(source, event_type, point, CGMouseButton::Left)?;
    event.post(CGEventTapLocation::HID);
    Ok(())
}

#[cfg(target_os = "windows")]
fn inject_mouse_win(kind: &str, x: i32, y: i32, button: Option<u8>) -> Result<(), Box<dyn std::error::Error>> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    let (screen_w, screen_h) = get_screen_size();
    let abs_x = (x * 65536 / screen_w as i32) as i32;
    let abs_y = (y * 65536 / screen_h as i32) as i32;

    let (flags, data) = match kind {
        "mousemove" => (MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0u32),
        "mousedown" => (MOUSEEVENTF_LEFTDOWN, 0),
        "mouseup"   => (MOUSEEVENTF_LEFTUP, 0),
        "scroll"    => (MOUSEEVENTF_WHEEL, 120u32), // one notch
        _ => return Ok(()),
    };

    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: abs_x, dy: abs_y,
                mouseData: data,
                dwFlags: flags,
                time: 0, dwExtraInfo: 0,
            }
        }
    };

    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32); }
    Ok(())
}

// ── Keyboard Injection ─────────────────────────────────────
pub fn inject_key(
    kind: &str,
    key: &str,
    modifiers: KeyModifiers,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    return inject_key_mac(kind, key, modifiers);

    #[cfg(target_os = "windows")]
    return inject_key_win(kind, key, modifiers);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Keyboard injection not supported".into())
}

#[cfg(target_os = "macos")]
fn inject_key_mac(kind: &str, key: &str, modifiers: KeyModifiers) -> Result<(), Box<dyn std::error::Error>> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;

    let source    = CGEventSource::new(CGEventSourceStateID::HIDSystemState)?;
    let key_code  = key_to_vkcode_mac(key);
    let key_down  = kind == "keydown";

    let mut flags = CGEventFlags::empty();
    if modifiers.ctrl  { flags |= CGEventFlags::CGEventFlagControl;  }
    if modifiers.shift { flags |= CGEventFlags::CGEventFlagShift;     }
    if modifiers.alt   { flags |= CGEventFlags::CGEventFlagAlternate; }
    if modifiers.meta  { flags |= CGEventFlags::CGEventFlagCommand;   }

    let event = CGEvent::new_keyboard_event(source, key_code, key_down)?;
    event.set_flags(flags);
    event.post(CGEventTapLocation::HID);
    Ok(())
}

#[cfg(target_os = "windows")]
fn inject_key_win(kind: &str, key: &str, modifiers: KeyModifiers) -> Result<(), Box<dyn std::error::Error>> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    let vk    = key_to_vkcode_win(key);
    let flags = if kind == "keyup" { KEYEVENTF_KEYUP } else { KEYEVENTF_EXTENDEDKEY };

    let mut inputs = Vec::new();

    // Modifier down
    if modifiers.ctrl  { inputs.push(make_key_input(VK_CONTROL.0, KEYEVENTF_EXTENDEDKEY)); }
    if modifiers.shift { inputs.push(make_key_input(VK_SHIFT.0,   KEYEVENTF_EXTENDEDKEY)); }
    if modifiers.alt   { inputs.push(make_key_input(VK_MENU.0,    KEYEVENTF_EXTENDEDKEY)); }
    if modifiers.meta  { inputs.push(make_key_input(VK_LWIN.0,    KEYEVENTF_EXTENDEDKEY)); }

    // Main key
    inputs.push(make_key_input(vk, flags));

    // Modifier up
    if modifiers.ctrl  { inputs.push(make_key_input(VK_CONTROL.0, KEYEVENTF_KEYUP)); }
    if modifiers.shift { inputs.push(make_key_input(VK_SHIFT.0,   KEYEVENTF_KEYUP)); }
    if modifiers.alt   { inputs.push(make_key_input(VK_MENU.0,    KEYEVENTF_KEYUP)); }
    if modifiers.meta  { inputs.push(make_key_input(VK_LWIN.0,    KEYEVENTF_KEYUP)); }

    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32); }
    Ok(())
}

// ── Key code mapping ───────────────────────────────────────
#[cfg(target_os = "macos")]
fn key_to_vkcode_mac(key: &str) -> u16 {
    match key {
        " " => 49,  "a" => 0,  "b" => 11, "c" => 8,  "d" => 2,
        "e" => 14,  "f" => 3,  "g" => 5,  "h" => 4,  "i" => 34,
        "j" => 38,  "k" => 40, "l" => 37, "m" => 46, "n" => 45,
        "o" => 31,  "p" => 35, "q" => 12, "r" => 15, "s" => 1,
        "t" => 17,  "u" => 32, "v" => 9,  "w" => 13, "x" => 7,
        "y" => 16,  "z" => 6,
        "Return" => 36, "Backspace" => 51, "Tab" => 48,
        "Escape" => 53, "Delete" => 117,
        "ArrowLeft" => 123, "ArrowRight" => 124, "ArrowDown" => 125, "ArrowUp" => 126,
        "F1"=>122,"F2"=>120,"F3"=>99,"F4"=>118,"F5"=>96,"F6"=>97,"F7"=>98,"F8"=>100,
        _ => 0,
    }
}

#[cfg(target_os = "windows")]
fn key_to_vkcode_win(key: &str) -> u16 {
    match key {
        " " => 0x20, "Return" => 0x0D, "Backspace" => 0x08, "Tab" => 0x09,
        "Escape" => 0x1B, "Delete" => 0x2E,
        "ArrowLeft" => 0x25, "ArrowRight" => 0x27,
        "ArrowDown" => 0x28, "ArrowUp" => 0x26,
        k if k.len() == 1 => k.chars().next().unwrap().to_ascii_uppercase() as u16,
        _ => 0,
    }
}

#[cfg(target_os = "windows")]
fn make_key_input(vk: u16, flags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS) -> windows::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } }
    }
}

// ── Screen size ────────────────────────────────────────────
fn get_screen_size() -> (u32, u32) {
    #[cfg(target_os = "macos")]
    unsafe {
        let screen = NSScreen::mainScreen(nil);
        let frame  = NSScreen::frame(screen);
        return (frame.size.width as u32, frame.size.height as u32);
    }

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::*;
        let w = GetSystemMetrics(SM_CXSCREEN) as u32;
        let h = GetSystemMetrics(SM_CYSCREEN) as u32;
        return (w, h);
    }

    (1920, 1080)
}
