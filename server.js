import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Server } from 'socket.io';
import { Chess } from 'chess.js';

const app = express();
const http = createServer(app);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const io = new Server(http, {
  cors: { origin: allowedOrigins.length ? allowedOrigins : false, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 20_000
});
const rooms = new Map();
const LIMIT_ROOMS = 100; // Prototype resource protection; not a production scaling plan.
const MAX_MINUTES = 60;
const MAX_INCREMENT = 30;
const TICK_MS = 250;

app.get('/', (_req, res) => res.json({ name: 'Fair Play Chess Server', status: 'online', version: '0.1.0' }));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function token() { return randomBytes(12).toString('hex'); }
function roomCode() {
  let code;
  do { code = randomBytes(4).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function state(room) {
  return {
    code: room.code,
    fen: room.chess.fen(),
    pgn: room.chess.pgn(),
    turn: room.chess.turn(),
    history: room.chess.history({ verbose: true }).map(m => ({ from: m.from, to: m.to, san: m.san, promotion: m.promotion || null })),
    clocks: { ...room.clocks },
    players: { w: Boolean(room.players.w), b: Boolean(room.players.b) },
    status: room.status,
    result: room.result,
    lastMoveAt: room.lastMoveAt,
    serverTime: Date.now()
  };
}
function emit(room) { io.to(room.code).emit('game:state', state(room)); }
function settleClock(room, now = Date.now()) {
  if (room.status !== 'playing' || room.lastMoveAt === null) return;
  const side = room.chess.turn();
  const elapsed = Math.max(0, now - room.lastMoveAt);
  room.clocks[side] = Math.max(0, room.clocks[side] - elapsed);
  room.lastMoveAt = now;
  if (room.clocks[side] <= 0) {
    room.status = 'finished';
    room.result = { reason: 'timeout', winner: side === 'w' ? 'b' : 'w' };
    emit(room);
  }
}
function fail(ack, message) { if (typeof ack === 'function') ack({ ok: false, error: message }); }
function success(ack, data = {}) { if (typeof ack === 'function') ack({ ok: true, ...data }); }
function checkMembership(socket, code) {
  const room = rooms.get(code);
  if (!room || socket.data.roomCode !== code || !socket.data.color || room.players[socket.data.color] !== socket.id) return null;
  return room;
}

io.on('connection', socket => {
  socket.on('game:create', (options = {}, ack) => {
    if (socket.data.roomCode) return fail(ack, 'Leave your existing game first.');
    if (rooms.size >= LIMIT_ROOMS) return fail(ack, 'Server is at its test capacity.');
    const minutes = Number(options.minutes ?? 10);
    const increment = Number(options.increment ?? 0);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES || !Number.isInteger(increment) || increment < 0 || increment > MAX_INCREMENT) {
      return fail(ack, 'Use 1–60 minutes and 0–30 seconds increment.');
    }
    const code = roomCode();
    const room = {
      code, chess: new Chess(), players: { w: socket.id, b: null },
      clocks: { w: minutes * 60_000, b: minutes * 60_000 }, incrementMs: increment * 1000,
      status: 'waiting', result: null, lastMoveAt: null,
      createdAt: Date.now(), moves: []
    };
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.color = 'w';
    socket.join(code);
    success(ack, { code, color: 'w', state: state(room) });
    emit(room);
  });

  socket.on('game:join', ({ code } = {}, ack) => {
    if (socket.data.roomCode) return fail(ack, 'Leave your existing game first.');
    if (typeof code !== 'string') return fail(ack, 'Enter the game code.');
    code = code.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return fail(ack, 'Game not found.');
    if (room.players.b) return fail(ack, 'That game is full.');
    if (room.status !== 'waiting') return fail(ack, 'That game has already started.');
    room.players.b = socket.id;
    room.status = 'playing';
    room.lastMoveAt = Date.now();
    socket.data.roomCode = code;
    socket.data.color = 'b';
    socket.join(code);
    success(ack, { code, color: 'b', state: state(room) });
    emit(room);
  });

  socket.on('game:move', ({ code, from, to, promotion } = {}, ack) => {
    const room = typeof code === 'string' ? checkMembership(socket, code.trim().toUpperCase()) : null;
    if (!room) return fail(ack, 'Not a player in this game.');
    settleClock(room);
    if (room.status !== 'playing') return fail(ack, 'Game is not in progress.');
    if (room.chess.turn() !== socket.data.color) return fail(ack, 'Not your turn.');
    if (typeof from !== 'string' || typeof to !== 'string' || !/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return fail(ack, 'Invalid square.');
    if (promotion !== undefined && !['q', 'r', 'b', 'n'].includes(promotion)) return fail(ack, 'Invalid promotion.');
    let move;
    try { move = room.chess.move({ from, to, promotion: promotion || 'q' }); }
    catch { return fail(ack, 'Illegal move.'); }
    const now = Date.now();
    room.clocks[socket.data.color] += room.incrementMs;
    room.lastMoveAt = now;
    room.moves.push({ ply: room.moves.length + 1, from: move.from, to: move.to, san: move.san, fen: room.chess.fen(), serverTimestamp: now, whiteMs: Math.round(room.clocks.w), blackMs: Math.round(room.clocks.b) });
    if (room.chess.isGameOver()) {
      room.status = 'finished';
      room.result = room.chess.isCheckmate()
        ? { reason: 'checkmate', winner: socket.data.color }
        : { reason: 'draw', winner: null };
    }
    success(ack, { move: move.san });
    emit(room);
  });

  socket.on('game:resign', ({ code } = {}, ack) => {
    const room = typeof code === 'string' ? checkMembership(socket, code.trim().toUpperCase()) : null;
    if (!room) return fail(ack, 'Not a player in this game.');
    if (room.status !== 'playing') return fail(ack, 'Game is not in progress.');
    room.status = 'finished';
    room.result = { reason: 'resignation', winner: socket.data.color === 'w' ? 'b' : 'w' };
    success(ack);
    emit(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.status === 'waiting') { rooms.delete(code); return; }
    // A disconnect does not stop the clock or automatically award a win.
    // A production implementation needs authenticated reconnection and durable game state.
    io.to(code).emit('game:notice', 'An opponent disconnected; the clock keeps running.');
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.status === 'playing') {
      settleClock(room, now);
      if (room.status === 'playing') emit(room);
    }
    if ((room.status === 'finished' && now - (room.lastMoveAt ?? room.createdAt) > 60 * 60_000) ||
        (room.status === 'waiting' && now - room.createdAt > 30 * 60_000)) rooms.delete(code);
  }
}, TICK_MS).unref();

const port = Number(process.env.PORT || 3000);
http.listen(port, '0.0.0.0', () => console.log(`Fair Play Chess Server listening on ${port}`));
