#!/usr/bin/env python3
"""Synchronize LG WMVEL2137 microwave and WLSGL5833F range clocks.

The daemon discovers both device IDs from appliance announcements on rethink's
local MQTT broker and keeps monitoring provisioning traffic. A reconnect after
an outage schedules another synchronization at the next minute boundary.
Explicit IDs remain available for installations with multiple matching units.

Each appliance is queried immediately before a clock write so a busy or
unknown appliance is left untouched. Clock writes do not change microwave
sound or range beeper preferences because changing those settings can itself
produce an audible confirmation.
"""

import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess
from threading import Condition, Event, Thread
import time
from urllib.request import urlopen
from zoneinfo import ZoneInfo

MICROWAVE_MODELS = {"WMVEL2137", "MVEL2033F"}
RANGE_MODELS = {"WLSGL5833F"}

MICROWAVE_CLOCK_TEMPLATE = bytearray.fromhex("f043210e1732008000808080130000000000")
RANGE_CLOCK_TEMPLATE = bytearray.fromhex(
    "f043210e0c1a018080808080808080ff8080800107ea0714118000000000000080"
)

SOUND_OFF = "aa16f043210e8080800080808080800000000080f7bb"
SOUND_ON = "aa16f043210e8080800380808080800000000080f0bb"
MICROWAVE_STATUS_QUERY = "aa1cf0ed114101000000180e111718191a1a1b0000000000000091bb"
RANGE_STATUS_QUERY = "aa1cf0ed114001000000180e111718191a1a1b0000000000000096bb"
MICROWAVE_IDLE_PREFIX = bytes.fromhex(
    "003000015500000000000000ff030d000000000000000000000000000000c300000000"
)
RANGE_BEEPER = {
    "mute": "aa25f043210e8080808080808080008080ff8080800000808080808000000000000080e5bb",
    "low": "aa25f043210e8080808080808080018080ff8080800000808080808000000000000080e4bb",
    "high": "aa25f043210e8080808080808080028080ff8080800000808080808000000000000080e7bb",
}
DEFAULT_BROKER_PORT = 1884


def checksum(data):
    return (sum(data) & 0xFF) ^ 0x55


def build(body):
    head = bytes([0xAA, len(body) + 4]) + bytes(body)
    return (head + bytes([checksum(head), 0xBB])).hex()


def microwave_clock_frame(target):
    body = bytearray(MICROWAVE_CLOCK_TEMPLATE)
    body[4] = target.hour
    body[5] = target.minute
    body[6] = 0
    body[12] = 0
    return build(body)


def range_clock_frame(target):
    body = bytearray(RANGE_CLOCK_TEMPLATE)
    body[4] = target.hour % 12 or 12
    body[5] = target.minute
    # Captured ThinQ writes keep byte 6 at 1 for the range's 12-hour display.
    # Byte 19, rather than byte 6, carries the AM (0) / PM (1) flag.
    body[6] = 1
    body[19] = 1 if target.hour >= 12 else 0
    body[20:22] = target.year.to_bytes(2, "big")
    body[22] = target.month
    body[23] = target.day
    body[24] = target.second
    return build(body)


def normalize_model(value):
    if not isinstance(value, str):
        return None
    return value.strip().upper().split(".", 1)[0]


def parse_payload(payload_text):
    try:
        payload = json.loads(payload_text.rstrip("\x00"))
    except (json.JSONDecodeError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def port_from_config(config_path, setting, default=None):
    """Read a scalar or split bind port from rethink's JSON-with-comments config."""
    try:
        text = Path(config_path).read_text(encoding="utf-8")
    except OSError:
        return default

    match = re.search(rf'"{re.escape(setting)}"\s*:\s*(?:(\d+)|\{{(.*?)\}})', text, re.DOTALL)
    if not match:
        return default
    if match.group(1):
        return int(match.group(1))
    bind = re.search(r'"bind"\s*:\s*(\d+)', match.group(2))
    return int(bind.group(1)) if bind else default


def broker_port_from_config(config_path):
    return port_from_config(config_path, "mqtt_port", DEFAULT_BROKER_PORT)


def classify_inventory(inventory):
    """Return appliance IDs from rethink's current management inventory."""
    found = {}
    if not isinstance(inventory, dict):
        return found
    for device_id, info in inventory.items():
        if not isinstance(device_id, str) or not isinstance(info, dict):
            continue
        models = {normalize_model(info.get("model")), normalize_model(info.get("modelName"))}
        if models & MICROWAVE_MODELS:
            found.setdefault("microwave", device_id)
        if models & RANGE_MODELS:
            found.setdefault("range", device_id)
    return found


def management_inventory(host, port, timeout=5):
    with urlopen(f"http://{host}:{port}/api/devices", timeout=timeout) as response:
        return json.load(response)


def classify_announcement(topic, payload_text):
    """Return (appliance, device_id) for a supported local MQTT announcement."""
    if "clip/message/devices/" not in topic and "clip/provisioning/devices/" not in topic:
        return None
    payload = parse_payload(payload_text)
    if payload is None:
        return None

    device_id = payload.get("did")
    data = payload.get("data")
    app_info = data.get("appInfo", {}) if isinstance(data, dict) else {}
    models = {
        normalize_model(payload.get("kind")),
        normalize_model(app_info.get("modelName")),
    }
    if not isinstance(device_id, str) or not device_id:
        return None
    if models & MICROWAVE_MODELS:
        return "microwave", device_id
    if models & RANGE_MODELS:
        return "range", device_id
    return None


def decode_microwave_record(payload):
    """Return (current record, is queried snapshot) for 41EB/41EC."""
    if not isinstance(payload, dict) or payload.get("cmd") != "device_packet":
        return None
    data = payload.get("data")
    if not isinstance(data, str):
        return None
    try:
        packet = bytes.fromhex(data)
    except ValueError:
        return None
    if len(packet) < 4 or packet[0] != 0xAA or packet[-1] != 0xBB:
        return None
    body = packet[2:-2]
    if len(packet) == 0x34 and packet[1] == 0x34 and body[0:2] == bytes([0x41, 0xEB]):
        return body[2:], True
    elif len(packet) == 0x62 and packet[1] == 0x62 and body[0:2] == bytes([0x41, 0xEC]):
        return body[2 + 46 : 2 + 46 * 2], False
    return None


def decode_sound_preference(payload):
    """Decode the stable 0x50/0x53 microwave sound setting, if present."""
    decoded = decode_microwave_record(payload)
    if decoded is None:
        return None
    current, _ = decoded
    sound = current[35]
    if (sound & 0xFC) != 0x50 or (sound & 0x03) not in (0, 3):
        return None
    return (sound & 0x03) == 3


def decode_microwave_busy(payload):
    """Conservatively require the captured standby operational fingerprint."""
    decoded = decode_microwave_record(payload)
    if decoded is None:
        return None
    current, _ = decoded
    if current[1] & 0xFE != 0x30:
        return None
    operational = bytearray(current[: len(MICROWAVE_IDLE_PREFIX)])
    # The low bit of byte 1 changes from 0x30 to 0x31 after a clock write while
    # all other captured idle fields remain unchanged. It is not a use-state bit.
    operational[1] &= 0xFE
    return bytes(operational) != MICROWAVE_IDLE_PREFIX


def decode_range_record(payload):
    """Return (current record, is queried snapshot) for 40EB/40EC."""
    if not isinstance(payload, dict) or payload.get("cmd") != "device_packet":
        return None
    data = payload.get("data")
    if not isinstance(data, str):
        return None
    try:
        packet = bytes.fromhex(data)
    except ValueError:
        return None
    if len(packet) < 4 or packet[0] != 0xAA or packet[-1] != 0xBB:
        return None
    body = packet[2:-2]
    if len(packet) == 0x51 and packet[1] == 0x51 and body[0:2] == bytes([0x40, 0xEB]):
        return body[2:], True
    elif len(packet) == 0x9C and packet[1] == 0x9C and body[0:2] == bytes([0x40, 0xEC]):
        return body[2 + 75 : 2 + 75 * 2], False
    return None


def decode_range_beeper_preference(payload):
    """Decode WLSGL5833F 40EB/40EC record byte 6 as mute/low/high."""
    decoded = decode_range_record(payload)
    if decoded is None:
        return None
    current, _ = decoded
    return {0: "mute", 1: "low", 2: "high"}.get(current[6])


def decode_range_busy(payload):
    """Require both oven OFF and the queried aggregate cooktop flag inactive."""
    decoded = decode_range_record(payload)
    if decoded is None:
        return None
    current, _ = decoded
    if current[15] != 0 or current[31] == 0x06:
        return True
    if current[15] == 0 and current[31] == 0x0E:
        return False
    return None


def decode_range_active_edge(payload):
    """Decode immediate burner aggregate edges; return None for other packets."""
    if not isinstance(payload, dict) or payload.get("cmd") != "device_packet":
        return None
    data = payload.get("data")
    if not isinstance(data, str):
        return None
    try:
        packet = bytes.fromhex(data)
    except ValueError:
        return None
    if len(packet) < 8 or packet[0] != 0xAA or packet[-1] != 0xBB:
        return None
    body = packet[2:-2]
    if len(body) == 4 and body[0:2] == bytes([0x40, 0xB1]):
        if body[2:4] == bytes([1, 1]):
            return True
        if body[2:4] == bytes([2, 0]):
            return False
    if len(body) >= 4 and body[0:2] == bytes([0x40, 0xB2]):
        subtype = int.from_bytes(body[2:4], "big")
        if subtype == 0x0021:
            return True
        if subtype == 0x0022:
            return False
    return None


def decode_device_ack(payload):
    """Identify the captured generic ACK for either supported appliance."""
    if not isinstance(payload, dict) or payload.get("cmd") != "device_packet":
        return None
    data = payload.get("data")
    if not isinstance(data, str):
        return None
    normalized = data.replace(" ", "").lower()
    if normalized == "aa084100430063bb":
        return "microwave"
    if normalized == "aa084000430060bb":
        return "range"
    return None


class ApplianceMonitor:
    """Track appliance discovery, status, acknowledgements, and reconnects."""

    def __init__(self, host, port, microwave_id=None, range_id=None):
        self.host = host
        self.port = port
        self.microwave_id = microwave_id
        self.range_id = range_id
        self.sound_enabled = None
        self.sound_revision = 0
        self.microwave_ack_revision = 0
        self.microwave_busy = None
        self.range_beeper_volume = None
        self.beeper_revision = 0
        self.range_ack_revision = 0
        self.range_busy = None
        self.range_cooktop_active = None
        self.condition = Condition()
        self.reconnect = Event()
        self.process = None
        self.failure = None
        self.closing = False

    def start(self):
        command = [
            "mosquitto_sub",
            "-h",
            self.host,
            "-p",
            str(self.port),
            "-v",
            "-t",
            "clip/message/devices/+",
            "-t",
            "clip/provisioning/devices/+",
        ]
        try:
            self.process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError as error:
            raise RuntimeError("mosquitto_sub is required for discovery and reconnect monitoring") from error
        Thread(target=self._read_lines, daemon=True).start()

    def close(self):
        if self.process is None:
            return
        self.closing = True
        self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process = None

    def discover(self, need_microwave, need_range, timeout, require_all=True):
        print(f"Discovering connected appliances for up to {timeout:g} seconds...")
        deadline = time.monotonic() + timeout
        with self.condition:
            while (need_microwave and not self.microwave_id) or (need_range and not self.range_id):
                if self.failure:
                    raise RuntimeError(self.failure)
                have_any = (need_microwave and self.microwave_id) or (need_range and self.range_id)
                if not require_all and have_any:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(remaining)

            missing = []
            if need_microwave and not self.microwave_id:
                missing.append("WMVEL2137/MVEL2033F microwave")
            if need_range and not self.range_id:
                missing.append("WLSGL5833F range")
            if missing:
                if require_all:
                    raise RuntimeError(
                        f"timed out discovering {', '.join(missing)}; verify it is online or provide the corresponding "
                        "--*-id override"
                    )
                print(f"Still waiting for {', '.join(missing)}; continuing with available appliances")
            return self.microwave_id, self.range_id

    def device_ids(self):
        with self.condition:
            return self.microwave_id, self.range_id

    def sound_preference(self):
        with self.condition:
            return self.sound_enabled

    def sound_snapshot(self):
        with self.condition:
            return self.sound_revision, self.sound_enabled

    def wait_for_sound_report(self, after_revision, timeout):
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.sound_revision <= after_revision:
                if self.failure:
                    raise RuntimeError(self.failure)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False, None, None
                self.condition.wait(remaining)
            return True, self.sound_enabled, self.microwave_busy

    def beeper_preference(self):
        with self.condition:
            return self.range_beeper_volume

    def beeper_snapshot(self):
        with self.condition:
            return self.beeper_revision, self.range_beeper_volume

    def wait_for_beeper_report(self, after_revision, timeout):
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.beeper_revision <= after_revision:
                if self.failure:
                    raise RuntimeError(self.failure)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False, None, None
                self.condition.wait(remaining)
            return True, self.range_beeper_volume, self.range_busy

    def busy_states(self):
        with self.condition:
            return self.microwave_busy, self.range_busy

    def ack_snapshot(self, appliance):
        with self.condition:
            return self.microwave_ack_revision if appliance == "microwave" else self.range_ack_revision

    def wait_for_ack(self, appliance, after_revision, timeout):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                revision = self.microwave_ack_revision if appliance == "microwave" else self.range_ack_revision
                if revision > after_revision:
                    return True
                if self.failure:
                    raise RuntimeError(self.failure)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.condition.wait(remaining)

    def _read_lines(self):
        assert self.process is not None and self.process.stdout is not None
        for line in self.process.stdout:
            topic, separator, payload_text = line.rstrip("\r\n").partition(" ")
            if not separator:
                continue
            self.process_message(topic, payload_text)
        if not self.closing:
            assert self.process.stderr is not None
            detail = self.process.stderr.read().strip()
            with self.condition:
                self.failure = "MQTT subscriber exited"
                if detail:
                    self.failure += f": {detail}"
                self.condition.notify_all()

    def process_message(self, topic, payload_text):
        """Consume one broker message. Kept separate for protocol tests."""
        match = classify_announcement(topic, payload_text)
        payload = parse_payload(payload_text)
        if payload is None:
            return

        with self.condition:
            discovered = False
            if match:
                appliance, device_id = match
                if appliance == "microwave" and not self.microwave_id:
                    self.microwave_id = device_id
                    discovered = True
                    print(f"Discovered microwave {device_id}")
                elif appliance == "range" and not self.range_id:
                    self.range_id = device_id
                    discovered = True
                    print(f"Discovered range {device_id}")

            device_id = payload.get("did")
            if device_id == self.microwave_id or (match and match[0] == "microwave"):
                if decode_device_ack(payload) == "microwave":
                    self.microwave_ack_revision += 1
                decoded = decode_microwave_record(payload)
                if decoded is not None:
                    _, is_snapshot = decoded
                    sound = decode_sound_preference(payload)
                    if sound is not None:
                        if sound != self.sound_enabled:
                            self.sound_enabled = sound
                            print(f"Microwave sound preference: {'ON' if sound else 'OFF'}")
                    busy = decode_microwave_busy(payload)
                    if is_snapshot or busy is True:
                        previous_busy = self.microwave_busy
                        self.microwave_busy = busy
                        if busy != previous_busy:
                            state = "UNKNOWN" if busy is None else "BUSY" if busy else "IDLE"
                            print(f"Microwave use state: {state}")
                    if is_snapshot:
                        self.sound_revision += 1

            if device_id == self.range_id or (match and match[0] == "range"):
                if decode_device_ack(payload) == "range":
                    self.range_ack_revision += 1
                decoded = decode_range_record(payload)
                if decoded is not None:
                    _, is_snapshot = decoded
                    beeper = decode_range_beeper_preference(payload)
                    if beeper is not None:
                        if beeper != self.range_beeper_volume:
                            self.range_beeper_volume = beeper
                            print(f"Range beeper preference: {beeper.upper()}")
                    busy = decode_range_busy(payload)
                    if self.range_cooktop_active is True:
                        busy = True
                    if is_snapshot or busy is True:
                        previous_busy = self.range_busy
                        self.range_busy = busy
                        if busy != previous_busy:
                            state = "UNKNOWN" if busy is None else "BUSY" if busy else "IDLE"
                            print(f"Range use state: {state}")
                    if is_snapshot:
                        self.beeper_revision += 1
                active_edge = decode_range_active_edge(payload)
                if active_edge is not None:
                    self.range_cooktop_active = active_edge
                    if active_edge is True and self.range_busy is not True:
                        self.range_busy = True
                        print("Range use state: BUSY")

            if discovered or (
                "clip/provisioning/devices/" in topic
                and device_id in (self.microwave_id, self.range_id)
                and payload.get("cmd") in ("preDeploy", "deploy")
            ):
                self.reconnect.set()
            self.condition.notify_all()


class Publisher:
    def __init__(self, host, port, dry_run=False):
        self.host = host
        self.port = port
        self.dry_run = dry_run
        self.last_mid = 0

    def send(self, device_id, frame, label):
        self.last_mid = max(self.last_mid + 1, time.time_ns() // 1_000_000)
        payload = json.dumps(
            {
                "did": device_id,
                "mid": self.last_mid,
                "cmd": "packet",
                "type": 1,
                "data": frame,
            }
        )
        if self.dry_run:
            print(f"{label}: {payload}")
            return
        subprocess.run(
            [
                "mosquitto_pub",
                "-h",
                self.host,
                "-p",
                str(self.port),
                "-t",
                f"lime/devices/{device_id}",
                "-m",
                payload,
            ],
            check=True,
        )
        print(f"{label}: sent to {device_id}")


def send_clock_setting(publisher, monitor, appliance, device_id, frame, label, timeout):
    """Send a clock write without changing audio settings and await its ACK."""
    if publisher.dry_run or monitor is None:
        publisher.send(device_id, frame, label)
        if not publisher.dry_run:
            time.sleep(1.25)
        return

    ack_revision = monitor.ack_snapshot(appliance)
    publisher.send(device_id, frame, label)
    if not monitor.wait_for_ack(appliance, ack_revision, timeout):
        raise TimeoutError(f"{label} ACK timed out")
    print(f"{label}: ACK confirmed")


def sync_target(
    publisher,
    target,
    microwave_id,
    range_id,
    only,
    microwave_busy=False,
    range_busy=False,
    monitor=None,
    command_timeout=2.0,
):
    errors = []
    if only in ("both", "microwave") and microwave_id and microwave_busy is False:
        try:
            send_clock_setting(
                publisher,
                monitor,
                "microwave",
                microwave_id,
                microwave_clock_frame(target),
                f"microwave clock {target.isoformat()}",
                command_timeout,
            )
        except Exception as error:
            errors.append(("microwave", error))

    elif only in ("both", "microwave"):
        if not microwave_id:
            print("microwave unavailable; clock update deferred")
        else:
            state = "busy" if microwave_busy else "state unknown"
            print(f"microwave {state}; clock update deferred")

    if only in ("both", "range") and range_id and range_busy is False:
        try:
            send_clock_setting(
                publisher,
                monitor,
                "range",
                range_id,
                range_clock_frame(target),
                f"range clock {target.isoformat()}",
                command_timeout,
            )
        except Exception as error:
            errors.append(("range", error))
    elif only in ("both", "range"):
        if not range_id:
            print("range unavailable; clock update deferred")
        else:
            state = "busy" if range_busy else "state unknown"
            print(f"range {state}; clock update deferred")

    for appliance, error in errors:
        print(f"{appliance} time sync failed: {error}")
    if errors:
        raise RuntimeError("one or more appliance clock updates failed")


def next_minute_boundary(now=None):
    now = time.time() if now is None else now
    return (int(now) // 60 + 1) * 60


def next_queryable_boundary(query_lead, now=None):
    now = time.time() if now is None else now
    boundary = next_minute_boundary(now)
    return boundary + 60 if boundary - now < query_lead else boundary


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.json", help="rethink config used to discover the MQTT bind port")
    parser.add_argument("--broker-host", default="127.0.0.1")
    parser.add_argument("--broker-port", type=int, help="override the MQTT bind port from --config")
    parser.add_argument("--management-host", default="127.0.0.1")
    parser.add_argument("--management-port", type=int, help="override management_port from --config")
    parser.add_argument("--microwave-id", help="override automatic microwave discovery")
    parser.add_argument("--range-id", help="override automatic range discovery")
    parser.add_argument("--discover-timeout", type=float, default=90, help="discovery timeout in seconds")
    parser.add_argument("--timezone", help="IANA timezone; defaults to the server timezone")
    parser.add_argument("--period", type=int, default=86400, help="seconds between updates (default: 86400)")
    parser.add_argument("--lead", type=float, default=0.35, help="seconds before the minute boundary")
    parser.add_argument("--query-lead", type=float, default=3.0, help="seconds before the boundary to query settings")
    parser.add_argument("--status-timeout", type=float, default=2.0, help="seconds to await queried status snapshots")
    parser.add_argument("--only", choices=("both", "microwave", "range"), default="both")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    direct = parser.add_mutually_exclusive_group()
    direct.add_argument("--sound", choices=("on", "off"), help="send only a microwave sound command")
    direct.add_argument(
        "--set-range-beeper",
        choices=("mute", "low", "high"),
        help="send only the selected range beeper command",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    if args.period <= 0:
        raise ValueError("--period must be positive")
    if args.discover_timeout <= 0:
        raise ValueError("--discover-timeout must be positive")
    if args.status_timeout <= 0:
        raise ValueError("--status-timeout must be positive")
    if args.query_lead <= args.lead + args.status_timeout:
        raise ValueError("--query-lead must exceed --lead plus --status-timeout")
    timezone = ZoneInfo(args.timezone) if args.timezone else None
    broker_port = args.broker_port if args.broker_port is not None else broker_port_from_config(args.config)
    print(f"Using rethink MQTT broker {args.broker_host}:{broker_port}")

    direct_action = args.sound is not None or args.set_range_beeper is not None
    need_microwave = args.sound is not None or (not direct_action and args.only in ("both", "microwave"))
    need_range = args.set_range_beeper is not None or (not direct_action and args.only in ("both", "range"))
    microwave_id = args.microwave_id
    range_id = args.range_id
    management_port = (
        args.management_port
        if args.management_port is not None
        else port_from_config(args.config, "management_port")
    )
    if management_port and ((need_microwave and not microwave_id) or (need_range and not range_id)):
        try:
            inventory = classify_inventory(management_inventory(args.management_host, management_port))
            if need_microwave and not microwave_id:
                microwave_id = inventory.get("microwave")
                if microwave_id:
                    print(f"Discovered microwave {microwave_id} from rethink management")
            if need_range and not range_id:
                range_id = inventory.get("range")
                if range_id:
                    print(f"Discovered range {range_id} from rethink management")
        except Exception as error:
            print(f"Rethink management inventory unavailable: {error}; falling back to MQTT traffic")

    monitor = ApplianceMonitor(args.broker_host, broker_port, microwave_id, range_id)
    monitor.start()
    try:
        microwave_id, range_id = monitor.discover(
            need_microwave,
            need_range,
            args.discover_timeout,
            require_all=args.once or direct_action,
        )
        publisher = Publisher(args.broker_host, broker_port, args.dry_run)

        if args.sound:
            publisher.send(microwave_id, SOUND_ON if args.sound == "on" else SOUND_OFF, f"sound {args.sound}")
            return
        if args.set_range_beeper:
            publisher.send(
                range_id,
                RANGE_BEEPER[args.set_range_beeper],
                f"range beeper {args.set_range_beeper.upper()}",
            )
            return

        # Initial startup always receives an ASAP sync; provisioning messages
        # consumed during discovery are part of that startup and can be cleared.
        monitor.reconnect.clear()
        want_microwave = args.only in ("both", "microwave")
        want_range = args.only in ("both", "range")
        pending_microwave = want_microwave
        pending_range = want_range
        next_sync = next_queryable_boundary(args.query_lead)
        while True:
            wait = max(0, next_sync - args.query_lead - time.time())
            if not args.dry_run and monitor.reconnect.wait(wait):
                monitor.reconnect.clear()
                pending_microwave = want_microwave
                pending_range = want_range
                next_sync = next_queryable_boundary(args.query_lead)
                print(f"Appliance reconnection detected; clock sync scheduled for {datetime.fromtimestamp(next_sync, timezone)}")
                continue

            microwave_id, range_id = monitor.device_ids()
            microwave_busy = None
            range_busy = None
            sound_revision = None
            beeper_revision = None
            if microwave_id and pending_microwave:
                sound_revision, _ = monitor.sound_snapshot()
                publisher.send(microwave_id, MICROWAVE_STATUS_QUERY, "microwave status query")
            if range_id and pending_range:
                beeper_revision, _ = monitor.beeper_snapshot()
                publisher.send(range_id, RANGE_STATUS_QUERY, "range status query")

            if args.dry_run:
                microwave_busy = False
                range_busy = False
            else:
                status_deadline = time.monotonic() + args.status_timeout
                if sound_revision is not None:
                    fresh, _, microwave_busy = monitor.wait_for_sound_report(
                        sound_revision,
                        max(0, status_deadline - time.monotonic()),
                    )
                    if not fresh:
                        print("microwave status query timed out; clock update will be deferred")
                if beeper_revision is not None:
                    fresh, _, range_busy = monitor.wait_for_beeper_report(
                        beeper_revision,
                        max(0, status_deadline - time.monotonic()),
                    )
                    if not fresh:
                        print("range status query timed out; clock update will be deferred")

            wait = max(0, next_sync - args.lead - time.time())
            if not args.dry_run and monitor.reconnect.wait(wait):
                monitor.reconnect.clear()
                pending_microwave = want_microwave
                pending_range = want_range
                next_sync = next_queryable_boundary(args.query_lead)
                print(f"Appliance reconnection detected; clock sync scheduled for {datetime.fromtimestamp(next_sync, timezone)}")
                continue

            if not args.dry_run:
                live_microwave_busy, live_range_busy = monitor.busy_states()
                if live_microwave_busy is True:
                    microwave_busy = True
                if live_range_busy is True:
                    range_busy = True

            target = datetime.fromtimestamp(next_sync, timezone)
            microwave_id, range_id = monitor.device_ids()
            cycle_only = "both" if pending_microwave and pending_range else "microwave" if pending_microwave else "range"
            sync_target(
                publisher,
                target,
                microwave_id,
                range_id,
                cycle_only,
                microwave_busy,
                range_busy,
                monitor,
                args.status_timeout,
            )
            if pending_microwave and (not microwave_id or microwave_busy is False):
                pending_microwave = False
            if pending_range and (not range_id or range_busy is False):
                pending_range = False
            if args.once:
                return
            if pending_microwave or pending_range:
                next_sync = next_queryable_boundary(args.query_lead)
            else:
                next_sync += args.period
                if next_sync <= time.time():
                    next_sync = next_queryable_boundary(args.query_lead)
                pending_microwave = want_microwave
                pending_range = want_range
    finally:
        monitor.close()


if __name__ == "__main__":
    main()
