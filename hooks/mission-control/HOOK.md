---
name: mission-control
description: "Sync agent lifecycle events to Mission Control dashboard"
homepage: https://github.com/manish-raana/openclaw-mission-control
metadata:
  {
    "openclaw":
      {
        "emoji": "chart",
        "events": ["gateway:startup", "agent:bootstrap", "command:new"],
        "install": [{ "id": "user", "kind": "user", "label": "User-installed hook" }],
      },
  }
---

# Mission Control Integration

Stores agent lifecycle events in a local SQLite database for real-time task tracking.

## How It Works

1. On `gateway:startup`, registers a persistent listener via `onAgentEvent()`
2. The listener watches for lifecycle events (`stream: "lifecycle"`)
3. On `phase: "start"` or `phase: "end"`, writes logs to SQLite

## Configuration

Add to `/root/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "mission-control": {
          "enabled": true,
          "env": {
            "MISSION_CONTROL_DB_PATH": "/root/.openclaw/mission-control/events.db"
          }
        }
      }
    }
  }
}
```

Alternatively, use:
```json
"SQLITE_DB_PATH": "/root/.openclaw/mission-control/events.db"
```

You can also set `MISSION_CONTROL_DB_PATH` or `SQLITE_DB_PATH` as environment variables (hook config takes priority).

## What It Does

- On agent start: Creates task in Mission Control (status: in_progress)
- On agent end: Marks task as done
- On agent error: Marks task for review

## Disabling

```bash
openclaw hooks disable mission-control
```

