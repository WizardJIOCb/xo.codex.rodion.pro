const storageKey = "rift-xo-client-id";

const state = {
  clientId: localStorage.getItem(storageKey) || crypto.randomUUID(),
  roomCode: null,
  selectedMode: "rift",
  selectedPower: null,
  source: null,
  data: null,
  renderSignature: null,
  animatedMarks: new Set(),
  busy: false,
  toastTimer: null
};

localStorage.setItem(storageKey, state.clientId);

const dom = {
  board: document.querySelector("#board"),
  roomLine: document.querySelector("#roomLine"),
  roomCode: document.querySelector("#roomCode"),
  turnCore: document.querySelector("#turnCore"),
  turnLabel: document.querySelector("#turnLabel"),
  stateLabel: document.querySelector("#stateLabel"),
  scoreX: document.querySelector("#scoreX"),
  scoreO: document.querySelector("#scoreO"),
  tieScore: document.querySelector("#tieScore"),
  energyX: document.querySelector("#energyX"),
  energyO: document.querySelector("#energyO"),
  pulseButton: document.querySelector("#pulseButton"),
  pulseCost: document.querySelector("#pulseCost"),
  resetButton: document.querySelector("#resetButton"),
  shareButton: document.querySelector("#shareButton"),
  modeButtons: document.querySelector("#modeButtons"),
  botRoomButton: document.querySelector("#botRoomButton"),
  onlineRoomButton: document.querySelector("#onlineRoomButton"),
  joinForm: document.querySelector("#joinForm"),
  joinInput: document.querySelector("#joinInput"),
  youLabel: document.querySelector("#youLabel"),
  gridLabel: document.querySelector("#gridLabel"),
  lineLabel: document.querySelector("#lineLabel"),
  eventFeed: document.querySelector("#eventFeed"),
  toast: document.querySelector("#toast"),
  canvas: document.querySelector("#fieldCanvas")
};

init();

function init() {
  setupCanvas();
  bindEvents();

  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room) {
    joinRoom(room);
  } else {
    createRoom("bot");
  }
}

function bindEvents() {
  dom.board.addEventListener("click", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell || !state.data) return;

    const index = Number(cell.dataset.index);
    if (state.selectedPower === "pulse") {
      sendAction({ type: "pulse", index });
      return;
    }

    sendAction({ type: "move", index });
  });

  dom.pulseButton.addEventListener("click", () => {
    if (!state.data) return;
    if (dom.pulseButton.disabled) return;

    state.selectedPower = state.selectedPower === "pulse" ? null : "pulse";
    render();
  });

  dom.resetButton.addEventListener("click", () => {
    sendAction({ type: "reset", mode: state.selectedMode });
  });

  dom.shareButton.addEventListener("click", async () => {
    if (!state.roomCode) return;

    const url = roomUrl(state.roomCode);
    try {
      await navigator.clipboard.writeText(url);
      showToast("Ссылка скопирована.");
    } catch {
      showToast(url);
    }
  });

  dom.modeButtons.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;

    state.selectedMode = button.dataset.mode;
    sendAction({ type: "mode", mode: state.selectedMode });
  });

  dom.botRoomButton.addEventListener("click", () => createRoom("bot"));
  dom.onlineRoomButton.addEventListener("click", () => createRoom("online"));

  dom.joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = dom.joinInput.value.trim();
    if (code) joinRoom(code);
  });
}

async function createRoom(opponent) {
  const response = await request("/api/rooms", {
    method: "POST",
    body: {
      clientId: state.clientId,
      mode: state.selectedMode,
      opponent
    }
  });

  if (!response) return;
  acceptState(response);
  updateUrl(response.room.code);
  connectEvents(response.room.code);
}

async function joinRoom(code) {
  const normalized = code.trim().toUpperCase();
  const response = await request(`/api/rooms/${encodeURIComponent(normalized)}/join`, {
    method: "POST",
    body: { clientId: state.clientId }
  });

  if (!response) return;
  acceptState(response);
  updateUrl(response.room.code);
  connectEvents(response.room.code);
}

async function sendAction(action) {
  if (!state.roomCode || state.busy) return;
  state.busy = true;

  const response = await request(`/api/rooms/${encodeURIComponent(state.roomCode)}/action`, {
    method: "POST",
    body: {
      clientId: state.clientId,
      ...action
    }
  });

  state.busy = false;
  if (response) {
    acceptState(response);
  }
}

async function request(url, options = {}) {
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const payload = await response.json();
    if (!response.ok) {
      showToast(payload.error || "Запрос не выполнен.");
      return null;
    }

    return payload;
  } catch {
    showToast("Сервер недоступен.");
    return null;
  }
}

function connectEvents(code) {
  if (state.source) {
    state.source.close();
  }

  state.source = new EventSource(`/api/rooms/${encodeURIComponent(code)}/events?clientId=${encodeURIComponent(state.clientId)}`);
  state.source.addEventListener("state", (event) => {
    acceptState(JSON.parse(event.data));
  });
  state.source.onerror = () => {
    dom.roomLine.textContent = "Переподключение";
  };
}

function acceptState(payload) {
  const previous = state.data;
  const incomingSignature = stateSignature(payload);
  if (state.renderSignature === incomingSignature) {
    return;
  }

  const resetAnimations = shouldResetMarkAnimations(previous, payload);

  state.data = payload;
  state.renderSignature = incomingSignature;
  state.clientId = payload.clientId || state.clientId;
  localStorage.setItem(storageKey, state.clientId);
  state.roomCode = payload.room.code;
  state.selectedMode = payload.room.mode;

  if (resetAnimations) {
    state.animatedMarks = new Set();
  }

  if (!previous || resetAnimations) {
    seedExistingMarks(payload);
  }

  if (state.selectedPower === "pulse" && !canUsePulse(payload)) {
    state.selectedPower = null;
  }

  render();
}

function render() {
  if (!state.data) return;

  const { room, game, modes } = state.data;
  const mode = modes[game.mode];
  const you = room.you === "spectator" ? "Наблюдатель" : room.you;
  const turnText = game.status === "playing" ? `Ход ${game.turn}` : game.status === "won" ? `Победил ${game.winner}` : "Ничья";
  const seatText = room.opponent === "bot" ? "бот" : room.players.O ? "онлайн" : "ожидание";

  dom.roomLine.textContent = `Комната ${room.code} · ${seatText}`;
  dom.roomCode.textContent = room.code;
  dom.turnLabel.textContent = turnText;
  dom.stateLabel.textContent = mode.title;
  dom.scoreX.textContent = room.scores.X;
  dom.scoreO.textContent = room.scores.O;
  dom.tieScore.textContent = room.scores.ties;
  dom.youLabel.textContent = you;
  dom.gridLabel.textContent = `${game.size}×${game.size}`;
  dom.lineLabel.textContent = game.winLength;
  dom.energyX.value = game.energy.X;
  dom.energyO.value = game.energy.O;
  dom.energyX.max = Math.max(5, mode.pulseCost || 0, game.energy.X);
  dom.energyO.max = Math.max(5, mode.pulseCost || 0, game.energy.O);
  dom.pulseCost.textContent = mode.pulseCost || "—";
  dom.turnCore.dataset.turn = game.turn.toLowerCase();

  renderModes(room, game.mode);
  renderBoard(room, game, mode);
  renderEvents(game.events);
  renderPulse(room, game, mode);
}

function renderModes(room, activeMode) {
  for (const button of dom.modeButtons.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.mode === activeMode);
    button.disabled = !room.isHost;
  }
}

function renderBoard(room, game, mode) {
  const oldestByMark = new Map();
  if (mode.markLimit) {
    for (const mark of ["X", "O"]) {
      const oldest = game.cells
        .map((cell, index) => ({ cell, index }))
        .filter(({ cell }) => cell && cell.mark === mark)
        .sort((a, b) => a.cell.id - b.cell.id)[0];
      if (oldest) oldestByMark.set(mark, oldest.index);
    }
  }

  dom.board.style.setProperty("--size", game.size);
  dom.board.classList.toggle("size-4", game.size === 4);
  dom.board.innerHTML = "";

  game.cells.forEach((cell, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell";
    button.dataset.index = index;
    const isSpark = game.sparks.includes(index);
    const isWinner = game.winningLine.includes(index);
    const targetable = state.selectedPower === "pulse" && cell && cell.mark !== room.you;
    const actionable = canAct(room, game) && (state.selectedPower === "pulse" ? targetable : !cell);
    button.disabled = !actionable;

    button.classList.toggle("empty", !cell);
    button.classList.toggle("spark", isSpark);
    button.classList.toggle("winner", isWinner);
    button.classList.toggle("targetable", targetable);
    button.classList.toggle("oldest", Boolean(cell && oldestByMark.get(cell.mark) === index));

    if (cell) {
      const mark = document.createElement("span");
      const markKey = markAnimationKey(room, game, cell);
      const isFresh = !state.animatedMarks.has(markKey);
      mark.className = `mark mark-${cell.mark.toLowerCase()}${isFresh ? " fresh" : ""}`;
      mark.textContent = cell.mark;
      button.append(mark);
      button.ariaLabel = `${cell.mark}, клетка ${index + 1}`;
      state.animatedMarks.add(markKey);
    } else {
      button.ariaLabel = `Пустая клетка ${index + 1}`;
    }

    dom.board.append(button);
  });
}

function shouldResetMarkAnimations(previous, payload) {
  if (!previous) return true;
  if (previous.room.code !== payload.room.code) return true;
  if (previous.game.mode !== payload.game.mode) return true;
  if (previous.game.size !== payload.game.size) return true;
  return payload.game.moveId < previous.game.moveId;
}

function seedExistingMarks(payload) {
  for (const cell of payload.game.cells) {
    if (cell) {
      state.animatedMarks.add(markAnimationKey(payload.room, payload.game, cell));
    }
  }
}

function markAnimationKey(room, game, cell) {
  return `${room.code}:${game.mode}:${game.size}:${cell.id}:${cell.mark}`;
}

function stateSignature(payload) {
  const { room, game } = payload;
  return JSON.stringify({
    room: {
      code: room.code,
      opponent: room.opponent,
      players: room.players,
      scores: room.scores,
      you: room.you,
      isHost: room.isHost,
      mode: room.mode
    },
    game: {
      mode: game.mode,
      size: game.size,
      winLength: game.winLength,
      turn: game.turn,
      moveId: game.moveId,
      status: game.status,
      winner: game.winner,
      winningLine: game.winningLine,
      sparks: game.sparks,
      energy: game.energy,
      cells: game.cells.map((cell) => (cell ? `${cell.mark}:${cell.id}:${cell.charged ? 1 : 0}` : "")),
      events: game.events.map((event) => event.id)
    }
  });
}

function renderEvents(events) {
  dom.eventFeed.innerHTML = "";
  for (const event of events) {
    const item = document.createElement("li");
    item.textContent = event.text;
    dom.eventFeed.append(item);
  }
}

function renderPulse(room, game, mode) {
  const enabled = canUsePulse(state.data);
  dom.pulseButton.hidden = !mode.pulseCost;
  dom.pulseButton.disabled = !enabled;
  dom.pulseButton.classList.toggle("active", state.selectedPower === "pulse");
  dom.pulseButton.setAttribute("aria-pressed", state.selectedPower === "pulse" ? "true" : "false");
}

function canAct(room, game) {
  return game.status === "playing" && (room.you === "X" || room.you === "O") && room.you === game.turn;
}

function canUsePulse(payload) {
  const { room, game, modes } = payload;
  const mode = modes[game.mode];
  if (!mode.pulseCost) return false;
  if (!canAct(room, game)) return false;
  return game.energy[room.you] >= mode.pulseCost;
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => dom.toast.classList.remove("visible"), 2600);
}

function updateUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  window.history.replaceState({}, "", url);
}

function roomUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  return url.toString();
}

function setupCanvas() {
  const canvas = dom.canvas;
  const context = canvas.getContext("2d");
  const particles = [];
  const pointer = { x: 0, y: 0, active: false };

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * ratio);
    canvas.height = Math.floor(window.innerHeight * ratio);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    particles.length = 0;
    const count = window.innerWidth < 720 ? 34 : 58;
    for (let i = 0; i < count; i += 1) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.42,
        vy: (Math.random() - 0.5) * 0.42,
        tone: i % 3
      });
    }
  }

  function draw() {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    context.fillStyle = "rgba(8, 9, 8, 0.2)";
    context.fillRect(0, 0, window.innerWidth, window.innerHeight);

    for (const particle of particles) {
      particle.x += particle.vx;
      particle.y += particle.vy;

      if (particle.x < -20) particle.x = window.innerWidth + 20;
      if (particle.x > window.innerWidth + 20) particle.x = -20;
      if (particle.y < -20) particle.y = window.innerHeight + 20;
      if (particle.y > window.innerHeight + 20) particle.y = -20;
    }

    for (let i = 0; i < particles.length; i += 1) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j += 1) {
        const b = particles[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > 126) continue;

        context.strokeStyle = `rgba(240, 188, 66, ${0.12 * (1 - distance / 126)})`;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }

      if (pointer.active) {
        const distance = Math.hypot(a.x - pointer.x, a.y - pointer.y);
        if (distance < 160) {
          context.strokeStyle = `rgba(33, 208, 178, ${0.18 * (1 - distance / 160)})`;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(pointer.x, pointer.y);
          context.stroke();
        }
      }

      context.fillStyle = a.tone === 0 ? "rgba(33, 208, 178, 0.72)" : a.tone === 1 ? "rgba(255, 90, 95, 0.62)" : "rgba(240, 188, 66, 0.62)";
      context.beginPath();
      context.arc(a.x, a.y, 1.7, 0, Math.PI * 2);
      context.fill();
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
  });
  window.addEventListener("pointerleave", () => {
    pointer.active = false;
  });

  resize();
  draw();
}
