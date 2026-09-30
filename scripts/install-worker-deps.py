"""Rate-limit pip's initial downloads without host privileges or tc.

The trusted package index is fetched through an HTTP forward proxy bound only
to this container's loopback. TLS CONNECT relays ciphertext unchanged.
"""
import http.server
import select
import socket
import subprocess
import sys
import threading
import time

lock = threading.Lock()
budget_at = 0.0
speed = max(12500, int(sys.argv[2]) * 125)

def pace(size):
    global budget_at
    with lock:
        budget_at = max(time.monotonic(), budget_at) + size / speed
        wait = budget_at - time.monotonic()
    if wait > 0:
        time.sleep(wait)

class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_CONNECT(self):
        host, port = self.path.rsplit(':', 1)
        # Only pip's selected public indexes/files are reachable through here.
        if host not in ('pypi.org', 'files.pythonhosted.org') or port != '443':
            self.send_error(403)
            return
        with socket.create_connection((host, 443), timeout=30) as upstream:
            self.send_response(200)
            self.end_headers()
            while True:
                ready, _, _ = select.select([upstream, self.connection], [], [], 60)
                if not ready:
                    return
                for source in ready:
                    data = source.recv(16384)
                    if not data:
                        return
                    if source is upstream:
                        pace(len(data))
                    (self.connection if source is upstream else upstream).sendall(data)

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    result = subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
        '--proxy', f'http://127.0.0.1:{server.server_port}', '--index-url', 'https://pypi.org/simple',
        '--no-cache-dir', '-r', sys.argv[1]], check=False)
finally:
    server.shutdown()
sys.exit(result.returncode)
