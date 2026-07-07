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

import { BleManager, State } from 'react-native-ble-plx';

// ─── BLE UUIDs (must match OTATest.ino) ──────────────────────────────────────
const SERVICE_UUID      = '12345678-1234-1234-1234-123456789abc';
const SENSOR_DATA_UUID  = '12345678-1234-1234-1234-123456789abd';
const BATTERY_DATA_UUID = '12345678-1234-1234-1234-123456789abe';
const COMMAND_UUID      = '12345678-1234-1234-1234-123456789abf';
const CONFIG_UUID       = '12345678-1234-1234-1234-123456789ac0';
const DEVICE_NAME       = 'TetraRadio';

const ThemeContext = React.createContext(null);

// ─── Real BLE Hook ────────────────────────────────────────────────────────────
function useBLE() {
  const [state, setState] = useState({
    radioDetected: false,
    radioConnected: false,
    scanning: false,
    sensorDropped: false,  //true when sensor data has been silent for >3s
    sensorMode: 2,
    sensitivities: [50, 50, 50, 50],
    invertPair0: false,
    invertPair1: false,
    direction0: 0, val0: 0, val1: 0,
    direction1: 0, val2: 0, val3: 0,
    battLevels: [0, 0, 0, 0],
    log: ['Ready. Press SCAN to find TetraRadio.'],
  });

  const managerRef   = useRef(null);
  const deviceRef    = useRef(null);
  const scanTimerRef = useRef(null);
  const lastDataTime = useRef(null);

  // Initialise BLE manager once
  useEffect(() => {
    managerRef.current = new BleManager();
    return () => {
      managerRef.current?.destroy();
    };
  }, []);

  const addLog = useCallback((msg) => {
    setState(prev => ({
      ...prev,
      log: [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.log.slice(0, 49)],
    }));
  }, []);

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
  const subscribeToDevice = useCallback(async (device) => {
    try {
      // Sensor data — NOTIFY characteristic, fires on every Arduino update
      device.monitorCharacteristicForService(
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
          setState(prev => ({
            ...prev,
            direction0, val0, val1,
            direction1, val2, val3,
          }));
        }
      );

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

      // Clean up battery polling when device disconnects
      device.onDisconnected(() => {
        clearInterval(battInterval);
        deviceRef.current = null;
        lastDataTime.current = null;
        setState(prev => ({
          ...prev,
          radioDetected: false,
          radioConnected: false,
          sensorDropped: false,
          direction0: 0, val0: 0, val1: 0,
          direction1: 0, val2: 0, val3: 0,
          battLevels: [0, 0, 0, 0],
        }));
        addLog('TetraRadio disconnected');
      });

      addLog('Subscribed to sensor data');

      // Monitor config characteristic — firmware sends one packet on phone connect
      // with current settings so app display matches firmware state.
      // Packet: [sensorCount, inversionFlags, sens0, sens1, sens2, sens3]
      device.monitorCharacteristicForService(
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
    } catch (e) {
      addLog(`Subscribe error: ${e.message}`);
    }
  }, [addLog]);

  const startScan = useCallback(async () => {
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      addLog('Bluetooth permissions denied');
      return;
    }

    // Wait for BLE to be powered on
    const bleState = await managerRef.current.state();
    if (bleState !== State.PoweredOn) {
      addLog('Bluetooth is off — please enable it');
      return;
    }

    setState(prev => ({ ...prev, scanning: true, radioDetected: false, radioConnected: false }));
    addLog('Scanning for TetraRadio...');

    // Auto-stop scan after 15 seconds if nothing found
    scanTimerRef.current = setTimeout(() => {
      managerRef.current?.stopDeviceScan();
      setState(prev => ({ ...prev, scanning: false }));
      addLog('Scan timeout — TetraRadio not found');
    }, 15000);

    managerRef.current.startDeviceScan(
      null,   // filter by service UUID so we only see TetraRadio
      null,
      async (error, device) => {
        if (error) {
          addLog(`Scan error: ${error.message}`);
          setState(prev => ({ ...prev, scanning: false }));
          clearTimeout(scanTimerRef.current);
          return;
        }

        if (device?.name === DEVICE_NAME) {
          // Found it — stop scan and connect
          managerRef.current.stopDeviceScan();
          clearTimeout(scanTimerRef.current);
          setState(prev => ({ ...prev, radioDetected: true, scanning: false }));
          addLog(`Found ${DEVICE_NAME}! Connecting...`);

          try {
            const connected = await device.connect();
            await connected.discoverAllServicesAndCharacteristics();
            deviceRef.current = connected;
            setState(prev => ({ ...prev, radioConnected: true }));
            addLog(`Connected to ${DEVICE_NAME}`);
            subscribeToDevice(connected);
          } catch (e) {
            addLog(`Connection failed: ${e.message}`);
            setState(prev => ({ ...prev, radioDetected: false }));
          }
        }
      }
    );
  }, [requestPermissions, subscribeToDevice, addLog]);

  const disconnect = useCallback(async () => {
    clearTimeout(scanTimerRef.current);
    managerRef.current?.stopDeviceScan();
    if (deviceRef.current) {
      try {
        await deviceRef.current.cancelConnection();
      } catch (e) {
        // Already disconnected — ignore
      }
      deviceRef.current = null;
    }
    setState(prev => ({
      ...prev,
      radioDetected: false,
      radioConnected: false,
      scanning: false,
      direction0: 0, val0: 0, val1: 0,
      direction1: 0, val2: 0, val3: 0,
      battLevels: [0, 0, 0, 0],
    }));
    addLog('Disconnected');
  }, [addLog]);

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
      deviceRef.current?.cancelConnection().catch(() => {});
    };
  }, []);

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

  return { state, startScan, disconnect, sendCommand, handleSensorMode, handleSensitivity, handleInvert };
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
function SensorCard({ label, value, max = 200, threshold, battery, sensitivityValue, onSensitivityChange }) {
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
  const { state, startScan, disconnect, sendCommand, handleSensorMode, handleSensitivity, handleInvert } = useBLE();
  const { radioDetected, radioConnected, scanning, sensorDropped,
          sensorMode, sensitivities, invertPair0, invertPair1,
          direction0, val0, val1, direction1, val2, val3,
          battLevels, log } = state;

  const [showLog, setShowLog] = useState(false);
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

        {/* Scan / Disconnect Button */}
        <TouchableOpacity
          style={[styles.mainBtn, radioConnected && styles.mainBtnDisconnect]}
          onPress={radioConnected ? disconnect : startScan}
          disabled={scanning}
        >
          <Text style={styles.mainBtnText}>
            {scanning ? 'SCANNING...' : radioConnected ? 'DISCONNECT' : 'SCAN FOR RADIO'}
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
              threshold={100}
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
                threshold={100}
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
          </>
        )}

        {/* Log Toggle */}
        <TouchableOpacity style={styles.logToggle} onPress={() => setShowLog(v => !v)}>
          <Text style={styles.logToggleText}>{showLog ? '▲ HIDE LOG' : '▼ SHOW LOG'}</Text>
        </TouchableOpacity>

        {showLog && (
          <View style={styles.logBox}>
            {log.map((line, i) => (
              <Text key={i} style={styles.logLine}>{line}</Text>
            ))}
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
  logBox:          { backgroundColor: C.logBg, borderRadius: 8, padding: 12,
                     borderWidth: 1, borderColor: C.border },
  logLine:         { color: C.logText, fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
                     lineHeight: 16 },
});
