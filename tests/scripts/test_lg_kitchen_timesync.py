from datetime import datetime
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parents[2] / "scripts" / "lg-kitchen-timesync.py"
SPEC = importlib.util.spec_from_file_location("lg_kitchen_timesync", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class KitchenTimeSyncTest(unittest.TestCase):
    def test_periodic_fallback_defaults_to_daily(self):
        with patch("sys.argv", ["lg-kitchen-timesync.py"]):
            self.assertEqual(MODULE.parse_args().period, 86400)

    def test_reads_scalar_and_split_mqtt_bind_ports(self):
        import tempfile

        for value, expected in (("1883", 1883), ('{"bind": 2884, "advertise": 8883}', 2884)):
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as config:
                config.write('{\n  // local plaintext broker\n  "mqtt_port": ' + value + "\n}")
                path = config.name
            try:
                self.assertEqual(MODULE.broker_port_from_config(path), expected)
            finally:
                Path(path).unlink()

    def test_classifies_live_device_announcements(self):
        microwave = MODULE.classify_announcement(
            "clip/message/devices/microwave-id",
            '{"did":"microwave-id","kind":"WMVEL2137","cmd":"device_packet","data":"AA08F0EF004682BB"}',
        )
        range_device = MODULE.classify_announcement(
            "clip/message/devices/range-id",
            '{"did":"range-id","kind":"WLSGL5833F","cmd":"device_packet"}',
        )

        self.assertEqual(microwave, ("microwave", "microwave-id"))
        self.assertEqual(range_device, ("range", "range-id"))

    def test_classifies_management_inventory(self):
        inventory = {
            "microwave-id": {"model": "302", "modelName": "MVEL2033F.ASTCNA0"},
            "range-id": {"model": "WLSGL5833F", "modelName": "WLSGL5833F"},
            "other-id": {"model": "UNKNOWN"},
        }

        self.assertEqual(
            MODULE.classify_inventory(inventory),
            {"microwave": "microwave-id", "range": "range-id"},
        )

    def test_uses_hardware_model_and_regional_suffix_as_fallback(self):
        match = MODULE.classify_announcement(
            "clip/provisioning/devices/microwave-id",
            '{"did":"microwave-id","kind":"302","data":{"appInfo":{"modelName":"MVEL2033F.ASTCNA0"}}}',
        )

        self.assertEqual(match, ("microwave", "microwave-id"))

    def test_ignores_unrelated_or_invalid_messages(self):
        self.assertIsNone(MODULE.classify_announcement("lime/devices/id", "{}"))
        self.assertIsNone(MODULE.classify_announcement("clip/message/devices/id", "not-json"))
        self.assertIsNone(
            MODULE.classify_announcement(
                "clip/message/devices/id",
                '{"did":"id","kind":"UNKNOWN","cmd":"device_packet"}',
            )
        )

    def test_generated_frames_have_valid_length_and_checksum(self):
        target = datetime(2026, 7, 20, 21, 24, 45)
        frames = [
            MODULE.microwave_clock_frame(target),
            MODULE.range_clock_frame(target),
            MODULE.MICROWAVE_STATUS_QUERY,
            MODULE.RANGE_STATUS_QUERY,
            *MODULE.RANGE_BEEPER.values(),
        ]
        for frame in frames:
            packet = bytes.fromhex(frame)
            self.assertEqual(packet[0], 0xAA)
            self.assertEqual(packet[1], len(packet))
            self.assertEqual(packet[-1], 0xBB)
            self.assertEqual(packet[-2], MODULE.checksum(packet[:-2]))

        self.assertEqual(
            MODULE.range_clock_frame(target),
            "aa25f043210e0918018080808080808080ff8080800107ea07142d800000000000008059bb",
        )
        self.assertEqual(
            MODULE.range_clock_frame(datetime(2026, 7, 21, 1, 22, 28)),
            "aa25f043210e0116018080808080808080ff8080800007ea07151c8000000000000080a4bb",
        )

    def test_decodes_microwave_sound_preference(self):
        def status(value):
            body = bytearray([0x41, 0xEC]) + bytearray(46) + bytearray(46)
            body[2 + 46 + 35] = value
            return {"cmd": "device_packet", "data": MODULE.build(body)}

        self.assertIs(MODULE.decode_sound_preference(status(0x50)), False)
        self.assertIs(MODULE.decode_sound_preference(status(0x53)), True)
        self.assertIsNone(MODULE.decode_sound_preference(status(0x51)))

        snapshot = {
            "cmd": "device_packet",
            "data": "aa3441eb003000015500000000000000ff030d000000000000000000000000000000c3000000005300008080808001000000e3bb",
        }
        self.assertIs(MODULE.decode_sound_preference(snapshot), True)
        self.assertIs(MODULE.decode_microwave_busy(snapshot), False)

        active_snapshot = {
            "cmd": "device_packet",
            "data": "aa3441eb023000004401000000000a00ff030d000014000100000000000000000000c7000100005320018080808001000000b9bb",
        }
        self.assertIs(MODULE.decode_microwave_busy(active_snapshot), True)

        post_clock_idle = {
            "cmd": "device_packet",
            "data": "AA3441EB003100015500000000000000FF030D000000000000000000000000000000C3000000005300008080808001000000E2BB",
        }
        self.assertIs(MODULE.decode_microwave_busy(post_clock_idle), False)

        busy_record = bytearray(bytes.fromhex(snapshot["data"])[4:-2])
        busy_record[0] = 1
        busy = {"cmd": "device_packet", "data": MODULE.build(bytes([0x41, 0xEB]) + busy_record)}
        self.assertIs(MODULE.decode_microwave_busy(busy), True)

    def test_decodes_range_beeper_preference(self):
        packet = "aa9c40ec0100000000000200ff020000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000100ff020000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000c0bb"
        self.assertEqual(
            MODULE.decode_range_beeper_preference({"cmd": "device_packet", "data": packet}),
            "low",
        )

        snapshot = "aa5140eb0000000000000100ff020000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000063bb"
        self.assertEqual(
            MODULE.decode_range_beeper_preference({"cmd": "device_packet", "data": snapshot}),
            "low",
        )
        self.assertIs(MODULE.decode_range_busy({"cmd": "device_packet", "data": snapshot}), False)

        active = bytearray(bytes.fromhex(snapshot)[4:-2])
        active[15] = 1
        busy = {"cmd": "device_packet", "data": MODULE.build(bytes([0x40, 0xEB]) + active)}
        self.assertIs(MODULE.decode_range_busy(busy), True)

        cooktop_active = bytearray(bytes.fromhex(snapshot)[4:-2])
        cooktop_active[31] = 0x06
        busy = {
            "cmd": "device_packet",
            "data": MODULE.build(bytes([0x40, 0xEB]) + cooktop_active),
        }
        self.assertIs(MODULE.decode_range_busy(busy), True)
        self.assertIs(
            MODULE.decode_range_active_edge(
                {"cmd": "device_packet", "data": "aa0840b10101f0bb"}
            ),
            True,
        )

    def test_monitor_tracks_sound_and_reconnect_for_selected_device(self):
        monitor = MODULE.ApplianceMonitor("localhost", 1884, "microwave-id", "range-id")
        body = bytearray([0x41, 0xEC]) + bytearray(46) + bytearray(46)
        body[2 + 46 + 35] = 0x50
        monitor.process_message(
            "clip/message/devices/microwave-id",
            '{"did":"microwave-id","kind":"WMVEL2137","cmd":"device_packet","data":"'
            + MODULE.build(body)
            + '"}',
        )
        self.assertIs(monitor.sound_preference(), False)

        # A reconnect remains detectable even if a later provisioning payload
        # omits model metadata, because the selected device ID is authoritative.
        monitor.process_message(
            "clip/provisioning/devices/range-id",
            '{"did":"range-id","cmd":"preDeploy","data":{}}',
        )
        self.assertTrue(monitor.reconnect.is_set())

    def test_monitor_waits_for_a_fresh_microwave_sound_snapshot(self):
        monitor = MODULE.ApplianceMonitor("localhost", 1884, "microwave-id", "range-id")
        revision, preference = monitor.sound_snapshot()
        self.assertEqual((revision, preference), (0, None))

        monitor.process_message(
            "clip/message/devices/microwave-id",
            '{"did":"microwave-id","kind":"WMVEL2137","cmd":"device_packet","data":"'
            "aa3441eb003000015500000000000000ff030d000000000000000000000000000000c3000000005300008080808001000000e3bb"
            '"}',
        )

        self.assertEqual(monitor.wait_for_sound_report(revision, 0), (True, True, False))

    def test_daemon_discovery_can_continue_with_one_appliance(self):
        monitor = MODULE.ApplianceMonitor("localhost", 1884, "microwave-id", None)

        self.assertEqual(
            monitor.discover(True, True, 60, require_all=False),
            ("microwave-id", None),
        )

        monitor.process_message(
            "clip/message/devices/range-id",
            '{"did":"range-id","kind":"WLSGL5833F","cmd":"device_packet"}',
        )
        self.assertEqual(monitor.device_ids(), ("microwave-id", "range-id"))
        self.assertTrue(monitor.reconnect.is_set())

    def test_monitor_tracks_range_beeper_preference(self):
        monitor = MODULE.ApplianceMonitor("localhost", 1884, "microwave-id", "range-id")
        packet = "aa9c40ec0100000000000000ff020000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000200ff020000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000c1bb"
        monitor.process_message(
            "clip/message/devices/range-id",
            '{"did":"range-id","kind":"WLSGL5833F","cmd":"device_packet","data":"' + packet + '"}',
        )
        self.assertEqual(monitor.beeper_preference(), "high")

    def test_monitor_waits_for_a_fresh_range_beeper_snapshot(self):
        monitor = MODULE.ApplianceMonitor("localhost", 1884, "microwave-id", "range-id")
        revision, preference = monitor.beeper_snapshot()
        self.assertEqual((revision, preference), (0, None))
        snapshot = "aa5140eb0000000000000100ff020000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000063bb"
        monitor.process_message(
            "clip/message/devices/range-id",
            '{"did":"range-id","kind":"WLSGL5833F","cmd":"device_packet","data":"' + snapshot + '"}',
        )

        self.assertEqual(monitor.wait_for_beeper_report(revision, 0), (True, "low", False))

        monitor.process_message(
            "clip/message/devices/range-id",
            '{"did":"range-id","kind":"WLSGL5833F","cmd":"device_packet","data":"aa0840b10101f0bb"}',
        )
        self.assertEqual(monitor.busy_states(), (None, True))

    def test_busy_or_unknown_appliances_receive_no_clock_or_audio_commands(self):
        class RecordingPublisher:
            dry_run = True

            def __init__(self):
                self.frames = []

            def send(self, device_id, frame, label):
                self.frames.append(frame)

        for busy in (True, None):
            publisher = RecordingPublisher()
            MODULE.sync_target(
                publisher,
                datetime(2026, 7, 21, 1, 0),
                "microwave-id",
                "range-id",
                "both",
                busy,
                busy,
            )
            self.assertEqual(publisher.frames, [])

    def test_sync_writes_clocks_without_audio_changes(self):
        class RecordingPublisher:
            dry_run = True

            def __init__(self):
                self.frames = []

            def send(self, device_id, frame, label):
                self.frames.append((device_id, frame, label))

        target = datetime(2026, 7, 20, 21, 24, 45)
        publisher = RecordingPublisher()
        MODULE.sync_target(publisher, target, "microwave-id", "range-id", "both")
        self.assertEqual(
            [frame for _, frame, _ in publisher.frames],
            [MODULE.microwave_clock_frame(target), MODULE.range_clock_frame(target)],
        )

        unavailable = RecordingPublisher()
        MODULE.sync_target(unavailable, target, None, "range-id", "both")
        self.assertEqual(
            [frame for _, frame, _ in unavailable.frames],
            [MODULE.range_clock_frame(target)],
        )

    def test_clock_waits_for_ack(self):
        class RecordingPublisher:
            dry_run = False

            def __init__(self):
                self.frames = []

            def send(self, device_id, frame, label):
                self.frames.append(frame)

        class ConfirmingMonitor:
            def __init__(self, ack_result=True):
                self.ack_result = ack_result
                self.ack_waits = []

            def ack_snapshot(self, appliance):
                return 0

            def wait_for_ack(self, appliance, revision, timeout):
                self.ack_waits.append(appliance)
                return self.ack_result

        target = datetime(2026, 7, 21, 1, 22, 28)
        publisher = RecordingPublisher()
        monitor = ConfirmingMonitor()
        MODULE.sync_target(
            publisher,
            target,
            "microwave-id",
            None,
            "microwave",
            monitor=monitor,
        )
        self.assertEqual(
            publisher.frames,
            [MODULE.microwave_clock_frame(target)],
        )
        self.assertEqual(monitor.ack_waits, ["microwave"])

        publisher = RecordingPublisher()
        monitor = ConfirmingMonitor(False)
        with self.assertRaises(RuntimeError):
            MODULE.sync_target(
                publisher,
                target,
                "microwave-id",
                None,
                "microwave",
                monitor=monitor,
            )
        self.assertEqual(publisher.frames, [MODULE.microwave_clock_frame(target)])

    def test_next_minute_boundary(self):
        self.assertEqual(MODULE.next_minute_boundary(100.25), 120)
        self.assertEqual(MODULE.next_queryable_boundary(3, 100.25), 120)
        self.assertEqual(MODULE.next_queryable_boundary(3, 118), 180)


if __name__ == "__main__":
    unittest.main()
