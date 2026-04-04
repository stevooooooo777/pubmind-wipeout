/**
 * 💥 WIPEOUT — Game Server
 * 3-lives elimination quiz game
 * Plugs into the BOSHD game server ping system
 * Node.js + WebSocket (ws) + Express
 *
 * Install deps: npm install express ws node-fetch
 */

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3008;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────

const games = {}; // keyed by gameCode

function createGame(gameCode, category = "general") {
  return {
    gameCode,
    category,
    phase: "lobby",         // lobby | question | reveal | game-over
    questionNum: 0,
    maxQuestions: 15,       // game ends if nobody eliminated before this
    players: {},            // socketId → { name, lives, alive, answer, answeredAt }
    tvSocket: null,
    hostSocket: null,
    currentQuestion: null,  // { question, options, correct, funFact }
    answers: {},            // socketId → answer
    timer: null,
    questionStartTime: null,
  };
}

// ─────────────────────────────────────────
// PING ENDPOINT — BOSHD routing system
// ─────────────────────────────────────────

app.get("/ping", (req, res) => {
  res.json({ game: "wipeout", status: "ready", label: "💥 Wipeout" });
});

app.get("/api/room/:code", (req, res) => {
  const g = games[req.params.code.toUpperCase()];
  if (!g) return res.status(404).json({ found: false });
  res.json({ found: true, gameType: "wipeout", phase: g.phase, category: g.category });
});

app.get("/game/:code", (req, res) => {
  const g = games[req.params.code];
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json({ game: "wipeout", gameType: "wipeout", phase: g.phase, category: g.category });
});

// ─────────────────────────────────────────
// CLAUDE — Generate trivia question
// ─────────────────────────────────────────

async function generateQuestion(category, questionNum) {
  const difficulty =
    questionNum <= 3 ? "easy" :
    questionNum <= 7 ? "medium" :
    questionNum <= 11 ? "hard" : "very hard";

  const prompt = `You are generating a trivia question for a pub elimination game called Wipeout.
Category: ${category}
Question number: ${questionNum}
Difficulty: ${difficulty}

Rules:
- Easy: well-known facts most people would know
- Medium: requires some knowledge
- Hard: genuinely tricky, designed to eliminate players
- Very hard: specialist knowledge, designed to find a winner

Respond ONLY with valid JSON, no markdown, no preamble:
{
  "question": "...",
  "options": ["A: ...", "B: ...", "C: ...", "D: ..."],
  "correct": "A",
  "funFact": "A short fun fact about the answer (1-2 sentences, conversational and surprising)"
}

Wrong answers must be believable. No trick questions. Fun fact should be genuinely interesting.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("Claude question gen failed:", e);
    // Fallback question
    return {
      question: "What is the capital of France?",
      options: ["A: London", "B: Berlin", "C: Paris", "D: Madrid"],
      correct: "C",
      funFact: "Paris has been the capital of France since 987 AD — over 1,000 years of history.",
    };
  }
}

// ─────────────────────────────────────────
// WEBSOCKET — Real-time game engine
// ─────────────────────────────────────────

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, gameCode, payload } = msg;

    // ── CREATE (host) ─────────────────────
    if (type === "create") {
      const code = payload.code || Math.random().toString(36).slice(2, 8).toUpperCase();
      const category = payload.category || "general";
      games[code] = createGame(code, category);
      const g = games[code];

      ws.gameCode = code;
      ws.role = "host";
      g.hostSocket = ws;

      ws.send(json({ type: "created", gameCode: code, category }));
      console.log(`Game created: ${code} (${category})`);
    }

    // ── JOIN ──────────────────────────────
    if (type === "join") {
      const g = games[gameCode];
      if (!g) return ws.send(err("Game not found"));

      if (payload.role === "tv") {
        g.tvSocket = ws;
        ws.gameCode = gameCode;
        ws.role = "tv";
        ws.send(json({ type: "tv-connected", gameCode }));
        return;
      }

      if (payload.role === "host") {
        g.hostSocket = ws;
        ws.gameCode = gameCode;
        ws.role = "host";
        ws.send(json({ type: "host-reconnected", gameCode, players: g.players }));
        return;
      }

      // Player join
      if (g.phase !== "lobby") {
        return ws.send(err("Game already in progress"));
      }

      g.players[ws.id] = {
        name: payload.name,
        lives: 3,
        alive: true,
        answer: null,
        answeredAt: null,
      };

      ws.gameCode = gameCode;
      ws.role = "player";
      ws.playerName = payload.name;

      ws.send(json({ type: "joined", playerId: ws.id, name: payload.name, lives: 3 }));
      broadcastTV(g, { type: "player-joined", players: g.players });
      broadcastHost(g, { type: "player-joined", players: g.players });
      broadcastPlayers(g, { type: "player-list", players: sanitisePlayers(g.players) });

      console.log(`${payload.name} joined ${gameCode}`);
    }

    // ── START (host) ──────────────────────
    if (type === "start") {
      const g = games[gameCode];
      if (!g || g.phase !== "lobby") return;
      if (Object.keys(g.players).length < 1) return ws.send(err("Need at least 1 player"));

      console.log(`Game ${gameCode} starting`);
      await askNextQuestion(g);
    }

    // ── ANSWER (player) ───────────────────
    if (type === "answer") {
      const g = games[gameCode];
      if (!g || g.phase !== "question") return;

      const player = g.players[ws.id];
      if (!player || !player.alive) return;
      if (g.answers[ws.id]) return; // already answered

      g.answers[ws.id] = payload.answer;
      player.answeredAt = Date.now() - g.questionStartTime;

      ws.send(json({ type: "answer-received" }));

      // Broadcast answer count to TV + host
      const aliveCount = Object.values(g.players).filter(p => p.alive).length;
      const answeredCount = Object.keys(g.answers).length;
      broadcastTV(g, { type: "answer-count", answered: answeredCount, total: aliveCount });
      broadcastHost(g, { type: "answer-count", answered: answeredCount, total: aliveCount });

      // If everyone alive has answered, reveal early
      if (answeredCount >= aliveCount) {
        clearTimeout(g.timer);
        revealAnswers(g);
      }
    }

    // ── NEXT (host advances) ──────────────
    if (type === "next") {
      const g = games[gameCode];
      if (!g) return;

      // Check if game should end
      const alivePlayers = Object.values(g.players).filter(p => p.alive);
      if (alivePlayers.length <= 1 || g.questionNum >= g.maxQuestions) {
        endGame(g);
      } else {
        await askNextQuestion(g);
      }
    }

    // ── KICK (host removes player) ────────
    if (type === "kick") {
      const g = games[gameCode];
      if (!g || ws.role !== "host") return;
      const target = payload.playerId;
      if (g.players[target]) {
        delete g.players[target];
        broadcastAll(g, { type: "player-list", players: sanitisePlayers(g.players) });
      }
    }
  });

  ws.on("close", () => {
    const g = games[ws.gameCode];
    if (!g) return;

    if (ws.role === "player") {
      // Mark as disconnected but keep in game if it's in progress
      if (g.phase === "lobby") {
        delete g.players[ws.id];
        broadcastTV(g, { type: "player-list", players: sanitisePlayers(g.players) });
        broadcastHost(g, { type: "player-list", players: sanitisePlayers(g.players) });
      }
      // In-game disconnects: player just won't answer, treated as wrong
    }
  });
});

// ─────────────────────────────────────────
// GAME FLOW
// ─────────────────────────────────────────

async function askNextQuestion(g) {
  g.questionNum++;
  g.phase = "question";
  g.answers = {};

  // Reset per-round answer state
  Object.values(g.players).forEach(p => {
    p.answer = null;
    p.answeredAt = null;
  });

  // Generate question via Claude
  broadcastAll(g, { type: "question-loading", questionNum: g.questionNum });

  const q = await generateQuestion(g.category, g.questionNum);
  g.currentQuestion = q;
  g.questionStartTime = Date.now();

  const TIME_LIMIT = 20; // seconds

  broadcastAll(g, {
    type: "question",
    questionNum: g.questionNum,
    maxQuestions: g.maxQuestions,
    question: q.question,
    options: q.options,
    timeLimit: TIME_LIMIT,
    alivePlayers: Object.values(g.players).filter(p => p.alive).length,
  });

  // Auto-reveal when timer expires
  g.timer = setTimeout(() => revealAnswers(g), (TIME_LIMIT + 2) * 1000);
}

function revealAnswers(g) {
  clearTimeout(g.timer);
  if (g.phase !== "question") return;
  g.phase = "reveal";

  const q = g.currentQuestion;
  const eliminated = [];
  const lifeChanges = {}; // socketId → { name, livesLeft, lostLife }

  // Score each player
  Object.entries(g.players).forEach(([id, player]) => {
    if (!player.alive) return;

    const answer = g.answers[id];
    const correct = answer === q.correct;

    lifeChanges[id] = {
      name: player.name,
      answer: answer || null,
      correct,
      livesLeft: player.lives,
      lostLife: false,
    };

    if (!correct) {
      player.lives--;
      lifeChanges[id].livesLeft = player.lives;
      lifeChanges[id].lostLife = true;

      if (player.lives <= 0) {
        player.alive = false;
        eliminated.push({ id, name: player.name });
      }
    }
  });

  // Notify individual players of their result
  wss.clients.forEach((client) => {
    if (client.gameCode === g.gameCode && client.role === "player" && client.readyState === 1) {
      const change = lifeChanges[client.id];
      if (!change) return;

      if (!g.players[client.id]?.alive && change.lostLife) {
        // This player just got eliminated
        client.send(json({
          type: "eliminated",
          livesLeft: 0,
          correct: q.correct,
        }));
      } else if (change.lostLife) {
        client.send(json({
          type: "life-lost",
          livesLeft: change.livesLeft,
          correct: q.correct,
        }));
      } else {
        client.send(json({
          type: "correct-answer",
          livesLeft: change.livesLeft,
          correct: q.correct,
        }));
      }
    }
  });

  // Broadcast reveal to TV + host
  const revealPayload = {
    type: "reveal",
    correct: q.correct,
    funFact: q.funFact,
    lifeChanges,
    eliminated,
    players: sanitisePlayers(g.players),
    questionNum: g.questionNum,
  };

  broadcastTV(g, revealPayload);
  broadcastHost(g, revealPayload);

  // Check if game should auto-end (1 or 0 players left alive)
  const alivePlayers = Object.values(g.players).filter(p => p.alive);
  if (alivePlayers.length <= 1 || g.questionNum >= g.maxQuestions) {
    setTimeout(() => endGame(g), 5000);
  }
  // Otherwise host presses "Next Question" to continue
}

function endGame(g) {
  g.phase = "game-over";
  clearTimeout(g.timer);

  const leaderboard = Object.entries(g.players)
    .map(([id, p]) => ({ id, name: p.name, lives: p.lives, alive: p.alive }))
    .sort((a, b) => {
      // Alive players first, then by lives remaining
      if (a.alive && !b.alive) return -1;
      if (!a.alive && b.alive) return 1;
      return b.lives - a.lives;
    });

  const winner = leaderboard[0] || null;

  broadcastAll(g, {
    type: "game-over",
    winner,
    leaderboard,
  });

  console.log(`Game ${g.gameCode} ended. Winner: ${winner?.name}`);
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

// Strip server-only fields before sending to clients
function sanitisePlayers(players) {
  const out = {};
  Object.entries(players).forEach(([id, p]) => {
    out[id] = { name: p.name, lives: p.lives, alive: p.alive };
  });
  return out;
}

function broadcastAll(g, data) {
  broadcastTV(g, data);
  broadcastHost(g, data);
  broadcastPlayers(g, data);
}

function broadcastTV(g, data) {
  if (g.tvSocket?.readyState === 1) g.tvSocket.send(json(data));
}

function broadcastHost(g, data) {
  if (g.hostSocket?.readyState === 1) g.hostSocket.send(json(data));
}

function broadcastPlayers(g, data) {
  wss.clients.forEach((ws) => {
    if (ws.gameCode === g.gameCode && ws.role === "player" && ws.readyState === 1) {
      ws.send(json(data));
    }
  });
}

function json(data) { return JSON.stringify(data); }
function err(msg) { return json({ type: "error", message: msg }); }

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`💥 Wipeout server running on port ${PORT}`);
});
