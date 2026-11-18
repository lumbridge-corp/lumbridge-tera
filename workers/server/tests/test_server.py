import base64
import json
import struct
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import gzip
from pathlib import Path

from tera_worker.config import Config
from tera_worker.server import serve

# 1x1 PNG
PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360f8cf00000301010018dd8db000"
    "00000049454e44ae426082")).decode()


class WorkerHTTP(unittest.TestCase):
    token = ""
    backends = ["mock"]
    allow_research = False

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        cfg = Config(host="127.0.0.1", port=0, data_dir=Path(self.tmp.name), backends=self.backends,
                     allow_research=self.allow_research, token=self.token)
        self.httpd = serve(cfg)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.t = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.t.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.worker.stop()
        self.httpd.server_close()
        self.tmp.cleanup()

    def req(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        h.update(headers or {})
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if resp.headers.get_content_type() == "application/json" else raw)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def wait(self, jid, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            s, j = self.req("GET", f"/v1/jobs/{jid}")
            self.assertEqual(s, 200)
            if j["status"] in ("done", "failed"):
                return j
            time.sleep(0.05)
        self.fail("job did not finish")


class TestMock(WorkerHTTP):
    def test_health_lists_models_with_licence(self):
        s, h = self.req("GET", "/v1/health")
        self.assertEqual(s, 200)
        self.assertTrue(h["ok"])
        kinds = {m["kind"] for m in h["models"]}
        self.assertEqual(kinds, {"image_to_splat", "image_to_model", "text_to_motion"})
        for m in h["models"]:
            self.assertEqual(m["name"], "mock")
            self.assertEqual(m["license"], "Apache-2.0")
            self.assertTrue(m["default"])

    def test_image_to_splat(self):
        s, r = self.req("POST", "/v1/jobs", {"kind": "image_to_splat", "input": {"image": PNG}})
        self.assertEqual(s, 202, r)
        self.assertTrue(r["id"].startswith("j_"))
        j = self.wait(r["id"])
        self.assertEqual(j["status"], "done", j)
        self.assertEqual(j["progress"], 1.0)
        fmts = [o["format"] for o in j["outputs"]]
        self.assertEqual(fmts, ["spz", "ply"])
        spz = urllib.request.urlopen(j["outputs"][0]["url"]).read()
        magic, version, n = struct.unpack("<III", gzip.decompress(spz)[:12])
        self.assertEqual((magic, version, n), (0x5053474E, 3, 512))
        ply = urllib.request.urlopen(j["outputs"][1]["url"]).read()
        self.assertTrue(ply.startswith(b"ply\nformat binary_little_endian 1.0\nelement vertex 512\n"))

    def test_data_uri_and_glb(self):
        s, r = self.req("POST", "/v1/jobs", {"kind": "image_to_model",
                                             "input": {"image": "data:image/png;base64," + PNG}})
        self.assertEqual(s, 202, r)
        j = self.wait(r["id"])
        self.assertEqual(j["status"], "done", j)
        glb = urllib.request.urlopen(j["outputs"][0]["url"]).read()
        magic, ver, total = struct.unpack("<III", glb[:12])
        self.assertEqual((magic, ver, total), (0x46546C67, 2, len(glb)))
        jlen, jtype = struct.unpack("<II", glb[12:20])
        self.assertEqual(jtype, 0x4E4F534A)
        gltf = json.loads(glb[20:20 + jlen])
        self.assertEqual(gltf["asset"]["version"], "2.0")

    def test_text_to_motion(self):
        s, r = self.req("POST", "/v1/jobs", {"kind": "text_to_motion", "input": {"prompt": "wave"}})
        self.assertEqual(s, 202, r)
        j = self.wait(r["id"])
        self.assertEqual(j["outputs"][0]["format"], "bvh")
        txt = urllib.request.urlopen(j["outputs"][0]["url"]).read().decode()
        self.assertTrue(txt.startswith("HIERARCHY"))

    def test_bad_requests(self):
        self.assertEqual(self.req("POST", "/v1/jobs", {"kind": "nope"})[0], 400)
        self.assertEqual(self.req("POST", "/v1/jobs", {"kind": "image_to_splat", "input": {}})[0], 400)
        self.assertEqual(self.req("POST", "/v1/jobs", {"kind": "image_to_splat",
                                                       "input": {"image": "aGVsbG8="}})[0], 400)
        s, e = self.req("POST", "/v1/jobs", {"kind": "image_to_splat", "input": {"image": PNG},
                                             "params": {"model": "lyra1"}})
        self.assertEqual(s, 400)
        self.assertIn("not available", e["error"])
        self.assertEqual(self.req("GET", "/v1/jobs/j_0000")[0], 404)
        self.assertEqual(self.req("GET", "/v1/nothing")[0], 404)

    def test_failure_is_reported(self):
        s, r = self.req("POST", "/v1/jobs", {"kind": "image_to_splat", "input": {"image": PNG},
                                             "params": {"mock_fail": True}})
        j = self.wait(r["id"])
        self.assertEqual(j["status"], "failed")
        self.assertIn("mock failure", j["error"])

    def test_one_job_at_a_time_and_cancel(self):
        ids = []
        for _ in range(3):
            s, r = self.req("POST", "/v1/jobs", {"kind": "image_to_splat", "input": {"image": PNG},
                                                 "params": {"mock_delay": 0.6}})
            ids.append(r["id"])
        time.sleep(0.15)
        states = [self.req("GET", f"/v1/jobs/{i}")[1]["status"] for i in ids]
        self.assertEqual(states.count("running"), 1)
        s, c = self.req("DELETE", f"/v1/jobs/{ids[2]}")
        self.assertEqual((s, c["status"], c["error"]), (200, "failed", "cancelled"))
        self.assertEqual(self.wait(ids[0])["status"], "done")
        self.assertEqual(self.wait(ids[1])["status"], "done")
        self.assertEqual(self.req("GET", f"/v1/jobs/{ids[2]}")[1]["status"], "failed")

    def test_files_cannot_escape_job_dir(self):
        s, r = self.req("POST", "/v1/jobs", {"kind": "text_to_motion", "input": {"prompt": "x"}})
        self.wait(r["id"])
        for bad in (f"/v1/files/{r['id']}/../job.json", f"/v1/files/{r['id']}/%2e%2e/job.json",
                    f"/v1/files/{r['id']}/../../../etc/passwd"):
            self.assertEqual(self.req("GET", bad)[0], 404, bad)


class TestResearchGate(WorkerHTTP):
    backends = ["lyra2", "mock"]

    def test_research_backend_disabled_by_default(self):
        s, h = self.req("GET", "/v1/health")
        self.assertNotIn("lyra2", [m["name"] for m in h["models"]])
        d = [x for x in h["disabled"] if x["name"] == "lyra2"][0]
        self.assertEqual(d["license"], "research-only")
        s, e = self.req("POST", "/v1/jobs", {"kind": "image_to_splat", "input": {"image": PNG},
                                             "params": {"model": "lyra2"}})
        self.assertEqual(s, 400)
        self.assertIn("TERA_ALLOW_RESEARCH", e["error"])


class TestResearchAllowed(WorkerHTTP):
    backends = ["lyra2", "mock"]
    allow_research = True

    def test_research_backend_listed_but_never_default(self):
        s, h = self.req("GET", "/v1/health")
        ly = [m for m in h["models"] if m["name"] == "lyra2"]
        self.assertTrue(ly)
        for m in ly:
            self.assertEqual(m["license"], "research-only")
            self.assertFalse(m["default"])
        s, r = self.req("POST", "/v1/jobs", {"kind": "image_to_splat", "input": {"image": PNG}})
        self.assertEqual(r["model"], "mock")


class TestUnavailableBackends(WorkerHTTP):
    backends = ["lyra1", "trellis", "kimodo", "mock"]

    def test_unavailable_backends_are_listed_and_skipped(self):
        s, h = self.req("GET", "/v1/health")
        by = {(m["name"], m["kind"]): m for m in h["models"]}
        self.assertEqual(by[("lyra1", "image_to_splat")]["license"], "NVIDIA Open Model License")
        self.assertEqual(by[("trellis", "image_to_model")]["license"], "MIT")
        self.assertEqual(by[("kimodo", "text_to_motion")]["license"], "NVIDIA Open Model License")
        for name in ("lyra1", "trellis", "kimodo"):
            m = [x for x in h["models"] if x["name"] == name][0]
            self.assertFalse(m["available"])
            self.assertTrue(m["reason"])
        self.assertTrue(by[("mock", "image_to_splat")]["default"])
        s, e = self.req("POST", "/v1/jobs", {"kind": "image_to_model", "input": {"image": PNG},
                                             "params": {"model": "trellis"}})
        self.assertEqual(s, 503)


class TestToken(WorkerHTTP):
    token = "s3cret"

    def test_token_required_except_health(self):
        self.token = ""
        self.assertEqual(self.req("GET", "/v1/health")[0], 200)
        self.assertEqual(self.req("POST", "/v1/jobs", {"kind": "text_to_motion",
                                                       "input": {"prompt": "x"}})[0], 401)
        self.token = "s3cret"
        self.assertEqual(self.req("POST", "/v1/jobs", {"kind": "text_to_motion",
                                                       "input": {"prompt": "x"}})[0], 202)


class TestRecovery(unittest.TestCase):
    def test_unfinished_jobs_fail_after_restart(self):
        with tempfile.TemporaryDirectory() as d:
            jd = Path(d) / "jobs" / "j_abc"
            (jd / "out").mkdir(parents=True)
            (jd / "job.json").write_text(json.dumps({"id": "j_abc", "status": "running", "kind": "text_to_motion",
                                                     "model": "mock", "created": time.time(), "outputs": []}))
            httpd = serve(Config(port=0, data_dir=Path(d)))
            try:
                j = httpd.worker.get("j_abc")
                self.assertEqual(j["status"], "failed")
                self.assertIn("restarted", j["error"])
            finally:
                httpd.worker.stop()
                httpd.server_close()


if __name__ == "__main__":
    unittest.main()
