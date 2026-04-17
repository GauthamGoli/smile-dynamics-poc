#!/usr/bin/env python3
"""Serve the POC directory with SQLite session storage."""
import base64
import json
import math
import os
import re
import shutil
import sqlite3
from http.server import SimpleHTTPRequestHandler, HTTPServer

PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(ROOT, "results")
DATA_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "smile.db")

SAFE_NAME = re.compile(r"^[A-Za-z0-9._\-]+$")
SAFE_PERSON = re.compile(r"^(Sameen|GG)$")
SAFE_SESSION = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$")
VALID_ENCODINGS = ("utf8", "base64")


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        person        TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        trials        INTEGER NOT NULL,
        trials_passed INTEGER NOT NULL,
        vectors_json  TEXT NOT NULL,
        quality_json  TEXT NOT NULL,
        baseline_json TEXT,
        notes         TEXT
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_person ON sessions(person)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at)")
    conn.commit()
    conn.close()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def median(values):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def mad_sigma(values):
    if len(values) < 2:
        return None
    med = median(values)
    deviations = sorted(abs(v - med) for v in values)
    mad = median(deviations)
    return mad * 1.4826


def flatten_paths(obj, prefix="", out=None):
    if out is None:
        out = {}
    if obj is None:
        return out
    if isinstance(obj, (int, float)):
        if math.isfinite(obj):
            out[prefix] = obj
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            flatten_paths(v, f"{prefix}.{k}" if prefix else k, out)
    return out


def compute_baseline(person):
    conn = get_db()
    rows = conn.execute(
        "SELECT vectors_json FROM sessions WHERE person = ? ORDER BY created_at",
        (person,)
    ).fetchall()
    conn.close()

    if not rows:
        return {"baseline": {}, "sessionCount": 0}

    all_flat = [flatten_paths(json.loads(r["vectors_json"])) for r in rows]
    all_keys = set()
    for f in all_flat:
        all_keys.update(f.keys())

    baseline = {}
    for k in sorted(all_keys):
        values = [f[k] for f in all_flat if k in f and math.isfinite(f[k])]
        if len(values) < 2:
            baseline[k] = {"median": median(values) if values else None, "sigma": None, "n": len(values)}
        else:
            baseline[k] = {"median": median(values), "sigma": mad_sigma(values), "n": len(values)}

    return {"baseline": baseline, "sessionCount": len(rows)}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw)

    def _json_response(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_file(self, dir_path, name, content, encoding):
        os.makedirs(dir_path, exist_ok=True)
        full = os.path.join(dir_path, name)
        if encoding == "base64":
            data = base64.b64decode(content, validate=True)
            with open(full, "wb") as f:
                f.write(data)
            return len(data)
        else:
            with open(full, "w", encoding="utf-8") as f:
                f.write(content)
            return len(content.encode("utf-8"))

    def do_GET(self):
        if self.path.startswith("/sessions"):
            self._handle_get_sessions()
        elif self.path.startswith("/baseline"):
            self._handle_get_baseline()
        else:
            super().do_GET()

    def _handle_get_sessions(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        person = qs.get("person", [None])[0]
        if not person or not SAFE_PERSON.match(person):
            self.send_error(400, "missing or invalid person param")
            return
        conn = get_db()
        rows = conn.execute(
            "SELECT id, person, created_at, trials, trials_passed, vectors_json, quality_json, baseline_json FROM sessions WHERE person = ? ORDER BY created_at DESC",
            (person,)
        ).fetchall()
        conn.close()
        sessions = []
        for r in rows:
            sessions.append({
                "id": r["id"],
                "person": r["person"],
                "created_at": r["created_at"],
                "trials": r["trials"],
                "trials_passed": r["trials_passed"],
                "vectors": json.loads(r["vectors_json"]),
                "quality": json.loads(r["quality_json"]),
                "baseline": json.loads(r["baseline_json"]) if r["baseline_json"] else None,
            })
        self._json_response({"sessions": sessions})

    def _handle_get_baseline(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        person = qs.get("person", [None])[0]
        if not person or not SAFE_PERSON.match(person):
            self.send_error(400, "missing or invalid person param")
            return
        self._json_response(compute_baseline(person))

    def do_DELETE(self):
        if self.path.startswith("/session/"):
            self._handle_delete_session()
        else:
            self.send_error(404, "unknown endpoint")

    def _handle_delete_session(self):
        from urllib.parse import urlparse, parse_qs
        raw_path = self.path.split("?")[0]
        parts = raw_path.strip("/").split("/")
        session_id = parts[1] if len(parts) >= 2 else ""
        qs = parse_qs(urlparse(self.path).query)
        person = qs.get("person", [None])[0]

        if not session_id or not SAFE_SESSION.match(session_id):
            self.send_error(400, "invalid sessionId")
            return
        if not person or not SAFE_PERSON.match(person):
            self.send_error(400, "invalid person")
            return

        conn = get_db()
        cur = conn.execute("DELETE FROM sessions WHERE id = ? AND person = ?", (session_id, person))
        conn.commit()
        conn.close()

        if cur.rowcount == 0:
            self.send_error(404, "session not found")
            return

        dir_path = os.path.join(RESULTS_DIR, person, session_id)
        if os.path.isdir(dir_path):
            shutil.rmtree(dir_path)

        print(f"deleted {person}/{session_id}")
        self._json_response({"ok": True, "deleted": session_id})

    def do_POST(self):
        if self.path == "/save":
            self._handle_save()
        elif self.path == "/session":
            self._handle_post_session()
        else:
            self.send_error(404, "unknown endpoint")

    def _handle_save(self):
        try:
            payload = self._read_json_body()
            name = str(payload["filename"])
            body = str(payload["content"])
            person = str(payload["person"])
            session = str(payload["sessionId"])
            encoding = str(payload.get("encoding", "utf8"))
        except Exception as e:
            self.send_error(400, f"bad payload: {e}")
            return
        if not SAFE_NAME.match(name):
            self.send_error(400, "illegal filename")
            return
        if not SAFE_PERSON.match(person):
            self.send_error(400, "illegal person")
            return
        if not SAFE_SESSION.match(session):
            self.send_error(400, "illegal sessionId")
            return
        if encoding not in VALID_ENCODINGS:
            self.send_error(400, "illegal encoding")
            return
        try:
            dir_path = os.path.join(RESULTS_DIR, person, session)
            written = self._write_file(dir_path, name, body, encoding)
        except Exception as e:
            self.send_error(500, f"write failed: {e}")
            return
        rel = os.path.relpath(os.path.join(dir_path, name), ROOT)
        print(f"saved {rel} ({written} bytes, {encoding})")
        self._json_response({"ok": True, "path": rel})

    def _handle_post_session(self):
        try:
            p = self._read_json_body()
            session_id = str(p["sessionId"])
            person = str(p["person"])
            trials = int(p["trials"])
            trials_passed = int(p["trialsPassed"])
            vectors = p["vectors"]
            quality = p["quality"]
            baseline_snapshot = p.get("baseline")
            images = p.get("images", [])
        except Exception as e:
            self.send_error(400, f"bad payload: {e}")
            return
        if not SAFE_PERSON.match(person):
            self.send_error(400, "illegal person")
            return
        if not SAFE_SESSION.match(session_id):
            self.send_error(400, "illegal sessionId")
            return

        dir_path = os.path.join(RESULTS_DIR, person, session_id)
        for img in images:
            name = str(img.get("filename", ""))
            if not SAFE_NAME.match(name):
                continue
            enc = str(img.get("encoding", "utf8"))
            if enc not in VALID_ENCODINGS:
                continue
            try:
                self._write_file(dir_path, name, str(img["content"]), enc)
            except Exception:
                pass

        created_at = session_id.replace("_", "T").replace("-", ":", 2)
        created_at = created_at[:19] + "." + created_at[20:23] + "Z" if len(created_at) > 20 else created_at

        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, person, created_at, trials, trials_passed, vectors_json, quality_json, baseline_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, person, created_at, trials, trials_passed,
             json.dumps(vectors), json.dumps(quality),
             json.dumps(baseline_snapshot) if baseline_snapshot else None)
        )
        conn.commit()
        conn.close()

        print(f"session {person}/{session_id} ({trials_passed}/{trials} trials, {len(images)} images)")
        self._json_response({"ok": True, "id": session_id})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    init_db()
    print(f"serve.py on http://localhost:{PORT}/  db={DB_PATH}  results={RESULTS_DIR}")
    HTTPServer(("", PORT), Handler).serve_forever()
