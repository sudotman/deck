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

    def test_a_bulb_can_stay_out_of_room_scenes(self):
        devices = json.loads(json.dumps(DEVICES))
        devices["wiz"]["bulbs"].append({"mac": "a8bb50000003", "name": "kitchen", "ip": "192.0.2.12", "scenes": False})
        b = bridge.Bridge(devices)
        self.assertEqual(b.resolve(["bulbs"]), ["bedroom", "corridor"])
        self.assertIn("kitchen", b.resolve(["all"]))
        self.assertEqual(b.resolve(["kitchen"]), ["kitchen"])

    def test_a_dozing_bulb_is_sent_the_message_every_second(self):
        devices = json.loads(json.dumps(DEVICES))
        devices["wiz"]["bulbs"][1]["timeout"] = 10
        b = bridge.Bridge(devices)
        for quick, expected in ((True, {"192.0.2.10": (2, 1.0), "192.0.2.11": (5, 1.0)}), (False, {"192.0.2.10": (3, 1.5), "192.0.2.11": (10, 1.0)})):
            plans = {}
            with mock.patch.object(bridge, "wiz_call", side_effect=lambda ip, msg, tries, timeout: plans.setdefault(ip, (tries, timeout)) and {"result": {}}):
                asyncio.run(b.bulbs.call(list(b.bulbs.devices), {"method": "getPilot", "params": {}}, quick=quick))
            self.assertEqual(plans, expected)

    def test_tv_wakes_and_sleeps_over_adb(self):
        calls = []

        async def run(adb, *args):
            calls.append(" ".join(args))
            return "already connected" if args[0] == "connect" else "  mWakefulness=Asleep\n" if "dumpsys" in args else ""

        tv = bridge.Tv({"address": "192.0.2.42:5555", "adb": "adb"}, run=run)
        self.assertEqual(asyncio.run(tv.status()), {"configured": True, "awake": False})
        self.assertEqual(asyncio.run(tv.set("wake")), {"configured": True, "awake": True})
        self.assertEqual(calls[-1], "-s 192.0.2.42:5555 shell input keyevent KEYCODE_WAKEUP")
        with self.assertRaises(ValueError):
            asyncio.run(tv.set("reboot"))

    def test_tv_needs_a_valid_address_and_says_when_unreachable(self):
        async def unreachable(adb, *args):
            return "failed to connect to 192.0.2.42:5555"
        tv = bridge.Tv({"address": "192.0.2.42:5555"}, run=unreachable)
        self.assertEqual(asyncio.run(tv.status()), {"configured": True, "awake": None})
        with self.assertRaises(RuntimeError):
            asyncio.run(tv.set("wake"))
        self.assertEqual(asyncio.run(bridge.Tv({"address": "1.2.3.4; reboot"}).status()), {"configured": False, "awake": None})
        self.assertEqual(bridge.find_adb(env={"LOCALAPPDATA": "C:/L"}, exists=lambda p: False), "adb")

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


class FakeTransport:
    def __init__(self):
        self.sent = []

    def sendto(self, data, address):
        self.sent.append((json.loads(data), address))

    def is_closing(self):
        return False


class WizTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, value in (("STATE_FILE", Path(self.tmp.name) / "state.json"), ("source_ip", lambda target: "192.0.2.5")):
            patcher = mock.patch.object(bridge, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.path = Path(self.tmp.name) / "devices.json"
        self.config = json.loads(json.dumps(DEVICES))
        self.path.write_text(json.dumps(self.config))
        self.bridge = bridge.Bridge(self.config, self.path)
        self.bulbs = self.bridge.bulbs
        self.bulbs.transport = FakeTransport()

    def test_capabilities_come_from_the_module_name_and_white_range(self):
        rgb = bridge.wiz_capabilities({"moduleName": "ESP01_SHRGB1C_31", "fwVersion": "1.28.0"}, {"cctRange": [2200, 2700, 6500, 6500]})
        self.assertEqual((rgb["kind"], rgb["color"], rgb["temp"], rgb["scenes"], rgb["firmware"]), ("color", True, [2200, 6500], True, "1.28.0"))
        tw = bridge.wiz_capabilities({"moduleName": "ESP03_SHTW1C_01"}, None, {"whiteRange": [2700, 6500]})
        self.assertEqual((tw["kind"], tw["color"], tw["temp"]), ("tunable", False, [2700, 6500]))
        self.assertEqual(bridge.wiz_capabilities({"moduleName": "ESP06_SHTW1C_01"})["temp"], [2700, 6500])  # no range given
        dw = bridge.wiz_capabilities({"moduleName": "ESP01_SHDW1C_31"})
        self.assertEqual((dw["kind"], dw["temp"], dw["scenes"], dw["dimmable"]), ("dimmable", None, True, True))
        plug = bridge.wiz_capabilities({"moduleName": "ESP10_SOCKET_06"})
        self.assertEqual((plug["kind"], plug["dimmable"], plug["scenes"]), ("socket", False, False))
        self.assertIsNone(bridge.wiz_capabilities({}))

    def test_steps_fit_what_each_bulb_can_do(self):
        tw = bridge.wiz_capabilities({"moduleName": "ESP03_SHTW1C_01"})
        self.assertEqual(bridge.fit_step({"color": [90, 0, 255], "brightness": 35}, tw), {"brightness": 35})
        self.assertEqual(bridge.fit_step({"temp": 2200}, tw), {"temp": 2700})
        dw = bridge.wiz_capabilities({"moduleName": "ESP01_SHDW1C_31"})
        self.assertIsNone(bridge.wiz_message(bridge.fit_step({"temp": 5000}, dw)))
        self.assertEqual(bridge.fit_step({"temp": 9000}, None), {"temp": 9000})  # unknown bulbs get the step as sent

    def test_the_bridge_registers_for_pushes_and_takes_state_from_them(self):
        self.bulbs.register("a8bb50000001")
        message, address = self.bulbs.transport.sent[-1]
        self.assertEqual(address, ("192.0.2.10", bridge.WIZ_PORT))
        self.assertEqual(message["method"], "registration")
        self.assertEqual(message["params"], {"phoneIp": "192.0.2.5", "register": True, "phoneMac": self.bulbs.push_mac, "id": "1"})
        self.assertRegex(self.bulbs.push_mac, r"^[0-9a-f]{12}$")
        self.assertEqual(self.bridge.state["pushMac"], self.bulbs.push_mac, "kept, so bulbs see the same controller after a restart")

        self.bulbs.on_push({"method": "syncPilot", "params": {"mac": "a8bb50000001", "src": "udp", "state": True, "temp": 2700, "dimming": 40, "rssi": -60}}, "192.0.2.20")
        self.assertEqual(self.bulbs.ips["a8bb50000001"], "192.0.2.20", "a push from a new address moves the bulb")
        self.bulbs.on_push({"method": "registration", "result": {"mac": "a8bb50000002", "success": True}}, "192.0.2.11")
        self.bulbs.pilots["a8bb50000002"] = {"state": False}
        self.bulbs.caps.update({"a8bb50000001": {"kind": "color"}, "a8bb50000002": {"kind": "color"}})  # already known
        with mock.patch.object(bridge, "wiz_call", side_effect=AssertionError("fresh bulbs are not asked")):
            devices = {d["name"]: d for d in asyncio.run(self.bulbs.describe())}
        self.assertEqual((devices["bedroom"]["on"], devices["bedroom"]["temp"], devices["bedroom"]["brightness"]), (True, 2700, 40))
        self.assertEqual(devices["corridor"]["on"], False)

    def test_bulbs_announce_themselves_when_they_start(self):
        self.bulbs.caps["a8bb50000001"] = {"kind": "color"}
        self.bulbs.on_push({"method": "firstBeat", "params": {"mac": "a8bb50000001", "fwVersion": "1.30.0"}}, "192.0.2.30")
        self.assertEqual(self.bulbs.ips["a8bb50000001"], "192.0.2.30")
        self.assertNotIn("a8bb50000001", self.bulbs.caps, "its capabilities are read again after a restart")
        self.assertEqual(self.bulbs.transport.sent[-1][1], ("192.0.2.30", bridge.WIZ_PORT), "and it is registered straight away")
        self.bulbs.on_push({"method": "firstBeat", "params": {"mac": "a8bb500000ff"}}, "192.0.2.31")
        self.assertEqual(self.bulbs.strangers["a8bb500000ff"]["ip"], "192.0.2.31")
        for junk in ({"method": "syncPilot", "params": {"mac": "nope"}}, {"method": "syncPilot"}, ["x"], {"method": "firstBeat", "params": "x"}):
            self.bulbs.on_push(junk, "192.0.2.32")
        self.assertEqual(len(self.bulbs.strangers), 1)

    def test_a_lost_reply_is_confirmed_by_the_bulbs_push(self):
        def lost(ip, message, tries, timeout):
            self.bulbs.on_push({"method": "syncPilot", "params": {"mac": "a8bb50000001", "state": True, "temp": 2200, "dimming": 10}}, ip)
            return None
        with mock.patch.object(bridge, "wiz_call", side_effect=lost):
            results = asyncio.run(self.bulbs.call(["a8bb50000001"], {"method": "setPilot", "params": {"state": True, "temp": 2200, "dimming": 10}}))
        self.assertEqual(results["a8bb50000001"]["result"], {"success": True})
        self.assertNotIn("a8bb50000001", self.bulbs.errors)

    def test_a_bulb_that_moved_is_retried_at_its_new_address(self):
        tried = []

        def call(ip, message, tries, timeout):
            tried.append(ip)
            if ip == "192.0.2.10":
                self.bulbs.on_push({"method": "syncPilot", "params": {"mac": "a8bb50000001", "state": False}}, "192.0.2.40")
                return None
            return {"result": {"success": True}}
        with mock.patch.object(bridge, "wiz_call", side_effect=call), mock.patch.object(bridge, "wiz_sweep", side_effect=AssertionError("no sweep needed")):
            results = asyncio.run(self.bulbs.call(["a8bb50000001"], {"method": "setPilot", "params": {"state": True, "dimming": 50}}))
        self.assertEqual(tried, ["192.0.2.10", "192.0.2.40"])
        self.assertTrue(results["a8bb50000001"]["result"]["success"])
        self.assertEqual(self.bulbs.pilots["a8bb50000001"], {"state": True, "dimming": 50})

    def test_pilots_merge_and_restore(self):
        pilot = bridge.merge_pilot({"state": True, "r": 1, "g": 2, "b": 3, "dimming": 50}, {"state": True, "temp": 3000})
        self.assertEqual(pilot, {"state": True, "dimming": 50, "temp": 3000})
        self.assertEqual(bridge.merge_pilot(pilot, {"state": True, "sceneId": 4})["sceneId"], 4)
        self.assertNotIn("temp", bridge.merge_pilot(pilot, {"state": True, "sceneId": 4}))
        self.assertEqual(bridge.restore_message({"state": False, "temp": 3000}), {"method": "setState", "params": {"state": False}})
        self.assertEqual(bridge.restore_message({"state": True, "sceneId": 4, "speed": 100, "dimming": 80})["params"], {"state": True, "dimming": 80, "sceneId": 4, "speed": 100})
        self.assertEqual(bridge.restore_message({"state": True, "r": 9, "g": 8, "b": 7, "c": 0, "w": 0, "dimming": 30})["params"], {"state": True, "dimming": 30, "r": 9, "g": 8, "b": 7, "c": 0, "w": 0})

    def test_identify_blinks_then_puts_the_bulb_back(self):
        sent = []

        def call(ip, message, tries, timeout):
            sent.append(message)
            return {"result": {"mac": "a8bb50000001", "state": True, "temp": 2700, "dimming": 40}} if message["method"] == "getPilot" else {"result": {"success": True}}
        with mock.patch.object(bridge, "wiz_call", side_effect=call), mock.patch.object(bridge.asyncio, "sleep", new=mock.AsyncMock()):
            asyncio.run(self.bridge.route("POST", "/identify", {"host": "127.0.0.1", "content-type": "application/json"}, b'{"name": "bedroom"}'))
        self.assertEqual([m["method"] for m in sent], ["getPilot"] + ["setPilot", "setState"] * 3 + ["setPilot"])
        self.assertEqual(sent[-1]["params"], {"state": True, "dimming": 40, "temp": 2700})
        status, _ = asyncio.run(self.bridge.route("POST", "/identify", {"host": "127.0.0.1", "content-type": "application/json"}, b'{"name": "attic"}'))
        self.assertEqual(status, 404)

    def test_discovery_lists_only_new_bulbs_with_what_they_can_do(self):
        def sweep(subnet, wait, pilots):
            pilots["a8bb500000aa"] = {"state": True, "rssi": -55}
            return {"a8bb50000001": "192.0.2.10", "a8bb500000aa": "192.0.2.50"}

        async def probe(ip):
            return bridge.wiz_capabilities({"moduleName": "ESP01_SHRGB1C_31"})
        self.bulbs.subnet = "192.0.2"
        self.bulbs.strangers["a8bb500000bb"] = {"ip": "192.0.2.51", "at": bridge.time.monotonic()}
        with mock.patch.object(bridge, "wiz_sweep", side_effect=sweep), mock.patch.object(self.bulbs, "probe", side_effect=probe):
            found = asyncio.run(self.bulbs.discover())
        self.assertEqual(found["subnet"], "192.0.2")
        self.assertEqual([(b["mac"], b["ip"], b["on"]) for b in found["bulbs"]], [("a8bb500000aa", "192.0.2.50", True), ("a8bb500000bb", "192.0.2.51", None)])
        self.assertEqual(found["bulbs"][0]["capabilities"]["kind"], "color")

    def test_bulbs_are_added_changed_and_removed_in_devices_json(self):
        self.bulbs.found["a8bb500000aa"] = "192.0.2.50"
        edit = lambda body: asyncio.run(self.bridge.route("POST", "/bulbs", {"host": "127.0.0.1", "content-type": "application/json"}, json.dumps(body).encode()))
        self.assertEqual(edit({"action": "add", "mac": "A8:BB:50:00:00:AA", "name": "kitchen", "label": "Kitchen  light", "scenes": False})[0], 200)
        saved = json.loads(self.path.read_text())["wiz"]["bulbs"]
        self.assertEqual(saved[-1], {"mac": "a8bb500000aa", "name": "kitchen", "label": "Kitchen light", "ip": "192.0.2.50", "scenes": False})
        self.assertEqual(self.bridge.resolve(["bulbs"]), ["bedroom", "corridor"], "a bulb added outside scenes stays out of them")
        self.assertEqual(self.bulbs.transport.sent[-1][1], ("192.0.2.50", bridge.WIZ_PORT), "and is registered for pushes")
        for bad in ({"action": "add", "mac": "a8bb500000aa", "name": "kitchen-2"}, {"action": "add", "mac": "a8bb500000ab", "name": "bedroom"},
                    {"action": "add", "mac": "a8bb500000ab", "name": "Kitchen!"}, {"action": "add", "mac": "zz", "name": "x"},
                    {"action": "update", "name": "kitchen", "timeout": 99}, {"action": "explode"}):
            self.assertEqual(edit(bad)[0], 400, bad)
        self.assertEqual(edit({"action": "update", "name": "attic", "label": "x"})[0], 404)
        self.assertEqual(edit({"action": "update", "name": "kitchen", "label": "Kitchen", "scenes": True, "timeout": 10})[0], 200)
        self.assertEqual(json.loads(self.path.read_text())["wiz"]["bulbs"][-1], {"mac": "a8bb500000aa", "name": "kitchen", "label": "Kitchen", "ip": "192.0.2.50", "timeout": 10})
        self.assertEqual(edit({"action": "remove", "name": "kitchen"})[0], 200)
        self.assertEqual([b["name"] for b in json.loads(self.path.read_text())["wiz"]["bulbs"]], ["bedroom", "corridor"])
        self.assertIsNone(self.bulbs.by_name("kitchen"))


if __name__ == "__main__":
    unittest.main()
