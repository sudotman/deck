"""Deck lights bridge: one local HTTP API for Bluetooth LED strips (ELK-BLEDOM family)
and WiZ bulbs (Wi-Fi UDP). Deck proxies to it; it listens on 127.0.0.1 only.

Devices are listed in devices.json next to this file (see devices.example.json).
Run it as a user that can use Bluetooth; on Windows that means a user session or an
S4U scheduled task, not the Local Service account.

  GET  /health   bridge version
  GET  /state    last-known strip state and live WiZ bulb state
  POST /set      {"steps": [{"targets": ["strips", "bedroom"], "on": true, "color": [r, g, b],
                   "brightness": 1-100, "temp": 2200-6500, "scene": WiZ scene id,
                   "effect": strip effect name, "speed": 0-100}, ...]}

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

VERSION = "1.1.0"
HERE = Path(__file__).resolve().parent
DEVICES_FILE = Path(os.environ.get("DECK_LIGHTS_DEVICES", HERE / "devices.json"))
STATE_FILE = HERE / "state.json"

STRIP_WRITE = "0000fff3-0000-1000-8000-00805f9b34fb"
STRIP_IDLE_SECONDS = 90  # release the strip so its phone app can connect
WIZ_PORT = 38899

STRIP_EFFECTS = {
    "jump3": 0x87, "jump7": 0x88, "fade3": 0x89, "rainbow-fade": 0x8A,
    "red-breathe": 0x8B, "green-breathe": 0x8C, "blue-breathe": 0x8D,
    "yellow-breathe": 0x8E, "cyan-breathe": 0x8F, "purple-breathe": 0x90,
    "white-breathe": 0x91, "red-green": 0x92, "red-blue": 0x93, "green-blue": 0x94,
    "strobe7": 0x95, "red-strobe": 0x96, "green-strobe": 0x97, "blue-strobe": 0x98,
    "white-strobe": 0x9C,
}
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
        # MELK-branded controllers ignore commands until they get this wake-up pair.
        self.wake = device.get("protocol", "elk-bledom") == "melk"
        self.state = state.setdefault("strips", {}).setdefault(self.name, {"on": None, "color": None, "brightness": None, "effect": None, "speed": None, "updatedAt": None})
        self.client = None
        self.lock = asyncio.Lock()
        self.last_used = 0.0
        self.last_error = None
        self.idle_task = None

    @staticmethod
    def packets(step, s):
        """Translate one step into packets, recording the resulting state in s."""
        out = []
        if step.get("on") is False:
            s["on"] = False
            return [_packet(0x7E, 0x00, 0x04, 0x00, 0x00, 0x00, 0xFF, 0x00, 0xEF)]
        out.append(_packet(0x7E, 0x00, 0x04, 0xF0, 0x00, 0x01, 0xFF, 0x00, 0xEF))
        s["on"] = True
        color = step.get("color") or (kelvin_to_rgb(step["temp"]) if "temp" in step else None)
        if color:
            r, g, b = color
            out.append(_packet(0x7E, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xEF))
            s["color"], s["effect"] = list(color), None
        if "effect" in step:
            if step["effect"] not in STRIP_EFFECTS:
                raise ValueError("Unknown strip effect: " + step["effect"])
            out.append(_packet(0x7E, 0x00, 0x03, STRIP_EFFECTS[step["effect"]], 0x03, 0x00, 0x00, 0x00, 0xEF))
            s["effect"] = step["effect"]
        if "speed" in step:
            out.append(_packet(0x7E, 0x00, 0x02, step["speed"], 0x00, 0x00, 0x00, 0x00, 0xEF))
            s["speed"] = step["speed"]
        if "brightness" in step:
            out.append(_packet(0x7E, 0x04, 0x01, step["brightness"], 0xFF, 0x00, 0x00, 0x00, 0xEF))
            s["brightness"] = step["brightness"]
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
        if self.wake:
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
        return {"name": self.name, "label": self.label, "kind": "strip", "connected": self.client is not None and self.client.is_connected, "lastError": self.last_error, **self.state}


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


def wiz_message(step):
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
            reply = (await self.call([mac], wiz_message(step)))[mac]
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
                    Strip.packets(step, {})
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
        return {"version": VERSION, "devices": [s.describe() for s in self.strips.values()] + bulbs, "effects": list(STRIP_EFFECTS), "wizScenes": WIZ_SCENES}

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
