# LoopOps Server Handoff 2026-06-27 15:26 HKT

Status: `ready-for-manual-review`

## Scope

This handoff records the current Web review server state without opening a browser, launching the native app, using AppleScript, using Accessibility, or using screen recording.

## Verified URLs

| URL | Result | Notes |
| --- | --- | --- |
| `http://127.0.0.1:5188/` | `HTTP/1.1 200 OK` | Stable manual review URL. |
| `http://127.0.0.1:5189/` | stopped | Temporary Vite fallback from the tracked Codex exec session was closed. |

## Permission Model

```text
browser_opened=false
native_app_opened=false
system_automation=false
apple_script=false
accessibility=false
screen_recording=false
tracked_exec_session_running=false
```

## Review Entry

- Web review URL: `http://127.0.0.1:5188/`
- Human review gallery: `human-review-gallery.html`
- Native visual gallery: `native-visual-audit/loopops-native-visual-2026-06-27-144538/README.md`
- Pending manual review record: `review-records/loopops-review-2026-06-27-145550.md`

## Verification Commands

```bash
curl -I --max-time 2 http://127.0.0.1:5188/
curl -I --max-time 2 http://127.0.0.1:5189/
```

The `5188` probe returned `HTTP/1.1 200 OK`. The `5189` probe returned a connection failure after the duplicate fallback session was stopped. The sandboxed `curl` path can report false connection failures, so this handoff used the same local execution context that started the server for the final probe.
