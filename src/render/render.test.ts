import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldPack, CameraScript } from "../schema/index.ts";
import { evaluateCamera } from "../camera/evaluate.ts";
import { ffmpegArgs, parseCamera, poseScript, prepareScript, render } from "./render.ts";
import { videoLayer } from "./hyperframes.ts";

const root = new URL("../../", import.meta.url).pathname;
const world = WorldPack.parse(JSON.parse(readFileSync(join(root, "worlds/demo/world.json"), "utf8")));

test("ffmpeg args: png pipe in, h264 yuv420p faststart out, exact duration", () => {
  const a = ffmpegArgs({ fps: 30, out: "x.mp4", frames: 240 });
  const s = a.join(" ");
  assert.match(s, /-f image2pipe -framerate 30 -c:v png -i -/);
  assert.match(s, /-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 -t 8\.000000 -movflags \+faststart x\.mp4$/);
  assert.ok(!s.includes("-c:a"));
});

test("ffmpeg args: audio delayed by a positive shift, skipped into by a negative one", () => {
  const late = ffmpegArgs({ fps: 30, out: "x.mp4", frames: 30, audio: { path: "a.wav", shift: 1.5 } }).join(" ");
  assert.match(late, /-i a\.wav .*-map 0:v:0 -map 1:a:0 -af adelay=1500:all=1,apad -c:a aac/);
  const early = ffmpegArgs({ fps: 30, out: "x.mp4", frames: 30, audio: { path: "a.wav", shift: -2 } }).join(" ");
  assert.match(early, /-ss 2\.000000 -i a\.wav/);
  assert.ok(!early.includes("adelay"));
});

test("parseCamera: names, x,y,z:tx,ty,tz[:fov], errors", () => {
  assert.deepEqual(parseCamera(undefined, world), world.cameras!.default);
  assert.deepEqual(parseCamera("1,2,3:4,5,6:30", world), { position: [1, 2, 3], target: [4, 5, 6], fov: 30 });
  assert.deepEqual(parseCamera("1,2,3:4,5,6", world).fov, 45);
  assert.throws(() => parseCamera("nope", world), /no camera "nope"/);
  assert.throws(() => parseCamera("1,2:3,4,5", world), /bad camera/);
});

test("poseScript is a valid script that evaluates to the pose", () => {
  const pose = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 30 };
  const s = CameraScript.parse(poseScript(pose, 640, 360, "demo"));
  assert.deepEqual(evaluateCamera(s, 0), pose);
});

test("prepareScript rejects invalid scripts with every error", () => {
  assert.throws(() => prepareScript({ ...poseScript({ position: [0, 0, 0], target: [0, 0, 0] }, 641, 360), events: [{ t: 0, ops: [{ op: "remove", id: "ghost" }] }] }, join(root, "worlds/demo")), (e: Error) =>
    /even/.test(e.message) && /ghost/.test(e.message) && /position == target/.test(e.message));
});

test("videoLayer: HyperFrames timing attributes, trim, muted unless audio", () => {
  const clip = { file: "/c/abc.mp4", duration: 8, audio: false, key: "abcdef0123" };
  assert.equal(videoLayer(clip), '<video id="tera-abcdef01" class="clip tera" src="abc.mp4" data-start="0" data-duration="8" muted playsinline></video>');
  const l = videoLayer({ ...clip, audio: true }, { src: "./assets/a.mp4", start: 2.5, mediaStart: 1, duration: 3, track: 2, id: "x" });
  assert.equal(l, '<video id="x" class="clip tera" src="./assets/a.mp4" data-start="2.5" data-duration="3" data-media-start="1" data-track-index="2" data-has-audio="true" playsinline></video>');
  assert.throws(() => videoLayer(clip, { mediaStart: 6, duration: 3 }), /outside/);
});

// Real Chrome + ffmpeg. Slow on a busy box, so opt-in: TERA_E2E=1 npm test
test("e2e: render 10 frames twice, identical bytes", { skip: !process.env.TERA_E2E }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "tera-e2e-"));
  try {
    const hashes: string[] = [];
    for (const i of [1, 2]) {
      const out = join(dir, `r${i}.mp4`);
      const r = await render({ worldDir: join(root, "worlds/demo"), script: join(root, "worlds/demo/intro.camera.json"), out, from: 4.8, to: 4.8 + 10 / 30, width: 320, height: 180 });
      assert.equal(r.frames, 10);
      assert.ok(existsSync(out) && statSync(out).size > 0);
      hashes.push(createHash("sha256").update(readFileSync(out)).digest("hex"));
    }
    assert.equal(hashes[0], hashes[1]);
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames,pix_fmt", "-of", "csv=p=0", join(dir, "r1.mp4")], { encoding: "utf8" });
    assert.equal(probe.stdout.trim(), "320,180,yuv420p,10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
