"""Deck lights bridge: one local HTTP API for Bluetooth LED strips (ELK-BLEDOM family)
and WiZ bulbs (Wi-Fi UDP). Deck proxies to it; it listens on 127.0.0.1 only.

Devices are listed in devices.json next to this file (see devices.example.json).
Run it as a user that can use Bluetooth; on Windows that means a user session or an
S4U scheduled task, not the Local Service account.

  GET  /health   bridge version
  GET  /state    last-known strip state and live WiZ bulb state
  POST /set      {"steps": [{"targets": ["strips", "bedroom"], "on": true, "color": [r, g, b],
                   "brightness": 1-100, "temp": 2200-6500, "scene": WiZ scene id,
                   "effect": strip effect name, "pattern": MELK pattern number 0-255, "speed": 0-100,
                   "music": 0-8 (strip microphone mode, 0 = off), "sensitivity": 0-100,
                   "timer": minutes until the strip switches itself off (0 = cancel)}, ...]}

Targets are device names, or the groups "strips", "bulbs" and "all".
"""
import asyncio
import json
import logging
import logging.handlers
import math
import os
import socket
import time
from pathlib import Path

VERSION = "1.2.0"
HERE = Path(__file__).resolve().parent
DEVICES_FILE = Path(os.environ.get("DECK_LIGHTS_DEVICES", HERE / "devices.json"))
STATE_FILE = HERE / "state.json"

STRIP_WRITE = "0000fff3-0000-1000-8000-00805f9b34fb"
STRIP_IDLE_SECONDS = 90  # release the strip so its phone app can connect
WIZ_PORT = 38899

# Built-in effects: (name, label, code). Classic controllers drive plain RGB strips;
# MELK ("symphony") controllers drive addressable strips with their own pattern set.
CLASSIC_EFFECTS = [
    ("jump3", "3-colour jump", 0x87), ("jump7", "7-colour jump", 0x88), ("fade3", "3-colour fade", 0x89),
    ("rainbow-fade", "Rainbow fade", 0x8A), ("red-breathe", "Red breathe", 0x8B), ("green-breathe", "Green breathe", 0x8C),
    ("blue-breathe", "Blue breathe", 0x8D), ("yellow-breathe", "Yellow breathe", 0x8E), ("cyan-breathe", "Cyan breathe", 0x8F),
    ("purple-breathe", "Purple breathe", 0x90), ("white-breathe", "White breathe", 0x91), ("red-green", "Red–green fade", 0x92),
    ("red-blue", "Red–blue fade", 0x93), ("green-blue", "Green–blue fade", 0x94), ("strobe7", "7-colour strobe", 0x95),
    ("red-strobe", "Red strobe", 0x96), ("green-strobe", "Green strobe", 0x97), ("blue-strobe", "Blue strobe", 0x98),
    ("yellow-strobe", "Yellow strobe", 0x99), ("cyan-strobe", "Cyan strobe", 0x9A), ("purple-strobe", "Purple strobe", 0x9B),
    ("white-strobe", "White strobe", 0x9C),
]
MELK_EFFECTS = [
    ("auto", "Auto cycle", 0), *[(f"mode-{n}", f"Mode {n}", n) for n in range(1, 9)],
    ("rainbow", "Rainbow cycle", 16), ("wave", "Colour wave", 32), ("breathe", "Breathing", 48), ("strobe", "Strobe", 64),
    ("jump", "RGB jump", 128), ("fade", "RGB fade", 144), ("blue-scroll", "Blue scroll", 207),
]
# Generic names scenes can use on any strip.
CLASSIC_ALIASES = {"auto": "jump7", "rainbow": "rainbow-fade", "wave": "fade3", "breathe": "white-breathe", "strobe": "strobe7", "jump": "jump7", "fade": "fade3"}
MUSIC_MODES = 8  # the controller's own microphone drives these
WIZ_SCENES = {
    1: "Ocean", 2: "Romance", 3: "Sunset", 4: "Party", 5: "Fireplace", 6: "Cozy",
    7: "Forest", 8: "Pastel colors", 9: "Wake up", 10: "Bedtime", 11: "Warm white",
    12: "Daylight", 13: "Cool white", 14: "Night light", 15: "Focus", 16: "Relax",
    17: "True colors", 18: "TV time", 19: "Plant growth", 20: "Spring", 21: "Summer",
    22: "Fall", 23: "Deep dive", 24: "Jungle", 25: "Mojito", 26: "Club",
    27: "Christmas", 28: "Halloween", 29: "Candlelight", 30: "Golden white",
    31: "Pulse", 32: "Steampunk",
}

log = logging.getLogger("lights")


def load_devices(path=DEVICES_FILE):
    try:
        config = json.loads(Path(path).read_text())
    except OSError:
        raise SystemExit(f"No device list at {path}. Copy devices.example.json to devices.json and edit it.")
    names = [s["name"] for s in config.get("strips", [])] + [b["name"] for b in config.get("wiz", {}).get("bulbs", [])]
    if len(names) != len(set(names)) or {"strips", "bulbs", "all"} & set(names):
        raise SystemExit("Device names must be unique and not 'strips', 'bulbs' or 'all'.")
    return config


def load_state():
    try:
        state = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}
    if "neon" in state and "strips" not in state:  # 1.0 kept a single strip under "neon"
        state["strips"] = {"neon": state.pop("neon")}
    return state


def save_state(state):
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE_FILE)


def kelvin_to_rgb(kelvin):
    """Approximate a white temperature as RGB for a strip (Tanner Helland's fit)."""
    t = kelvin / 100
    r = 255 if t <= 66 else 329.698727446 * (t - 60) ** -0.1332047592
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * (t - 60) ** -0.0755148492
    b = 255 if t >= 66 else 0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    return [max(0, min(255, round(v))) for v in (r, g, b)]


# ---------- Bluetooth strips (ELK-BLEDOM protocol) ----------

def _packet(*b):
    return bytes(b)


class Strip:
    def __init__(self, device, state):
        self.name, self.label, self.address = device["name"], device.get("label", device["name"]), device["address"]
        self.melk = device.get("protocol", "elk-bledom") == "melk"
        self.effects = MELK_EFFECTS if self.melk else CLASSIC_EFFECTS
        self.state = state.setdefault("strips", {}).setdefault(self.name, {})
        for key in ("on", "color", "brightness", "effect", "speed", "music", "sensitivity", "offAt", "updatedAt"):
            self.state.setdefault(key, None)
        self.client = None
        self.lock = asyncio.Lock()
        self.last_used = 0.0
        self.last_error = None
        self.idle_task = None

    def effect_code(self, name):
        if isinstance(name, int):
            if self.melk and 0 <= name <= 255:
                return name, f"pattern-{name}"
            raise ValueError("Pattern numbers only apply to addressable (MELK) strips")
        name = name if self.melk else CLASSIC_ALIASES.get(name, name)
        for key, _, code in self.effects:
            if key == name:
                return code, key
        raise ValueError(f"Unknown effect for {self.label}: {name}")

    def packets(self, step, s):
        """Translate one step into frames, recording the resulting state in s.
        Frames: Home Assistant's elkbledom models (MELK-OA10) and the LotusLamp X app."""
        f = lambda *b: bytes([0x7E, *b, 0xEF])
        if step.get("on") is False:
            s["on"] = False
            return [f(0x04 if self.melk else 0x00, 0x04, 0x00, 0x00, 0x00, 0xFF, 0x00)]
        out = [f(0x04 if self.melk else 0x00, 0x04, 0xF0, 0x00, 0x01, 0xFF, 0x00)]
        s["on"] = True
        if "music" in step and step["music"] == 0:
            out.append(f(0x04, 0x07, 0x00, 0xFF, 0xFF, 0xFF, 0x00))
            s["music"] = None
        color = step.get("color") or (kelvin_to_rgb(step["temp"]) if "temp" in step else None)
        if color:
            if s.get("music"):
                out.append(f(0x04, 0x07, 0x00, 0xFF, 0xFF, 0xFF, 0x00))
            r, g, b = color
            out.append(f(0x00, 0x05, 0x03, r, g, b, 0x00))
            s.update(color=list(color), effect=None, music=None)
        if "effect" in step or "pattern" in step:
            code, key = self.effect_code(step["pattern"] if "pattern" in step else step["effect"])
            if s.get("music"):
                out.append(f(0x04, 0x07, 0x00, 0xFF, 0xFF, 0xFF, 0x00))
            out.append(f(0x05, 0x03, code, 0x06, 0xFF, 0xFF, 0x00) if self.melk else f(0x00, 0x03, code, 0x03, 0x00, 0x00, 0x00))
            s.update(effect=key, music=None)
        if "speed" in step:  # 0-100 in Deck; MELK controllers take 0-255
            v = step["speed"]
            out.append(f(0x04, 0x02, (v * 255 + 50) // 100, 0xFF, 0xFF, 0xFF, 0x00) if self.melk else f(0x00, 0x02, v, 0x00, 0x00, 0x00, 0x00))
            s["speed"] = v
        if step.get("music"):
            if not 1 <= step["music"] <= MUSIC_MODES:
                raise ValueError(f"Music modes run from 1 to {MUSIC_MODES}")
            out += [f(0x04, 0x07, 0x01, 0xFF, 0xFF, 0xFF, 0x00), f(0x05, 0x03, 0x7F + step["music"], 0x04, 0xFF, 0xFF, 0x00)]
            s.update(music=step["music"], effect=None)
        if "sensitivity" in step:
            out.append(f(0x04, 0x06, step["sensitivity"], 0xFF, 0xFF, 0xFF, 0x00))
            s["sensitivity"] = step["sensitivity"]
        if "brightness" in step:
            b = step["brightness"]
            out.append(f(0x04, 0x01, b, 0x01, 0xFF, 0xFF, 0x00) if self.melk else f(0x04, 0x01, b, 0xFF, 0x00, 0x00, 0x00))
            s["brightness"] = b
        if "timer" in step:  # minutes; the controller counts seconds (16-bit) and switches itself off
            seconds = step["timer"] * 60
            if not 0 <= seconds <= 0xFFFF:
                raise ValueError("Sleep timers run up to 18 hours")
            out.append(f(0x07, 0x76, seconds & 0xFF, seconds >> 8, 0xFF, 0xFF, 0x00))
            s["offAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(time.time() + seconds)) if seconds else None
        return out

    async def _connect(self):
        from bleak import BleakClient, BleakScanner

        if self.client is not None and self.client.is_connected:
            return self.client
        device = await BleakScanner.find_device_by_address(self.address, timeout=12)
        if device is None:
            raise RuntimeError(f"{self.label} did not answer over Bluetooth. If its phone app is connected, close the app.")
        client = BleakClient(device, timeout=20)
        await client.connect()
        if self.melk:  # MELK controllers ignore commands until they get this wake-up pair
            for wake in (b"\x7e\x07\x83", b"\x7e\x04\x04"):
                await client.write_gatt_char(STRIP_WRITE, wake, response=False)
                await asyncio.sleep(0.2)
        self.client = client
        log.info("%s connected", self.name)
        return client

    async def _disconnect(self):
        client, self.client = self.client, None
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass

    async def _release_when_idle(self):
        while True:
            await asyncio.sleep(10)
            if time.monotonic() - self.last_used < STRIP_IDLE_SECONDS:
                continue
            async with self.lock:
                if time.monotonic() - self.last_used >= STRIP_IDLE_SECONDS:
                    await self._disconnect()
                    log.info("%s released after idle", self.name)
                    return

    async def apply(self, steps):
        async with self.lock:
            pending = dict(self.state)  # only remembered once the strip has the packets
            packets = [p for step in steps for p in self.packets(step, pending)]
            for attempt in (1, 2):
                try:
                    client = await self._connect()
                    for p in packets:
                        await client.write_gatt_char(STRIP_WRITE, p, response=False)
                        await asyncio.sleep(0.12)
                    break
                except Exception as error:
                    await self._disconnect()
                    if attempt == 2:
                        self.last_error = str(error) or type(error).__name__
                        raise RuntimeError(self.last_error) from error
            self.last_used = time.monotonic()
            self.last_error = None
            self.state.update(pending, updatedAt=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
            if self.idle_task is None or self.idle_task.done():
                self.idle_task = asyncio.create_task(self._release_when_idle())

    def describe(self):
        state = dict(self.state)
        if state.get("offAt") and time.strptime(state["offAt"], "%Y-%m-%dT%H:%M:%S%z") < time.localtime():
            state.update(on=False, offAt=None)  # the controller's own sleep timer has fired
        return {"name": self.name, "label": self.label, "kind": "strip", "protocol": "melk" if self.melk else "elk-bledom",
                "connected": self.client is not None and self.client.is_connected, "lastError": self.last_error,
                "effects": [{"name": k, "label": l} for k, l, _ in self.effects], "musicModes": MUSIC_MODES,
                "patternNumbers": self.melk, **state}


# ---------- WiZ bulbs (local UDP JSON) ----------

def wiz_call(ip, message, tries=3, timeout=1.5):
    """Send one JSON message and return the bulb's reply, or None."""
    if not ip:
        return None
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    payload = json.dumps(message).encode()
    try:
        for _ in range(tries):
            try:
                s.sendto(payload, (ip, WIZ_PORT))
                data, _ = s.recvfrom(4096)
                return json.loads(data)
            except (socket.timeout, ConnectionResetError, OSError, ValueError):
                pass
    finally:
        s.close()
    return None


def wiz_sweep(subnet, wait=2.5):
    """Ask every address on the /24; return {mac: ip}. Unicast, because Windows
    Firewall drops replies to a broadcast query."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.01)
    payload = json.dumps({"method": "getPilot", "params": {}}).encode()
    found = {}

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(4096)
                mac = json.loads(data).get("result", {}).get("mac")
                if mac:
                    found[mac] = ip
            except (socket.timeout, BlockingIOError, ConnectionResetError, OSError, ValueError):
                pass

    for i in range(1, 255):
        try:
            s.sendto(payload, (f"{subnet}.{i}", WIZ_PORT))
        except OSError:
            drain(0.05)
    drain(wait)
    s.close()
    return found


BULB_FIELDS = {"on", "color", "temp", "scene", "brightness"}


def wiz_message(step):
    """The WiZ message for a step, or None when the step only carries strip settings."""
    if not BULB_FIELDS & step.keys():
        return None
    if step.get("on") is False:
        return {"method": "setState", "params": {"state": False}}
    params = {"state": True}
    if "color" in step:
        params.update(dict(zip("rgb", step["color"])))
    if "temp" in step:
        params["temp"] = step["temp"]
    if "scene" in step:
        if step["scene"] not in WIZ_SCENES:
            raise ValueError("Unknown WiZ scene: " + str(step["scene"]))
        params["sceneId"] = step["scene"]
    if "speed" in step and "scene" in step:
        params["speed"] = max(10, min(200, step["speed"] * 2))
    if "brightness" in step:
        params["dimming"] = max(10, step["brightness"])
    if len(params) == 1:
        return {"method": "setState", "params": {"state": True}}
    return {"method": "setPilot", "params": params}


class Bulbs:
    def __init__(self, config, state):
        self.subnet = config.get("subnet")
        self.devices = {b["mac"].lower().replace(":", ""): b for b in config.get("bulbs", [])}
        self.ips = state.setdefault("wizIps", {})
        for mac, device in self.devices.items():
            self.ips.setdefault(mac, device.get("ip"))
        self.errors = {}
        self.last_sweep = 0.0
        self.lock = asyncio.Lock()

    def by_name(self, name):
        return next((mac for mac, d in self.devices.items() if d["name"] == name), None)

    def names(self):
        return [d["name"] for d in self.devices.values()]

    async def _refresh_ips(self, missing, min_interval):
        """Sweep the subnet (rate-limited) in case a bulb changed address."""
        if not self.subnet:
            return []
        async with self.lock:
            if time.monotonic() - self.last_sweep < min_interval:
                return []
            self.last_sweep = time.monotonic()
            found = await asyncio.to_thread(wiz_sweep, self.subnet)
            moved = [m for m in missing if m in found and found[m] != self.ips.get(m)]
            self.ips.update({m: ip for m, ip in found.items() if m in self.devices})
            return moved

    async def call(self, macs, message, quick=False):
        """quick: status reads for the UI - fewer retries, and sweep at most every 5 minutes."""
        tries, timeout, sweep_interval = (2, 1.0, 300) if quick else (3, 1.5, 60)
        results = dict(zip(macs, await asyncio.gather(*(asyncio.to_thread(wiz_call, self.ips.get(m), message, tries, timeout) for m in macs))))
        missing = [m for m, r in results.items() if r is None]
        if missing:
            for mac in await self._refresh_ips(missing, sweep_interval):
                results[mac] = await asyncio.to_thread(wiz_call, self.ips[mac], message, tries, timeout)
        for mac, reply in results.items():
            if reply is None:
                self.errors[mac] = f"No reply from {self.ips.get(mac) or 'an unknown address'}. The bulb may be off at the switch, or this computer cannot reach it over Wi-Fi."
            elif "error" in reply:
                self.errors[mac] = reply["error"].get("message", "The bulb rejected the command")
            else:
                self.errors.pop(mac, None)
        return results

    async def describe(self):
        if not self.devices:
            return []
        replies = await self.call(list(self.devices), {"method": "getPilot", "params": {}}, quick=True)
        out = []
        for mac, device in self.devices.items():
            r = (replies.get(mac) or {}).get("result") or {}
            scene = r.get("sceneId") or None
            out.append({
                "name": device["name"], "label": device.get("label", device["name"]), "kind": "wiz", "mac": mac, "ip": self.ips.get(mac),
                "reachable": bool(r), "lastError": self.errors.get(mac),
                "on": r.get("state"), "brightness": r.get("dimming"), "temp": r.get("temp") or None,
                "color": [r["r"], r["g"], r["b"]] if all(k in r for k in "rgb") else None,
                "scene": scene, "sceneName": WIZ_SCENES.get(scene), "rssi": r.get("rssi"),
            })
        return out

    async def apply(self, mac, steps):
        for step in steps:
            message = wiz_message(step)
            if message is None:
                continue
            reply = (await self.call([mac], message))[mac]
            if reply is None or "error" in reply:
                raise RuntimeError(self.errors.get(mac) or "The bulb did not accept the command")


# ---------- HTTP ----------

class Bridge:
    def __init__(self, devices=None):
        devices = devices if devices is not None else load_devices()
        self.state = load_state()
        self.strips = {s["name"]: Strip(s, self.state) for s in devices.get("strips", [])}
        self.bulbs = Bulbs(devices.get("wiz", {}), self.state)

    def resolve(self, targets):
        names = []
        for t in targets:
            if t == "all":
                names += [*self.strips, *self.bulbs.names()]
            elif t == "strips":
                names += list(self.strips)
            elif t == "bulbs":
                names += self.bulbs.names()
            elif t in self.strips or self.bulbs.by_name(t):
                names.append(t)
            else:
                raise ValueError("Unknown light: " + str(t))
        return list(dict.fromkeys(names))

    async def set(self, steps):
        per_device = {}
        for step in steps:
            for name in self.resolve(step.get("targets") or []):
                per_device.setdefault(name, []).append({k: v for k, v in step.items() if k != "targets"})
        for name, device_steps in per_device.items():  # reject bad values before touching any light
            for step in device_steps:
                if name in self.strips:
                    self.strips[name].packets(step, {})
                else:
                    wiz_message(step)

        async def run(name, device_steps):
            try:
                if name in self.strips:
                    await self.strips[name].apply(device_steps)
                else:
                    await self.bulbs.apply(self.bulbs.by_name(name), device_steps)
                return name, {"ok": True}
            except Exception as error:
                log.warning("%s: %s", name, error)
                return name, {"ok": False, "error": str(error)}

        results = dict(await asyncio.gather(*(run(n, s) for n, s in per_device.items())))
        save_state(self.state)
        return {"results": results}

    async def describe(self):
        bulbs = await self.bulbs.describe()
        save_state(self.state)
        return {"version": VERSION, "devices": [s.describe() for s in self.strips.values()] + bulbs, "wizScenes": WIZ_SCENES}

    async def route(self, method, path, headers, body):
        if headers.get("host", "").split(":")[0] not in ("127.0.0.1", "localhost"):
            return 403, {"error": "Host is not allowed"}
        if method == "GET" and path == "/health":
            return 200, {"ok": True, "version": VERSION}
        if method == "GET" and path == "/state":
            return 200, await self.describe()
        if method == "POST" and path == "/set":
            if not headers.get("content-type", "").startswith("application/json"):
                return 415, {"error": "Send JSON"}
            steps = json.loads(body or b"{}").get("steps")
            if not isinstance(steps, list) or not steps:
                return 400, {"error": "Send at least one step"}
            try:
                return 200, await self.set(steps)
            except ValueError as error:
                return 400, {"error": str(error)}
        return 404, {"error": "Not found"}

    async def handle(self, reader, writer):
        status, payload = 400, {"error": "Bad request"}
        try:
            method, path, _ = (await asyncio.wait_for(reader.readline(), 10)).decode("latin1").split(" ", 2)
            headers = {}
            while True:
                line = await asyncio.wait_for(reader.readline(), 10)
                if line in (b"\r\n", b"\n", b""):
                    break
                key, _, value = line.decode("latin1").partition(":")
                headers[key.strip().lower()] = value.strip()
            length = int(headers.get("content-length") or 0)
            if length > 65536:
                raise ValueError("Request too large")
            body = await asyncio.wait_for(reader.readexactly(length), 10) if length else b""
            status, payload = await self.route(method, path.split("?")[0], headers, body)
        except Exception as error:
            log.exception("request failed")
            status, payload = 500, {"error": str(error) or type(error).__name__}
        data = json.dumps(payload).encode()
        reason = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 415: "Unsupported Media Type"}.get(status, "Error")
        writer.write(f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode() + data)
        try:
            await writer.drain()
        finally:
            writer.close()


async def main():
    devices = load_devices()
    bridge = Bridge(devices)
    port = int(os.environ.get("DECK_LIGHTS_PORT", devices.get("port", 8183)))
    server = await asyncio.start_server(bridge.handle, "127.0.0.1", port)
    log.info("lights bridge %s listening on 127.0.0.1:%s with %d strips and %d bulbs", VERSION, port, len(bridge.strips), len(bridge.bulbs.devices))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    handler = logging.handlers.RotatingFileHandler(HERE / "bridge.log", maxBytes=262144, backupCount=1, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(main())
    except Exception:
        log.exception("lights bridge stopped")
        raise
