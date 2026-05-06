from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
import json
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent
EXPORTS = ROOT / "exports"
EXPORTS.mkdir(exist_ok=True)


def safe_filename(name: str) -> str:
    name = unquote(name or "export.bin")
    name = Path(name).name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "-", name).strip(" .-")
    return name or "export.bin"


class ChromaHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/convert-preview":
            self.handle_convert_preview(parsed)
            return

        if parsed.path != "/save":
            self.send_error(404)
            return

        filename = safe_filename(parse_qs(parsed.query).get("filename", ["export.bin"])[0])
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)

        if not body:
            self.send_error(400, "No file data received")
            return

        target = EXPORTS / filename
        stem = target.stem
        suffix = target.suffix
        counter = 1
        while target.exists():
            target = EXPORTS / f"{stem}-{counter}{suffix}"
            counter += 1

        target.write_bytes(body)
        response = {
            "ok": True,
            "filename": target.name,
            "size": target.stat().st_size,
            "path": str(target),
            "url": f"/exports/{target.name}",
        }
        data = json.dumps(response).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_convert_preview(self, parsed):
        filename = safe_filename(parse_qs(parsed.query).get("filename", ["preview.mp4"])[0])
        if not filename.lower().endswith(".mp4"):
            filename = f"{Path(filename).stem}.mp4"

        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.send_error(500, "FFmpeg is not installed")
            return

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if not body:
            self.send_error(400, "No video data received")
            return

        target = EXPORTS / filename
        stem = target.stem
        suffix = target.suffix
        counter = 1
        while target.exists():
            target = EXPORTS / f"{stem}-{counter}{suffix}"
            counter += 1

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            input_path = temp_path / "preview.webm"
            input_path.write_bytes(body)

            command = [
                ffmpeg,
                "-y",
                "-i",
                str(input_path),
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(target),
            ]
            result = subprocess.run(command, capture_output=True, text=True)

        if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
            self.send_error(500, result.stderr[-1000:] or "FFmpeg conversion failed")
            return

        response = {
            "ok": True,
            "filename": target.name,
            "size": target.stat().st_size,
            "path": str(target),
            "url": f"/exports/{target.name}",
        }
        data = json.dumps(response).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 5176), ChromaHandler)
    print("Serving Chroma Subtitle Studio at http://127.0.0.1:5176/")
    server.serve_forever()
