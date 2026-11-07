# Fair Play Chess — Multiplayer Server v0.1

This is the **first backend prototype**, not yet connected to the Netlify chessboard.

## What it does

- Create an eight-character private game code (`game:create`)
- Join that game from a second browser (`game:join`)
- Verify moves using Chess.js on the server (`game:move`)
- Keep server-authoritative countdown clocks with optional increment
- Broadcast game state and game-over results using Socket.IO
- Capture a basic per-move record in memory (move, FEN, timestamp, clock values)
- Respond to `/health` with server status

## Local use

Node.js 20+ required.

```bash
npm install
npm start
```

## Deploy on Railway

Connect this GitHub repository as a Node.js service. Railway detects `package.json` and runs `npm start` (set start command manually if necessary). Generate a public HTTPS domain under **Networking**. Add an environment variable:

`ALLOWED_ORIGINS=https://zippy-gaufre-f12e24.netlify.app`

The port is read from Railway's `PORT` environment variable.

## Socket events

Client sends with acknowledgements:

- `game:create` payload `{ "minutes": 10, "increment": 0 }`
- `game:join` payload `{ "code": "AB12CD34" }`
- `game:move` payload `{ "code": "AB12CD34", "from": "e2", "to": "e4" }`
- `game:resign` payload `{ "code": "AB12CD34" }`

Server emits `game:state` and `game:notice`.

**Important:** This is for development and two-device testing only. Rooms and move logs are in memory; server restart loses them. It does not provide player login, reconnect/resume, fraud detection, a persistent database, or any cash features. Do not use it for competitions involving prizes or wagers.
