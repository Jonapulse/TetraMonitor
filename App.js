import React, { useState, useEffect, useRef, useCallback, useContext, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  StatusBar,
  Platform,
  PermissionsAndroid,
  PanResponder,
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

// ─── BLE OTA UUIDs (must match OTAService.ino) ───────────────────────────────
// NOTE: placeholder values — swap in the real generated UUIDs once finalized
// in OTAService.ino, and keep both sides in sync.
const OTA_SERVICE_UUID  = 'c076ed50-9e91-4566-9023-3cb1b9173244';
const OTA_CONTROL_UUID  = 'ed3c98b9-0a71-45e0-9b14-b89d3316549d';
const OTA_DATA_UUID     = 'ee191e3a-95c6-4bf1-92b8-1980c9e7b8e9';
const OTA_STATUS_UUID   = '5c8b02e7-5520-468f-bcba-fcc5093da1c9';
const OTA_VERSION_UUID  = 'c82f2a3c-f48c-4cfa-b447-0277467898e4';

const OTA_CHUNK_PAYLOAD_MAX = 244;
const OTA_TARGET_MTU        = 249; 
const OTA_CHUNK_DELAY_MS    = 5;  

// Status codes sent by the radio over OTA_STATUS_UUID — must match the
// OTAStatusCode enum in OTAService.ino.
const OTA_STATUS = {
  READY:     0x01,
  PROGRESS:  0x02,
  DONE:      0x03,
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
  });

  const managerRef   = useRef(bleManager);
  const deviceRef    = useRef(null);
  const scanTimerRef = useRef(null);
  const lastDataTime = useRef(null);
  const subscriptionsRef = useRef({ sensorSub: null, configSub: null, disconnectSub: null, battInterval: null, otaSub: null });
  const disconnectFallbackRef = useRef(null);
  const isConnectingRef = useRef(false);
  const otaAbortRef = useRef(false);

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
          }
        } catch (e) {
          // Non-fatal — battery read failure doesn't affect sensor data
        }
      };
      readBattery();
      const battInterval = setInterval(readBattery, 5000);
      subscriptionsRef.current.battInterval = battInterval;

      // Clean up all listeners/intervals when device disconnects — whether
      // that's from the user tapping disconnect or an unexpected drop.
      const disconnectSub = device.onDisconnected(() => {
        clearTimeout(disconnectFallbackRef.current);
        cleanupSubscriptions();
        deviceRef.current = null;
        lastDataTime.current = null;
        prevDirection0.current = 0;
        prevDirection1.current = 0;
        setState(prev => ({
          ...prev,
          radioDetected: false,
          radioConnected: false,
          sensorDropped: false,
          direction0: 0, val0: 0, val1: 0,
          direction1: 0, val2: 0, val3: 0,
          battLevels: [0, 0, 0, 0],
          firmwareVersion: null,
        }));
        addLog('TetraRadio disconnected');
      });
      subscriptionsRef.current.disconnectSub = disconnectSub;

      addLog('Subscribed to sensor data');

      readFirmwareVersion(device).then(version => {
        if (version) {
          addLog(`Firmware version: ${version}`);
          setState(prev => ({ ...prev, firmwareVersion: version }));
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
  }, [addLog, cleanupSubscriptions, addSerialLog, addRawLog, readFirmwareVersion]);

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

          // Anything delivered here already matched the UUID filter above —
          // no need to check device.name.
          managerRef.current.stopDeviceScan();
          clearTimeout(scanTimerRef.current);
          setState(prev => ({ ...prev, radioDetected: true, scanning: false, connecting: true }));
          addLog(`Found ${device.name || DEVICE_NAME}! Connecting...`);

          try {
            await new Promise(resolve => setTimeout(resolve, 300)); //TODO: Check if you we need this debug thing
            const connected = await device.connect();
            await connected.discoverAllServicesAndCharacteristics();
            deviceRef.current = connected;
            setState(prev => ({ ...prev, radioConnected: true, connecting: false}));
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
    } finally {
      resetConnectingGuard();
    }
  }, [requestPermissions, subscribeToDevice, addLog]);

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
  // firmwareBytes must be a Buffer (or Buffer-compatible Uint8Array) of the
  // full .bin image. Manifest fetch / download / caching happens upstream
  // of this function — this only handles the wire protocol against
  // OTAService.ino once you already have the bytes in hand.
  const sendFirmwareUpdate = useCallback(async (firmwareBytes) => {
    if (!deviceRef.current || !state.radioConnected) {
      addLog('OTA: not connected to radio');
      return { success: false, error: 'Not connected' };
    }

    const device = deviceRef.current;
    const totalSize = firmwareBytes.length;
    const expectedCRC = crc32(firmwareBytes, 0);

    otaAbortRef.current = false;
    setState(prev => ({
      ...prev, otaStatus: 'sending', otaProgress: 0, otaError: null,
      otaBytesTotal: totalSize, otaBytesSent: 0,
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

        if (code === OTA_STATUS.READY || code === OTA_STATUS.DONE) {
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
      const startPayload = Buffer.alloc(9);
      startPayload.write('S', 0, 'ascii');
      startPayload.writeUInt32LE(totalSize, 1);
      startPayload.writeUInt32LE(expectedCRC, 5);

      const readyPromise = waitForStatus();
      await device.writeCharacteristicWithResponseForService(
        OTA_SERVICE_UUID, OTA_CONTROL_UUID, startPayload.toString('base64')
      );
      await readyPromise; // rejects if the radio replies with an error code instead of READY
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
        await new Promise(r => setTimeout(r, OTA_CHUNK_DELAY_MS));

        seq++;
        offset = end;
      }

      // ---- END: verify + apply ----
      if (asyncError) throw asyncError;
      setState(prev => ({ ...prev, otaStatus: 'verifying' }));
      addLog('OTA: all chunks sent, verifying...');

      const donePromise = waitForStatus();
      await device.writeCharacteristicWithResponseForService(
        OTA_SERVICE_UUID, OTA_CONTROL_UUID, Buffer.from(['E'.charCodeAt(0)]).toString('base64')
      );
      await donePromise; // rejects on ERR_CRC / ERR_WRITE

      setState(prev => ({ ...prev, otaStatus: 'done', otaProgress: 1 }));
      addLog('OTA: update applied, radio is rebooting');
      cleanupOTA();
      return { success: true };

    } catch (e) {
      cleanupOTA();
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
function StatusBadge({ detected, connected, scanning, sensorDropped }) {
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
      <View>
        <Text style={[styles.statusLabel, { color }]}>{label}</Text>
        <Text style={styles.statusSub}>{sublabel}</Text>
      </View>
    </View>
  );
}


// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { state, startScan, disconnect, sendCommand, handleSensorMode, handleSensitivity, handleInvert,
          sendFirmwareUpdate, cancelFirmwareUpdate, addLog } = useBLE();
  const { radioDetected, radioConnected, scanning, connecting, sensorDropped,
          sensorMode, sensitivities, invertPair0, invertPair1,
          direction0, val0, val1, direction1, val2, val3,
          battLevels, log, serialLog, rawLog,
          otaStatus, otaProgress, otaBytesSent, otaBytesTotal, otaError,
          firmwareVersion } = state;

  const [showLog, setShowLog] = useState(false);
  const [logStream, setLogStream] = useState('events'); // 'events' | 'serial'
  const [logDropdownOpen, setLogDropdownOpen] = useState(false);
  const [theme, setTheme] = useState('dark');
  const colors = theme === 'dark' ? darkColors : lightColors;
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <ThemeContext.Provider value={{ colors, styles }}>
    <View style={styles.root}>
      <StatusBar barStyle={colors.statusBarStyle} backgroundColor={colors.bg} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>TETRASKI</Text>
            <Text style={styles.headerSub}>Radio Controller Interface</Text>
          </View>
          <TouchableOpacity
            style={styles.themeToggle}
            onPress={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
          >
            <Text style={styles.themeToggleText}>{theme === 'dark' ? '☀️' : '🌙'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        {/* Connection Status */}
        <StatusBadge detected={radioDetected} connected={radioConnected} scanning={scanning} sensorDropped={sensorDropped} />
        {radioConnected && firmwareVersion && (
          <Text style={{ color: colors.textSecondary ?? colors.headerSub, fontSize: 12, textAlign: 'center', marginTop: -8, marginBottom: 8 }}>
            Firmware v{firmwareVersion}
          </Text>
        )}

        {/* Scan / Disconnect Button */}
        <TouchableOpacity
          style={[styles.mainBtn, radioConnected && styles.mainBtnDisconnect]}
          onPress={radioConnected ? disconnect : startScan}
          disabled={scanning || connecting}
        >
          <Text style={styles.mainBtnText}>
            {scanning ? 'SCANNING...' : connecting ? 'CONNECTING...' : radioConnected ? 'DISCONNECT' : 'SCAN FOR RADIO'}
          </Text>
        </TouchableOpacity>

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

            {/* Controls */}
            <Text style={styles.sectionTitle}>CONTROLS</Text>

            <Text style={styles.controlLabel}>SENSOR MODE</Text>
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

            <TouchableOpacity style={styles.calibrateBtn} onPress={() => sendCommand('5')}>
              <Text style={styles.calibrateBtnText}>⟳  RECALIBRATE</Text>
            </TouchableOpacity>

            {/* TEMPORARY: exercises the full OTA path against a REAL firmware
                image manually pushed to TEST_FIRMWARE_PATH via adb, so a
                write+reboot cycle can be validated before the manifest/
                download flow exists. Remove once real update UI replaces it. */}
            <TouchableOpacity
              style={[styles.calibrateBtn, { marginTop: 8 }]}
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
              disabled={otaStatus === 'sending' || otaStatus === 'verifying'}
            >
              <Text style={styles.calibrateBtnText}>
                {otaStatus === 'sending'    ? `⇪ SENDING... ${Math.round(otaProgress * 100)}% (${otaBytesSent}/${otaBytesTotal})`
                  : otaStatus === 'verifying' ? '⇪ VERIFYING...'
                  : '⇪ TEST OTA TRANSFER (firmware.bin)'}
              </Text>
            </TouchableOpacity>
            {otaStatus === 'error' && (
              <Text style={{ color: colors.danger, fontSize: 11, marginTop: 6, textAlign: 'center' }}>
                OTA error: {otaError}
              </Text>
            )}
            {otaStatus === 'done' && (
              <Text style={{ color: colors.accent, fontSize: 11, marginTop: 6, textAlign: 'center' }}>
                Transfer completed — radio should be rebooting now
              </Text>
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
  headerAccent:    { color: C.accent },
  headerSub:       { fontSize: 11, color: C.textDim, letterSpacing: 2, marginTop: 2 },
  themeToggle:     { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
                     backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  themeToggleText: { fontSize: 18 },

  statusCard:      { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface,
                     borderRadius: 10, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: C.border, gap: 14 },
  statusDot:       { width: 12, height: 12, borderRadius: 6 },
  statusLabel:     { fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  statusSub:       { fontSize: 11, color: C.textDim, marginTop: 2 },

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
  battText:        { fontSize: 10, color: C.textDim },
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
