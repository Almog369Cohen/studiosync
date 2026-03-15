// tauri-bridge.js — JS ↔ Tauri Native Bridge
// =============================================
// This file is loaded ONLY in the desktop app (Pro).
// In browser (Free), window.__TAURI__ is undefined
// and all these functions silently do nothing or
// fall back to browser APIs.
//
// Usage in main app:
//   import { TauriBridge } from './tauri-bridge.js'
//   const devices = await TauriBridge.listAudioDevices()

import { invoke }     from '@tauri-apps/api/tauri'
import { listen }     from '@tauri-apps/api/event'
import { appWindow }  from '@tauri-apps/api/window'
import { sendNotification } from '@tauri-apps/api/notification'

// ── Audio ──────────────────────────────────────────────────
export const Audio = {
  async listDevices() {
    return invoke('list_audio_devices')
  },

  async startCapture(deviceName = null) {
    return invoke('start_audio_capture', { device_name: deviceName })
  },

  async stopCapture() {
    return invoke('stop_audio_capture')
  },
}

// ── Virtual Device ─────────────────────────────────────────
export const VirtualDevice = {
  async isInstalled() {
    return invoke('check_virtual_device')
  },

  async install() {
    return invoke('install_virtual_device')
  },
}

// ── Screen Capture ─────────────────────────────────────────
export const Screen = {
  async start(windowTitle = null) {
    return invoke('start_screen_capture', { window_title: windowTitle })
  },
}

// ── Remote Input Injection ─────────────────────────────────
export const Input = {
  async mouse(kind, x, y, button = null) {
    return invoke('inject_mouse_event', { kind, x, y, button })
  },

  async key(kind, key, modifiers = {}) {
    return invoke('inject_key_event', {
      kind, key,
      modifiers: {
        ctrl:  modifiers.ctrl  || false,
        shift: modifiers.shift || false,
        alt:   modifiers.alt   || false,
        meta:  modifiers.meta  || false,
      }
    })
  },
}

// ── DAW Bridge ─────────────────────────────────────────────
export const DAW = {
  async connect(dawType) {
    return invoke('connect_daw', { daw_type: dawType })
  },

  async send(command, args = {}) {
    return invoke('send_daw_command', { command, args })
  },
}

// ── Session Info ───────────────────────────────────────────
export const Session = {
  async getInfo() {
    return invoke('get_session_info')
  },

  async checkSubscription() {
    return invoke('check_subscription')
  },
}

// ── Event Listeners (Rust → JS) ────────────────────────────
export const Events = {
  // Called when Tauri detects a DAW running on startup
  onDawDetected(callback) {
    return listen('daw-detected', event => callback(event.payload))
  },

  // Called when audio device list changes (plug/unplug)
  onDeviceChange(callback) {
    return listen('audio-device-change', event => callback(event.payload))
  },

  // Called when virtual device install completes
  onDriverInstalled(callback) {
    return listen('driver-installed', event => callback(event.payload))
  },

  // Called when DAW sends transport state change
  onDawEvent(callback) {
    return listen('daw-event', event => callback(event.payload))
  },

  // Called on peer connect/disconnect
  onPeerChange(callback) {
    return listen('peer-change', event => callback(event.payload))
  },
}

// ── Window Controls ────────────────────────────────────────
export const Window = {
  async minimize()     { return appWindow.minimize()          },
  async maximize()     { return appWindow.toggleMaximize()    },
  async hide()         { return appWindow.hide()              },  // goes to tray
  async close()        { return appWindow.close()             },
  async setTitle(t)    { return appWindow.setTitle(t)         },
  async setAlwaysOnTop(v) { return appWindow.setAlwaysOnTop(v) },
}

// ── Notifications ──────────────────────────────────────────
export const Notify = {
  async show(title, body, icon = null) {
    return sendNotification({ title, body, icon })
  }
}

// ── Auto-init: listen for DAW events and pipe to app ───────
export async function initTauriBridge() {
  if (!window.__TAURI__) {
    console.log('[Bridge] Running in browser (Free tier)')
    return false
  }

  console.log('[Bridge] Running in Tauri desktop (Pro tier)')

  // Listen for DAW detection
  await Events.onDawDetected(({ daw, name }) => {
    console.log('[Bridge] DAW detected:', name)
    // Auto-select in setup
    const btn = document.getElementById('dawBtn-' + daw)
    if (btn) {
      btn.click()
      window.toast?.('🎛 זיהינו ' + name + ' — נבחר אוטומטית', 'green')
    }
  })

  // Listen for DAW events → pipe to app state
  await Events.onDawEvent(event => {
    if (window.RTC?.handleDAWMessage) {
      window.RTC.handleDAWMessage(event, 'native-daw')
    }
  })

  // Notify system tray of session state changes
  window.addEventListener('session-state-change', async (e) => {
    const { state: s } = e.detail
    if (s === 'live') {
      await Notify.show('StudioSync', 'הסשן פעיל! השותף מחובר 🎛')
    }
  })

  return true
}

// ── Export single object for simple usage ─────────────────
export const TauriBridge = {
  Audio, VirtualDevice, Screen, Input, DAW, Session, Events, Window, Notify,
  init: initTauriBridge,
  isDesktop: !!window.__TAURI__,
}

export default TauriBridge
