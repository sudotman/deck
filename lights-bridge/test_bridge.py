"""Hardware-free tests for the lights bridge: python -m unittest test_bridge.py"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import bridge


DEVICES = {
    "strips": [{"name": "strip", "address": "AA:BB:CC:DD:EE:FF"}],
    "wiz": {"bulbs": [{"mac": "a8bb50000001", "name": "bedroom", "ip": "192.0.2.10"}, {"mac": "a8bb50000002", "name": "corridor", "ip": "192.0.2.11"}]},
}


CLASSIC = {"name": "strip", "address": "AA:BB:CC:DD:EE:FF"}
MELK = {"name": "neon", "address": "AA:BB:CC:DD:EE:01", "protocol": "melk"}


def frames(device, step, state=None):
    return [p.hex() for p in bridge.Strip(device, {}).packets(step, state if state is not None else {})]


class PacketTests(unittest.TestCase):
    def test_classic_strip_frames_and_state(self):
        state = {}
        self.assertEqual(frames(CLASSIC, {"color": [255, 90, 0], "brightness": 40}, state), ["7e0004f00001ff00ef", "7e000503ff5a0000ef", "7e040128ff000000ef"])
        self.assertEqual(state["color"], [255, 90, 0])
        self.assertEqual(frames(CLASSIC, {"on": False}, state), ["7e0004000000ff00ef"])
        self.assertEqual(frames(CLASSIC, {"effect": "rainbow"})[1], "7e00038a03000000ef")  # generic name, classic code
        with self.assertRaises(ValueError):
            frames(CLASSIC, {"pattern": 37})

    def test_melk_patterns_follow_the_vendor_table(self):
        self.assertEqual(len(bridge.MELK_EFFECTS), 213)
        names = {name: (label, code) for name, label, code, _ in bridge.MELK_EFFECTS}
        self.assertEqual(len(names), 213)  # repeated vendor names are numbered, not dropped
        self.assertEqual(names["red-tail"], ("Red Tail", 25))
        self.assertEqual(names["7-color-jump"], ("7-Color Jump", 193))
        self.assertEqual(names["green-dot-in-red-running-2"], ("Green-Dot in Red Running 2", 169))
        self.assertEqual(names["7-color-energy"], ("7-Color Energy", 212))
        # the vendor builder's mode frame: 7E 05 03 <id> 06 FF FF 00 EF
        self.assertEqual(frames(MELK, {"effect": "red-tail"})[1], "7e05031906ffff00ef")
        self.assertEqual(frames(MELK, {"pattern": 193}), frames(MELK, {"effect": "7-color-jump"}))
        self.assertEqual(frames(MELK, {"effect": "rainbow"})[1], "7e05030106ffff00ef")  # scenes' rainbow is Magic Forward
        self.assertEqual(frames(MELK, {"effect": "auto"})[1], "7e05030006ffff00ef")
        self.assertEqual(frames(MELK, {"effect": "magic-forward", "speed": 50})[2], "7e040232ffffff00ef")
        for bad in ({"pattern": 213}, {"effect": "mode-3"}, {"effect": "jump7"}):
            with self.assertRaises(ValueError):
                frames(MELK, bad)

    def test_melk_music_brightness_and_timer(self):
        state = {"effect": "red-tail"}
        self.assertEqual(frames(MELK, {"music": 3, "sensitivity": 60}, state), ["7e0404f00001ff00ef", "7e040701ffffff00ef", "7e07038204ffff00ef", "7e04063cffffff00ef"])
        self.assertEqual((state["music"], state["sensitivity"]), (3, 60))
        # switching visualiser keeps the microphone on
        self.assertEqual(frames(MELK, {"music": 5}, state)[1:], ["7e040701ffffff00ef", "7e07038404ffff00ef"])
        # stopping music switches the microphone off and puts the last pattern back
        self.assertEqual(frames(MELK, {"music": 0}, state)[1:], ["7e040700ffffff00ef", "7e05031906ffff00ef"])
        self.assertEqual((state["music"], state["effect"]), (None, "red-tail"))
        # a new colour during music mode also switches the microphone off first
        state = {"music": 2, "color": [1, 2, 3]}
        self.assertEqual(frames(MELK, {"color": [255, 0, 0]}, state)[1:], ["7e040700ffffff00ef", "7e000503ff000000ef"])
        self.assertEqual(frames(MELK, {"music": 0}, {"color": [255, 0, 0]})[1:], ["7e040700ffffff00ef", "7e000503ff000000ef"])
        self.assertEqual(frames(MELK, {"brightness": 100})[1], "7e04016401ffff00ef")
        state = {}
        self.assertEqual(frames(MELK, {"timer": 60}, state)[1], "7e0776100effff00ef")
        self.assertIsNotNone(state["offAt"])
        frames(MELK, {"timer": 0}, state)
        self.assertIsNone(state["offAt"])
        for bad in ({"music": 9}, {"timer": 2000}, {"effect": "disco"}):
            with self.assertRaises(ValueError):
                frames(MELK, bad)

    def test_names_from_an_older_bridge_are_forgotten(self):
        strip = bridge.Strip(MELK, {"strips": {"neon": {"effect": "mode-3", "color": [1, 2, 3]}}})
        self.assertIsNone(strip.state["effect"])
        self.assertEqual(strip.state["color"], [1, 2, 3])
        described = strip.describe()
        self.assertEqual(described["musicModes"][0], "Energetic")
        self.assertEqual(described["effects"][25], {"name": "red-tail", "label": "Red Tail", "group": "Tail"})

    def test_strip_maps_white_temperature_to_rgb(self):
        state = {}
        frames(CLASSIC, {"temp": 2700}, state)
        r, g, b = state["color"]
        self.assertEqual(r, 255)
        self.assertTrue(g < r and b < g)

    def test_wiz_messages(self):
        self.assertEqual(bridge.wiz_message({"on": False}), {"method": "setState", "params": {"state": False}})
        self.assertEqual(bridge.wiz_message({"on": True}), {"method": "setState", "params": {"state": True}})
        self.assertEqual(bridge.wiz_message({"color": [1, 2, 3], "brightness": 5}), {"method": "setPilot", "params": {"state": True, "r": 1, "g": 2, "b": 3, "dimming": 10}})
        self.assertEqual(bridge.wiz_message({"scene": 11})["params"]["sceneId"], 11)
        with self.assertRaises(ValueError):
            bridge.wiz_message({"scene": 999})
        self.assertIsNone(bridge.wiz_message({"music": 2}))  # strip-only steps leave bulbs alone


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(bridge, "STATE_FILE", Path(self.tmp.name) / "state.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        self.bridge = bridge.Bridge(DEVICES)
        self.calls = []

        async def strip_apply(steps):
            self.calls.append(("strip", steps))

        async def bulb_apply(mac, steps):
            name = self.bridge.bulbs.devices[mac]["name"]
            if name == "corridor":
                raise RuntimeError("No reply")
            self.calls.append((name, steps))

        self.bridge.strips["strip"].apply = strip_apply
        self.bridge.bulbs.apply = bulb_apply

    def test_groups_resolve_and_each_device_reports_its_own_result(self):
        result = asyncio.run(self.bridge.set([{"targets": ["bulbs"], "temp": 2200}, {"targets": ["all"], "brightness": 10}]))
        self.assertEqual(result["results"]["strip"], {"ok": True})
        self.assertEqual(result["results"]["bedroom"], {"ok": True})
        self.assertFalse(result["results"]["corridor"]["ok"])
        self.assertIn(("bedroom", [{"temp": 2200}, {"brightness": 10}]), self.calls)
        self.assertTrue((Path(self.tmp.name) / "state.json").exists())

    def test_invalid_steps_change_nothing(self):
        with self.assertRaises(ValueError):
            asyncio.run(self.bridge.set([{"targets": ["strips"], "color": [0, 0, 255]}, {"targets": ["strip"], "effect": "disco"}]))
        with self.assertRaises(ValueError):
            asyncio.run(self.bridge.set([{"targets": ["kitchen"], "on": True}]))
        self.assertEqual(self.calls, [])

    def test_http_guards(self):
        route = self.bridge.route
        self.assertEqual(asyncio.run(route("GET", "/health", {"host": "evil.example"}, b""))[0], 403)
        self.assertEqual(asyncio.run(route("POST", "/set", {"host": "127.0.0.1:8183", "content-type": "text/plain"}, b"{}"))[0], 415)
        status, body = asyncio.run(route("POST", "/set", {"host": "127.0.0.1:8183", "content-type": "application/json"}, json.dumps({"steps": [{"targets": ["strip"], "on": False}]}).encode()))
        self.assertEqual((status, body["results"]["strip"]), (200, {"ok": True}))

    def test_device_names_must_not_shadow_groups(self):
        path = Path(self.tmp.name) / "devices.json"
        path.write_text(json.dumps({"strips": [{"name": "bulbs", "address": "AA:BB:CC:DD:EE:FF"}]}))
        with self.assertRaises(SystemExit):
            bridge.load_devices(path)

    def test_old_single_strip_state_is_migrated(self):
        (Path(self.tmp.name) / "state.json").write_text(json.dumps({"neon": {"on": True, "color": [1, 2, 3]}}))
        state = bridge.load_state()
        self.assertEqual(state["strips"]["neon"]["color"], [1, 2, 3])


if __name__ == "__main__":
    unittest.main()
