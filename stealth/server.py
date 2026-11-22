# Tier 4 (`stealth`) of the tiered reading (opportunity types plan step 6c-2, D15): Scrapling's
# StealthyFetcher, for a source whose catalog entry says `maxTier: "stealth"` because the `browser` tier
# is answered with a check page. Same contract as browser/server.mjs, so the daily run's fetcher talks to
# both the same way; reachable only on its own compose network (no published port), started with the
# daily run and removed after it (deploy/compose.yaml, systemd unit).
#
#   POST /render  {"url": "https://…", "timeoutMs": 25000, "waitFor": "selector"}
#     200 with `x-upstream-status: <status of the page's first response>` and the HTML as the body;
#         a redirect is reported as its own 3xx status (redirects are never followed as a success)
#     400 bad request, 422 the waitFor selector never became visible (`x-error: LayoutMissing`), 502 the
#     browser failed (`x-error: <error name>`), 504 the page did not settle before the deadline
#     (timeoutMs from the request's arrival)
#   GET /healthz  200 "ok"
#
# No login, no CAPTCHA solving, no IP rotation (AGENTS.md): fetch_page() is the only call into Scrapling
# and passes one fixed argument set with challenge solving off, no proxy, no cookies and no stored
# profile; test_server.py pins the set. A page that answers with a check is returned as it is, and the
# source's connector fails on it.
#
# One page at a time, each in its own child process with its own browser: StealthyFetcher's call blocks
# with only per-operation timeouts, so the deadline over the whole render is kept by killing the child
# and everything started under it, the browser included (CI's image job checks that none is left after
# a render that ran out of time). Nothing carries over between renders. Only the standard library is
# imported here; Scrapling is imported in the child, so the tests need neither it nor a browser.
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("PORT", "3100"))
MAX_TIMEOUT_MS = 120_000
MAX_BODY = 64 * 1024
# Navigation and the waitFor wait end this long before the deadline, so their own timeouts (a missing
# selector: 422) are seen before the deadline kills the child (504), as in browser/render.mjs.
MARGIN_MS = 1_500
# The longest wait for the page's network to go quiet; a page that keeps polling is read after it.
IDLE_MS = 5_000
# A selector wait shorter than this proves nothing about the layout: the render ran out of time instead.
MIN_WAIT_MS = 1_000


class RenderTimeout(Exception):
    """The render did not finish before its deadline."""


class LayoutMissing(Exception):
    """The page loaded but the waitFor selector never became visible: its layout changed, retrying will not help."""


class RenderFailed(Exception):
    """The browser failed; `name` is the error's class name, the only detail that leaves the service."""

    def __init__(self, name):
        super().__init__(name)
        self.name = name


def now_ms():
    return time.time() * 1000


def parse_render_request(text):
    """Validates a /render body; returns (request, None) or (None, why it is refused)."""
    try:
        body = json.loads(text)
    except ValueError:
        return None, "body is not JSON"
    if not isinstance(body, dict):
        return None, "body is not an object"
    url, timeout_ms, wait_for = body.get("url"), body.get("timeoutMs"), body.get("waitFor")
    try:
        parts = urlsplit(url) if isinstance(url, str) else None
    except ValueError:
        parts = None
    if parts is None or parts.scheme not in ("http", "https") or not parts.hostname:
        return None, "url must be http(s)"
    if type(timeout_ms) is not int or not 0 < timeout_ms <= MAX_TIMEOUT_MS:
        return None, "timeoutMs must be 1..%d" % MAX_TIMEOUT_MS
    if wait_for is not None and (not isinstance(wait_for, str) or not wait_for.strip()):
        return None, "waitFor must be a selector"
    return {"url": url, "timeoutMs": timeout_ms, "waitFor": wait_for}, None


def fetch_page(fetcher, url, wait_for, deadline):
    """
    The one call into Scrapling: renders `url` and returns (status of the first response, HTML as bytes).
    A first response other than 200 returns with an empty body. `fetcher` is StealthyFetcher (a stub in
    the tests); `deadline` is in epoch milliseconds.
    """
    first, failure = [], []

    def left():
        return int(deadline - now_ms() - MARGIN_MS)

    def budget():
        return max(1, left())

    def page_setup(page):
        # The first hop: a redirect answers with its 3xx, the page with its own status.
        def on_response(response):
            if not first and response.request.is_navigation_request() and response.frame == page.main_frame:
                first.append(response.status)

        page.on("response", on_response)

    def page_action(page):
        # Both waits are made here and not by Scrapling (network_idle, wait_selector): it gives the idle
        # wait the whole timeout, so a page that keeps polling would use up the render, and it logs a
        # selector that never appears and returns the page anyway. An error raised here is swallowed the
        # same way, so it is recorded for the check below.
        if first and first[0] != 200:
            return
        try:
            page.wait_for_load_state("networkidle", timeout=max(1, min(IDLE_MS, left() // 2)))
        except Exception:  # noqa: BLE001
            pass  # still busy: read what is there
        if wait_for is None:
            return
        if left() < MIN_WAIT_MS:
            failure.append("RenderTimeout")
            return
        try:
            page.locator(wait_for).first.wait_for(state="visible", timeout=left())
        except Exception as e:  # noqa: BLE001
            failure.append(type(e).__name__)

    response = fetcher.fetch(
        url,
        headless=True,
        network_idle=False,
        timeout=budget(),
        solve_cloudflare=False,
        google_search=False,  # Scrapling's default sends a Google referer: no visit is claimed that did not happen
        retries=1,  # one attempt (Scrapling's default is 3): the daily run decides what is read again, within the source's request cap
        page_setup=page_setup,
        page_action=page_action,
    )
    status = first[0] if first else response.status
    if status != 200:
        return status, b""
    if failure:
        if failure[0] == "TimeoutError":
            raise LayoutMissing()
        if failure[0] == "RenderTimeout":
            raise RenderTimeout()
        raise RenderFailed(failure[0])
    body = response.body
    return status, body if isinstance(body, bytes) else str(body).encode()


def child_main():
    """One render: the request as JSON on stdin; a JSON line ({"status"} or {"error"}) then the HTML on stdout."""
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)  # whatever the library prints goes to the log, never into the result
    request = json.loads(sys.stdin.read())
    html = b""
    try:
        from scrapling.fetchers import StealthyFetcher

        status, html = fetch_page(StealthyFetcher, request["url"], request["waitFor"], request["deadline"])
        head = {"status": status}
    except BaseException as e:  # noqa: BLE001
        head = {"error": e.name if isinstance(e, RenderFailed) else type(e).__name__}
        html = b""
    out.write(json.dumps(head).encode() + b"\n" + html)
    out.flush()


CHILD = [sys.executable, os.path.abspath(__file__), "--render"]


def descendants(pid):
    """Every process started under `pid`, in whatever session or process group it now runs."""
    parent_of = {}
    if os.path.isdir("/proc/self"):
        for entry in os.listdir("/proc"):
            if entry.isdigit():
                try:
                    with open("/proc/%s/stat" % entry) as f:
                        # "pid (name) state ppid ...": the name may hold spaces and brackets.
                        parent_of[int(entry)] = int(f.read().rsplit(")", 1)[1].split()[1])
                except (OSError, ValueError, IndexError):
                    pass
    else:  # the development machine (macOS has no /proc)
        table = subprocess.run(["ps", "-Ao", "pid=,ppid="], stdout=subprocess.PIPE, check=False).stdout.decode()
        for line in table.splitlines():
            fields = line.split()
            if len(fields) == 2 and fields[0].isdigit() and fields[1].isdigit():
                parent_of[int(fields[0])] = int(fields[1])
    found, frontier = [], [pid]
    while frontier:
        frontier = [child for child, parent in parent_of.items() if parent in frontier and child not in found]
        found += frontier
    return found


def render_in_child(request, command=CHILD, stderr=None):
    """Runs one render in a child process and kills its whole process group at the deadline or when it is done."""
    payload = json.dumps({"url": request["url"], "waitFor": request["waitFor"], "deadline": request["deadline"]}).encode()
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
    try:
        out, _ = child.communicate(payload, timeout=max(0.001, (request["deadline"] - now_ms()) / 1000))
    except subprocess.TimeoutExpired:
        raise RenderTimeout() from None
    finally:
        # Whatever the child started goes with it, so the next render never runs beside a leftover
        # browser: the driver starts the browser in a session of its own, out of reach of the group kill.
        for pid in descendants(child.pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        child.kill()
        child.communicate()
    line, _, html = out.partition(b"\n")
    try:
        head = json.loads(line)
    except ValueError:
        head = None
    if not isinstance(head, dict):
        raise RenderFailed("NoResult")
    if type(head.get("status")) is int:
        return head["status"], html
    name = head.get("error")
    if name == "LayoutMissing":
        raise LayoutMissing()
    if isinstance(name, str) and "Timeout" in name:
        raise RenderTimeout()
    raise RenderFailed(name if isinstance(name, str) and name else "NoResult")


STATUS_OF = {RenderTimeout: 504, LayoutMissing: 422}


def create_server(render=render_in_child, host="0.0.0.0", port=PORT):
    turn = threading.Lock()

    def one(request):
        """Renders one after another; a request still waiting at its deadline is not rendered."""
        if not turn.acquire(timeout=max(0, (request["deadline"] - now_ms()) / 1000)):
            raise RenderTimeout()
        try:
            return render(request)
        finally:
            turn.release()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def answer(self, status, headers=None, body=b""):
            self.send_response(status)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(body)))
            self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def do_GET(self):
            if self.path == "/healthz":
                return self.answer(200, {"content-type": "text/plain"}, b"ok")
            self.answer(404)

        def do_POST(self):
            if self.path != "/render":
                return self.answer(404)
            arrived = now_ms()
            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                return self.answer(400, {"content-type": "text/plain"}, b"content-length is not a number")
            if length > MAX_BODY:
                return self.answer(413)
            request, error = parse_render_request(self.rfile.read(length).decode("utf-8", "replace") if length > 0 else "")
            if error:
                return self.answer(400, {"content-type": "text/plain"}, error.encode())
            request = {**request, "id": str(uuid.uuid4()), "deadline": arrived + request["timeoutMs"]}
            try:
                status, html = one(request)
            except Exception as e:  # noqa: BLE001
                name = re.sub(r"[^\w.-]", "", e.name if isinstance(e, RenderFailed) else type(e).__name__) or "Error"
                # Only the error name and host are logged: never page content (AGENTS.md).
                print("render %s %s: %s" % (request["id"], urlsplit(request["url"]).hostname, name), file=sys.stderr, flush=True)
                return self.answer(STATUS_OF.get(type(e), 502), {"x-error": name})
            self.answer(200, {"content-type": "text/html; charset=utf-8", "x-upstream-status": str(status)}, html)

    class Server(ThreadingHTTPServer):
        daemon_threads = True

    return Server((host, port), Handler)


if __name__ == "__main__":
    if sys.argv[1:] == ["--render"]:
        child_main()
    else:
        httpd = create_server()
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        print("stealth tier listening on %d" % PORT, flush=True)
        httpd.serve_forever()
