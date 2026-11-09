"""Deck lights bridge: one local HTTP API for Bluetooth LED strips (ELK-BLEDOM family)
and WiZ bulbs (Wi-Fi UDP). Deck proxies to it; it listens on 127.0.0.1 only.

Devices are listed in devices.json next to this file (see devices.example.json).
Run it as a user that can use Bluetooth; on Windows that means a user session or an
S4U scheduled task, not the Local Service account.

  GET  /health   bridge version
  GET  /state    last-known strip state and live WiZ bulb state
  POST /set      {"steps": [{"targets": ["strips", "bedroom"], "on": true, "color": [r, g, b],
                   "brightness": 1-100, "temp": 1000-10000 (kept within each bulb's range),
                   "scene": WiZ scene id, "effect": strip effect name,
                   "pattern": MELK pattern number 0-212, "speed": 0-100,
                   "music": 0-8 (strip microphone mode, 0 = off), "sensitivity": 0-100,
                   "timer": minutes until the strip switches itself off (0 = cancel)}, ...]}
  GET  /discover WiZ bulbs on the network that devices.json doesn't list yet
  POST /bulbs    {"action": "add", "mac", "name", "label", "scenes"} | {"action": "update", "name",
                   "label", "scenes", "timeout"} | {"action": "remove", "name"}; saves devices.json
  POST /identify {"name"} or {"mac"}: blink a bulb three times, then put it back

Targets are device names, or the groups "strips", "bulbs" and "all".
"""
import asyncio
import json
import logging
import logging.handlers
import math
import os
import re
import socket
import time
from pathlib import Path

VERSION = "1.6.0"
HERE = Path(__file__).resolve().parent
DEVICES_FILE = Path(os.environ.get("DECK_LIGHTS_DEVICES", HERE / "devices.json"))
STATE_FILE = HERE / "state.json"

STRIP_WRITE = "0000fff3-0000-1000-8000-00805f9b34fb"
STRIP_IDLE_SECONDS = 90  # release the strip so its phone app can connect
WIZ_PORT = 38899

# Built-in effects: (name, label, code, group). Classic controllers drive plain RGB strips;
# MELK ("symphony") controllers drive addressable strips with their own pattern set.
CLASSIC_EFFECTS = [(name, label, code, None) for name, label, code in (
    ("jump3", "3-colour jump", 0x87), ("jump7", "7-colour jump", 0x88), ("fade3", "3-colour fade", 0x89),
    ("rainbow-fade", "Rainbow fade", 0x8A), ("red-breathe", "Red breathe", 0x8B), ("green-breathe", "Green breathe", 0x8C),
    ("blue-breathe", "Blue breathe", 0x8D), ("yellow-breathe", "Yellow breathe", 0x8E), ("cyan-breathe", "Cyan breathe", 0x8F),
    ("purple-breathe", "Purple breathe", 0x90), ("white-breathe", "White breathe", 0x91), ("red-green", "Red–green fade", 0x92),
    ("red-blue", "Red–blue fade", 0x93), ("green-blue", "Green–blue fade", 0x94), ("strobe7", "7-colour strobe", 0x95),
    ("red-strobe", "Red strobe", 0x96), ("green-strobe", "Green strobe", 0x97), ("blue-strobe", "Blue strobe", 0x98),
    ("yellow-strobe", "Yellow strobe", 0x99), ("cyan-strobe", "Cyan strobe", 0x9A), ("purple-strobe", "Purple strobe", 0x9B),
    ("white-strobe", "White strobe", 0x9C),
)]
# MELK ("symphony") controllers drive addressable strips. Their patterns are numbered 0-212,
# in the order of the vendor apps' own table (arrays.xml modes_group0-7 in duoCo StripX,
# decompiled and checked on a MELK-OC21 by github.com/wxx9248/Corner-Floor-Lamp-Controller).
# btgadget (github.com/ilyakurdyukov/btgadget) documents the same range, 0x600-0x6d4, for a
# MELK-OA10 with Lotus Lamp X. Vendor typos are fixed; repeated names get a number.
MELK_PATTERNS = (
    "Auto Play", "Magic Forward", "Magic Back", "7-Color Trans", "7-Color Trans Back", "R-G-B Trans",
    "R-G-B Trans Back", "Y-C-P Trans", "Y-C-P Trans Back", "6-Color to Red", "6-Color to Red Back",
    "6-Color to Green", "6-Color to Green Back", "6-Color to Blue", "6-Color to Blue Back", "6-Color to Cyan",
    "6-Color to Cyan Back", "6-Color to Yellow", "6-Color to Yellow Back", "6-Color to Purple",
    "6-Color to Purple Back", "6-Color to White", "6-Color to White Back", "7-Color Tail", "7-Color Tail Back",
    "Red Tail", "Red Tail Back", "Green Tail", "Green Tail Back", "Blue Tail", "Blue Tail Back",
    "Yellow Tail", "Yellow Tail Back", "Cyan Tail", "Cyan Tail Back", "Purple Tail", "Purple Tail Back",
    "White Tail", "White Tail Back", "7-Color Water", "7-Color Water Back", "R-G-B Water", "R-G-B Water Back",
    "Y-C-P Water", "Y-C-P Water Back", "R-G Water", "R-G Water Back", "G-B Water", "G-B Water Back",
    "Y-B Water", "Y-B Water Back", "Y-C Water", "Y-C Water Back", "C-P Water", "C-P Water Back",
    "White Water", "White Water Back", "7-Color Close", "7-Color Open", "R-G-B Close", "R-G-B Open",
    "Y-C-P Close", "Y-C-P Open", "Red Close", "Red Open", "Green Close", "Green Open", "Blue Close",
    "Blue Open", "Yellow Close", "Yellow Open", "Cyan Close", "Cyan Open", "Purple Close", "Purple Open",
    "White Close", "White Open", "7-Color Race", "7-Color Race Back", "R-G-B Race", "R-G-B Race Back",
    "Y-C-P Race", "Y-C-P Race Back", "7-Color Wave", "7-Color Wave Back", "R-G-B Wave", "R-G-B Wave Back",
    "Y-C-P Wave", "Y-C-P Wave Back", "Red Running", "Red Run Back", "Green Running", "Green Run Back",
    "Blue Running", "Blue Run Back", "Yellow Running", "Yellow Run Back", "Cyan Running", "Cyan Run Back",
    "Purple Running", "Purple Run Back", "White Running", "White Run Back", "7-Color Running",
    "7-Color Run Back", "R-G-B Running", "R-G-B Run Back", "Y-C-P Running", "Y-C-P Run Back", "B-P-C-Y Running",
    "B-P-C-Y Run Back", "B-G-C-Y Running", "B-G-C-Y Run Back", "Red-Dot in White Running", "Red-Dot in White Run Back",
    "Green-Dot in Red Running", "Green-Dot in Red Run Back", "Blue-Dot in Green Running", "Blue-Dot in Green Run Back",
    "Yellow-Dot in Blue Running", "Yellow-Dot in Blue Run Back", "Cyan-Dot in Yellow Running",
    "Cyan-Dot in Yellow Run Back", "Purple-Dot in Cyan Running", "Purple-Dot in Cyan Run Back",
    "White-Dot in Purple Running", "White-Dot in Purple Run Back", "White-Dot in Red Running",
    "White-Dot in Red Run Back", "7-Color in Red Running", "7-Color in Red Run Back", "7-Color in Green Running",
    "7-Color in Green Run Back", "7-Color in Blue Running", "7-Color in Blue Run Back", "7-Color in Yellow Running",
    "7-Color in Yellow Run Back", "7-Color in Cyan Running", "7-Color in Cyan Run Back", "7-Color in Purple Running",
    "7-Color in Purple Run Back", "7-Color in White Running", "7-Color in White Run Back", "W-R-W Flow",
    "W-R-W Flow Back", "W-G-W Flow", "W-G-W Flow Back", "W-B-W Flow", "W-B-W Flow Back", "W-Y-W Flow",
    "W-Y-W Flow Back", "W-C-W Flow", "W-C-W Flow Back", "W-P-W Flow", "W-P-W Flow Back", "R-W-R Flow",
    "R-W-R Flow Back", "G-W-G Flow", "G-W-G Flow Back", "B-W-B Flow", "B-W-B Flow Back", "Y-W-Y Flow",
    "Y-W-Y Flow Back", "C-W-C Flow", "C-W-C Flow Back", "P-W-P Flow", "P-W-P Flow Back", "Green-Dot in Blue Running",
    "Green-Dot in Blue Run Back", "Green-Dot in Red Running", "Green-Dot in Red Run Back", "Red-Dot in Blue Running",
    "Red-Dot in Blue Run Back", "Cyan-Dot in Yellow Running", "Cyan-Dot in Yellow Run Back", "Yellow-Dot in Purple Running",
    "Yellow-Dot in Purple Run Back", "White-Dot in Yellow Running", "White-Dot in Yellow Run Back",
    "Yellow-Dot in White Running", "Yellow-Dot in White Run Back", "7-Color Flush", "7-Color Flush Back",
    "R-G-B Flush", "R-G-B Flush Back", "Y-C-P Flush", "Y-C-P Flush Back", "7-Color Flush Close",
    "7-Color Flush Open", "R-G-B Flush Close", "R-G-B Flush Open", "Y-C-P Flush Close", "Y-C-P Flush Open",
    "7-Color Jump", "R-G-B Jump", "Y-C-P Jump", "7-Color Strobe", "R-G-B Strobe", "Y-C-P Strobe",
    "7-Color Gradual", "R-Y Gradual", "R-P Gradual", "G-C Gradual", "G-Y Gradual", "B-P Gradual",
    "Red Marquee", "Green Marquee", "Blue Marquee", "Yellow Marquee", "Cyan Marquee", "Purple Marquee",
    "White Marquee", "7-Color Energy",
)
# Families for grouping the list, matched in order (Flush before Close and Open).
MELK_FAMILIES = (
    ("Flush", "Flush"), ("Close", "Close and open"), ("Open", "Close and open"), ("Tail", "Tail"),
    ("Water", "Water"), ("Race", "Race"), ("Wave", "Wave"), ("Run", "Running"), ("Flow", "Flow"),
    ("Trans", "Transition"), (" to ", "Transition"), ("Jump", "Jump"), ("Strobe", "Strobe"),
    ("Gradual", "Gradual"), ("Marquee", "Marquee"), ("Magic", "Magic"), ("Auto", "Auto"), ("Energy", "Energy"),
)


def melk_effects():
    """(name, label, code, group) for every MELK pattern."""
    seen, out = {}, []
    for code, label in enumerate(MELK_PATTERNS):
        seen[label] = seen.get(label, 0) + 1
        label = label if seen[label] == 1 else f"{label} {seen[label]}"
        group = next(g for word, g in MELK_FAMILIES if word in label)
        name = "".join(c if c.isalnum() else "-" for c in label.lower()).strip("-")
        out.append((name, label, code, group))
    return out


MELK_EFFECTS = melk_effects()
# Generic names scenes can use on any strip.
CLASSIC_ALIASES = {"auto": "jump7", "rainbow": "rainbow-fade", "wave": "fade3", "breathe": "white-breathe", "strobe": "strobe7", "jump": "jump7", "fade": "fade3"}
MELK_ALIASES = {"auto": "auto-play", "rainbow": "magic-forward", "wave": "7-color-wave", "breathe": "7-color-gradual",
                "strobe": "7-color-strobe", "jump": "7-color-jump", "fade": "7-color-gradual"}
# The microphone's eight visualisers (ExternalMicEqMode in the apps), the remote's music buttons.
MUSIC_MODES = ("Energetic", "Rhythm", "Spectrum", "Rolling", "Energetic 2", "Rhythm 2", "Spectrum 2", "Rolling 2")
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
        if self.state["effect"] not in {key for key, *_ in self.effects}:  # names from an older bridge
            self.state["effect"] = None
        self.client = None
        self.lock = asyncio.Lock()
        self.last_used = 0.0
        self.last_error = None
        self.idle_task = None

    def effect_code(self, name):
        if isinstance(name, int):
            if not self.melk:
                raise ValueError("Pattern numbers only apply to addressable (MELK) strips")
            if not 0 <= name < len(MELK_EFFECTS):
                raise ValueError(f"Pattern numbers run from 0 to {len(MELK_EFFECTS) - 1}")
            return name, MELK_EFFECTS[name][0]
        name = (MELK_ALIASES if self.melk else CLASSIC_ALIASES).get(name, name)
        for key, _, code, _ in self.effects:
            if key == name:
                return code, key
        raise ValueError(f"Unknown effect for {self.label}: {name}")

    def mode_frame(self, code):
        f = lambda *b: bytes([0x7E, *b, 0xEF])
        return f(0x05, 0x03, code, 0x06, 0xFF, 0xFF, 0x00) if self.melk else f(0x00, 0x03, code, 0x03, 0x00, 0x00, 0x00)

    def packets(self, step, s):
        """Translate one step into frames, recording the resulting state in s.
        Classic frames are the ELK-BLEDOM set. MELK frames follow the vendor apps' builders
        (see MELK_PATTERNS); power, colour and brightness are Home Assistant elkbledom's."""
        f = lambda *b: bytes([0x7E, *b, 0xEF])
        mic_off = f(0x04, 0x07, 0x00, 0xFF, 0xFF, 0xFF, 0x00)
        if step.get("on") is False:
            s["on"] = False
            return [f(0x04 if self.melk else 0x00, 0x04, 0x00, 0x00, 0x00, 0xFF, 0x00)]
        out = [f(0x04 if self.melk else 0x00, 0x04, 0xF0, 0x00, 0x01, 0xFF, 0x00)]
        s["on"] = True
        color = step.get("color") or (kelvin_to_rgb(step["temp"]) if "temp" in step else None)
        effect = step["pattern"] if "pattern" in step else step.get("effect")
        if step.get("music") == 0 or (s.get("music") and (color or effect is not None)):
            out.append(mic_off)
            if step.get("music") == 0 and not color and effect is None:
                # The microphone leaves the strip frozen on its last frame, so put the look back.
                if s.get("effect"):
                    out.append(self.mode_frame(self.effect_code(s["effect"])[0]))
                elif s.get("color"):
                    out.append(f(0x00, 0x05, 0x03, *s["color"], 0x00))
            s["music"] = None
        if color:
            r, g, b = color
            out.append(f(0x00, 0x05, 0x03, r, g, b, 0x00))
            s.update(color=list(color), effect=None)
        if effect is not None:
            code, key = self.effect_code(effect)
            out.append(self.mode_frame(code))
            s["effect"] = key
        if "speed" in step:  # 0-100
            v = step["speed"]
            out.append(f(0x04, 0x02, v, 0xFF, 0xFF, 0xFF, 0x00) if self.melk else f(0x00, 0x02, v, 0x00, 0x00, 0x00, 0x00))
            s["speed"] = v
        if step.get("music"):
            if not 1 <= step["music"] <= len(MUSIC_MODES):
                raise ValueError(f"Music modes run from 1 to {len(MUSIC_MODES)}")
            # Mic on, then the visualiser: the visualiser frame is what starts it reacting.
            out += [f(0x04, 0x07, 0x01, 0xFF, 0xFF, 0xFF, 0x00), f(0x07, 0x03, 0x7F + step["music"], 0x04, 0xFF, 0xFF, 0x00)]
            s["music"] = step["music"]
        if "sensitivity" in step:  # 0-100
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
                "effects": [{"name": k, "label": l, **({"group": g} if g else {})} for k, l, _, g in self.effects],
                "musicModes": list(MUSIC_MODES), **state}


# ---------- WiZ bulbs (local UDP JSON) ----------
# Bulbs answer JSON on UDP 38899. A controller that sends "registration" every 20 seconds is told
# about every change on UDP 38900 ("syncPilot"), and a bulb announces itself there when it powers
# up ("firstBeat"), with its MAC, so a bulb on a new address is found without sweeping the subnet.
# The WiZ app works this way, and so does pywizlight (Home Assistant's library).

PUSH_PORT = 38900
PUSH_KEEPALIVE = 20  # seconds between registrations; a bulb forgets a controller after about 30
PUSH_FRESH = 45  # a bulb heard from this recently is answering, and its last state stands
PILOT_KEYS = ("state", "dimming", "temp", "sceneId", "speed", "r", "g", "b", "c", "w", "rssi")
MAC = re.compile(r"^[0-9a-f]{12}$")
NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


def clean_label(label, fallback):
    text = "".join(ch for ch in " ".join(str(label or "").split()) if ch.isprintable())[:60]
    return text or fallback


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


def wiz_sweep(subnet, wait=2.5, pilots=None):
    """Ask every address on the /24; return {mac: ip} (and each bulb's state in pilots).
    Unicast, because Windows Firewall drops replies to a broadcast query."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.01)
    payload = json.dumps({"method": "getPilot", "params": {}}).encode()
    found = {}

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(4096)
                result = json.loads(data).get("result", {})
                mac = str(result.get("mac") or "").lower()
                if MAC.match(mac):
                    found[mac] = ip
                    if pilots is not None:
                        pilots[mac] = result
            except (socket.timeout, BlockingIOError, ConnectionResetError, OSError, ValueError, AttributeError):
                pass

    for i in range(1, 255):
        try:
            s.sendto(payload, (f"{subnet}.{i}", WIZ_PORT))
        except OSError:
            drain(0.05)
    drain(wait)
    s.close()
    return found


def source_ip(target):
    """This computer's address on the route to target. Connecting a UDP socket sends nothing."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((target, 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def local_subnet():
    ip = source_ip("192.0.2.1")
    return ip.rsplit(".", 1)[0] if ip and not ip.startswith("127.") else None


def wiz_capabilities(system, model=None, user=None):
    """What a bulb can do, from getSystemConfig and getModelConfig (getUserConfig on older firmware).
    The module name's second part says it: ESP01_SHRGB1C_31 is colour, ..._SHTW_... tunable white,
    ..._SHDW_... dimmable white, ..._SOCKET_... a plug. None when the bulb didn't say."""
    module = str((system or {}).get("moduleName") or "")
    if not module:
        return None
    ident = module.split("_")[1].upper() if "_" in module else module.upper()
    kind = "color" if "RGB" in ident else "tunable" if "TW" in ident else "socket" if "SOCKET" in ident else "dimmable"
    temp = None
    if kind in ("color", "tunable"):
        for source in (model or {}, user or {}):
            values = source.get("extRange") or source.get("cctRange") or source.get("whiteRange")
            if isinstance(values, list) and values and all(isinstance(v, (int, float)) and v > 0 for v in values):
                temp = [int(min(values)), int(max(values))]
                break
        temp = temp or ([2200, 6500] if kind == "color" else [2700, 6500])
    return {
        "model": module, "firmware": (system or {}).get("fwVersion"), "kind": kind,
        "color": kind == "color", "temp": temp, "dimmable": kind != "socket",
        "scenes": kind in ("color", "tunable") or "DH" in ident or "SH" in ident,
    }


def fit_step(step, caps):
    """A step reshaped for what a bulb can do: no colour on a white bulb, white kept within its range.
    A white bulb in a colour scene still takes the scene's brightness."""
    if not caps:
        return step
    step = dict(step)
    if not caps.get("color"):
        step.pop("color", None)
    if "temp" in step:
        if caps.get("temp"):
            low, high = caps["temp"]
            step["temp"] = max(low, min(high, step["temp"]))
        else:
            step.pop("temp")
    if not caps.get("scenes"):
        step.pop("scene", None)
    if not caps.get("dimmable"):
        step.pop("brightness", None)
    return step


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


def merge_pilot(pilot, params):
    """A bulb's state after it accepted params: a scene, a colour and a white replace each other."""
    pilot = dict(pilot or {})
    if "sceneId" in params:
        drop = ("r", "g", "b", "c", "w", "temp")
    elif any(k in params for k in "rgb"):
        drop = ("temp", "sceneId", "c", "w")
    elif "temp" in params:
        drop = ("r", "g", "b", "c", "w", "sceneId")
    else:
        drop = ()
    for key in drop:
        pilot.pop(key, None)
    pilot.update(params)
    return pilot


def pilot_matches(pilot, params):
    return all(pilot.get(k) == v for k, v in params.items() if k in ("state", "dimming", "temp", "sceneId", "r", "g", "b"))


def restore_message(pilot):
    """The message that puts a bulb back the way getPilot found it."""
    if not pilot.get("state"):
        return {"method": "setState", "params": {"state": False}}
    params = {"state": True}
    if pilot.get("dimming"):
        params["dimming"] = pilot["dimming"]
    if pilot.get("sceneId"):
        params["sceneId"] = pilot["sceneId"]
        if pilot.get("speed"):
            params["speed"] = pilot["speed"]
    elif pilot.get("temp"):
        params["temp"] = pilot["temp"]
    elif all(pilot.get(k) is not None for k in "rgb"):
        params.update({k: pilot[k] for k in "rgbcw" if pilot.get(k) is not None})
    return {"method": "setPilot", "params": params}


class Bulbs:
    def __init__(self, config, state):
        self.subnet = config.get("subnet")
        self.devices = {}
        self.ips = state.setdefault("wizIps", {})
        self.caps = state.setdefault("wizModels", {})
        # The address bulbs know this bridge by when it registers: any stable 12 hex digits.
        self.push_mac = state.setdefault("pushMac", os.urandom(6).hex())
        for device in config.get("bulbs", []):
            self.add(device)
        self.errors = {}
        self.pilots = {}  # mac -> last known state, from a push or a reply
        self.heard = {}  # mac -> when the bulb last said anything (monotonic)
        self.strangers = {}  # mac -> {"ip", "at"}: unlisted bulbs that announced themselves
        self.found = {}  # mac -> ip, from the last discovery
        self.transport = None  # the push socket, while listening
        self.dirty = False
        self.last_sweep = 0.0
        self.lock = asyncio.Lock()

    def add(self, device):
        mac = device["mac"] = device["mac"].lower().replace(":", "")
        self.devices[mac] = device
        if not self.ips.get(mac):
            self.ips[mac] = device.get("ip")

    def remove(self, mac):
        self.devices.pop(mac, None)
        for table in (self.ips, self.caps, self.pilots, self.heard, self.errors):
            table.pop(mac, None)

    def by_name(self, name):
        return next((mac for mac, d in self.devices.items() if d["name"] == name), None)

    def names(self, scenes_only=False):
        """Every bulb's name; with scenes_only, those that room scenes change (a bulb in another room,
        such as the kitchen, sets "scenes": false and is left out of the "bulbs" group)."""
        return [d["name"] for d in self.devices.values() if not scenes_only or d.get("scenes", True)]

    def answering(self, mac):
        return time.monotonic() - self.heard.get(mac, -1e9) <= PUSH_FRESH

    def note_ip(self, mac, ip):
        if ip and self.ips.get(mac) != ip:
            log.info("%s is now at %s", self.devices.get(mac, {}).get("name", mac), ip)
            self.ips[mac] = ip
            self.dirty = True

    # --- pushes ---

    def on_push(self, message, ip):
        """A datagram on the push port: a bulb's new state, a bulb starting up, or a registration reply."""
        if not isinstance(message, dict):
            return
        method = message.get("method")
        body = message.get("params") if method in ("syncPilot", "firstBeat") else message.get("result")
        if not isinstance(body, dict):
            return
        mac = str(body.get("mac") or "").lower()
        if not MAC.match(mac):
            return
        if mac not in self.devices:
            if method == "firstBeat":
                self.strangers[mac] = {"ip": ip, "at": time.monotonic()}
            return
        self.heard[mac] = time.monotonic()
        self.note_ip(mac, ip)
        self.errors.pop(mac, None)
        if method == "syncPilot":
            self.pilots[mac] = {k: body[k] for k in PILOT_KEYS if k in body}
        elif method == "firstBeat":
            self.caps.pop(mac, None)  # it restarted, perhaps on new firmware
            self.register(mac)

    def register(self, mac):
        """Ask a bulb to push its changes here. Sent from the push socket, so the reply lands there too."""
        ip = self.ips.get(mac)
        if not ip or not self.transport or self.transport.is_closing():
            return
        phone_ip = source_ip(ip)
        if not phone_ip:
            return
        message = {"method": "registration", "params": {"phoneIp": phone_ip, "register": True, "phoneMac": self.push_mac, "id": "1"}}
        try:
            self.transport.sendto(json.dumps(message, separators=(",", ":")).encode(), (ip, WIZ_PORT))
        except OSError as error:
            log.debug("registration with %s failed: %s", ip, error)

    def listening(self):
        return bool(self.transport and not self.transport.is_closing())

    async def listen(self):
        bulbs = self

        class Push(asyncio.DatagramProtocol):
            def datagram_received(self, data, addr):
                try:
                    bulbs.on_push(json.loads(data), addr[0])
                except ValueError:
                    pass

            def error_received(self, error):  # an ICMP "unreachable" from a bulb that's off at the switch
                log.debug("push socket: %s", error)

        try:
            self.transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(Push, local_addr=("0.0.0.0", PUSH_PORT))
            log.info("listening for WiZ updates on UDP %s", PUSH_PORT)
        except OSError as error:
            self.transport = None
            log.warning("no WiZ updates: UDP %s is unavailable (%s); polling instead", PUSH_PORT, error)

    async def run_push(self, save=None):
        """Listen for pushes and keep every bulb registered, for as long as the bridge runs."""
        while True:
            if not self.listening():
                await self.listen()
            for mac in list(self.devices):
                self.register(mac)
            if self.dirty and save:
                self.dirty = False
                save()
            await asyncio.sleep(PUSH_KEEPALIVE)

    # --- requests ---

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

        # Some bulbs sleep their Wi-Fi while switched off and only hear a message that lands while
        # they briefly wake, so waiting longer doesn't help: repeating does. Such a bulb sets
        # "timeout" in devices.json, and the message is resent every second for that many seconds
        # (half that for status reads) until it answers. Repeats are harmless: each sets the same state.
        def plan(mac):
            patience = float(self.devices[mac].get("timeout", 0))
            if not patience:
                return tries, timeout
            return max(tries, math.ceil(patience / (2 if quick else 1))), 1.0

        started, addresses = time.monotonic(), {m: self.ips.get(m) for m in macs}
        results = dict(zip(macs, await asyncio.gather(*(asyncio.to_thread(wiz_call, addresses[m], message, *plan(m)) for m in macs))))
        params = message.get("params") or {}
        changes = message["method"] in ("setPilot", "setState")
        for mac in [m for m, r in results.items() if r is None]:
            # The reply was lost, but the bulb pushed its new state afterwards: it did change.
            if changes and self.heard.get(mac, 0) > started and pilot_matches(self.pilots.get(mac, {}), params):
                results[mac] = {"method": message["method"], "result": {"success": True}}
            # Or a push came from a new address in the meantime: try there before sweeping.
            elif self.ips.get(mac) != addresses[mac]:
                results[mac] = await asyncio.to_thread(wiz_call, self.ips[mac], message, *plan(mac))
        missing = [m for m, r in results.items() if r is None]
        if missing:
            for mac in await self._refresh_ips(missing, sweep_interval):
                results[mac] = await asyncio.to_thread(wiz_call, self.ips[mac], message, *plan(mac))
        for mac, reply in results.items():
            if reply is None:
                self.errors[mac] = f"No reply from {self.ips.get(mac) or 'an unknown address'}. The bulb may be off at the switch, or this computer cannot reach it over Wi-Fi."
            elif "error" in reply:
                self.errors[mac] = reply["error"].get("message", "The bulb rejected the command")
            else:
                self.errors.pop(mac, None)
                self.heard[mac] = time.monotonic()
                result = reply.get("result") or {}
                if message["method"] == "getPilot":
                    self.pilots[mac] = {k: result[k] for k in PILOT_KEYS if k in result}
                elif changes:
                    self.pilots[mac] = merge_pilot(self.pilots.get(mac), params)
        return results

    async def probe(self, ip):
        """A bulb's capabilities, asked of the bulb itself."""
        ask = lambda method: asyncio.to_thread(wiz_call, ip, {"method": method, "params": {}}, 2, 1.0)
        system = ((await ask("getSystemConfig")) or {}).get("result")
        if not system:
            return None
        model = ((await ask("getModelConfig")) or {}).get("result")  # older firmware: "Method not found"
        user = None if model else ((await ask("getUserConfig")) or {}).get("result")
        return wiz_capabilities(system, model, user)

    async def describe(self):
        if not self.devices:
            return []
        # Bulbs that pushed recently are described from what they said; the rest are asked.
        stale = [m for m in self.devices if not self.answering(m) or m not in self.pilots]
        if stale:
            await self.call(stale, {"method": "getPilot", "params": {}}, quick=True)
        unknown = [m for m in self.devices if m not in self.caps and self.answering(m)]
        for mac, caps in zip(unknown, await asyncio.gather(*(self.probe(self.ips.get(m)) for m in unknown))):
            if caps:
                self.caps[mac] = caps
        out = []
        for mac, device in self.devices.items():
            r = self.pilots.get(mac, {}) if self.answering(mac) else {}
            scene = r.get("sceneId") or None
            out.append({
                "name": device["name"], "label": device.get("label", device["name"]), "kind": "wiz", "mac": mac, "ip": self.ips.get(mac),
                "reachable": bool(r), "lastError": self.errors.get(mac),
                "on": r.get("state"), "brightness": r.get("dimming"), "temp": r.get("temp") or None,
                "color": [r["r"], r["g"], r["b"]] if all(r.get(k) is not None for k in "rgb") and not r.get("temp") else None,
                "scene": scene, "sceneName": WIZ_SCENES.get(scene), "rssi": r.get("rssi"),
                "capabilities": self.caps.get(mac), "inScenes": device.get("scenes", True), "timeout": device.get("timeout", 0),
            })
        return out

    async def apply(self, mac, steps):
        for step in steps:
            message = wiz_message(fit_step(step, self.caps.get(mac)))
            if message is None:
                continue
            reply = (await self.call([mac], message))[mac]
            if reply is None or "error" in reply:
                raise RuntimeError(self.errors.get(mac) or "The bulb did not accept the command")

    async def discover(self):
        """Bulbs on the network that aren't listed yet: a sweep, plus any that announced themselves."""
        subnet = self.subnet or local_subnet()
        pilots = {}
        found = await asyncio.to_thread(wiz_sweep, subnet, 2.5, pilots) if subnet else {}
        for mac, seen in self.strangers.items():
            if time.monotonic() - seen["at"] < 86400:
                found.setdefault(mac, seen["ip"])
        for mac, ip in found.items():
            if mac in self.devices:
                self.note_ip(mac, ip)
        new = {mac: ip for mac, ip in found.items() if mac not in self.devices}
        self.found = dict(new)
        caps = await asyncio.gather(*(self.probe(ip) for ip in new.values()))
        return {"subnet": subnet, "bulbs": [
            {"mac": mac, "ip": ip, "capabilities": c, "on": pilots.get(mac, {}).get("state"), "rssi": pilots.get(mac, {}).get("rssi")}
            for (mac, ip), c in zip(new.items(), caps)
        ]}

    async def identify(self, mac):
        """Blink a bulb three times so you can tell which one it is, then put it back as it was."""
        ip = self.ips.get(mac) if mac in self.devices else self.found.get(mac) or self.strangers.get(mac, {}).get("ip")
        if not ip:
            raise LookupError("Unknown bulb: " + mac)
        before = ((await asyncio.to_thread(wiz_call, ip, {"method": "getPilot", "params": {}}, 3, 1.0)) or {}).get("result")
        if not before:
            raise RuntimeError(f"No reply from {ip}. The bulb may be off at the switch.")
        for i in range(6):
            message = {"method": "setPilot", "params": {"state": True, "dimming": 100}} if i % 2 == 0 else {"method": "setState", "params": {"state": False}}
            await asyncio.to_thread(wiz_call, ip, message, 1, 0.4)
            await asyncio.sleep(0.35)
        await asyncio.to_thread(wiz_call, ip, restore_message(before), 3, 1.0)
        if mac in self.devices:
            self.pilots[mac] = {k: before[k] for k in PILOT_KEYS if k in before}
        return {"ok": True}


# ---------- TV power (ADB) ----------

TV_ADDRESS = re.compile(r"^[\w.-]+:\d{1,5}$")
WAKEFULNESS = {"Awake": True, "Dreaming": True, "Asleep": False, "Dozing": False}


def find_adb(configured=None, env=os.environ, exists=os.path.exists):
    """config "adb", else the adb Relay (the desktop TV remote) bundles, else adb from the PATH."""
    if configured:
        return configured
    local = env.get("LOCALAPPDATA")
    relay = local and os.path.join(local, "Programs", "android-tv-remote-desktop", "resources", "scrcpy", "adb.exe")
    return relay if relay and exists(relay) else "adb"


async def run_adb(adb, *args, timeout=15):
    proc = await asyncio.create_subprocess_exec(adb, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0))
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("The TV didn't answer.")
    return out.decode("utf-8", "replace")


class Tv:
    """Wakes the TV and puts it to sleep over wireless ADB, which keeps answering in standby. Runs here
    rather than in Deck because the TV trusts this user's ADB key (Relay's pairing allowed it once)."""

    def __init__(self, config, run=run_adb):
        address = (config or {}).get("address")
        self.address = address if address and TV_ADDRESS.match(address) else None
        self.adb = find_adb((config or {}).get("adb"))
        self.run = run
        self.lock = asyncio.Lock()

    async def _connect(self):
        out = await self.run(self.adb, "connect", self.address)
        if re.search(r"unable|failed|refused|cannot", out, re.I):
            raise RuntimeError("The TV didn't answer. Is it plugged in and on the Wi-Fi?")

    async def status(self):
        if not self.address:
            return {"configured": False, "awake": None}
        async with self.lock:
            try:
                await self._connect()
                state = re.search(r"mWakefulness=(\w+)", await self.run(self.adb, "-s", self.address, "shell", "dumpsys", "power"))
                return {"configured": True, "awake": WAKEFULNESS.get(state.group(1)) if state else None}
            except (OSError, RuntimeError):
                return {"configured": True, "awake": None}

    async def set(self, action):
        """Neither key toggles, so waking a TV that's on does nothing."""
        if not self.address:
            raise LookupError("Add the TV's ADB address to devices.json as \"tv\": {\"address\": \"ip:5555\"}")
        if action not in ("wake", "sleep"):
            raise ValueError("Choose wake or sleep")
        async with self.lock:
            try:
                await self._connect()
                await self.run(self.adb, "-s", self.address, "shell", "input", "keyevent", "KEYCODE_WAKEUP" if action == "wake" else "KEYCODE_SLEEP")
            except OSError:
                raise RuntimeError("adb isn't available here. Install Relay, or set \"adb\" under \"tv\" in devices.json.")
        return {"configured": True, "awake": action == "wake"}


# ---------- HTTP ----------

class Bridge:
    def __init__(self, devices=None, devices_path=None):
        self.devices_path = Path(devices_path or DEVICES_FILE)
        self.config = devices if devices is not None else load_devices(self.devices_path)
        self.state = load_state()
        self.strips = {s["name"]: Strip(s, self.state) for s in self.config.get("strips", [])}
        self.bulbs = Bulbs(self.config.setdefault("wiz", {}), self.state)
        self.tv = Tv(self.config.get("tv"))

    def save_devices(self):
        tmp = self.devices_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.config, indent=2) + "\n")
        tmp.replace(self.devices_path)

    async def edit_bulbs(self, body):
        """Add, change or remove a WiZ bulb, and save devices.json."""
        action = body.get("action")
        listed = self.config["wiz"].setdefault("bulbs", [])
        if action == "add":
            mac = str(body.get("mac") or "").lower().replace(":", "")
            if not MAC.match(mac):
                raise ValueError("Choose a bulb by its MAC address")
            if mac in self.bulbs.devices:
                raise ValueError("That bulb is already listed")
            name = body.get("name")
            if not isinstance(name, str) or not NAME.match(name) or name in ("strips", "bulbs", "all"):
                raise ValueError("Names use lowercase letters, digits and dashes, starting with a letter")
            if name in self.strips or self.bulbs.by_name(name):
                raise ValueError(f"There is already a light called {name}")
            device = {"mac": mac, "name": name, "label": clean_label(body.get("label"), name)}
            ip = self.bulbs.found.get(mac) or self.bulbs.strangers.get(mac, {}).get("ip")
            if ip:
                device["ip"] = ip
            if body.get("scenes") is False:
                device["scenes"] = False
            listed.append(device)
            self.bulbs.add(device)
            self.bulbs.found.pop(mac, None)
            self.bulbs.strangers.pop(mac, None)
            self.bulbs.register(mac)
        elif action in ("update", "remove"):
            mac = self.bulbs.by_name(body.get("name"))
            if not mac:
                raise LookupError("Unknown light: " + str(body.get("name")))
            device = self.bulbs.devices[mac]
            if action == "remove":
                listed[:] = [d for d in listed if d is not device and d.get("mac", "").lower().replace(":", "") != mac]
                self.bulbs.remove(mac)
            else:
                if "label" in body:
                    device["label"] = clean_label(body["label"], device["name"])
                if "scenes" in body:
                    if not isinstance(body["scenes"], bool):
                        raise ValueError("Choose whether room scenes change this light")
                    device.pop("scenes", None) if body["scenes"] else device.update(scenes=False)
                if "timeout" in body:
                    timeout = body["timeout"]
                    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 <= timeout <= 30:
                        raise ValueError("Keep trying for 0 to 30 seconds")
                    device.pop("timeout", None) if not timeout else device.update(timeout=timeout)
        else:
            raise ValueError("Choose add, update or remove")
        self.save_devices()
        save_state(self.state)
        return {"ok": True}

    def resolve(self, targets):
        names = []
        for t in targets:
            if t == "all":
                names += [*self.strips, *self.bulbs.names()]
            elif t == "strips":
                names += list(self.strips)
            elif t == "bulbs":
                names += self.bulbs.names(scenes_only=True)
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
        return {"version": VERSION, "devices": [s.describe() for s in self.strips.values()] + bulbs, "wizScenes": WIZ_SCENES,
                "push": {"listening": self.bulbs.listening(), "port": PUSH_PORT}}

    async def route(self, method, path, headers, body):
        if headers.get("host", "").split(":")[0] not in ("127.0.0.1", "localhost"):
            return 403, {"error": "Host is not allowed"}
        if method == "POST" and not headers.get("content-type", "").startswith("application/json"):
            return 415, {"error": "Send JSON"}
        if method == "GET" and path == "/health":
            return 200, {"ok": True, "version": VERSION}
        if method == "GET" and path == "/state":
            return 200, await self.describe()
        if method == "GET" and path == "/discover":
            return 200, await self.bulbs.discover()
        if method == "POST" and path in ("/bulbs", "/identify"):
            try:
                request = json.loads(body or b"{}")
                if not isinstance(request, dict):
                    raise ValueError("Send a JSON object")
                if path == "/bulbs":
                    return 200, await self.edit_bulbs(request)
                mac = self.bulbs.by_name(request.get("name")) if request.get("name") else str(request.get("mac") or "").lower().replace(":", "")
                if not mac or not MAC.match(mac):
                    return 404, {"error": "Unknown light"}
                return 200, await self.bulbs.identify(mac)
            except ValueError as error:
                return 400, {"error": str(error)}
            except LookupError as error:
                return 404, {"error": str(error)}
            except RuntimeError as error:
                return 502, {"error": str(error)}
        if method == "POST" and path == "/set":
            steps = json.loads(body or b"{}").get("steps")
            if not isinstance(steps, list) or not steps:
                return 400, {"error": "Send at least one step"}
            try:
                return 200, await self.set(steps)
            except ValueError as error:
                return 400, {"error": str(error)}
        if path == "/tv" and method in ("GET", "POST"):
            if method == "GET":
                return 200, await self.tv.status()
            if not headers.get("content-type", "").startswith("application/json"):
                return 415, {"error": "Send JSON"}
            try:
                return 200, await self.tv.set(json.loads(body or b"{}").get("action"))
            except ValueError as error:
                return 400, {"error": str(error)}
            except LookupError as error:
                return 404, {"error": str(error)}
            except RuntimeError as error:
                return 502, {"error": str(error)}
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
    push = asyncio.create_task(bridge.bulbs.run_push(save=lambda: save_state(bridge.state)))  # noqa: F841 - kept until exit
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
