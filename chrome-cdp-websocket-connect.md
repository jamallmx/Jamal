# Chrome 150+ (2025–2026) DevTools / CDP WebSocket Connection Guide

Symptom: Chrome launched with `--remote-debugging-port=0` and a temp
`--user-data-dir`. The `DevToolsActivePort` file is written and contains a
valid dynamic port, but the WebSocket connection to
`ws://127.0.0.1:<port>/devtools/browser/<id>` (or page endpoints) fails even
after multiple retries.

================================================================================
TL;DR FIX
================================================================================
Add `--remote-allow-origins=*`, connect via literal `127.0.0.1` (never
`localhost`), and use `Storage.getCookies` on the browser socket (or
`Network.getAllCookies` after `Network.enable` on a page socket).
That combination resolves the "port file exists, WebSocket refused after N
retries" pattern in the overwhelming majority of cases.

================================================================================
1. YES — `--remote-allow-origins` IS REQUIRED (since Chrome 111)
================================================================================
This is the change that bites almost everyone, and it produces exactly your
symptom.

As a fix for a DevTools CSRF/SSRF class of attack, Chrome began REJECTING the
WebSocket upgrade with HTTP 403 whenever the client sends an `Origin` header
that is not explicitly allow-listed.

- The HTTP endpoints (`/json`, `/json/list`, `/json/version`) still work fine
  — which is why everything LOOKS healthy up to the WebSocket step.
- The WebSocket UPGRADE is what gets blocked. Many WS client libraries send an
  `Origin` header by default, so the 403 hits right at `connect`.

FIX — launch with:
    --remote-allow-origins=*
or, tighter, the specific origin your client sends, e.g.:
    --remote-allow-origins=http://127.0.0.1:<port>

The URL structure and handshake themselves did NOT change — it is still a
normal RFC6455 upgrade to the `webSocketDebuggerUrl`. No new auth token or new
handshake was added.

Two secondary gotchas that also cause a refused/failed connect even with
origins allowed:

- BIND ADDRESS. The port file shows a port, but newer Chrome binds DevTools to
  `127.0.0.1` (not `0.0.0.0`). If you connect via `localhost` and it resolves
  to IPv6 `::1`, you get connection-refused. Use literal `127.0.0.1`.

- HOST HEADER VALIDATION. Connect by IP, not by a hostname, or Chrome may
  reject the request as a DNS-rebinding risk.

================================================================================
2. headless=new TARGET BEHAVIOR + CORRECT SEQUENCE
================================================================================
`--headless=new` (now effectively the default `--headless`) DOES create an
initial page target automatically — typically `about:blank`. You do NOT need
to pre-navigate to get a target; `/json/list` will show it. (The old legacy
`--headless` was the mode that sometimes came up with no page target.)

Reliable connect sequence:

1. Read the SECOND line of `DevToolsActivePort` — it is the browser WS path
   (`/devtools/browser/<id>`), so you do not have to query for it.
   Line 1 is the port.

2. Or hit `GET http://127.0.0.1:<port>/json/version` → use its
   `webSocketDebuggerUrl` for a BROWSER-level connection.

3. For a page target, `GET http://127.0.0.1:<port>/json/list` (equivalently
   `/json`) → pick an entry of `"type":"page"` → use its
   `webSocketDebuggerUrl`.

4. Open the WebSocket to that URL (with `--remote-allow-origins` satisfied) and
   send CDP commands as JSON:
       {"id":N,"method":"...","params":{...}}

================================================================================
3. COOKIE EXTRACTION — WHICH ENDPOINT + WHICH METHOD
================================================================================
Two clean options:

A) BROWSER-LEVEL connection (simplest for all cookies):
   Connect to the BROWSER `webSocketDebuggerUrl` and call `Storage.getCookies`
   (with empty params) — returns all cookies across contexts. This is the
   modern, recommended path and needs no page target at all.

B) PAGE-LEVEL connection:
   Connect to a PAGE `webSocketDebuggerUrl`, send `Network.enable`, then
   `Network.getAllCookies`.

IMPORTANT MISMATCH: `Network.getAllCookies` is targeted at a session/page. If
you send it over a BROWSER-level socket you may get "method not found" or empty
results. That mismatch (right method, wrong target type) is a common reason
people think the connection "failed."
   - Browser socket  → use `Storage.getCookies`
   - Page socket     → use `Network.getAllCookies`

Example over a page socket:
    {"id":1,"method":"Network.enable"}
    {"id":2,"method":"Network.getAllCookies"}

================================================================================
4. DevToolsActivePort QUIRKS (Chrome 140–156)
================================================================================
The file semantics are unchanged and reliable:
    line 1 = port
    line 2 = browser WS path

The failures people attribute to the port file are almost always downstream:

- TIMING. With `--remote-debugging-port=0` the file is written slightly after
  launch. Poll for the file AND for a successful `/json/version` before
  attempting the WS — do not assume readiness the instant the file appears.

- PROFILE REUSE. If another Chrome instance is already using that
  `--user-data-dir`, the new process can silently hand off to the existing one
  and your port file / expectations desync. Use a unique temp profile per
  launch.

- CRASH ON LAUNCH. If Chrome exits right after writing the file (missing
  `--no-sandbox` in a container, missing deps), the port file lingers but
  nothing is listening → connection-refused. Verify the process is still alive.

================================================================================
RECOMMENDED LAUNCH FLAGS (containers / CI)
================================================================================
    --headless=new
    --remote-debugging-port=0
    --remote-allow-origins=*
    --user-data-dir=<unique temp dir>
    --no-sandbox            (containers without a sandbox)
    --disable-dev-shm-usage (avoid /dev/shm exhaustion)
