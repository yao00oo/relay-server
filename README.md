# OpenClaw Relay

A minimal relay system that lets two OpenClaw instances communicate via a central relay server.

## Structure

```
openclaw-relay/
├── relay-server/   Express + TypeScript relay server (in-memory)
├── relay-skill/    TypeScript client module for OpenClaw agents
└── demo/           End-to-end demo of two agents talking to each other
```

## Message format

```ts
{
  from: string
  to: string
  payload: {
    taskType: "schedule_check" | "schedule_reply" | string
    content: string
  }
  ts: number   // Unix ms, set by relay server
}
```

## Relay Server API

| Method | Path           | Description                                      |
|--------|----------------|--------------------------------------------------|
| POST   | `/send`        | Send a message: `{ from, to, payload }`          |
| GET    | `/poll/:userId`| Return and clear all pending messages for a user |
| GET    | `/health`      | Returns `{ ok: true }`                           |

## Running the relay server standalone

```bash
# Build
npm run build

# Start (default port 3000)
npm run start:server

# Custom port
PORT=4000 node relay-server/dist/index.js
```

## relay-skill usage

```ts
import { sendMessage, pollMessages, startPolling } from 'relay-skill';

// Config via env vars (or pass serverUrl as last arg)
// RELAY_SERVER_URL=http://localhost:3000
// MY_USER_ID=user-a

await sendMessage('user-b', 'schedule_check', 'Are you free Friday?', 'user-a');

const msgs = await pollMessages('user-b');

const timer = startPolling('user-a', (msg) => {
  console.log('Incoming:', msg);
}, 5000);
// clearInterval(timer) to stop
```

## Running the demo

```bash
npm run demo
```

The demo:
1. Starts the relay server on port 3099
2. `user-a` sends a `schedule_check` to `user-b`
3. `user-b` polls, receives it, auto-replies with a `schedule_reply`
4. `user-a` polls and receives the reply

Expected output:
```
[user-a → relay]  taskType=schedule_check  "Are you free this Friday?"
[relay → user-b]  Polling messages for user-b...
[user-b received]  from=user-a  taskType=schedule_check  "Are you free this Friday?"
[user-b → relay]  taskType=schedule_reply  "Yes I'm free Friday afternoon"
[relay → user-a]  Polling messages for user-a...
[user-a received]  from=user-b  taskType=schedule_reply  "Yes I'm free Friday afternoon"
```
