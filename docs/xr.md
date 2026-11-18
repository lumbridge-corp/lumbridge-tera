# Tera in XR — Meta Quest 3 and Snap Spectacles

Any Tera world opens in a headset from the browser: no app, no build step.

| URL flag | what you get |
|---|---|
| `?xr=vr` | **Enter VR** button: immersive VR (Quest 3, Quest 2/Pro, any WebXR VR headset) |
| `?xr=ar` | **Start AR** button: `immersive-ar` — passthrough mixed reality on Quest 3, see-through AR on Snap Spectacles (Snap OS 2.0 browser) |
| `&xrsize=0.6` | real size in metres of the tabletop model's longest side (default 1.0 in VR, 0.5 in AR; try 0.3 on Spectacles, narrow FOV) |
| `&xrwalk=0.05` | world metres per real metre in walk mode (default 1 = 1:1; a miniature modelled at 1:20 walks at `0.05`) |
| `&xrstart=walk` | start VR at walk scale instead of tabletop |

XR forces the WebGL2 renderer (the safe path on the Quest browser; Gaussian splats
through Spark.js are WebGL2 too). Example:
`https://<machine>.<tailnet>.ts.net:8443/?world=/world/world.json&xr=vr`

## Controls

The world never moves; you do. Tabletop = you are a giant looking at a model; walk = 1:1.

| | Quest Touch controllers | hands (hand tracking) |
|---|---|---|
| select an entity | point, pull the **trigger** | point, **pinch** |
| move the world | hold **grip**, move the hand (also turns it) | pinch and drag |
| scale the world | hold **both grips**, spread / bring hands together (also turns) | pinch with both hands and spread |
| smooth move (VR) | **left stick** (head direction) | — |
| snap turn 30° (VR) | **right stick** left / right | — |
| teleport (VR) | point at the floor, pull the trigger | point at the floor, pinch |
| tabletop ↔ walk (VR) | **A** or **X** | — |
| reset the view | **B** or **Y** | — |
| place the model (AR) | first trigger on a surface (cyan ring = hit-test) | first pinch on a surface |

In AR the sky, fog and ground planes (planes tagged `ground` or wider than 8 m) are
hidden so the model sits in your room; without hit-test support it starts 0.8 m in
front of you at table height (0.8 m). A pinch that travels more than 2.5 cm is a grab,
shorter is a click.

### `tera:select`

Selecting an entity (XR trigger/pinch, or a mouse click on the flat page) fires a DOM
event on `window`:

```js
addEventListener("tera:select", (e) => {
  const { id, point, source } = e.detail; // "robot", [x, y, z] world metres, "controller" | "hand" | "mouse"
  // e.g. open the repo for that part, or show its live status
});
```

## Serving over HTTPS (WebXR needs a secure context)

WebXR only runs on `https://` pages or `http://localhost`. Pick one:

**A. Tailscale serve (recommended if you use Tailscale).** The headset must be on the same
tailnet (Tailscale Android app, sideloaded on Quest). On the machine that runs Tera:

```bash
cd lumbridge-tera
node bin/tera.ts serve worlds/demo --port 8790          # plain http on 127.0.0.1:8790
tailscale serve --bg --https=8443 http://127.0.0.1:8790  # HTTPS with the tailnet cert
tailscale serve status                                   # shows the https://<machine>.<tailnet>.ts.net:8443 URL
tailscale serve --https=8443 off                         # stop serving when done
```

(`tailscale` may need to run as the user that owns the daemon.) Open
`https://<machine>.<tailnet>.ts.net:8443/?world=/world/world.json&xr=vr` in the Quest
Browser. Keep it tailnet-only: never `tailscale funnel`.

**B. USB, no network setup.** Quest in developer mode, plugged in:

```bash
adb reverse tcp:8790 tcp:8790   # the headset's localhost:8790 → this machine
node bin/tera.ts serve worlds/demo --port 8790
```

Open `http://localhost:8790/?world=/world/world.json&xr=vr` on the Quest (localhost is a secure context).

**C. Self-signed certificate on the LAN** (Vite dev server, hot reload):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=tera" \
  -keyout /tmp/tera-key.pem -out /tmp/tera-cert.pem
TERA_HTTPS_CERT=/tmp/tera-cert.pem TERA_HTTPS_KEY=/tmp/tera-key.pem npx vite --host 0.0.0.0
```

Open `https://<machine-ip>:8790/?world=worlds/demo/world.json&xr=vr` and accept the
certificate warning once.

## Opening it on the Quest 3

1. Put the headset on, open **Browser**.
2. Type the URL (or send it from the Meta Horizon phone app / bookmark it).
3. The page shows the world as a normal 3D view with an **ENTER VR** (or **START AR**) button at the bottom. Press it with the trigger.
4. Allow the permission prompts (VR / passthrough, hand tracking).
5. Start in tabletop mode; press **A** to walk in. Press the Meta button and *Exit* or take the headset off to leave.

On **Snap Spectacles** (Snap OS 2.0 browser), use `?xr=ar` (it has no VR) and a small
tabletop (`&xrsize=0.3`): the field of view is narrow, so a model larger than ~40 cm at
arm's length gets cut off. Hands only: pinch to select, pinch-drag to move.

## Performance budget (Quest 3 mobile GPU, target 72–90 fps)

In an XR session Tera switches to a cheap path automatically:

- no post effects (`environment.post` applies to the flat page and video only);
- framebuffer scale 1.0 and fixed foveation 1 (`renderer.xr.setFoveation(1)`);
- shadow maps capped at 1024² (the sun's 4096² map drops to 1024² while in XR);
- once per session the page logs a console warning when a frame exceeds the budget:

| | budget | why |
|---|---|---|
| draw calls | ≤ 150 | each costs CPU on the Quest's mobile chip; merge small parts into models |
| triangles | ≤ 750 000 | both eyes are drawn, so ×2 on the GPU |
| Gaussian splats | ≤ 1 000 000 | Spark sorts every splat per frame; prefer fewer, larger splats (`.spz`) |
| shadow map | 1024² | |

Snap Spectacles have a smaller budget than the Quest: aim for half of each number.
Check the Quest Browser console (`chrome://inspect` on a computer with the Quest on USB)
for `[tera] XR over the Quest budget` lines.

## Testing without a headset

`npm run smoke:xr` runs the page in headless Chrome three ways: without WebXR (the button
says *WebXR not available*), with Chrome's WebXR and no headset (*VR not supported*), and
with Meta's [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime)
emulating a Quest 3 (a local devDependency, no network): it enters VR (tabletop, **A** →
walk 1:1, trigger on an entity → `tera:select`) and AR (no sky, model base at 0.8 m,
two-hand grab scales). What it cannot check: real frame rate, passthrough look, hand
tracking quality and comfort — try those on the headset.

For interactive testing on a desktop, install the *Immersive Web Emulator* browser
extension (Meta) and open the page with `?xr=vr`.
