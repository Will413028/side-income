# The stealth service's contract with a stub render, a stub fetcher and stub child processes: no browser
# and no Scrapling (the real ones run in CI's image job and on the VM).
#   python3 -m unittest discover -s stealth
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

import server
from server import LayoutMissing, RenderFailed, RenderTimeout

OK = {"url": "https://example.com/contests", "timeoutMs": 1000}


class Served:
    """The service on a free local port with the given render."""

    def __init__(self, render):
        self.httpd = server.create_server(render, host="127.0.0.1", port=0)
        self.base = "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_):
        self.httpd.shutdown()
        self.httpd.server_close()

    def post(self, body, path="/render"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        return self.open(urllib.request.Request(self.base + path, data=data, method="POST"))

    def get(self, path):
        return self.open(urllib.request.Request(self.base + path))

    @staticmethod
    def open(request):
        try:
            with urllib.request.urlopen(request, timeout=10) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.headers, e.read()


def raising(error):
    def render(_request):
        raise error

    return render


class Contract(unittest.TestCase):
    def test_a_rendered_page_comes_back_with_its_upstream_status(self):
        with Served(lambda _r: (200, "<p>contests</p>".encode())) as s:
            status, headers, body = s.post(OK)
        self.assertEqual((status, headers["x-upstream-status"], body), (200, "200", b"<p>contests</p>"))

    def test_an_upstream_403_is_the_upstream_status_not_a_service_error(self):
        with Served(lambda _r: (403, b"")) as s:
            status, headers, _ = s.post(OK)
        self.assertEqual((status, headers["x-upstream-status"]), (200, "403"))

    def test_a_selector_that_never_appears_is_422_named_LayoutMissing(self):
        with Served(raising(LayoutMissing())) as s:
            status, headers, _ = s.post({**OK, "waitFor": ".never"})
        self.assertEqual((status, headers["x-error"]), (422, "LayoutMissing"))

    def test_a_render_past_its_deadline_is_504(self):
        with Served(raising(RenderTimeout())) as s:
            status, headers, _ = s.post(OK)
        self.assertEqual((status, headers["x-error"]), (504, "RenderTimeout"))

    def test_a_browser_failure_is_502_with_its_name(self):
        with Served(raising(RenderFailed("Target Closed: <b>"))) as s:
            status, headers, _ = s.post(OK)
        self.assertEqual((status, headers["x-error"]), (502, "TargetClosedb"))
        with Served(raising(ValueError("x"))) as s:
            status, headers, _ = s.post(OK)
        self.assertEqual((status, headers["x-error"]), (502, "ValueError"))

    def test_bad_requests_are_refused_before_any_render(self):
        calls = []
        bad = [b"nope", b"[]", {"url": "file:///etc/passwd", "timeoutMs": 1}, {"url": "https://a.b", "timeoutMs": 0},
               {"url": "https://a.b", "timeoutMs": 999999}, {"url": "https://a.b", "timeoutMs": True},
               {"url": "https://a.b", "timeoutMs": 1.5}, {"url": "https://", "timeoutMs": 1}, {**OK, "waitFor": " "}, {**OK, "waitFor": 3}]
        with Served(lambda r: calls.append(r) or (200, b"")) as s:
            for body in bad:
                self.assertEqual(s.post(body)[0], 400, body)
            self.assertEqual(s.post(b"x" * (server.MAX_BODY + 1))[0], 413)
            self.assertEqual(s.post(OK, "/other")[0], 404)
            self.assertEqual(s.get("/other")[0], 404)
        self.assertEqual(calls, [])

    def test_request_headers_and_other_fields_are_not_taken(self):
        request, error = server.parse_render_request(json.dumps({**OK, "headers": {"User-Agent": "x"}, "proxy": "http://p"}))
        self.assertEqual((request, error), ({"url": OK["url"], "timeoutMs": 1000, "waitFor": None}, None))

    def test_each_render_gets_its_deadline_from_arrival(self):
        got = []
        before = time.time() * 1000
        with Served(lambda r: got.append(r) or (200, b"")) as s:
            s.post({**OK, "timeoutMs": 5000})
        self.assertTrue(before + 5000 <= got[0]["deadline"] <= time.time() * 1000 + 5000)

    def test_renders_run_one_at_a_time_and_a_request_whose_deadline_passed_in_the_queue_is_504_without_a_render(self):
        seen, running, peak = [], [0], [0]

        def render(request):
            running[0] += 1
            peak[0] = max(peak[0], running[0])
            seen.append(request["url"].rsplit("/", 1)[1])
            time.sleep(1)
            running[0] -= 1
            return 200, b""

        results = {}
        with Served(render) as s:
            def call(name, timeout_ms):
                results[name] = s.post({"url": "https://example.com/" + name, "timeoutMs": timeout_ms})[0]

            threads = [threading.Thread(target=call, args=("slow", 5000))]
            threads[0].start()
            while not seen:  # "slow" holds the turn before the others arrive
                time.sleep(0.01)
            threads += [threading.Thread(target=call, args=("late", 50)), threading.Thread(target=call, args=("next", 5000))]
            for t in threads[1:]:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual((results, sorted(seen), peak[0]), ({"slow": 200, "late": 504, "next": 200}, ["next", "slow"], 1))

    def test_healthz_answers_ok(self):
        with Served(lambda _r: (200, b"")) as s:
            self.assertEqual(s.get("/healthz")[::2], (200, b"ok"))


class FakeResponse:
    def __init__(self, status, navigation=True, frame="main"):
        self.status, self.frame, self._navigation = status, frame, navigation
        self.request = self

    def is_navigation_request(self):
        return self._navigation


class TimeoutError_(Exception):
    pass


TimeoutError_.__name__ = "TimeoutError"  # Playwright's, by name (the service never imports Playwright)


class FakePage:
    main_frame = "main"

    def __init__(self, wait_error=None):
        self.listeners, self.waits, self.idle, self.wait_error = [], [], [], wait_error
        self.first = self

    def wait_for_load_state(self, state, timeout):
        self.idle.append((state, timeout))
        raise TimeoutError_("still busy")

    def on(self, event, fn):
        self.listeners.append((event, fn))

    def locator(self, selector):
        self.waits.append([selector])
        return self

    def wait_for(self, **kwargs):
        self.waits[-1].append(kwargs)
        if self.wait_error:
            raise self.wait_error


class FakeFetcher:
    """Stands in for StealthyFetcher: records the call and plays the given responses through the hooks."""

    def __init__(self, responses, page=None, body=b"<html></html>"):
        self.responses, self.page, self.body, self.calls = responses, page or FakePage(), body, []

    def fetch(self, url, **kwargs):
        self.calls.append((url, kwargs))
        kwargs["page_setup"](self.page)
        for r in self.responses:
            for event, fn in self.page.listeners:
                if event == "response":
                    fn(r)
        try:
            kwargs["page_action"](self.page)
        except Exception:
            pass  # Scrapling logs and swallows a page_action error
        return type("Response", (), {"status": self.responses[-1].status, "body": self.body})()


def later(ms=30_000):
    return time.time() * 1000 + ms


class FetchPage(unittest.TestCase):
    def test_the_fetcher_gets_one_fixed_argument_set_with_challenge_solving_off(self):
        fetcher = FakeFetcher([FakeResponse(200)])
        server.fetch_page(fetcher, "https://example.com/c", None, later())
        (url, kwargs), = fetcher.calls
        self.assertEqual(url, "https://example.com/c")
        self.assertIs(kwargs["solve_cloudflare"], False)
        # Exactly these: no proxy (no IP rotation), no cookies or user data (no login), no headers.
        self.assertEqual(sorted(kwargs), ["google_search", "headless", "network_idle", "page_action", "page_setup", "retries", "solve_cloudflare", "timeout"])
        # One attempt: a failed render is not read again behind the source's request cap. No Google
        # referer, and the idle wait is the service's own (bounded), not Scrapling's.
        self.assertEqual([kwargs[k] for k in ("headless", "network_idle", "retries", "google_search")], [True, False, 1, False])
        self.assertTrue(0 < kwargs["timeout"] <= 30_000 - server.MARGIN_MS)

    def test_the_status_is_the_first_navigation_response_of_the_main_frame(self):
        page = [FakeResponse(200, navigation=False), FakeResponse(200, frame="ad"), FakeResponse(200), FakeResponse(503)]
        self.assertEqual(server.fetch_page(FakeFetcher(page, body=b"<p>x</p>"), "https://e.com", None, later()), (200, b"<p>x</p>"))

    def test_a_redirect_is_reported_as_its_own_status_with_no_body(self):
        fetcher = FakeFetcher([FakeResponse(301), FakeResponse(200)])
        self.assertEqual(server.fetch_page(fetcher, "https://e.com", ".list", later()), (301, b""))
        self.assertEqual(fetcher.page.waits, [])

    def test_the_selector_is_waited_for_visible_within_the_time_left(self):
        fetcher = FakeFetcher([FakeResponse(200)])
        server.fetch_page(fetcher, "https://e.com", ".list", later(10_000))
        (selector, kwargs), = fetcher.page.waits
        self.assertEqual((selector, kwargs["state"]), (".list", "visible"))
        self.assertTrue(0 < kwargs["timeout"] <= 10_000 - server.MARGIN_MS)

    def test_a_page_that_never_goes_quiet_is_still_read_after_a_bounded_wait(self):
        fetcher = FakeFetcher([FakeResponse(200)], body=b"<p>busy</p>")
        self.assertEqual(server.fetch_page(fetcher, "https://e.com", ".list", later(60_000)), (200, b"<p>busy</p>"))
        (state, timeout), = fetcher.page.idle
        self.assertEqual((state, timeout), ("networkidle", server.IDLE_MS))
        self.assertEqual(len(fetcher.page.waits), 1)
        short = FakeFetcher([FakeResponse(200)])
        server.fetch_page(short, "https://e.com", None, later(5_000))
        self.assertTrue(0 < short.page.idle[0][1] <= (5_000 - server.MARGIN_MS) // 2)

    def test_no_time_left_for_the_selector_is_a_timeout_not_a_layout_change(self):
        fetcher = FakeFetcher([FakeResponse(200)], FakePage(TimeoutError_("x")))
        with self.assertRaises(RenderTimeout):
            server.fetch_page(fetcher, "https://e.com", ".list", later(server.MARGIN_MS + server.MIN_WAIT_MS - 200))
        self.assertEqual(fetcher.page.waits, [])

    def test_a_selector_that_times_out_is_LayoutMissing_though_the_fetcher_swallows_it(self):
        fetcher = FakeFetcher([FakeResponse(200)], FakePage(TimeoutError_("x")))
        with self.assertRaises(LayoutMissing):
            server.fetch_page(fetcher, "https://e.com", ".never", later())

    def test_another_error_while_waiting_fails_the_render(self):
        fetcher = FakeFetcher([FakeResponse(200)], FakePage(ValueError("bad selector")))
        with self.assertRaises(RenderFailed) as raised:
            server.fetch_page(fetcher, "https://e.com", "!!", later())
        self.assertEqual(raised.exception.name, "ValueError")

    def test_no_navigation_response_seen_falls_back_to_the_fetchers_status(self):
        self.assertEqual(server.fetch_page(FakeFetcher([FakeResponse(404, navigation=False)]), "https://e.com", None, later())[0], 404)


def child(code):
    return [sys.executable, "-c", code]


class Child(unittest.TestCase):
    REQUEST = {"url": "https://e.com", "waitFor": None, "id": "t"}

    def test_the_childs_result_is_a_json_line_then_the_page(self):
        echo = "import sys,json; r=json.load(sys.stdin); sys.stdout.write(json.dumps({'status': 200}) + '\\n<p>' + r['url'] + '</p>')"
        self.assertEqual(server.render_in_child({**self.REQUEST, "deadline": later()}, child(echo)), (200, b"<p>https://e.com</p>"))

    def test_the_childs_errors_come_back_by_name(self):
        say = lambda head: child("print(%r)" % json.dumps(head))
        for name, error in [("LayoutMissing", LayoutMissing), ("TimeoutError", RenderTimeout), ("RenderTimeout", RenderTimeout)]:
            with self.assertRaises(error):
                server.render_in_child({**self.REQUEST, "deadline": later()}, say({"error": name}))
        with self.assertRaises(RenderFailed) as raised:
            server.render_in_child({**self.REQUEST, "deadline": later()}, say({"error": "TargetClosedError"}))
        self.assertEqual(raised.exception.name, "TargetClosedError")

    def test_a_child_that_dies_without_a_result_fails_the_render(self):
        for code in ["import sys; sys.exit(3)", "print('not json')", "print('{}')"]:
            with self.assertRaises(RenderFailed):
                server.render_in_child({**self.REQUEST, "deadline": later()}, child(code))

    def test_at_the_deadline_the_child_and_what_it_started_are_killed(self):
        # The child starts a grandchild in a session of its own (as the driver starts Chromium) and both
        # outlive the deadline.
        code = ("import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'], start_new_session=True);"
                "sys.stderr.write(str(p.pid)+'\\n'); sys.stderr.flush(); time.sleep(60)")
        read, write = os.pipe()
        started = time.time()
        with self.assertRaises(RenderTimeout):
            server.render_in_child({**self.REQUEST, "deadline": later(3000)}, child(code), stderr=write)
        os.close(write)
        self.assertLess(time.time() - started, 10)
        pid = os.read(read, 32).decode().strip()
        os.close(read)
        self.assertTrue(pid.isdigit(), "the child never started its grandchild before the deadline")
        grandchild = int(pid)
        for _ in range(50):
            try:
                os.kill(grandchild, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        os.kill(grandchild, 9)
        self.fail("the grandchild survived the deadline")


if __name__ == "__main__":
    unittest.main()
