const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const modes = {
  classic: {
    id: "classic",
    title: "Классика",
    size: 3,
    winLength: 3,
    markLimit: null,
    sparks: false,
    sparkCount: 0,
    pulseCost: null,
    stormEvery: 0
  },
  rift: {
    id: "rift",
    title: "Рифт",
    size: 3,
    winLength: 3,
    markLimit: 3,
    sparks: true,
    sparkCount: 2,
    pulseCost: 2,
    stormEvery: 0
  },
  supernova: {
    id: "supernova",
    title: "Сверхнова",
    size: 4,
    winLength: 4,
    markLimit: 4,
    sparks: true,
    sparkCount: 3,
    pulseCost: 3,
    stormEvery: 6
  }
};

const rooms = new Map();
const lineCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Внутренняя ошибка сервера." });
  }
});

server.listen(PORT, () => {
  console.log(`Rift XO is running at http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const body = await readBody(req);
    const clientId = normalizeClientId(body.clientId);
    const mode = modes[body.mode] ? body.mode : "rift";
    const opponent = body.opponent === "online" ? "online" : "bot";
    const room = createRoom(clientId, mode, opponent);

    sendJson(res, 201, publicState(room, clientId));
    broadcastRoom(room);
    maybeRunBot(room);
    return;
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "join") {
    const room = getRoom(parts[2]);
    if (!room) {
      sendJson(res, 404, { error: "Комната не найдена." });
      return;
    }

    const body = await readBody(req);
    const clientId = normalizeClientId(body.clientId);
    claimSeat(room, clientId);
    sendJson(res, 200, publicState(room, clientId));
    broadcastRoom(room);
    maybeRunBot(room);
    return;
  }

  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "action") {
    const room = getRoom(parts[2]);
    if (!room) {
      sendJson(res, 404, { error: "Комната не найдена." });
      return;
    }

    const body = await readBody(req);
    const clientId = normalizeClientId(body.clientId);
    const result = handleAction(room, clientId, body);
    if (!result.ok) {
      sendJson(res, result.status || 400, { error: result.error });
      return;
    }

    sendJson(res, 200, publicState(room, clientId));
    broadcastRoom(room);
    maybeRunBot(room);
    return;
  }

  if (req.method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "rooms" && parts[3] === "events") {
    const room = getRoom(parts[2]);
    if (!room) {
      sendJson(res, 404, { error: "Комната не найдена." });
      return;
    }

    const clientId = normalizeClientId(url.searchParams.get("clientId"));
    openEventStream(req, res, room, clientId);
    return;
  }

  sendJson(res, 404, { error: "Маршрут не найден." });
}

function serveStatic(req, res, url) {
  const requestedPath = decodeURIComponent(url.pathname);
  const normalizedPath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalizedPath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
        res.end(fallback);
      });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
    });
    res.end(content);
  });
}

function createRoom(clientId, mode, opponent) {
  const code = createRoomCode();
  const room = {
    code,
    host: clientId,
    opponent,
    players: {
      X: clientId,
      O: opponent === "bot" ? "BOT" : null
    },
    scores: { X: 0, O: 0, ties: 0 },
    game: createGame(mode),
    streams: new Set(),
    botTimer: null,
    createdAt: Date.now()
  };

  rooms.set(code, room);
  return room;
}

function createGame(mode) {
  const config = getMode(mode);
  const game = {
    mode: config.id,
    size: config.size,
    winLength: config.winLength,
    turn: "X",
    cells: Array.from({ length: config.size * config.size }, () => null),
    energy: { X: 0, O: 0 },
    moveId: 0,
    status: "playing",
    winner: null,
    winningLine: [],
    sparks: [],
    events: []
  };

  pushEvent(game, `${config.title}: новая партия.`);
  seedSparks(game);
  return game;
}

function getMode(mode) {
  return modes[mode] || modes.rift;
}

function createRoomCode() {
  let code = "";
  do {
    code = crypto.randomBytes(3).toString("hex").slice(0, 4).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function normalizeClientId(clientId) {
  if (typeof clientId === "string" && /^[a-f0-9-]{16,80}$/i.test(clientId)) {
    return clientId;
  }

  return crypto.randomUUID();
}

function getRoom(code) {
  return rooms.get(String(code || "").trim().toUpperCase());
}

function claimSeat(room, clientId) {
  if (room.players.X === clientId || room.players.O === clientId) {
    return;
  }

  if (!room.players.O && room.opponent === "online") {
    room.players.O = clientId;
    pushEvent(room.game, "Игрок O вошел в комнату.");
    return;
  }

  if (!room.players.X) {
    room.players.X = clientId;
  }
}

function handleAction(room, clientId, body) {
  const player = resolvePlayer(room, clientId);

  if (body.type === "reset") {
    if (player === "spectator" && room.host !== clientId) {
      return { ok: false, status: 403, error: "Наблюдатель не может перезапускать партию." };
    }

    const nextMode = modes[body.mode] ? body.mode : room.game.mode;
    room.game = createGame(nextMode);
    return { ok: true };
  }

  if (body.type === "mode") {
    if (room.host !== clientId) {
      return { ok: false, status: 403, error: "Режим меняет только создатель комнаты." };
    }

    const nextMode = modes[body.mode] ? body.mode : room.game.mode;
    room.game = createGame(nextMode);
    return { ok: true };
  }

  if (player !== "X" && player !== "O") {
    return { ok: false, status: 403, error: "Наблюдатель не может делать ходы." };
  }

  if (room.players[player] === "BOT") {
    return { ok: false, status: 403, error: "Этим знаком управляет бот." };
  }

  if (room.game.status !== "playing") {
    return { ok: false, error: "Партия уже завершена." };
  }

  if (room.game.turn !== player) {
    return { ok: false, error: "Сейчас ход другого игрока." };
  }

  if (body.type === "move") {
    return playMove(room, player, Number(body.index));
  }

  if (body.type === "pulse") {
    return usePulse(room.game, player, Number(body.index));
  }

  return { ok: false, status: 400, error: "Неизвестное действие." };
}

function resolvePlayer(room, clientId) {
  if (room.players.X === clientId) return "X";
  if (room.players.O === clientId) return "O";
  return "spectator";
}

function playMove(room, player, index) {
  const game = room.game;
  if (!Number.isInteger(index) || index < 0 || index >= game.cells.length) {
    return { ok: false, error: "Клетка вне поля." };
  }

  if (game.cells[index]) {
    return { ok: false, error: "Клетка уже занята." };
  }

  const config = getMode(game.mode);
  const grabbedSpark = game.sparks.includes(index);
  game.moveId += 1;
  game.cells[index] = {
    mark: player,
    id: game.moveId,
    charged: grabbedSpark
  };

  if (grabbedSpark) {
    game.energy[player] += 1;
    pushEvent(game, `${player} забрал энергию.`);
  }

  enforceMarkLimit(game, player);
  refillSparks(game);
  triggerStormIfNeeded(game, config);
  settleGame(room);

  if (game.status === "playing") {
    game.turn = opponentOf(player);
    pushEvent(game, `Ход ${game.turn}.`);
  }

  return { ok: true };
}

function usePulse(game, player, index) {
  const config = getMode(game.mode);
  const target = game.cells[index];
  if (!config.pulseCost) {
    return { ok: false, error: "В этом режиме импульс отключен." };
  }

  if (game.energy[player] < config.pulseCost) {
    return { ok: false, error: "Недостаточно энергии." };
  }

  if (!target || target.mark !== opponentOf(player)) {
    return { ok: false, error: "Импульс бьет только по знаку соперника." };
  }

  game.energy[player] -= config.pulseCost;
  game.cells[index] = null;
  pushEvent(game, `${player} сжег знак импульсом.`);
  refillSparks(game);
  return { ok: true };
}

function enforceMarkLimit(game, player) {
  const config = getMode(game.mode);
  if (!config.markLimit) return;

  const marks = game.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell && cell.mark === player)
    .sort((a, b) => a.cell.id - b.cell.id);

  while (marks.length > config.markLimit) {
    const oldest = marks.shift();
    game.cells[oldest.index] = null;
    pushEvent(game, `${player}: старый знак исчез.`);
  }
}

function triggerStormIfNeeded(game, config) {
  if (!config.stormEvery || game.moveId % config.stormEvery !== 0) {
    return;
  }

  const oldest = game.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => Boolean(cell))
    .sort((a, b) => a.cell.id - b.cell.id)[0];

  if (!oldest) return;

  game.cells[oldest.index] = null;
  pushEvent(game, "Сверхнова стерла самый старый знак.");
}

function settleGame(room) {
  const game = room.game;
  const result = findWinner(game.cells, game.size, game.winLength);
  if (result) {
    game.status = "won";
    game.winner = result.mark;
    game.winningLine = result.line;
    room.scores[result.mark] += 1;
    pushEvent(game, `${result.mark} собрал линию.`);
    return;
  }

  const config = getMode(game.mode);
  if (!config.markLimit && game.cells.every(Boolean)) {
    game.status = "draw";
    room.scores.ties += 1;
    pushEvent(game, "Ничья.");
  }
}

function seedSparks(game) {
  game.sparks = [];
  refillSparks(game);
}

function refillSparks(game) {
  const config = getMode(game.mode);
  if (!config.sparks) {
    game.sparks = [];
    return;
  }

  game.sparks = game.sparks.filter((index) => !game.cells[index]);
  const empties = game.cells
    .map((cell, index) => (cell ? null : index))
    .filter((index) => index !== null && !game.sparks.includes(index));

  while (game.sparks.length < config.sparkCount && empties.length > 0) {
    const randomIndex = Math.floor(Math.random() * empties.length);
    game.sparks.push(empties.splice(randomIndex, 1)[0]);
  }
}

function findWinner(cells, size, winLength) {
  const lines = getLines(size, winLength);
  for (const line of lines) {
    const first = cells[line[0]];
    if (!first) continue;

    const wins = line.every((index) => cells[index] && cells[index].mark === first.mark);
    if (wins) {
      return { mark: first.mark, line };
    }
  }

  return null;
}

function getLines(size, winLength) {
  const cacheKey = `${size}:${winLength}`;
  if (lineCache.has(cacheKey)) {
    return lineCache.get(cacheKey);
  }

  const lines = [];
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (const [dx, dy] of directions) {
        const line = [];
        for (let step = 0; step < winLength; step += 1) {
          const nx = x + dx * step;
          const ny = y + dy * step;
          if (nx < 0 || nx >= size || ny < 0 || ny >= size) {
            line.length = 0;
            break;
          }
          line.push(ny * size + nx);
        }
        if (line.length === winLength) {
          lines.push(line);
        }
      }
    }
  }

  lineCache.set(cacheKey, lines);
  return lines;
}

function opponentOf(player) {
  return player === "X" ? "O" : "X";
}

function pushEvent(game, text) {
  game.events.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text
  });
  game.events = game.events.slice(0, 8);
}

function maybeRunBot(room) {
  if (room.botTimer || room.game.status !== "playing") return;
  if (room.players[room.game.turn] !== "BOT") return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.game.status !== "playing" || room.players[room.game.turn] !== "BOT") return;

    botTurn(room);
    broadcastRoom(room);
    maybeRunBot(room);
  }, 520);
}

function botTurn(room) {
  const player = room.game.turn;
  const config = getMode(room.game.mode);

  if (config.pulseCost && room.game.energy[player] >= config.pulseCost) {
    const target = bestPulseTarget(room.game, opponentOf(player));
    if (target !== null) {
      usePulse(room.game, player, target);
    }
  }

  const move = chooseBotMove(room.game, player);
  if (move !== null) {
    playMove(room, player, move);
  }
}

function bestPulseTarget(game, opponent) {
  const threats = threatLines(game, opponent);
  if (threats.length === 0) {
    if (Math.random() > 0.25) return null;

    const marks = game.cells
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => cell && cell.mark === opponent)
      .sort((a, b) => b.cell.id - a.cell.id);
    return marks[0] ? marks[0].index : null;
  }

  const scores = new Map();
  for (const line of threats) {
    for (const index of line) {
      if (game.cells[index] && game.cells[index].mark === opponent) {
        scores.set(index, (scores.get(index) || 0) + 1);
      }
    }
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function threatLines(game, player) {
  return getLines(game.size, game.winLength).filter((line) => {
    let own = 0;
    let empty = 0;

    for (const index of line) {
      const cell = game.cells[index];
      if (cell && cell.mark === player) own += 1;
      if (!cell) empty += 1;
      if (cell && cell.mark !== player) return false;
    }

    return own === game.winLength - 1 && empty === 1;
  });
}

function chooseBotMove(game, player) {
  const empties = game.cells
    .map((cell, index) => (cell ? null : index))
    .filter((index) => index !== null);

  if (empties.length === 0) return null;

  const winningMove = empties.find((index) => wouldWinAfterMove(game, player, index));
  if (winningMove !== undefined) return winningMove;

  const blockMove = empties.find((index) => wouldWinAfterMove(game, opponentOf(player), index));
  if (blockMove !== undefined) return blockMove;

  const sparkMove = game.sparks.find((index) => empties.includes(index));
  if (sparkMove !== undefined && Math.random() < 0.75) return sparkMove;

  const centerBias = rankedBoardPositions(game.size);
  const ranked = [...empties].sort((a, b) => centerBias.indexOf(a) - centerBias.indexOf(b));
  const top = ranked.slice(0, Math.min(3, ranked.length));
  return top[Math.floor(Math.random() * top.length)];
}

function wouldWinAfterMove(game, player, index) {
  const config = getMode(game.mode);
  const cells = game.cells.map((cell) => (cell ? { ...cell } : null));
  const nextId = Math.max(0, ...cells.filter(Boolean).map((cell) => cell.id)) + 1;
  cells[index] = { mark: player, id: nextId };

  if (config.markLimit) {
    const own = cells
      .map((cell, cellIndex) => ({ cell, index: cellIndex }))
      .filter(({ cell }) => cell && cell.mark === player)
      .sort((a, b) => a.cell.id - b.cell.id);

    while (own.length > config.markLimit) {
      cells[own.shift().index] = null;
    }
  }

  const result = findWinner(cells, game.size, game.winLength);
  return Boolean(result && result.mark === player);
}

function rankedBoardPositions(size) {
  const cells = Array.from({ length: size * size }, (_, index) => {
    const x = index % size;
    const y = Math.floor(index / size);
    const center = (size - 1) / 2;
    const distance = Math.abs(x - center) + Math.abs(y - center);
    const cornerBonus = (x === 0 || x === size - 1) && (y === 0 || y === size - 1) ? -0.25 : 0;
    return { index, score: distance + cornerBonus + Math.random() * 0.05 };
  });

  return cells.sort((a, b) => a.score - b.score).map((cell) => cell.index);
}

function publicState(room, clientId) {
  return {
    clientId,
    room: {
      code: room.code,
      host: room.host,
      opponent: room.opponent,
      players: {
        X: room.players.X ? "taken" : null,
        O: room.players.O ? "taken" : null
      },
      scores: room.scores,
      you: resolvePlayer(room, clientId),
      isHost: room.host === clientId,
      mode: room.game.mode
    },
    modes: Object.fromEntries(
      Object.entries(modes).map(([key, value]) => [
        key,
        {
          id: value.id,
          title: value.title,
          size: value.size,
          winLength: value.winLength,
          markLimit: value.markLimit,
          pulseCost: value.pulseCost,
          stormEvery: value.stormEvery
        }
      ])
    ),
    game: room.game
  };
}

function broadcastRoom(room) {
  for (const stream of room.streams) {
    stream.res.write(`event: state\ndata: ${JSON.stringify(publicState(room, stream.clientId))}\n\n`);
  }
}

function openEventStream(req, res, room, clientId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const stream = {
    clientId,
    res,
    heartbeat: setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 20000)
  };

  room.streams.add(stream);
  res.write(`event: state\ndata: ${JSON.stringify(publicState(room, clientId))}\n\n`);

  req.on("close", () => {
    clearInterval(stream.heartbeat);
    room.streams.delete(stream);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
