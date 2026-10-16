import React, { useState, useEffect, useRef, useCallback, useContext, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Animated,
  StatusBar,
  Platform,
  PermissionsAndroid,
  PanResponder,
  Vibration,
  Alert,
} from 'react-native';

import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy'; // SDK 54 moved getInfoAsync/readAsStringAsync here

import { BleManager, LogLevel, State } from 'react-native-ble-plx';

// ─── BLE UUIDs (must match PhonePeripheral.ino) ──────────────────────────────
const SERVICE_UUID      = '4eeccffa-0893-48bf-bc8f-cd8fb2582adf';
const SENSOR_DATA_UUID  = '3cdac197-9d0d-45cf-a20a-59ef05ada9e2';
const BATTERY_DATA_UUID = '9a411fd3-d1fc-4d4e-804c-63d6d6a84124';
const COMMAND_UUID      = '4c9c9fb1-98e2-48cf-95c0-acf012c8bbf5';
const CONFIG_UUID       = '45d76eff-37fe-484b-aeea-b99581d35375';
const DEVICE_NAME       = 'TetraRadio';

// TEMPORARY: fixed path for manually pushing a real firmware.bin onto the
// device for OTA bench testing (via `adb push` into app-private storage).
// Not part of the real update flow — remove once manifest/download exists.
const TEST_FIRMWARE_PATH = FileSystem.documentDirectory + 'firmware.bin';

// ─── GitHub Releases manifest source ──────────────────────────────────────
// Public repo, no auth needed. The latest release carries three assets:
// firmware.bin (radio), ski_fw.bin (ski controller) and manifest.json, e.g.
// {"radio":"1.0.9","ski":"0.2.0"}. Versions are compared against the manifest,
// not the release tag. Point GITHUB_REPO at a scratch repo to test.
const GITHUB_REPO = 'Jonapulse/TetraskiController';
const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

// ─── BLE OTA UUIDs (must match OTAService.ino) ───────────────────────────────
// in OTAService.ino, and keep both sides in sync.
const OTA_SERVICE_UUID  = 'c076ed50-9e91-4566-9023-3cb1b9173244';
const OTA_CONTROL_UUID  = 'ed3c98b9-0a71-45e0-9b14-b89d3316549d';
const OTA_DATA_UUID     = 'ee191e3a-95c6-4bf1-92b8-1980c9e7b8e9';
const OTA_STATUS_UUID   = '5c8b02e7-5520-468f-bcba-fcc5093da1c9';
const OTA_VERSION_UUID  = 'c82f2a3c-f48c-4cfa-b447-0277467898e4';
const OTA_SKI_VERSION_UUID = 'f937d204-2a79-423d-bddf-e8530aafe87b';

const OTA_CHUNK_PAYLOAD_MAX = 244;
const OTA_TARGET_MTU        = 249;
const OTA_CHUNK_DELAY_MS    = 5;
// The ski image is written to the radio's LittleFS, which is slower than the
// OTA partition, so its chunks are paced further apart.
const OTA_SKI_CHUNK_DELAY_MS = 20;
// Longest wait for the radio to report the relay result. A healthy relay takes
// well under a minute, the radio's own worst-case timeouts add up to more.
const SKI_RELAY_TIMEOUT_MS  = 180000;
// READY is only sent once the radio's main loop is free (mid sensor connect or
// calibration it can be a while). Firmware calibration times out at 40 s.
const OTA_READY_TIMEOUT_MS  = 45000;

// Status codes sent by the radio over OTA_STATUS_UUID — must match the
// OTAStatusCode enum in OTAService.ino.
const OTA_STATUS = {
  READY:     0x01,
  PROGRESS:  0x02,
  DONE:      0x03,
  SKI_STORED:         0x04, // ski image written to the radio and CRC verified
  SKI_RELAY_PROGRESS: 0x10, // + phase(1) + bytesSent(4 LE) + bytesTotal(4 LE)
  SKI_RELAY_OK:       0x11, // + new ski version (ASCII)
  SKI_RELAY_FAIL:     0x12, // + reason(1) + skiNak(1) + known(1) + old ski version (ASCII)
  ERR_SIZE:  0xE0,
  ERR_SEQ:   0xE1,
  ERR_CRC:   0xE2,
  ERR_WRITE: 0xE3,
  ERR_STATE: 0xE4,
  ERR_BEGIN: 0xE5,
};

const OTA_ERROR_MESSAGES = {
  [OTA_STATUS.ERR_SIZE]:  'Firmware too large for OTA partition',
  [OTA_STATUS.ERR_SEQ]:   'Chunk sequence error — dropped or out-of-order packet',
  [OTA_STATUS.ERR_CRC]:   'CRC mismatch — transferred image is corrupt',
  [OTA_STATUS.ERR_WRITE]: 'Flash write failed on radio',
  [OTA_STATUS.ERR_STATE]: 'Radio rejected command for current OTA state',
  [OTA_STATUS.ERR_BEGIN]: 'Radio failed to begin update (Update.begin() failed)',
};

// Must match SkiRelayPhase and SkiUpdateResult in SkiUpdateService.ino.
const SKI_RELAY_PHASES = {
  1: 'Checking image',
  2: 'Entering update mode',
  3: 'Sending to ski',
  4: 'Ski verifying image',
  5: 'Ski installing',
  6: 'Waiting for ski to restart',
};

const SKI_RELAY_FAIL_MESSAGES = {
  1: 'Ski already runs this version or newer',
  2: 'Radio does not know the ski version',
  3: 'No ski image version stored on radio',
  4: 'Ski did not enter update mode',
  5: 'Transfer to ski failed',
  6: 'Ski refused to install the image',
  7: 'Ski did not answer after installing',
  8: 'Ski reports a different version than the image',
  9: 'No ski image stored on radio',
  10: 'Version string not found in the image',
};

// ─── CRC32 (standard CRC-32/IEEE 802.3 — matches ESP-IDF's crc32_le) ─────────
// Table-based, chainable: crc32(bufN, crc32(bufN-1, ..., crc32(buf1, 0)))
// equals crc32(concat(buf1..bufN), 0). We only need the full-buffer form
// here since the firmware chains chunk-wise but the result is identical
// regardless of how the data was split.
let _crc32Table = null;
function getCRC32Table() {
  if (_crc32Table) return _crc32Table;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  _crc32Table = table;
  return table;
}

function crc32(buffer, seed = 0) {
  const table = getCRC32Table();
  let crc = (seed ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < buffer.length; i++) {
    crc = (table[(crc ^ buffer[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ─── Semver comparison ────────────────────────────────────────────────────
// Compares two "MAJOR.MINOR.PATCH" strings. Returns 1 if a > b, -1 if a < b,
// 0 if equal. Missing/non-numeric segments treated as 0. Plain lexicographic
// comparison breaks on "1.10.0" vs "1.9.0" — this compares numerically per
// segment instead. Will be used to decide whether a manifest-advertised
// version is newer than the firmware's currently reported version.
function compareSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

// The ski comparison uses MAJOR.MINOR.PATCH only, so "0.2.0-bench" is "0.2.0".
function semverCore(v) {
  const m = String(v).match(/\d+\.\d+\.\d+/);
  return m ? m[0] : '0.0.0';
}

// The one place a ski update is confirmed before anything is downloaded or
// sent. Resolves true to go ahead.
function confirmSkiUpdate({ from, to }) {
  return new Promise(resolve => {
    Alert.alert(
      'Update ski controller?',
      `Install v${to} (currently v${from}).`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Install', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

const LOGO_LIGHT = require('./assets/logo_light_mode.png');
const LOGO_DARK = require('./assets/logo_dark_mode.png');

// ─── Alarms ───────────────────────────────────────────────────────────────────
// Battery percentages that trigger a low-battery alarm. Edit this list freely —
// each level fires once as a battery drops to or below it.
const LOW_BATTERY_ALARM_LEVELS = [20, 10];
// A battery has to climb this far back above a level before that level can
// fire again, so a reading hovering around a threshold doesn't re-alarm.
const BATTERY_ALARM_REARM_MARGIN = 5;
const ALARM_VIBRATION_PATTERN = [0, 400, 150, 400, 150, 400]; // ms: wait, buzz, pause, ...
const ALARM_SOUND = require('./assets/alarm.wav');
const ALARM_NOTIFICATION_CHANNEL = 'alarms';

// expo-audio is a native module, so it only exists in app builds made after it
// was added. On older builds the require throws and alarms are vibration-only.
let alarmPlayer = null;
try {
  const { createAudioPlayer, setAudioModeAsync } = require('expo-audio');
  setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  alarmPlayer = createAudioPlayer(ALARM_SOUND);
} catch (e) {
  alarmPlayer = null;
}

// Same story for expo-notifications: without the native module there's no
// system notification, only the in-app popup.
let Notifications = null;
try {
  Notifications = require('expo-notifications');
  // While the app is open the popup already explains the alarm, so skip the
  // heads-up banner and just file the message in the notification list.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync(ALARM_NOTIFICATION_CHANNEL, {
      name: 'Alarms',
      importance: Notifications.AndroidImportance.HIGH,
    }).catch(() => {});
  }
} catch (e) {
  Notifications = null;
}

// Vibrate + sound, an in-app popup explaining the issue, and the same message
// posted to the phone's notifications.
function triggerAlarm({ title, message }) {
  Vibration.vibrate(ALARM_VIBRATION_PATTERN);
  try {
    alarmPlayer?.seekTo(0);
    alarmPlayer?.play();
  } catch (e) {
    // Non-fatal — vibration has already fired
  }
  Alert.alert(title, message);
  Notifications?.scheduleNotificationAsync({
    content: { title, body: message },
    trigger: Platform.OS === 'android' ? { channelId: ALARM_NOTIFICATION_CHANNEL } : null,
  }).catch(() => {});
}

// What each alarm tells the user. `batteries` is e.g. ['Left 18%', 'Right 9%'].
const ALARM_MESSAGES = {
  sensorDropped: () => ({
    title: 'Sensor disconnected',
    message: 'The radio has stopped receiving sensor data. Check to see if a sensor was turned off.',
  }),
  sensorBattery: (batteries) => ({
    title: 'Sensor battery low',
    message: `Low sensor battery: ${batteries.join(', ')}. Recharge or swap the sensor soon.`,
  }),
  skiBattery: (level) => ({
    title: 'Ski battery low',
    message: `The ski battery is at ${level}%. Recharge it soon.`,
  }),
};

// Fires an alarm when sensor data drops out and when any battery falls to one
// of LOW_BATTERY_ALARM_LEVELS.
function useAlarms({ radioConnected, sensorDropped, sensorMode, battLevels, skiBattery, addLog }) {
  const prevDroppedRef = useRef(false);
  const alarmedLevelRef = useRef({}); // battery name → lowest level already alarmed

  useEffect(() => {
    if (sensorDropped && !prevDroppedRef.current) {
      triggerAlarm(ALARM_MESSAGES.sensorDropped());
      addLog('ALARM: sensor disconnected');
    }
    prevDroppedRef.current = sensorDropped;
  }, [sensorDropped]);

  // Ask once for permission to post notifications (Android 13+ / iOS).
  useEffect(() => {
    Notifications?.requestPermissionsAsync().catch(() => {});
  }, []);

  useEffect(() => {
    if (!radioConnected) {
      alarmedLevelRef.current = {};
      return;
    }
    const batteries = [
      ['Left', battLevels[0]],
      ['Right', battLevels[1]],
      ...(sensorMode === 4 ? [['Wedge In', battLevels[2]], ['Wedge Out', battLevels[3]]] : []),
      ['Ski', skiBattery],
    ];
    const firedSensors = [];
    let firedSki = null;
    for (const [name, level] of batteries) {
      if (level == null || level <= 0) continue; // 0 / null = no reading yet
      const alarmed = alarmedLevelRef.current[name];
      const reached = LOW_BATTERY_ALARM_LEVELS.filter(t => level <= t);
      const lowest = reached.length ? Math.min(...reached) : null;
      if (lowest !== null && (alarmed === undefined || lowest < alarmed)) {
        alarmedLevelRef.current[name] = lowest;
        if (name === 'Ski') firedSki = level;
        else firedSensors.push(`${name} ${level}%`);
      } else if (alarmed !== undefined && level > alarmed + BATTERY_ALARM_REARM_MARGIN) {
        const held = LOW_BATTERY_ALARM_LEVELS.filter(t => level <= t + BATTERY_ALARM_REARM_MARGIN);
        alarmedLevelRef.current[name] = held.length ? Math.min(...held) : undefined;
      }
    }
    if (firedSensors.length) {
      triggerAlarm(ALARM_MESSAGES.sensorBattery(firedSensors));
      addLog(`ALARM: low sensor battery — ${firedSensors.join(', ')}`);
    }
    if (firedSki !== null) {
      triggerAlarm(ALARM_MESSAGES.skiBattery(firedSki));
      addLog(`ALARM: low ski battery — ${firedSki}%`);
    }
  }, [radioConnected, sensorMode, battLevels, skiBattery]);
}

const ThemeContext = React.createContext(null);

//Initialize BleManager at module level to avoid messy on-dismount destroys
const bleManager = new BleManager();
bleManager.setLogLevel(LogLevel.Verbose);

// ─── Real BLE Hook ────────────────────────────────────────────────────────────
function useBLE() {
  const [state, setState] = useState({
    radioDetected: false,
    radioConnected: false,
    scanning: false,
    connecting: false,
    sensorDropped: false,  //true when sensor data has been silent for >3s
    sensorMode: 2,
    sensitivities: [50, 50, 50, 50],
    invertPair0: false,
    invertPair1: false,
    direction0: 0, val0: 0, val1: 0,
    direction1: 0, val2: 0, val3: 0,
    battLevels: [0, 0, 0, 0],
    skiBattery: null,        // PLACEHOLDER: ski battery %, null until the radio reports it
    log: ['Ready. Press SCAN to find TetraRadio.'],
    serialLog: ['Waiting for serial output from radio controller...'],
    rawLog: [],
    otaStatus: 'idle',       // 'idle' | 'sending' | 'verifying' | 'done' | 'error'
    otaProgress: 0,          // 0..1
    otaBytesSent: 0,
    otaBytesTotal: 0,
    otaError: null,
    firmwareVersion: null,   // read from the radio on connect; used for manifest
                             // compare and to verify a post-OTA reboot landed
                             // on the expected version
    skiVersion: null,        // cached ski version read from the radio, null if unknown
    updateCheck: { status: 'idle', latestVersion: null, downloadUrl: null, size: 0, ski: null, error: null },
                             // status: 'idle' | 'checking' | 'checked' | 'error'
                             // ski: { version, downloadUrl, size } or null
    skiUpdate: { status: 'idle', phase: 0, sent: 0, total: 0, newVersion: null, error: null, known: true, oldVersion: null },
                             // status: 'idle' | 'downloading' | 'sending' | 'relaying' | 'done' | 'error'
    postUpdateStatus: 'idle',
                             // 'idle' | 'reconnecting' | 'verified' | 'mismatch' | 'failed'
                             // — tracks reconnecting after an OTA reboot and
                             // confirming the new version actually took.
  });

  const managerRef   = useRef(bleManager);
  const deviceRef    = useRef(null);
  const scanTimerRef = useRef(null);
  const lastDataTime = useRef(null);
  const subscriptionsRef = useRef({ sensorSub: null, configSub: null, disconnectSub: null, battInterval: null, otaSub: null });
  const disconnectFallbackRef = useRef(null);
  const isConnectingRef = useRef(false);
  const otaAbortRef = useRef(false);
  const otaStatusRef = useRef('idle');
  const pendingVerifyVersionRef = useRef(null);
  const postOtaFailTimeoutRef = useRef(null);

  const prevDirection0 = useRef(0);
  const prevDirection1 = useRef(0);

  const addLog = useCallback((msg) => {
    setState(prev => ({
      ...prev,
      log: [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.log.slice(0, 49)],
    }));
  }, []);

  const resetConnectingGuard = () => { isConnectingRef.current = false; };

  // Removes every listener/interval registered by subscribeToDevice. Must be
  // called on every disconnect path (both user-initiated and unexpected) —
  // otherwise each reconnect stacks another set of listeners onto the
  // underlying native connection, which is what caused "TetraRadio
  // disconnected" to fire multiple times per actual disconnect event.
  const cleanupSubscriptions = useCallback(() => {
    subscriptionsRef.current.sensorSub?.remove();
    subscriptionsRef.current.configSub?.remove();
    subscriptionsRef.current.disconnectSub?.remove();
    subscriptionsRef.current.otaSub?.remove();
    if (subscriptionsRef.current.battInterval) {
      clearInterval(subscriptionsRef.current.battInterval);
    }
    subscriptionsRef.current = { sensorSub: null, configSub: null, disconnectSub: null, battInterval: null, otaSub: null };
  }, []);

  const addSerialLog = useCallback((msg) => {
    setState(prev => ({
      ...prev,
      serialLog: [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.serialLog.slice(0, 49)],
    }));
  }, []);

  // Unlike addSerialLog (transitions only), this records every packet as it
  // arrives, including repeated idle/zero values — mirrors the raw, noisy
  // stream the firmware actually writes to TetraSki via Serial.print().
  const addRawLog = useCallback((msg) => {
    setState(prev => ({
      ...prev,
      rawLog: [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.rawLog.slice(0, 9)],
    }));
  }, []);

  // Human-readable label for a direction byte, matching the firmware's
  // sensorOutputs mapping (see MultiSensorAppTest.ino handleCommand / loop()).
  // pair 0 = left/right, pair 1 = wedge in/out.
  const directionLabel = (byte, pair) => {
    if (pair === 0) return byte === 1 ? 'LEFT' : byte === 2 ? 'RIGHT' : 'IDLE';
    return byte === 3 ? 'WEDGE IN' : byte === 4 ? 'WEDGE OUT' : 'IDLE';
  };

  // Request Android BLE permissions (Android 12+)
  const requestPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') return true;
    const apiLevel = Platform.Version;
    if (apiLevel >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return (
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]    === 'granted' &&
        granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === 'granted' &&
        granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === 'granted'
      );
    } else {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      return granted === 'granted';
    }
  }, []);

  // Subscribe to sensor data notifications and battery reads
  // Reusable so post-OTA verification (reading the version again after a
  // reboot to confirm it actually changed) can share this instead of
  // duplicating the read+decode logic.
  const readFirmwareVersion = useCallback(async (device) => {
    try {
      const char = await device.readCharacteristicForService(OTA_SERVICE_UUID, OTA_VERSION_UUID);
      if (!char?.value) return null;
      return Buffer.from(char.value, 'base64').toString('utf8');
    } catch (e) {
      addLog(`Failed to read firmware version: ${e.message}`);
      return null;
    }
  }, [addLog]);

  // Empty value means the radio has no answer from the ski yet. A radio too
  // old to have this characteristic throws, which also reads as unknown.
  const readSkiVersion = useCallback(async (device) => {
    try {
      const char = await device.readCharacteristicForService(OTA_SERVICE_UUID, OTA_SKI_VERSION_UUID);
      const version = char?.value ? Buffer.from(char.value, 'base64').toString('utf8') : '';
      setState(prev => ({ ...prev, skiVersion: version || null }));
    } catch (e) {
      setState(prev => ({ ...prev, skiVersion: null }));
    }
  }, []);

  const subscribeToDevice = useCallback(async (device) => {
    // Defensive: if subscribeToDevice were ever called again while a previous
    // connection's listeners are still live, this prevents them from stacking.
    cleanupSubscriptions();

    try {
      // Sensor data — NOTIFY characteristic, fires on every Arduino update
      const sensorSub = device.monitorCharacteristicForService(
        SERVICE_UUID,
        SENSOR_DATA_UUID,
        (error, characteristic) => {
          if (error) {
            addLog(`Sensor error: ${error.message}`);
            return;
          }
          if (!characteristic?.value) return;

          // Decode base64 payload:
          // [dir0, val0h, val0l, val1h, val1l, dir1, val2h, val2l, val3h, val3l]
          // Bytes 5-9 are only valid in 4-sensor mode; in 2-sensor mode firmware
          // sends 5 bytes so we guard with length checks.
          const bytes = Buffer.from(characteristic.value, 'base64');
          const direction0 = bytes[0];
          const val0 = (bytes[1] << 8) | bytes[2];
          const val1 = (bytes[3] << 8) | bytes[4];
          const direction1 = bytes.length >= 10 ? bytes[5] : 0;
          const val2 = bytes.length >= 10 ? (bytes[6] << 8) | bytes[7] : 0;
          const val3 = bytes.length >= 10 ? (bytes[8] << 8) | bytes[9] : 0;
          lastDataTime.current = Date.now();

          if (direction0 !== prevDirection0.current) {
            addSerialLog(`Pair0: ${direction0} (${directionLabel(direction0, 0)})`);
            prevDirection0.current = direction0;
          }
          if (bytes.length >= 10 && direction1 !== prevDirection1.current) {
            addSerialLog(`Pair1: ${direction1} (${directionLabel(direction1, 1)})`);
            prevDirection1.current = direction1;
          }
          addRawLog(`Pair0: ${direction0} (${directionLabel(direction0, 0)})  |  Pair1: ${direction1} (${directionLabel(direction1, 1)})`);

          setState(prev => ({
            ...prev,
            direction0, val0, val1,
            direction1, val2, val3,
          }));
        }
      );
      subscriptionsRef.current.sensorSub = sensorSub;

      // Battery — READ characteristic, poll every 5 seconds
      const readBattery = async () => {
        try {
          const battChar = await device.readCharacteristicForService(
            SERVICE_UUID,
            BATTERY_DATA_UUID
          );
          if (battChar?.value) {
            const bytes = Buffer.from(battChar.value, 'base64');
            setState(prev => ({ ...prev, battLevels: [bytes[0], bytes[1], bytes[2] ?? 0, bytes[3] ?? 0] }));
            // TODO: set skiBattery here once the radio includes the ski's
            // battery level in a data packet (firmware doesn't send it yet).
          }
        } catch (e) {
          // Non-fatal — battery read failure doesn't affect sensor data
        }
      };
      readBattery();
      const battInterval = setInterval(readBattery, 5000);
      subscriptionsRef.current.battInterval = battInterval;

      // Clean up all listeners/intervals when device disconnects — whether
      // that's from the user tapping disconnect, an unexpected drop, or (see
      // below) the radio rebooting into new firmware after a completed OTA.
      const disconnectSub = device.onDisconnected(() => {
        clearTimeout(disconnectFallbackRef.current);
        cleanupSubscriptions();
        deviceRef.current = null;
        lastDataTime.current = null;
        prevDirection0.current = 0;
        prevDirection1.current = 0;

        const followsCompletedOta = otaStatusRef.current === 'done';

        setState(prev => ({
          ...prev,
          radioDetected: false,
          radioConnected: false,
          sensorDropped: false,
          direction0: 0, val0: 0, val1: 0,
          direction1: 0, val2: 0, val3: 0,
          battLevels: [0, 0, 0, 0],
          skiBattery: null,
          firmwareVersion: null,
          skiVersion: null,
          postUpdateStatus: followsCompletedOta ? 'reconnecting' : prev.postUpdateStatus,
        }));

        if (followsCompletedOta) {
          addLog('Radio disconnected for reboot — waiting to reconnect and verify...');
          otaStatusRef.current = 'idle'; // consume the signal so a later, unrelated disconnect doesn't retrigger this
        } else {
          addLog('TetraRadio disconnected');
        }
      });
      subscriptionsRef.current.disconnectSub = disconnectSub;

      addLog('Subscribed to sensor data');

      readSkiVersion(device);
      readFirmwareVersion(device).then(version => {
        if (!version) return;
        addLog(`Firmware version: ${version}`);
        setState(prev => ({ ...prev, firmwareVersion: version }));

        // If we were waiting to verify a just-installed version, this read
        // (from the reconnect that just happened) is the verification.
        if (pendingVerifyVersionRef.current) {
          clearTimeout(postOtaFailTimeoutRef.current);
          const expected = pendingVerifyVersionRef.current;
          pendingVerifyVersionRef.current = null;
          if (version === expected) {
            addLog(`Update verified — now running v${version}`);
            setState(prev => ({ ...prev, postUpdateStatus: 'verified' }));
          } else {
            addLog(`Update verification MISMATCH — expected v${expected}, radio reports v${version}`);
            setState(prev => ({ ...prev, postUpdateStatus: 'mismatch' }));
          }
        } else {
          // Manual test-button path, or version read outside any update
          // flow — nothing to assert, just clear a stale 'reconnecting' if
          // one was somehow left over.
          setState(prev => (prev.postUpdateStatus === 'reconnecting' ? { ...prev, postUpdateStatus: 'idle' } : prev));
        }
      });

      // Monitor config characteristic — firmware sends one packet on phone connect
      // with current settings so app display matches firmware state.
      // Packet: [sensorCount, inversionFlags, sens0, sens1, sens2, sens3]
      const configSub = device.monitorCharacteristicForService(
        SERVICE_UUID,
        CONFIG_UUID,
        (error, characteristic) => {
          if (error || !characteristic?.value) return;
          const bytes = Buffer.from(characteristic.value, 'base64');
          if (bytes.length < 6) return;
          const sensorMode   = bytes[0] === 4 ? 4 : 2;
          const invertPair0  = (bytes[1] & 0x01) !== 0;
          const invertPair1  = (bytes[1] & 0x02) !== 0;
          const sensitivities = [bytes[2], bytes[3], bytes[4], bytes[5]];
          setState(prev => ({ ...prev, sensorMode, invertPair0, invertPair1, sensitivities }));
          addLog(`Config synced: ${sensorMode} sensors, inv=[${invertPair0},${invertPair1}], sens=[${sensitivities}]`);
        }
      );
      subscriptionsRef.current.configSub = configSub;
    } catch (e) {
      addLog(`Subscribe error: ${e.message}`);
    }
  }, [addLog, cleanupSubscriptions, addSerialLog, addRawLog, readFirmwareVersion, readSkiVersion]);

  const startScan = useCallback(async () => {
    if (isConnectingRef.current) {
      addLog('Already scanning/connecting — ignoring');
      return;
    }
    
    isConnectingRef.current = true;

    try{
      const hasPermission = await requestPermissions();
      if (!hasPermission) {
        addLog('Bluetooth permissions denied');
        resetConnectingGuard();
        return;
      }

      // Wait for BLE to be powered on
      const bleState = await managerRef.current.state();
      if (bleState !== State.PoweredOn) {
        addLog('Bluetooth is off — please enable it');
        resetConnectingGuard();
        return;
      }

      setState(prev => ({ ...prev, scanning: true, radioDetected: false, radioConnected: false }));
      addLog('Scanning for TetraRadio...');

      // Auto-stop scan after 15 seconds if nothing found
      scanTimerRef.current = setTimeout(() => {
        managerRef.current?.stopDeviceScan();
        setState(prev => ({ ...prev, scanning: false }));
        addLog('Scan timeout — TetraRadio not found');
        resetConnectingGuard();
      }, 15000);

      let handled = false;

      managerRef.current.startDeviceScan(
        [SERVICE_UUID],   // matches PhonePeripheral.ino PHONE_SERVICE_UUID
        null,
        async (error, device) => {
          if (error) {
            addLog(`Scan error: ${error.message}`);
            setState(prev => ({ ...prev, scanning: false }));
            clearTimeout(scanTimerRef.current);
            resetConnectingGuard();
            return;
          }

          if (handled) return;
          handled = true;

          managerRef.current.stopDeviceScan();
          clearTimeout(scanTimerRef.current);
          setState(prev => ({ ...prev, radioDetected: true, scanning: false, connecting: true }));
          addLog(`Found ${device.name || DEVICE_NAME}! Connecting...`);

          try {
            let connected = null;
            const MAX_ATTEMPTS = 4;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              try {
                connected = await device.connect({ timeout: 10000, refreshGatt: 'OnConnected' });
                await connected.discoverAllServicesAndCharacteristics();
                break;
              } catch (e) {
                addLog(`Connect attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e.message} (android=${e.androidErrorCode})`);
                try { await device.cancelConnection(); } catch (_) {}
                if (attempt === MAX_ATTEMPTS) throw e;
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }

            deviceRef.current = connected;
            setState(prev => ({ ...prev, radioConnected: true, connecting: false }));
            addLog(`Connected to ${DEVICE_NAME}`);
            subscribeToDevice(connected);
            resetConnectingGuard();
          } catch (e) { 
            addLog(`Connection failed: ${e.message}`);
            addLog(`  errorCode=${e.errorCode} reason=${e.reason}`);
            addLog(`  androidErrorCode=${e.androidErrorCode} androidCode=${e.attErrorCode}`);
            addLog(`  iosErrorCode=${e.iosErrorCode}`);
            console.log('Full BLE error:', JSON.stringify(e, null, 2));

            // Release the native GATT client even though connect failed —
            // otherwise it can leak and exhaust Android's GATT client slots.
            //TODO: Check if we need this debug thing
            try {
              await device.cancelConnection();
            } catch (_) {
              // already gone, fine
            }
            setState(prev => ({ ...prev, radioDetected: false, connecting: false}));
            resetConnectingGuard();
          }
        }
      );
    }
    catch(e){
      addLog(`Scan setup failed: ${e.message}`);
      resetConnectingGuard();
    }
  }, [requestPermissions, subscribeToDevice, addLog]);

  // Post-OTA reconnect: the radio needs a few seconds to actually reboot and
  // start advertising again before a scan would find it. 
  useEffect(() => {
    if (state.postUpdateStatus !== 'reconnecting') return;

    const reconnectDelay = setTimeout(() => {
      addLog('Attempting to reconnect after OTA reboot...');
      startScan();
    }, 3000);

    postOtaFailTimeoutRef.current = setTimeout(() => {
      setState(prev => (prev.postUpdateStatus === 'reconnecting' ? { ...prev, postUpdateStatus: 'failed' } : prev));
      addLog('Radio did not come back online after OTA — check it manually');
    }, 25000);

    return () => {
      clearTimeout(reconnectDelay);
      clearTimeout(postOtaFailTimeoutRef.current);
    };
  }, [state.postUpdateStatus]);

  const disconnect = useCallback(async () => {
    clearTimeout(scanTimerRef.current);
    managerRef.current?.stopDeviceScan();

    const device = deviceRef.current;
    if (!device) return;

    // Ask the radio to hang up on itself instead of calling cancelConnection() directly
    let wrote = false;
    try {
      const b64 = Buffer.from(['x'.charCodeAt(0)]).toString('base64');
      await device.writeCharacteristicWithResponseForService(SERVICE_UUID, COMMAND_UUID, b64);
      wrote = true;
      addLog('Sent disconnect request to radio');
    } catch (e) {
      addLog(`Disconnect request failed: ${e.message}`);
    }

    // Safety net: if the write itself failed, or the radio never confirms
    // within a few seconds, force a local teardown so the UI doesn't get stuck.
    disconnectFallbackRef.current = setTimeout(async () => {
      if (!deviceRef.current) return; // onDisconnected already handled it
      addLog('Radio did not confirm disconnect — forcing local teardown');
      try {
        await deviceRef.current.cancelConnection();
      } catch (e) {
        // ignore
      }
      cleanupSubscriptions();
      deviceRef.current = null;
      setState(prev => ({
        ...prev,
        radioDetected: false,
        radioConnected: false,
        scanning: false,
        direction0: 0, val0: 0, val1: 0,
        direction1: 0, val2: 0, val3: 0,
        battLevels: [0, 0, 0, 0],
        skiBattery: null,
      }));
    }, wrote ? 3000 : 0);
  }, [addLog, cleanupSubscriptions]);

  const sendCommand = useCallback(async (cmd) => {
    if (!deviceRef.current || !state.radioConnected) return;
    try {
      // Encode single command byte as base64
      const b64 = Buffer.from([cmd.charCodeAt(0)]).toString('base64');
      await deviceRef.current.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        COMMAND_UUID,
        b64
      );
      addLog(`Sent command: '${cmd}'`);
    } catch (e) {
      addLog(`Command error: ${e.message}`);
    }
  }, [state.radioConnected, addLog]);

  useEffect(() => {
    return () => {
      clearTimeout(scanTimerRef.current);
      managerRef.current?.stopDeviceScan();
      cleanupSubscriptions();
      deviceRef.current?.cancelConnection().catch(() => {});
    };
  }, [cleanupSubscriptions]);

  // Sensitivity identifier char per sensor (see MultiSensorAppTest.ino handleCommand):
  // sensor 0='l', 1='r', 2='u', 3='d', each followed by a two-digit ASCII value 00-99.
  // Firmware's BLE onWrite() only reads the first byte of each write, so the 3 bytes
  // are sent as 3 separate single-byte writes rather than one 3-byte write.
  const SENS_SENSOR_CHARS = ['l', 'r', 'u', 'd'];

  const sendSensitivityCommand = useCallback(async (cmdStr) => {
    if (!deviceRef.current || !state.radioConnected) return;
    try {
      for (const ch of cmdStr) {
        const b64 = Buffer.from([ch.charCodeAt(0)]).toString('base64');
        await deviceRef.current.writeCharacteristicWithResponseForService(
          SERVICE_UUID,
          COMMAND_UUID,
          b64
        );
      }
      addLog(`Sent sensitivity command: '${cmdStr}'`);
    } catch (e) {
      addLog(`Command error: ${e.message}`);
    }
  }, [state.radioConnected, addLog]);

  const handleSensorMode = useCallback((mode) => {
    setState(prev => ({ ...prev, sensorMode: mode }));
    sendCommand(mode === 2 ? 'o' : 'p');
  }, [sendCommand]);

  const handleSensitivity = useCallback((sensorIndex, rawValue) => {
    const clamped = Math.max(0, Math.min(99, Math.round(rawValue)));
    setState(prev => {
      const next = [...prev.sensitivities];
      next[sensorIndex] = clamped;
      return { ...prev, sensitivities: next };
    });
    const digits = clamped.toString().padStart(2, '0');
    sendSensitivityCommand(SENS_SENSOR_CHARS[sensorIndex] + digits);
  }, [sendSensitivityCommand]);

  const handleInvert = useCallback((pair, inverted) => {  //pair 0 = left/right, pair 1 = wedge
    setState(prev => pair === 0
      ? { ...prev, invertPair0: inverted }
      : { ...prev, invertPair1: inverted }
    );
    if (pair === 0) sendCommand(inverted ? '4' : '3');
    else            sendCommand(inverted ? 'h' : 'g');
  }, [sendCommand]);

  // ─── BLE OTA firmware transfer ────────────────────────────────────────────
  // skiVersion set: the image is the ski controller's. It is stored on the
  // radio instead of being flashed, and the radio does not reboot.
  const sendFirmwareUpdate = useCallback(async (firmwareBytes, skiVersion = null) => {
    if (!deviceRef.current || !state.radioConnected) {
      addLog('OTA: not connected to radio');
      return { success: false, error: 'Not connected' };
    }

    const device = deviceRef.current;
    const totalSize = firmwareBytes.length;
    const expectedCRC = crc32(firmwareBytes, 0);

    otaAbortRef.current = false;
    otaStatusRef.current = 'sending';
    setState(prev => ({
      ...prev, otaStatus: 'sending', otaProgress: 0, otaError: null,
      otaBytesTotal: totalSize, otaBytesSent: 0, postUpdateStatus: 'idle',
    }));
    addLog(`OTA: starting update, ${totalSize} bytes, crc=0x${expectedCRC.toString(16)}`);

    // Only one status response is ever "pending" at a time (READY after
    // START, DONE after END) — PROGRESS notifications flow through the
    // same subscription but don't resolve/reject anything. asyncError is
    // separate: it catches an error code that arrives *outside* either
    // pending window (e.g. a sequence/write error firmware reports mid-
    // transfer, while the chunk loop is just writing and not awaiting
    // anything) so it isn't silently dropped — the chunk loop below checks
    // it every iteration.
    let pendingResolve = null;
    let pendingReject = null;
    let asyncError = null;
    const waitForStatus = () => new Promise((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });

    const otaSub = device.monitorCharacteristicForService(
      OTA_SERVICE_UUID,
      OTA_STATUS_UUID,
      (error, characteristic) => {
        if (error) {
          asyncError = new Error(`OTA status error: ${error.message}`);
          pendingReject?.(asyncError);
          return;
        }
        if (!characteristic?.value) return;
        const bytes = Buffer.from(characteristic.value, 'base64');
        const code = bytes[0];

        if (code === OTA_STATUS.PROGRESS) {
          const bytesWritten = bytes.readUInt32LE(1);
          setState(prev => ({
            ...prev, otaBytesSent: bytesWritten,
            otaProgress: totalSize > 0 ? bytesWritten / totalSize : 0,
          }));
          return;
        }

        if (code === OTA_STATUS.READY || code === OTA_STATUS.DONE || code === OTA_STATUS.SKI_STORED) {
          pendingResolve?.(code);
        } else {
          const msg = OTA_ERROR_MESSAGES[code] || `Unknown OTA status (0x${code.toString(16)})`;
          asyncError = new Error(msg);
          pendingReject?.(asyncError);
        }
      }
    );
    subscriptionsRef.current.otaSub = otaSub;

    const cleanupOTA = () => {
      subscriptionsRef.current.otaSub?.remove();
      subscriptionsRef.current.otaSub = null;
    };

    try {
      // Request the largest ATT MTU the platform/radio will grant, then size
      // chunks off whatever actually gets negotiated — MTU can only go up
      // once set for a connection, never down, so a lower-than-requested
      // result here is fine, not an error; we just use less headroom per
      // chunk. requestMTU is Android-only in ble-plx; iOS negotiates
      // automatically and device.mtu reflects the outcome once connected
      // (not independently verified against real iOS hardware here).
      let negotiatedMtu = device.mtu || 23;
      if (Platform.OS === 'android') {
        const mtuDevice = await device.requestMTU(OTA_TARGET_MTU);
        negotiatedMtu = mtuDevice.mtu;
      } else {
        negotiatedMtu = device.mtu;
      }
      const chunkPayload = Math.max(20, Math.min(negotiatedMtu - 3 - 2, OTA_CHUNK_PAYLOAD_MAX));
      addLog(`OTA: MTU=${negotiatedMtu}, using ${chunkPayload}-byte chunks`);

      // ---- START: 'S' + size(4 LE) + crc32(4 LE) ----
      // Ski image: 'K' + size(4 LE) + crc32(4 LE) + version (ASCII). A separate
      // letter so a radio too old to know it rejects it instead of flashing itself.
      const startPayload = Buffer.alloc(9 + (skiVersion ? skiVersion.length : 0));
      startPayload.write(skiVersion ? 'K' : 'S', 0, 'ascii');
      startPayload.writeUInt32LE(totalSize, 1);
      startPayload.writeUInt32LE(expectedCRC, 5);
      if (skiVersion) startPayload.write(skiVersion, 9, 'ascii');

      const readyPromise = waitForStatus();
      await device.writeCharacteristicWithResponseForService(
        OTA_SERVICE_UUID, OTA_CONTROL_UUID, startPayload.toString('base64')
      );
      let readyTimer;
      await Promise.race([
        readyPromise, // rejects if the radio replies with an error code instead of READY
        new Promise((_, reject) => {
          readyTimer = setTimeout(
            () => reject(new Error('Radio busy, no READY received')),
            OTA_READY_TIMEOUT_MS
          );
        }),
      ]).finally(() => clearTimeout(readyTimer));
      addLog('OTA: radio ready, sending firmware...');

      // ---- DATA: seq(2 LE) + chunk payload, fixed-delay paced ----
      let seq = 0;
      let offset = 0;
      while (offset < totalSize) {
        if (otaAbortRef.current) throw new Error('OTA cancelled');
        if (asyncError) throw asyncError;

        const end = Math.min(offset + chunkPayload, totalSize);
        const framed = Buffer.alloc(2 + (end - offset));
        framed.writeUInt16LE(seq & 0xFFFF, 0);
        firmwareBytes.copy(framed, 2, offset, end);

        // WRITE_NR has no per-write ack, so throughput is throttled here
        // rather than waiting on a response per chunk.
        await device.writeCharacteristicWithoutResponseForService(
          OTA_SERVICE_UUID, OTA_DATA_UUID, framed.toString('base64')
        );
        await new Promise(r => setTimeout(r, skiVersion ? OTA_SKI_CHUNK_DELAY_MS : OTA_CHUNK_DELAY_MS));

        seq++;
        offset = end;
      }

      // ---- END: verify + apply ----
      if (asyncError) throw asyncError;
      otaStatusRef.current = 'verifying';
      setState(prev => ({ ...prev, otaStatus: 'verifying' }));
      addLog('OTA: all chunks sent, verifying...');

      const donePromise = waitForStatus();
      await device.writeCharacteristicWithResponseForService(
        OTA_SERVICE_UUID, OTA_CONTROL_UUID, Buffer.from(['E'.charCodeAt(0)]).toString('base64')
      );
      await donePromise; // rejects on ERR_CRC / ERR_WRITE

      if (skiVersion) {
        otaStatusRef.current = 'idle';
        setState(prev => ({ ...prev, otaStatus: 'idle', otaProgress: 1 }));
        addLog('OTA: ski image stored on radio');
        cleanupOTA();
        return { success: true };
      }

      otaStatusRef.current = 'done';
      setState(prev => ({ ...prev, otaStatus: 'done', otaProgress: 1 }));
      addLog('OTA: update applied, radio is rebooting');
      cleanupOTA();
      return { success: true };

    } catch (e) {
      cleanupOTA();
      otaStatusRef.current = 'error';
      setState(prev => ({ ...prev, otaStatus: 'error', otaError: e.message }));
      addLog(`OTA failed: ${e.message}`);
      // Best-effort ABORT so the radio doesn't sit stuck mid-transfer waiting
      // for chunks that are never coming.
      try {
        await device.writeCharacteristicWithResponseForService(
          OTA_SERVICE_UUID, OTA_CONTROL_UUID, Buffer.from(['A'.charCodeAt(0)]).toString('base64')
        );
      } catch (_) { /* best effort — radio may already be gone */ }
      return { success: false, error: e.message };
    }
  }, [state.radioConnected, addLog]);

  const cancelFirmwareUpdate = useCallback(() => {
    otaAbortRef.current = true;
  }, []);

  // ─── GitHub Releases manifest check ───────────────────────────────────────
  const checkForUpdate = useCallback(async () => {
    setState(prev => ({
      ...prev,
      updateCheck: { status: 'checking', latestVersion: null, downloadUrl: null, size: 0, ski: null, error: null },
    }));
    if (deviceRef.current) readSkiVersion(deviceRef.current);
    try {
      const res = await fetch(GITHUB_RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) {
        throw new Error(`GitHub API returned ${res.status}`);
      }
      const json = await res.json();
      const assets = json.assets || [];
      const asset = assets.find(a => a.name === 'firmware.bin');
      const skiAsset = assets.find(a => a.name === 'ski_fw.bin');
      const manifestAsset = assets.find(a => a.name === 'manifest.json');

      // A release made before manifests existed only has the tag to go by.
      let manifest = { radio: String(json.tag_name || '').replace(/^v/, '') };
      if (manifestAsset) {
        const manifestRes = await fetch(manifestAsset.browser_download_url);
        if (!manifestRes.ok) {
          throw new Error(`manifest.json download returned ${manifestRes.status}`);
        }
        manifest = await manifestRes.json();
      }

      const latestVersion = manifest.radio ? String(manifest.radio) : '';
      if (!latestVersion || !asset) {
        throw new Error('Latest release is missing a radio version or a firmware.bin asset');
      }
      const ski = manifest.ski && skiAsset
        ? { version: String(manifest.ski), downloadUrl: skiAsset.browser_download_url, size: skiAsset.size }
        : null;
      setState(prev => ({
        ...prev,
        updateCheck: {
          status: 'checked',
          latestVersion,
          downloadUrl: asset.browser_download_url,
          size: asset.size,
          ski,
          error: null,
        },
      }));
      addLog(`Latest release: radio v${latestVersion}` + (ski ? `, ski v${ski.version}` : ', no ski image'));
      return { latestVersion, downloadUrl: asset.browser_download_url, size: asset.size, ski };
    } catch (e) {
      setState(prev => ({
        ...prev,
        updateCheck: { status: 'error', latestVersion: null, downloadUrl: null, size: 0, ski: null, error: e.message },
      }));
      addLog(`Update check failed: ${e.message}`);
      return null;
    }
  }, [addLog, readSkiVersion]);

  // Downloads whatever checkForUpdate last found, verifies the byte count
  // against what GitHub reported, then hands the  buffer to the same 
  // transfer path the manual test button uses.
  const downloadAndInstallUpdate = useCallback(async () => {
    const { downloadUrl, size, latestVersion } = state.updateCheck;
    if (!downloadUrl) {
      addLog('No update available to download — run a check first');
      return;
    }
    try {
      addLog(`Downloading firmware v${latestVersion}...`);
      const localPath = FileSystem.cacheDirectory + 'firmware_update.bin';
      const result = await FileSystem.downloadAsync(downloadUrl, localPath);
      if (result.status !== 200) {
        throw new Error(`Download failed with HTTP status ${result.status}`);
      }
      const info = await FileSystem.getInfoAsync(localPath);
      if (size && info.size !== size) {
        throw new Error(`Downloaded ${info.size} bytes, expected ${size} — likely a truncated download`);
      }
      const base64 = await FileSystem.readAsStringAsync(localPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const firmwareBuffer = Buffer.from(base64, 'base64');
      addLog(`Downloaded firmware v${latestVersion} (${firmwareBuffer.length} bytes), starting transfer...`);
      pendingVerifyVersionRef.current = latestVersion;
      sendFirmwareUpdate(firmwareBuffer);
    } catch (e) {
      addLog(`Download failed: ${e.message}`);
    }
  }, [state.updateCheck, addLog, sendFirmwareUpdate]);

  // Tells the radio to relay its stored ski image to the ski, and resolves
  // with the radio's final report: { ok: true, newVersion } or
  // { ok: false, reason, skiNak, known, oldVersion }.
  const relaySkiImage = useCallback((device) => new Promise((resolve, reject) => {
    let timer = null;
    let sub = null;
    sub = device.monitorCharacteristicForService(
      OTA_SERVICE_UUID,
      OTA_STATUS_UUID,
      (error, characteristic) => {
        if (error) {
          finish(() => reject(new Error(`Lost contact with radio: ${error.message}`)));
          return;
        }
        if (!characteristic?.value) return;
        const bytes = Buffer.from(characteristic.value, 'base64');
        const code = bytes[0];

        if (code === OTA_STATUS.SKI_RELAY_PROGRESS && bytes.length >= 10) {
          const phase = bytes[1];
          const sent = bytes.readUInt32LE(2);
          const total = bytes.readUInt32LE(6);
          setState(prev => ({ ...prev, skiUpdate: { ...prev.skiUpdate, phase, sent, total } }));
        } else if (code === OTA_STATUS.SKI_RELAY_OK) {
          finish(() => resolve({ ok: true, newVersion: bytes.slice(1).toString('utf8') }));
        } else if (code === OTA_STATUS.SKI_RELAY_FAIL && bytes.length >= 4) {
          finish(() => resolve({
            ok: false,
            reason: bytes[1],
            skiNak: bytes[2],
            known: bytes[3] === 1,
            oldVersion: bytes.slice(4).toString('utf8'),
          }));
        } else if (code === OTA_STATUS.ERR_STATE) {
          finish(() => reject(new Error('Radio is busy and did not start the relay')));
        }
      }
    );
    function finish(settle) {
      clearTimeout(timer);
      sub?.remove();
      settle();
    }
    timer = setTimeout(
      () => finish(() => reject(new Error('No result from radio'))),
      SKI_RELAY_TIMEOUT_MS
    );
    device.writeCharacteristicWithResponseForService(
      OTA_SERVICE_UUID, OTA_CONTROL_UUID, Buffer.from(['R'.charCodeAt(0)]).toString('base64')
    ).catch(e => finish(() => reject(e)));
  }), []);

  // Ski update, start to finish: confirm, download ski_fw.bin, store it on the
  // radio over the normal chunk path, then have the radio relay it to the ski.
  const downloadAndInstallSkiUpdate = useCallback(async () => {
    const ski = state.updateCheck.ski;
    const from = state.skiVersion;
    if (!ski || !from || !deviceRef.current) return;

    if (!(await confirmSkiUpdate({ from, to: ski.version }))) return;

    const setSki = (fields) => setState(prev => ({ ...prev, skiUpdate: { ...prev.skiUpdate, ...fields } }));
    setSki({ status: 'downloading', phase: 0, sent: 0, total: 0, newVersion: null, error: null, known: true, oldVersion: from });
    try {
      addLog(`Downloading ski firmware v${ski.version}...`);
      const localPath = FileSystem.cacheDirectory + 'ski_fw_update.bin';
      const result = await FileSystem.downloadAsync(ski.downloadUrl, localPath);
      if (result.status !== 200) {
        throw new Error(`Download failed with HTTP status ${result.status}`);
      }
      const info = await FileSystem.getInfoAsync(localPath);
      if (ski.size && info.size !== ski.size) {
        throw new Error(`Downloaded ${info.size} bytes, expected ${ski.size}`);
      }
      const base64 = await FileSystem.readAsStringAsync(localPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const image = Buffer.from(base64, 'base64');

      setSki({ status: 'sending' });
      const sent = await sendFirmwareUpdate(image, ski.version);
      if (!sent.success) throw new Error(`Could not store the image on the radio (${sent.error})`);

      setSki({ status: 'relaying', phase: 0, sent: 0, total: image.length });
      addLog('Ski update: radio is relaying the image to the ski...');
      const report = await relaySkiImage(deviceRef.current);

      if (report.ok) {
        addLog(`Ski update done, ski now runs v${report.newVersion}`);
        setState(prev => ({
          ...prev,
          skiVersion: report.newVersion,
          skiUpdate: { ...prev.skiUpdate, status: 'done', newVersion: report.newVersion },
        }));
      } else {
        const message = SKI_RELAY_FAIL_MESSAGES[report.reason] || `Unknown failure (${report.reason})`;
        addLog(`Ski update failed: ${message} (ski code 0x${report.skiNak.toString(16)}), `
          + (report.known ? `ski still on v${report.oldVersion}` : `ski state unknown, was v${report.oldVersion}`));
        setState(prev => ({
          ...prev,
          skiVersion: report.known ? (report.oldVersion || null) : null,
          skiUpdate: { ...prev.skiUpdate, status: 'error', error: message, known: report.known, oldVersion: report.oldVersion || from },
        }));
      }
    } catch (e) {
      addLog(`Ski update failed: ${e.message}`);
      setSki({ status: 'error', error: e.message, known: true, oldVersion: from });
    }
  }, [state.updateCheck, state.skiVersion, addLog, sendFirmwareUpdate, relaySkiImage]);

  // Poll every second while radio is connected. If sensor data has been
  // silent for >3s, flag sensorDropped. Clears automatically when data resumes.
  // Pure observer — never sends commands or interferes with firmware reconnect.
  useEffect(() => {
    const interval = setInterval(() => {
      setState(prev => {
        if (!prev.radioConnected || lastDataTime.current === null) return prev;
        const dropped = Date.now() - lastDataTime.current > 3000;
        if (dropped === prev.sensorDropped) return prev;
        return { ...prev, sensorDropped: dropped };
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return {
    state, startScan, disconnect, sendCommand, handleSensorMode, handleSensitivity, handleInvert,
    sendFirmwareUpdate, cancelFirmwareUpdate, addLog, readFirmwareVersion,
    checkForUpdate, downloadAndInstallUpdate, downloadAndInstallSkiUpdate,
  };
}


// ─── Direction Indicator Component ───────────────────────────────────────────
// direction0: 0=idle, 1=left, 2=right
// direction1: 0=idle, 3=wedge in, 4=wedge out
function DirectionIndicator({ direction0, direction1, sensorMode }) {
  const { colors, styles } = useContext(ThemeContext);
  const leftAnim    = useRef(new Animated.Value(0)).current;
  const rightAnim   = useRef(new Animated.Value(0)).current;
  const wedgeInAnim = useRef(new Animated.Value(0)).current;
  const wedgeOutAnim= useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(leftAnim,     { toValue: direction0 === 1 ? 1 : 0, duration: 80, useNativeDriver: false }),
      Animated.timing(rightAnim,    { toValue: direction0 === 2 ? 1 : 0, duration: 80, useNativeDriver: false }),
      Animated.timing(wedgeInAnim,  { toValue: direction1 === 3 ? 1 : 0, duration: 80, useNativeDriver: false }),
      Animated.timing(wedgeOutAnim, { toValue: direction1 === 4 ? 1 : 0, duration: 80, useNativeDriver: false }),
    ]).start();
  }, [direction0, direction1]);

  const mkBg  = (anim) => anim.interpolate({ inputRange: [0,1], outputRange: [colors.dirInactiveBg, colors.accent] });
  const mkTxt = (anim) => anim.interpolate({ inputRange: [0,1], outputRange: [colors.dirInactiveText, colors.accentText] });

  return (
    <View style={{ marginBottom: 16 }}>
      {/* Wedge In (up) — only in 4-sensor mode, sits above the L/R row like a D-pad */}
      {sensorMode === 4 && (
        <Animated.View style={[styles.dirArrowVert, styles.dirArrowUp, { backgroundColor: mkBg(wedgeInAnim) }]}>
          <Animated.Text style={[styles.dirArrowText, { color: mkTxt(wedgeInAnim) }]}>▲</Animated.Text>
        </Animated.View>
      )}

      {/* Pair 0: Left / Right */}
      <View style={styles.dirRow}>
        <Animated.View style={[styles.dirArrow, { backgroundColor: mkBg(leftAnim) }]}>
          <Animated.Text style={[styles.dirArrowText, { color: mkTxt(leftAnim) }]}>◀</Animated.Text>
        </Animated.View>
        <View style={styles.dirCenter}>
          <Text style={styles.dirPairLabel}>L / R</Text>
          <Text style={[styles.dirLabel, direction0 === 0 && styles.dirLabelActive]}>
            {direction0 === 0 ? 'IDLE' : direction0 === 1 ? 'LEFT' : 'RIGHT'}
          </Text>
          {sensorMode === 4 && (
            <>
              <Text style={styles.dirPairLabelSecondary}>WEDGE</Text>
              <Text style={[styles.dirLabelSecondary, direction1 === 0 && styles.dirLabelActive]}>
                {direction1 === 0 ? 'IDLE' : direction1 === 3 ? 'IN' : 'OUT'}
              </Text>
            </>
          )}
        </View>
        <Animated.View style={[styles.dirArrow, { backgroundColor: mkBg(rightAnim) }]}>
          <Animated.Text style={[styles.dirArrowText, { color: mkTxt(rightAnim) }]}>▶</Animated.Text>
        </Animated.View>
      </View>

      {/* Wedge Out (down) — only in 4-sensor mode, sits below the L/R row like a D-pad */}
      {sensorMode === 4 && (
        <Animated.View style={[styles.dirArrowVert, styles.dirArrowDown, { backgroundColor: mkBg(wedgeOutAnim) }]}>
          <Animated.Text style={[styles.dirArrowText, { color: mkTxt(wedgeOutAnim) }]}>▼</Animated.Text>
        </Animated.View>
      )}
    </View>
  );
}


// ─── Sensor Card Component ────────────────────────────────────────────────────
// Touching/dragging the bar sets sensitivity: position along the bar maps to a
// continuous 0-99 value. The BLE command only fires on release, so a drag only
// sends one command (avoids flooding BLE + triggering repeated NVS saves on
// every intermediate finger position); the marker previews the value live while dragging.
function SensorCard({ label, value, max = 160, threshold, battery, sensitivityValue, onSensitivityChange }) {
  const { colors, styles } = useContext(ThemeContext);
  const fillPct = Math.min(value / max, 1);
  const isActive = value > threshold;

  const barWidthRef = useRef(0);
  const barRef = useRef(null);
  const barPageXRef = useRef(0);
  const [previewSensitivity, setPreviewSensitivity] = useState(null);

  const rawValueFromLocationX = useCallback((locationX) => {
    const width = barWidthRef.current;
    if (!width) return sensitivityValue;
    const pct = Math.max(0, Math.min(1, (locationX - barPageXRef.current) / width));
    return Math.round(pct * 99);
  }, [sensitivityValue]);

  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => {
      setPreviewSensitivity(rawValueFromLocationX(evt.nativeEvent.pageX));
    },
    onPanResponderMove: (evt) => {
      setPreviewSensitivity(rawValueFromLocationX(evt.nativeEvent.pageX));
    },
    onPanResponderRelease: (evt) => {
      const finalValue = rawValueFromLocationX(evt.nativeEvent.pageX);
      setPreviewSensitivity(null);
      onSensitivityChange(finalValue);
    },
    onPanResponderTerminate: () => {
      setPreviewSensitivity(null);
    },
  });

  const displaySensitivity = previewSensitivity !== null ? previewSensitivity : sensitivityValue;

  return (
    <View style={styles.sensorCard}>
      <View style={styles.sensorHeader}>
        <Text style={styles.sensorLabel}>{label}</Text>
        <View style={styles.sensorMeta}>
          <Text style={[styles.sensorActive, isActive && styles.sensorActiveOn]}>
            {isActive ? 'ACTIVE' : '——'}
          </Text>
          {battery > 0 && (
            <Text style={styles.battText}>🔋 {battery}%</Text>
          )}
        </View>
      </View>
      <View
        style={styles.barTrack}
        onLayout={() => {
          barRef.current?.measure((x, y, width, height, pageX) => {
            barWidthRef.current = width;
            barPageXRef.current = pageX;
          });
        }}
        ref={barRef}
        {...panResponder.panHandlers}
        hitSlop={{ top: 14, bottom: 14 }}
      >
        <View style={[styles.barFill, { width: `${fillPct * 100}%`, backgroundColor: isActive ? colors.accent : colors.inactiveBar }]} />
        {threshold > 0 && (
          <View style={[styles.barThreshold, { left: `${(threshold / max) * 100}%` }]} />
        )}
        <View style={[styles.sensMarker, { left: `${(displaySensitivity / 99) * 100}%`, backgroundColor: colors.accent }]} />
      </View>
      <Text style={styles.sensorValue}>{value}</Text>
    </View>
  );
}


// ─── Sensor Pair Block ────────────────────────────────────────────────────────
function SensorPairBlock({ pairLabel, labelA, labelB, valA, valB, battA, battB,
                           threshold, sensitivityA, sensitivityB, inverted,
                           onSensitivityA, onSensitivityB, onInvert }) {
  const { styles } = useContext(ThemeContext);
  return (
    <View style={styles.pairBlock}>
      <View style={styles.pairHeader}>
        <Text style={styles.pairLabel}>{pairLabel}</Text>
        <View style={styles.invertRow}>
          {['NORMAL','INVERT'].map((lbl, i) => {
            const active = i === 0 ? !inverted : inverted;
            return (
              <TouchableOpacity
                key={lbl}
                style={[styles.segBtn, active && styles.segBtnActive, { flex: 0, paddingHorizontal: 12 }]}
                onPress={() => onInvert(i === 1)}
              >
                <Text style={[styles.segBtnText, active && styles.segBtnTextActive]}>{lbl}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
      <View style={styles.cardRow}>
        <View style={{ flex: 1 }}>
          <SensorCard
            label={labelA} value={valA} threshold={threshold}
            battery={battA} sensitivityValue={sensitivityA} onSensitivityChange={onSensitivityA}
          />
        </View>
        <View style={{ flex: 1 }}>
          <SensorCard
            label={labelB} value={valB} threshold={threshold}
            battery={battB} sensitivityValue={sensitivityB} onSensitivityChange={onSensitivityB}
          />
        </View>
      </View>
    </View>
  );
}


// ─── Log Stream Dropdown ──────────────────────────────────────────────────────
const LOG_STREAMS = [
  { key: 'events', label: 'EVENT LOG' },
  { key: 'serial', label: 'SERIAL OUTPUT' },
  { key: 'raw',    label: 'RAW FEED (LAST 10)' },
];

function LogStreamDropdown({ selected, open, onToggleOpen, onSelect }) {
  const { styles } = useContext(ThemeContext);
  const currentLabel = LOG_STREAMS.find(s => s.key === selected)?.label ?? LOG_STREAMS[0].label;

  return (
    <View style={styles.dropdownWrap}>
      <TouchableOpacity style={styles.dropdownBtn} onPress={onToggleOpen}>
        <Text style={styles.dropdownBtnText}>{currentLabel}</Text>
        <Text style={styles.dropdownCaret}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.dropdownMenu}>
          {LOG_STREAMS.map((s, i) => (
            <TouchableOpacity
              key={s.key}
              style={[
                styles.dropdownItem,
                s.key === selected && styles.dropdownItemActive,
                i === LOG_STREAMS.length - 1 && { borderBottomWidth: 0 },
              ]}
              onPress={() => onSelect(s.key)}
            >
              <Text style={[styles.dropdownItemText, s.key === selected && styles.dropdownItemTextActive]}>
                {s.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}


// ─── Connection Status Badge ──────────────────────────────────────────────────
function StatusBadge({ detected, connected, scanning, sensorDropped, skiBattery }) {
  const { colors, styles } = useContext(ThemeContext);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (scanning || sensorDropped) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,   duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [scanning, sensorDropped]);

  const color    = sensorDropped ? colors.dropped : connected ? colors.accent : detected ? colors.warn : scanning ? colors.scanningDot : colors.danger;
  const label    = sensorDropped ? 'SENSOR DROPPED' : connected ? 'CONNECTED' : detected ? 'DETECTED' : scanning ? 'SCANNING' : 'NOT FOUND';
  const sublabel = sensorDropped ? 'Reconnecting to sensor...' : connected ? 'TetraRadio' : detected ? 'Connecting...' : scanning ? 'Looking for TetraRadio' : 'Radio controller offline';

  return (
    <View style={styles.statusCard}>
      <Animated.View style={[styles.statusDot, { backgroundColor: color, opacity: (scanning || sensorDropped) ? pulseAnim : 1 }]} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.statusLabel, { color }]}>{label}</Text>
        <Text style={styles.statusSub}>{sublabel}</Text>
      </View>
      {connected && (
        <View style={styles.skiBatt}>
          <Text style={styles.skiBattLabel}>SKI</Text>
          <Text style={styles.battText}>🔋 {skiBattery == null ? '--' : skiBattery}%</Text>
        </View>
      )}
    </View>
  );
}


// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { state, startScan, disconnect, sendCommand, handleSensorMode, handleSensitivity, handleInvert,
          sendFirmwareUpdate, cancelFirmwareUpdate, addLog, checkForUpdate, downloadAndInstallUpdate,
          downloadAndInstallSkiUpdate } = useBLE();
  const { radioDetected, radioConnected, scanning, connecting, sensorDropped,
          sensorMode, sensitivities, invertPair0, invertPair1,
          direction0, val0, val1, direction1, val2, val3,
          battLevels, skiBattery, log, serialLog, rawLog,
          otaStatus, otaProgress, otaBytesSent, otaBytesTotal, otaError,
          firmwareVersion, skiVersion, updateCheck, skiUpdate, postUpdateStatus } = state;

  const [showLog, setShowLog] = useState(false);
  const [logStream, setLogStream] = useState('events'); // 'events' | 'serial'
  const [logDropdownOpen, setLogDropdownOpen] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [showSettings, setShowSettings] = useState(false);
  const colors = theme === 'dark' ? darkColors : lightColors;
  const styles = useMemo(() => createStyles(colors), [colors]);

  useAlarms({ radioConnected, sensorDropped, sensorMode, battLevels, skiBattery, addLog });

  // Check GitHub for a newer firmware release once on app open, so the
  // settings button can flag it as soon as a radio connects and reports
  // its own version.
  useEffect(() => {
    checkForUpdate();
  }, []);

  const skiBusy = ['downloading', 'sending', 'relaying'].includes(skiUpdate.status);
  const otaBusy = otaStatus === 'sending' || otaStatus === 'verifying' || skiBusy;
  const updateAvailable = updateCheck.status === 'checked' && !!updateCheck.latestVersion && !!firmwareVersion
    && compareSemver(updateCheck.latestVersion, firmwareVersion) > 0;
  const skiUpdateAvailable = updateCheck.status === 'checked' && !!updateCheck.ski && !!skiVersion
    && compareSemver(semverCore(updateCheck.ski.version), semverCore(skiVersion)) > 0;

  return (
    <ThemeContext.Provider value={{ colors, styles }}>
    <View style={styles.root}>
      <StatusBar barStyle={colors.statusBarStyle} backgroundColor={colors.bg} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Image
              source={theme === 'dark' ? LOGO_DARK : LOGO_LIGHT}
              style={styles.headerLogo}
              resizeMode="contain"
              accessibilityLabel="TetraSki"
              />
            <Text style={styles.headerSub}>Radio Controller Interface</Text>
          </View>
          <View style={styles.headerBtns}>
            <TouchableOpacity
              style={styles.themeToggle}
              onPress={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            >
              <Text style={styles.themeToggleText}>{theme === 'dark' ? '☀️' : '🌙'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.themeToggle}
              onPress={() => setShowSettings(true)}
              accessibilityLabel={updateAvailable ? 'Settings, firmware update available' : 'Settings'}
            >
              <Text style={styles.themeToggleText}>⚙️</Text>
              {updateAvailable && <View style={styles.updateDot} />}
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        {/* Connection Status */}
        <StatusBadge detected={radioDetected} connected={radioConnected} scanning={scanning} sensorDropped={sensorDropped} skiBattery={skiBattery} />
        {radioConnected && firmwareVersion && (
          <Text style={{ color: colors.textSecondary ?? colors.headerSub, fontSize: 12, textAlign: 'center', marginTop: -8, marginBottom: 8 }}>
            Firmware v{firmwareVersion}
          </Text>
        )}

        {/* Scan Button — disconnect lives in the settings screen */}
        {!radioConnected && (
          <TouchableOpacity
            style={styles.mainBtn}
            onPress={startScan}
            disabled={scanning || connecting}
          >
            <Text style={styles.mainBtnText}>
              {scanning ? 'SCANNING...' : connecting ? 'CONNECTING...' : 'SCAN FOR RADIO'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Direction Indicator */}
          {radioConnected && (
          <>
            <Text style={styles.sectionTitle}>DIRECTION OUTPUT</Text>
            <DirectionIndicator direction0={direction0} direction1={direction1} sensorMode={sensorMode} />

            {/* Sensor Pair Blocks */}
            <Text style={styles.sectionTitle}>SENSOR DATA</Text>

            <SensorPairBlock
              pairLabel="LEFT / RIGHT"
              labelA="Left"   valA={val0} battA={battLevels[0]}
              labelB="Right"  valB={val1} battB={battLevels[1]}
              threshold={80}
              sensitivityA={sensitivities[0]} onSensitivityA={(lvl) => handleSensitivity(0, lvl)}
              sensitivityB={sensitivities[1]} onSensitivityB={(lvl) => handleSensitivity(1, lvl)}
              inverted={invertPair0}
              onInvert={(inv) => handleInvert(0, inv)}
            />

            {sensorMode === 4 && (
              <SensorPairBlock
                pairLabel="WEDGE IN / WEDGE OUT"
                labelA="Wedge In"  valA={val2} battA={battLevels[2]}
                labelB="Wedge Out" valB={val3} battB={battLevels[3]}
                threshold={80}
                sensitivityA={sensitivities[2]} onSensitivityA={(lvl) => handleSensitivity(2, lvl)}
                sensitivityB={sensitivities[3]} onSensitivityB={(lvl) => handleSensitivity(3, lvl)}
                inverted={invertPair1}
                onInvert={(inv) => handleInvert(1, inv)}
              />
            )}

          </>
        )}

        {/* Log Toggle */}
        <TouchableOpacity
          style={styles.logToggle}
          onPress={() => {
            setShowLog(v => !v);
            setLogDropdownOpen(false);
          }}
        >
          <Text style={styles.logToggleText}>{showLog ? '▲ HIDE LOG' : '▼ SHOW LOG'}</Text>
        </TouchableOpacity>

        {showLog && (
          <View>
            <LogStreamDropdown
              selected={logStream}
              open={logDropdownOpen}
              onToggleOpen={() => setLogDropdownOpen(v => !v)}
              onSelect={(key) => {
                setLogStream(key);
                setLogDropdownOpen(false);
              }}
            />
            <View style={styles.logBox}>
              {(logStream === 'serial' ? serialLog : logStream === 'raw' ? rawLog : log).length === 0 && (
                <Text style={styles.logLine}>Waiting for sensor data...</Text>
              )}
              {(logStream === 'serial' ? serialLog : logStream === 'raw' ? rawLog : log).map((line, i) => (
                <Text key={i} style={styles.logLine}>{line}</Text>
              ))}
            </View>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Settings — sensitive controls kept off the main screen */}
      <Modal
        visible={showSettings}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setShowSettings(false)}
      >
        <View style={styles.root}>
          <View style={styles.header}>
            <View style={styles.headerRow}>
              <Text style={styles.settingsTitle}>SETTINGS</Text>
              <TouchableOpacity
                style={styles.themeToggle}
                onPress={() => setShowSettings(false)}
                accessibilityLabel="Close settings"
              >
                <Text style={[styles.themeToggleText, { color: colors.text }]}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

            {!radioConnected && (
              <Text style={styles.settingsNote}>
                No radio connected — connect to change sensor mode, recalibrate, or install firmware.
              </Text>
            )}

            {radioConnected && (
              <>
                <Text style={styles.sectionTitle}>CONNECTION</Text>
                <TouchableOpacity
                  style={[styles.mainBtn, styles.mainBtnDisconnect]}
                  onPress={() => {
                    setShowSettings(false);
                    disconnect();
                  }}
                >
                  <Text style={[styles.mainBtnText, { color: theme === 'dark' ? colors.textBright : colors.danger }]}>
                    DISCONNECT
                  </Text>
                </TouchableOpacity>

                <Text style={styles.sectionTitle}>SENSOR MODE</Text>
                <View style={styles.btnRow}>
                  {[2, 4].map((mode) => (
                    <TouchableOpacity
                      key={mode}
                      style={[styles.segBtn, sensorMode === mode && styles.segBtnActive]}
                      onPress={() => handleSensorMode(mode)}
                    >
                      <Text style={[styles.segBtnText, sensorMode === mode && styles.segBtnTextActive]}>
                        {mode} SENSORS
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.sectionTitle}>CALIBRATION</Text>
                <TouchableOpacity style={styles.calibrateBtn} onPress={() => sendCommand('5')}>
                  <Text style={styles.calibrateBtnText}>⟳  RESET CALIBRATION</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Firmware — stays visible while disconnected so post-update
                reboot/verify status isn't hidden when the radio drops. */}
            <View style={styles.settingsTitleRow}>
              <Text style={[styles.sectionTitle, { marginBottom: 0, marginTop: 0 }]}>FIRMWARE</Text>
              {updateAvailable && <Text style={styles.updateTag}>UPDATE AVAILABLE</Text>}
            </View>
            <Text style={styles.settingsNote}>
              {firmwareVersion ? `Installed: v${firmwareVersion}` : 'Installed: unknown (no radio connected)'}
            </Text>

            {/* Real update path: GitHub Releases manifest check + download */}
            <TouchableOpacity
              style={[styles.calibrateBtn, { marginBottom: 8 }]}
              onPress={checkForUpdate}
              disabled={updateCheck.status === 'checking' || otaBusy}
            >
              <Text style={styles.calibrateBtnText}>
                {updateCheck.status === 'checking' ? '⟳ CHECKING FOR UPDATES...' : '⟳ CHECK FOR UPDATES'}
              </Text>
            </TouchableOpacity>

            {updateCheck.status === 'checked' && updateCheck.latestVersion && (
              updateAvailable ? (
                <>
                  <Text style={[styles.settingsStatus, { color: colors.accent }]}>
                    Update available: v{updateCheck.latestVersion} (current: v{firmwareVersion})
                  </Text>
                  <TouchableOpacity
                    style={[styles.calibrateBtn, { marginTop: 8, marginBottom: 8, borderColor: colors.accent }]}
                    onPress={downloadAndInstallUpdate}
                    disabled={otaBusy}
                  >
                    <Text style={[styles.calibrateBtnText, { color: colors.accent }]}>
                      {otaStatus === 'sending'    ? `⇪ SENDING... ${Math.round(otaProgress * 100)}% (${otaBytesSent}/${otaBytesTotal})`
                        : otaStatus === 'verifying' ? '⇪ VERIFYING...'
                        : `⇪ INSTALL v${updateCheck.latestVersion}`}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <Text style={styles.settingsStatus}>
                  {firmwareVersion
                    ? `Up to date (v${firmwareVersion})`
                    : `Latest release: v${updateCheck.latestVersion} — connect a radio to compare`}
                </Text>
              )
            )}
            {updateCheck.status === 'error' && (
              <Text style={[styles.settingsStatus, { color: colors.danger }]}>
                Update check failed: {updateCheck.error}
              </Text>
            )}

            {/* Only shown while otaStatus is still 'done' and hasn't yet
                transitioned to a postUpdateStatus below — brief, expected. */}
            {otaStatus === 'done' && postUpdateStatus === 'idle' && (
              <Text style={[styles.settingsStatus, { color: colors.accent }]}>
                Transfer completed — radio should be rebooting now
              </Text>
            )}
            {postUpdateStatus === 'reconnecting' && (
              <Text style={styles.settingsStatus}>
                ⟳ Reconnecting to verify update...
              </Text>
            )}
            {postUpdateStatus === 'verified' && (
              <Text style={[styles.settingsStatus, { color: colors.accent }]}>
                ✓ Update verified — now running v{firmwareVersion}
              </Text>
            )}
            {postUpdateStatus === 'mismatch' && (
              <Text style={[styles.settingsStatus, { color: colors.danger }]}>
                ⚠ Version mismatch after update — now running v{firmwareVersion}, expected different. Check the radio.
              </Text>
            )}
            {postUpdateStatus === 'failed' && (
              <Text style={[styles.settingsStatus, { color: colors.danger }]}>
                ⚠ Radio didn't come back online after update — check it manually and reconnect.
              </Text>
            )}

            {/* DEV-ONLY: exercises the full OTA path against a REAL firmware
                image manually pushed to TEST_FIRMWARE_PATH via adb — useful for
                testing an arbitrary local .bin without cutting a GitHub release.
                Gated behind __DEV__ so it never ships in a production build;
                delete this block entirely once the real flow above is fully
                trusted and this bench tool is no longer needed. */}
            {__DEV__ && radioConnected && (
              <TouchableOpacity
                style={[styles.calibrateBtn, { marginTop: 16, marginBottom: 8 }]}
                onPress={async () => {
                  try {
                    const info = await FileSystem.getInfoAsync(TEST_FIRMWARE_PATH);
                    if (!info.exists) {
                      addLog(`OTA: no firmware.bin found at ${TEST_FIRMWARE_PATH} — push it via adb first`);
                      return;
                    }
                    const base64 = await FileSystem.readAsStringAsync(TEST_FIRMWARE_PATH, {
                      encoding: FileSystem.EncodingType.Base64,
                    });
                    const firmwareBuffer = Buffer.from(base64, 'base64');
                    addLog(`OTA: read firmware.bin (${firmwareBuffer.length} bytes) from device storage`);
                    sendFirmwareUpdate(firmwareBuffer);
                  } catch (e) {
                    addLog(`OTA: failed to read firmware.bin: ${e.message}`);
                  }
                }}
                disabled={otaBusy}
              >
                <Text style={styles.calibrateBtnText}>
                  {otaStatus === 'sending'    ? `⇪ SENDING... ${Math.round(otaProgress * 100)}% (${otaBytesSent}/${otaBytesTotal})`
                    : otaStatus === 'verifying' ? '⇪ VERIFYING...'
                    : '⇪ [DEV] TEST OTA TRANSFER (manual firmware.bin)'}
                </Text>
              </TouchableOpacity>
            )}
            {otaStatus === 'error' && (
              <Text style={[styles.settingsStatus, { color: colors.danger }]}>
                OTA error: {otaError}
              </Text>
            )}

            {/* Ski controller firmware, relayed through the radio. Listed
                after the radio's own update, which goes first. */}
            {radioConnected && (
              <>
                <View style={[styles.settingsTitleRow, { marginTop: 24 }]}>
                  <Text style={[styles.sectionTitle, { marginBottom: 0, marginTop: 0 }]}>SKI CONTROLLER</Text>
                  {skiUpdateAvailable && <Text style={styles.updateTag}>UPDATE AVAILABLE</Text>}
                </View>
                <Text style={styles.settingsNote}>
                  {skiVersion ? `Ski controller: v${skiVersion}` : "Ski controller: unknown, can't be updated here"}
                </Text>
                {skiVersion && skiUpdateAvailable && (
                  updateAvailable ? (
                    <Text style={styles.settingsStatus}>
                      v{updateCheck.ski.version} available. Update the radio first.
                    </Text>
                  ) : (
                    <TouchableOpacity
                      style={[styles.calibrateBtn, { marginTop: 8, marginBottom: 8, borderColor: colors.accent }]}
                      onPress={downloadAndInstallSkiUpdate}
                      disabled={otaBusy}
                    >
                      <Text style={[styles.calibrateBtnText, { color: colors.accent }]}>
                        {skiUpdate.status === 'downloading' ? '⇪ DOWNLOADING...'
                          : skiUpdate.status === 'sending' ? `⇪ SENDING TO RADIO... ${Math.round(otaProgress * 100)}%`
                          : skiUpdate.status === 'relaying' ? '⇪ UPDATING SKI...'
                          : `⇪ INSTALL SKI v${updateCheck.ski.version}`}
                      </Text>
                    </TouchableOpacity>
                  )
                )}
                {skiVersion && !skiUpdateAvailable && updateCheck.status === 'checked' && updateCheck.ski
                  && skiUpdate.status !== 'done' && (
                  <Text style={styles.settingsStatus}>Up to date (v{skiVersion})</Text>
                )}
              </>
            )}
            {skiUpdate.status === 'relaying' && (
              <Text style={styles.settingsStatus}>
                {SKI_RELAY_PHASES[skiUpdate.phase] || 'Starting relay'}
                {skiUpdate.phase === 3 && skiUpdate.total > 0
                  ? ` ${Math.round((skiUpdate.sent / skiUpdate.total) * 100)}% (${skiUpdate.sent}/${skiUpdate.total})`
                  : '...'}
              </Text>
            )}
            {skiUpdate.status === 'done' && (
              <Text style={[styles.settingsStatus, { color: colors.accent }]}>
                ✓ Ski controller updated, now running v{skiUpdate.newVersion}
              </Text>
            )}
            {skiUpdate.status === 'error' && (
              <Text style={[styles.settingsStatus, { color: colors.danger }]}>
                ⚠ Ski update failed: {skiUpdate.error}. {skiUpdate.known
                  ? `Ski controller is still on v${skiUpdate.oldVersion}.`
                  : `Ski controller state is unknown (was v${skiUpdate.oldVersion}).`}
              </Text>
            )}

            {radioConnected && (
              <>
                <Text style={[styles.sectionTitle, { marginTop: 24 }]}>RADIO</Text>
                {/* TODO: soft reset isn't implemented yet (no firmware command) */}
                <TouchableOpacity style={[styles.calibrateBtn, { opacity: 0.4, marginBottom: 8 }]} disabled>
                  <Text style={styles.calibrateBtnText}>↺  SOFT RESET FIRMWARE</Text>
                </TouchableOpacity>
                <Text style={styles.settingsStatus}>Not available yet</Text>
              </>
            )}

            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
    </ThemeContext.Provider>
  );
}


// ─── Theme Palettes ───────────────────────────────────────────────────────────
const darkColors = {
  bg:            '#0a0f1a',
  surface:       '#111827',
  surfaceAlt:    '#0d1525',
  border:        '#1e2d42',
  accent:        '#00e5ff',
  accentText:    '#001820',
  accentSurface: '#001820',
  warn:          '#ffd600',
  danger:        '#f44336',
  dropped:       '#ff6d00',
  scanningDot:   '#888888',
  dim:           '#3a4a60',
  text:          '#c8d8e8',
  textDim:       '#4a6080',
  textBright:    '#ffffff',
  inactiveBar:   '#2a4060',
  trackBg:       '#1a2535',
  dirInactiveBg:   '#1a2030',
  dirInactiveText: '#3a4a60',
  logBg:         '#080d15',
  logText:       '#3a7a5a',
  statusBarStyle: 'light-content',
};

const lightColors = {
  bg:            '#f4f6fa',
  surface:       '#ffffff',
  surfaceAlt:    '#eef1f6',
  border:        '#d5dce6',
  accent:        '#0091a8',
  accentText:    '#ffffff',
  accentSurface: '#e0f7fa',
  warn:          '#b8860b',
  danger:        '#d32f2f',
  dropped:       '#e65100',
  scanningDot:   '#9aa5b1',
  dim:           '#aab4c2',
  text:          '#1a2436',
  textDim:       '#5b6b80',
  textBright:    '#0a0f1a',
  inactiveBar:   '#aaaeb3',
  trackBg:       '#e4e9f0',
  dirInactiveBg:   '#e4e9f0',
  dirInactiveText: '#9aa5b1',
  logBg:         '#eef1f6',
  logText:       '#2f7a52',
  statusBarStyle: 'dark-content',
};

const createStyles = (C) => StyleSheet.create({
  root:            { flex: 1, backgroundColor: C.bg },
  scroll:          { flex: 1 },
  scrollContent:   { padding: 16 },

  header:          { paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20, backgroundColor: C.bg },
  headerRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle:     { fontSize: 26, fontWeight: '900', color: C.textBright, letterSpacing: 4 },
  headerLogo:      { height: 36, aspectRatio: 755 / 190, alignSelf: 'flex-start' },
  headerAccent:    { color: C.accent },
  headerSub:       { fontSize: 11, color: C.textDim, letterSpacing: 2, marginTop: 2 },
  themeToggle:     { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  themeToggleText: { fontSize: 18 },
  headerBtns:      { flexDirection: 'row', gap: 8 },
  updateDot:       { position: 'absolute', top: -2, right: -2, width: 12, height: 12, borderRadius: 6,
                     backgroundColor: C.warn, borderWidth: 2, borderColor: C.bg },

  settingsTitle:   { fontSize: 18, fontWeight: '900', color: C.text, letterSpacing: 4 },
  settingsTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 10 },
  settingsNote:    { color: C.textDim, fontSize: 12, marginBottom: 12 },
  settingsStatus:  { color: C.textDim, fontSize: 12, marginBottom: 8, textAlign: 'center' },
  updateTag:       { color: C.warn, fontSize: 10, fontWeight: '800', letterSpacing: 2 },

  statusCard:      { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface,
                     borderRadius: 10, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: C.border, gap: 14 },
  statusDot:       { width: 12, height: 12, borderRadius: 6 },
  statusLabel:     { fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  statusSub:       { fontSize: 11, color: C.textDim, marginTop: 2 },
  skiBatt:         { alignItems: 'flex-end' },
  skiBattLabel:    { fontSize: 9, color: C.textDim, letterSpacing: 2, fontWeight: '700', marginBottom: 2 },

  mainBtn:         { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 14,
                     alignItems: 'center', marginBottom: 20 },
  mainBtnDisconnect: { backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.danger },
  mainBtnText:     { color: C.accentText, fontWeight: '800', letterSpacing: 2, fontSize: 13 },

  sectionTitle:    { fontSize: 10, color: C.textDim, letterSpacing: 3, fontWeight: '700',
                     marginBottom: 10, marginTop: 8 },

  dirRow:          { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  dirArrow:        { flex: 1, borderRadius: 8, paddingVertical: 20, alignItems: 'center', justifyContent: 'center' },
  dirArrowText:    { fontSize: 28 },
  dirArrowVert:    { width: '34%', alignSelf: 'center', borderRadius: 8, paddingVertical: 16,
                     alignItems: 'center', justifyContent: 'center' },
  dirArrowUp:      { marginBottom: 8 },
  dirArrowDown:    { marginTop: 8 },
  dirCenter:       { flex: 1, alignItems: 'center' },
  dirPairLabel:    { fontSize: 9, color: C.textDim, letterSpacing: 2, fontWeight: '700', marginBottom: 2 },
  dirLabel:        { fontSize: 16, fontWeight: '700', color: C.textDim, letterSpacing: 2 },
  dirLabelActive:  { color: C.text },
  dirPairLabelSecondary: { fontSize: 8, color: C.textDim, letterSpacing: 2, fontWeight: '700',
                           marginTop: 8, marginBottom: 2 },
  dirLabelSecondary: { fontSize: 13, fontWeight: '700', color: C.textDim, letterSpacing: 2 },

  pairBlock:       { backgroundColor: C.surface, borderRadius: 12, padding: 14,
                     marginBottom: 14, borderWidth: 1, borderColor: C.border },
  pairHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  pairLabel:       { fontSize: 11, color: C.text, fontWeight: '800', letterSpacing: 2 },
  invertRow:       { flexDirection: 'row', gap: 6 },
  cardRow:         { flexDirection: 'row', gap: 10 },

  sensorCard:      { backgroundColor: C.surfaceAlt, borderRadius: 8, padding: 10,
                     borderWidth: 1, borderColor: C.border },
  sensorHeader:    { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  sensorLabel:     { color: C.text, fontWeight: '700', fontSize: 13, letterSpacing: 1 },
  sensorMeta:      { flexDirection: 'row', gap: 8, alignItems: 'center' },
  sensorActive:    { fontSize: 9, color: C.dim, fontWeight: '700', letterSpacing: 1.5 },
  sensorActiveOn:  { color: C.accent },
  battText:        { fontSize: 14, color: C.textDim },
  barTrack:        { height: 6, backgroundColor: C.trackBg, borderRadius: 3, position: 'relative', overflow: 'visible' },
  barFill:         { height: 6, borderRadius: 3 },
  barThreshold:    { position: 'absolute', top: -3, width: 2, height: 12, backgroundColor: C.warn, borderRadius: 1 },
  sensMarker:      { position: 'absolute', top: -5, width: 4, height: 16, borderRadius: 2, marginLeft: -2 },
  sensorValue:     { color: C.textDim, fontSize: 10, marginTop: 5, textAlign: 'right' },

  controlLabel:    { color: C.textDim, fontSize: 10, letterSpacing: 2, fontWeight: '700', marginBottom: 8 },
  btnRow:          { flexDirection: 'row', gap: 8, marginBottom: 16 },
  segBtn:          { flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 6,
                     paddingVertical: 10, alignItems: 'center', backgroundColor: C.surface },
  segBtnActive:    { borderColor: C.accent, backgroundColor: C.accentSurface },
  segBtnText:      { color: C.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  segBtnTextActive: { color: C.accent },

  calibrateBtn:    { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingVertical: 14,
                     alignItems: 'center', marginBottom: 20 },
  calibrateBtnText: { color: C.text, fontWeight: '700', letterSpacing: 2, fontSize: 12 },

  logToggle:       { alignItems: 'center', paddingVertical: 10 },
  logToggleText:   { color: C.textDim, fontSize: 10, letterSpacing: 2, fontWeight: '700' },

  dropdownWrap:    { position: 'relative', zIndex: 10, marginBottom: 8 },
  dropdownBtn:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                     borderWidth: 1, borderColor: C.border, borderRadius: 6,
                     paddingVertical: 10, paddingHorizontal: 12, backgroundColor: C.surface },
  dropdownBtnText: { color: C.text, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  dropdownCaret:   { color: C.textDim, fontSize: 10 },
  dropdownMenu:    { position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                     borderWidth: 1, borderColor: C.border, borderRadius: 6,
                     backgroundColor: C.surface, overflow: 'hidden', zIndex: 20 },
  dropdownItem:    { paddingVertical: 10, paddingHorizontal: 12,
                     borderBottomWidth: 1, borderBottomColor: C.border },
  dropdownItemActive: { backgroundColor: C.accentSurface },
  dropdownItemText:   { color: C.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  dropdownItemTextActive: { color: C.accent },

  logBox:          { backgroundColor: C.logBg, borderRadius: 8, padding: 12,
                     borderWidth: 1, borderColor: C.border },
  logLine:         { color: C.logText, fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                     lineHeight: 16 },
});
