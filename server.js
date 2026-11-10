const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const RADIUS = 16;
const COLORS = ["#ffe066", "#8ce99a", "#74c0fc", "#ffa8a8", "#da77f2", "#ff922b", "#63e6be", "#e599f7"];
const SHAPES = ["circle", "square", "triangle"];
const TRAILS = ["none", "dots", "line"];
const ARENAS = {
  small: { w: 640, h: 480, label: "Small 640x480" },
  classic: { w: 800, h: 600, label: "Classic 800x600" },
  large: { w: 960, h: 720, label: "Large 960x720" },
};
const DEFAULT_SETTINGS = {
  maxPlayers: 6,
  tagsToWin: 10,
  cooldownMs: 1000,
  speed: 260,
  arena: "classic",
  allowBots: true,
  dashCdMs: 3000,
  gameMode: "classic",
};

// code -> { code, leaderId, state, settings, players: Map<id,player>, sockets: Map<id,ws>, tagCooldownUntil, winnerId }
const lobbies = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let tries = 0; tries < 50; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    if (!lobbies.has(c)) return c;
  }
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function cleanName(n, isBot) {
  let s = String(n || "Player").slice(0, 16).trim() || "Player";
  if (!isBot && BOT_NAME_RE.test(s)) s = "Player";
  return s;
}

function cleanLook(look, takenColors) {
  const l = look || {};
  let color = String(l.color || "").toLowerCase();
  if (!COLORS.includes(color)) {
    color = COLORS.find((c) => !takenColors.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
  } else if (takenColors.has(color)) {
    color = COLORS.find((c) => !takenColors.has(c)) || color;
  }
  let shape = String(l.shape || "circle").toLowerCase();
  if (!SHAPES.includes(shape)) shape = "circle";
  let trail = String(l.trail || "none").toLowerCase();
  if (!TRAILS.includes(trail)) trail = "none";
  return { color, shape, trail };
}

function cleanSettings(s) {
  const v = Object.assign({}, DEFAULT_SETTINGS, s || {});
  v.maxPlayers = Math.max(2, Math.min(8, parseInt(v.maxPlayers, 10) || 6));
  const ttw = parseInt(v.tagsToWin, 10);
  v.tagsToWin = ttw === 0 ? 0 : [3, 5, 10, 20].includes(ttw) ? ttw : 10;
  v.cooldownMs = [500, 1000, 2000].includes(parseInt(v.cooldownMs, 10)) ? parseInt(v.cooldownMs, 10) : 1000;
  v.speed = [200, 260, 320].includes(parseInt(v.speed, 10)) ? parseInt(v.speed, 10) : 260;
  if (!ARENAS[v.arena]) v.arena = "classic";
  v.allowBots = v.allowBots !== false;
  const dcd = parseInt(v.dashCdMs, 10);
  v.dashCdMs = dcd === 0 ? 0 : dcd === 5000 ? 5000 : 3000;
  v.gameMode = v.gameMode === "freeze" ? "freeze" : "classic";
  return v;
}

function arenaSize(lobby) {
  return ARENAS[lobby.settings.arena] || ARENAS.classic;
}

function spawnPos(lobby) {
  const { w, h } = arenaSize(lobby);
  return { x: 60 + Math.random() * (w - 120), y: 60 + Math.random() * (h - 120) };
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function sendError(ws, msg) {
  send(ws, { t: "error", msg });
}

function publicPlayers(lobby) {
  const now = Date.now();
  const dashOff = lobby.settings.dashCdMs === 0;
  return [...lobby.players.values()].map((p) => {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      shape: p.shape,
      trail: p.trail,
      x: Math.round(p.x),
      y: Math.round(p.y),
      it: p.it,
      bot: !!p.bot,
      kind: p.bot ? p.kind || "chaser" : undefined,
      difficulty: p.bot ? p.difficulty || "hard" : undefined,
      tags: p.tags || 0,
      dashing: now < (p.dashUntil || 0),
      dashCharges: dashOff ? 0 : p.dashCharges ?? DASH_MAX_CHARGES,
      dashMax: DASH_MAX_CHARGES,
      dashMsLeft: dashOff ? 0 : p.dashCharges > 0 ? 0 : Math.max(0, (p.dashNextAt || 0) - now),
      dashCdTotal: dashOff ? 0 : dashRegenMs(lobby, p),
      frozen: !!p.frozen,
      spectate: !!p.spectate,
      ready: !!p.ready,
      idle: !p.bot && !p.spectate && now - (p.lastActiveAt || now) > IDLE_AFTER_MS,
    };
  });
}

function lobbyTimeLeft(lobby) {
  if (lobby.settings.gameMode !== "freeze" || lobby.state !== "playing" || !lobby.endsAt) return null;
  return Math.max(0, lobby.endsAt - Date.now());
}

function broadcastLobby(lobby) {
  const msg = {
    t: "lobby",
    code: lobby.code,
    leaderId: lobby.leaderId,
    state: lobby.state,
    settings: lobby.settings,
    players: publicPlayers(lobby),
    winnerId: lobby.winnerId || null,
    winTeam: lobby.winTeam || null,
  };
  for (const ws of lobby.sockets.values()) send(ws, msg);
}

function broadcastState(lobby) {
  const msg = {
    t: "state",
    code: lobby.code,
    leaderId: lobby.leaderId,
    state: lobby.state,
    settings: { tagsToWin: lobby.settings.tagsToWin, arena: lobby.settings.arena, gameMode: lobby.settings.gameMode, dashCdMs: lobby.settings.dashCdMs },
    arena: arenaSize(lobby),
    players: publicPlayers(lobby),
    winnerId: lobby.winnerId || null,
    winTeam: lobby.winTeam || null,
    timeLeft: lobbyTimeLeft(lobby),
  };
  for (const ws of lobby.sockets.values()) send(ws, msg);
}

const BOT_KINDS = {
  chaser: { chase: 1.0, flee: 0.86, predict: 0.32, wander: 0.45, separate: 0.9, reactMs: 140 },
  runner: { chase: 0.86, flee: 1.0, predict: 0.14, wander: 0.7, separate: 1.35, reactMs: 200 },
  trickster: { chase: 0.93, flee: 0.92, predict: 0.2, wander: 1.5, separate: 1.1, reactMs: 170 },
};
const BOT_ORDER = ["chaser", "runner", "trickster"];

// easy < medium < hard (hard is the current behavior)
// react = kind.reactMs + diff.reactAdd ; turn = how fast bots steer toward a new heading
const BOT_DIFFS = {
  easy: { chase: 0.7, flee: 0.7, reactAdd: 240, predictMult: 0, wanderMult: 2.2, boostMult: 1.0, frozenMs: 650, juke: false, dashMult: 2.2, dashCdMs: 5200, dashChaseMin: 1e9, dashChaseMax: -1, dashFleeRange: 110, turnLerp: 0.12, mistake: 0.15 },
  medium: { chase: 0.87, flee: 0.87, reactAdd: 90, predictMult: 0.5, wanderMult: 1.4, boostMult: 1.08, frozenMs: 400, juke: false, dashMult: 2.8, dashCdMs: 4000, dashChaseMin: 150, dashChaseMax: 250, dashFleeRange: 140, turnLerp: 0.22, mistake: 0.06 },
  hard: { chase: 1.0, flee: 1.0, reactAdd: 0, predictMult: 1.0, wanderMult: 1.0, boostMult: 1.18, frozenMs: 350, juke: true, dashMult: 3.1, dashCdMs: 3000, dashChaseMin: 120, dashChaseMax: 280, dashFleeRange: 165, turnLerp: 0.38, mistake: 0.01 },
};

function botReactMs(p) {
  const kind = BOT_KINDS[p.kind] || BOT_KINDS.chaser;
  const diff = BOT_DIFFS[p.difficulty] || BOT_DIFFS.hard;
  return kind.reactMs + diff.reactAdd;
}

const DASH_TIME_MS = 160;
const DASH_GRACE_MS = 200;
const HUMAN_DASH_MULT = 3.1;
const DASH_MAX_CHARGES = 2;
const DASH_REGEN_MS = 4000;
const FREEZE_DURATION_MS = 120000;
const IDLE_AFTER_MS = 15000;
const LOBBY_TTL_MS = 3 * 60 * 60 * 1000;
const BOT_NAME_RE = /^bot[\s\d]/i;

function cleanDifficulty(d) {
  const s = String(d || "hard").toLowerCase();
  return BOT_DIFFS[s] ? s : "hard";
}

function makeBotPlayer(lobby, botsCount, difficulty) {
  const taken = new Set([...lobby.players.values()].map((p) => p.color));
  const free = COLORS.find((c) => !taken.has(c)) || "#adb5bd";
  const kind = BOT_ORDER[botsCount % BOT_ORDER.length];
  const diff = cleanDifficulty(difficulty);
  const pos = spawnPos(lobby);
  const botId = "bot-" + Math.random().toString(36).slice(2);
  return {
    id: botId,
    name: "Bot " + (botsCount + 1),
    color: free,
    shape: SHAPES[botsCount % SHAPES.length],
    trail: "none",
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    lastX: pos.x,
    lastY: pos.y,
    keys: {},
    moveVec: null,
    it: false,
    bot: true,
    kind,
    difficulty: diff,
    tags: 0,
    wobble: Math.random() * 10,
    thinkAt: 0,
    tx: pos.x,
    ty: pos.y,
    stuckMs: 0,
    lastCheckX: pos.x,
    lastCheckY: pos.y,
    lastCheckT: Date.now(),
    fleeBoostUntil: 0,
    frozenUntil: 0,
    jukeUntil: 0,
    jukeX: 0,
    jukeY: 0,
    waypointUntil: 0,
    waypointX: 0,
    waypointY: 0,
    dashUntil: 0,
    dashCharges: DASH_MAX_CHARGES,
    dashNextAt: 0,
    dashDx: 0,
    dashDy: 0,
    dashGraceUntil: 0,
    lastDx: 1,
    lastDy: 0,
    mdx: 1,
    mdy: 0,
    frozen: false,
    spectate: false,
    ready: false,
    lastActiveAt: Date.now(),
  };
}

function dashRegenMs(lobby, p) {
  if (lobby.settings.dashCdMs === 0) return Infinity;
  if (p.bot) {
    const diff = BOT_DIFFS[p.difficulty] || BOT_DIFFS.hard;
    return Math.max(diff.dashCdMs || 3000, lobby.settings.dashCdMs);
  }
  return lobby.settings.dashCdMs;
}

function tryDash(lobby, p, dirX, dirY, now) {
  if (lobby.settings.dashCdMs === 0) return false;
  if ((p.dashCharges ?? DASH_MAX_CHARGES) <= 0) return false;
  if (now < (p.dashUntil || 0)) return false;
  const len = Math.hypot(dirX, dirY);
  if (!(len > 0.01)) return false;
  p.dashDx = dirX / len;
  p.dashDy = dirY / len;
  p.lastDx = p.dashDx;
  p.lastDy = p.dashDy;
  p.dashUntil = now + DASH_TIME_MS;
  p.dashGraceUntil = p.dashUntil + DASH_GRACE_MS;
  p.dashCharges = (p.dashCharges ?? DASH_MAX_CHARGES) - 1;
  if (p.dashCharges < DASH_MAX_CHARGES) {
    p.dashNextAt = now + dashRegenMs(lobby, p);
  }
  return true;
}

function regenDash(lobby, p, now) {
  if (lobby.settings.dashCdMs === 0) return;
  if ((p.dashCharges ?? DASH_MAX_CHARGES) >= DASH_MAX_CHARGES) return;
  if (now >= (p.dashNextAt || 0)) {
    p.dashCharges = (p.dashCharges ?? 0) + 1;
    p.dashNextAt = p.dashCharges >= DASH_MAX_CHARGES ? 0 : now + dashRegenMs(lobby, p);
  }
}

function estimateVelocities(lobby, dt) {
  for (const p of lobby.players.values()) {
    const vx = (p.x - (p.lastX ?? p.x)) / dt;
    const vy = (p.y - (p.lastY ?? p.y)) / dt;
    p.vx = (p.vx || 0) * 0.7 + vx * 0.3;
    p.vy = (p.vy || 0) * 0.7 + vy * 0.3;
    // clamp crazy spikes from spawns
    if (!isFinite(p.vx)) p.vx = 0;
    if (!isFinite(p.vy)) p.vy = 0;
    p.lastX = p.x;
    p.lastY = p.y;
  }
}

function wallForce(p, w, h) {
  const margin = 110;
  let fx = 0,
    fy = 0;
  if (p.x < margin) fx += ((margin - p.x) / margin) * 2.0;
  if (p.x > w - margin) fx -= ((p.x - (w - margin)) / margin) * 2.0;
  if (p.y < margin) fy += ((margin - p.y) / margin) * 2.0;
  if (p.y > h - margin) fy -= ((p.y - (h - margin)) / margin) * 2.0;
  // extra push out of corners
  const cx = Math.min(p.x, w - p.x);
  const cy = Math.min(p.y, h - p.y);
  if (cx < 90 && cy < 90) {
    fx += (w / 2 - p.x) > 0 ? 0.8 : -0.8;
    fy += (h / 2 - p.y) > 0 ? 0.8 : -0.8;
  }
  return { fx, fy };
}

function thinkBot(p, lobby, now) {
  const kind = BOT_KINDS[p.kind] || BOT_KINDS.chaser;
  const diff = BOT_DIFFS[p.difficulty] || BOT_DIFFS.hard;
  const { w, h } = arenaSize(lobby);
  const all = [...lobby.players.values()];
  const it = all.find((q) => q.it);

  if (now < p.thinkAt) return;
  p.thinkAt = now + botReactMs(p) + Math.random() * 80;

  // forced waypoint (anti-camp escape) takes priority briefly
  if (now < p.waypointUntil) {
    p.tx = p.waypointX;
    p.ty = p.waypointY;
    return;
  }

  if (p.it) {
    // prefer humans so bots do not just train on each other
    const others = all.filter((q) => q !== p && !q.frozen && !q.spectate);
    const humans = others.filter((q) => !q.bot);
    const pool = humans.length > 0 ? humans : others;
    let best = null,
      bd = 1e9;
    for (const q of pool) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      // slight preference for closer + slower targets
      const score = d - (Math.hypot(q.vx || 0, q.vy || 0) * 0.1);
      if (score < bd) {
        bd = score;
        best = q;
      }
    }
    if (!best) return;
    // mistake: occasionally chase a random target instead of the best one
    if (pool.length > 1 && Math.random() < (diff.mistake || 0)) {
      best = pool[Math.floor(Math.random() * pool.length)];
    }
    let px = best.x + (best.vx || 0) * kind.predict * diff.predictMult;
    let py = best.y + (best.vy || 0) * kind.predict * diff.predictMult;
    // cut off: if target hugs wall, aim a bit toward center to intercept
    const nearWall = px < 90 || px > w - 90 || py < 90 || py > h - 90;
    if (nearWall) {
      px = px * 0.75 + (w / 2) * 0.25;
      py = py * 0.75 + (h / 2) * 0.25;
    }
    // own wander so two IT bots do not take identical lines (only one IT at a time, but keeps path organic)
    const wanderAmt = 22 * kind.wander * diff.wanderMult;
    px += Math.sin(now / 1100 + p.wobble) * wanderAmt;
    py += Math.cos(now / 900 + p.wobble * 1.7) * wanderAmt;
    p.tx = px;
    p.ty = py;
    // chase dash: close the gap when in range (range + cooldown differ by difficulty)
    const chaseD = Math.hypot(best.x - p.x, best.y - p.y);
    if (chaseD >= (diff.dashChaseMin ?? 120) && chaseD <= (diff.dashChaseMax ?? 280)) {
      const dx = px - p.x;
      const dy = py - p.y;
      // require rough alignment with current heading to avoid wild sideways dashes
      const hx = p.tx - p.x;
      const hy = p.ty - p.y;
      if (Math.hypot(hx, hy) > 1) {
        tryDash(lobby, p, dx, dy, now);
      }
    }
  } else if (it) {
    const dx = p.x - it.x;
    const dy = p.y - it.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = dx / d;
    const ny = dy / d;

    const wall = wallForce(p, w, h);

    // separation from other players so bots spread out
    let sx = 0,
      sy = 0;
    for (const q of all) {
      if (q === p) continue;
      const ox = p.x - q.x;
      const oy = p.y - q.y;
      const od = Math.hypot(ox, oy);
      if (od > 0 && od < 95) {
        const push = (1 - od / 95) * kind.separate;
        sx += (ox / od) * push;
        sy += (oy / od) * push;
      }
    }

    // gentle pull to center so they do not hug corners
    const cx = (w / 2 - p.x) / (w / 2);
    const cy = (h / 2 - p.y) / (h / 2);

    const wx = Math.sin(now / 800 + p.wobble * 2.1) * kind.wander * diff.wanderMult;
    const wy = Math.cos(now / 1000 + p.wobble * 1.3) * kind.wander * diff.wanderMult;

    // trickster juke: occasional perpendicular dash when IT is close (hard only)
    if (diff.juke && p.kind === "trickster" && d < 190 && now >= (p.jukeUntil || 0) && Math.random() < 0.06) {
      const side = Math.random() < 0.5 ? 1 : -1;
      p.jukeX = -ny * side;
      p.jukeY = nx * side;
      p.jukeUntil = now + 320;
    }
    let jx = 0,
      jy = 0;
    if (now < p.jukeUntil) {
      jx = p.jukeX * 1.6;
      jy = p.jukeY * 1.6;
    }

    const dirX = nx * 1.0 + wall.fx * 1.1 + sx + cx * 0.35 + wx * 0.5 + jx;
    const dirY = ny * 1.0 + wall.fy * 1.1 + sy + cy * 0.35 + wy * 0.5 + jy;
    const len = Math.hypot(dirX, dirY) || 1;
    const reach = 170;
    p.tx = p.x + (dirX / len) * reach;
    p.ty = p.y + (dirY / len) * reach;
    // flee dash: burst away when IT gets close (range + cooldown differ by difficulty)
    if (d <= (diff.dashFleeRange || 165)) {
      tryDash(lobby, p, dirX, dirY, now);
    }
  }
}

function moveBot(p, lobby, dt, now, baseSpeed) {
  const kind = BOT_KINDS[p.kind] || BOT_KINDS.chaser;
  const diff = BOT_DIFFS[p.difficulty] || BOT_DIFFS.hard;
  if (now < p.frozenUntil) return;
  const { w, h } = arenaSize(lobby);
  const m = RADIUS + 2;
  if (now < (p.dashUntil || 0)) {
    const dashMult = (diff.dashMult || 3.1) * (p.it ? kind.chase : kind.flee);
    p.x += (p.dashDx || 1) * baseSpeed * dashMult * dt;
    p.y += (p.dashDy || 0) * baseSpeed * dashMult * dt;
    p.x = Math.max(m, Math.min(w - m, p.x));
    p.y = Math.max(m, Math.min(h - m, p.y));
    return;
  }
  let mult = p.it ? 0.95 * kind.chase * diff.chase : 0.88 * kind.flee * diff.flee;
  if (!p.it && now < p.fleeBoostUntil) mult *= diff.boostMult;
  const dx = p.tx - p.x;
  const dy = p.ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 3) return;
  // turn smoothing: easy bots steer slowly toward a new heading, hard bots snap faster.
  // this is the visible reaction lag when a target jukes or dashes.
  const turn = diff.turnLerp ?? 0.25;
  const wantX = dx / d;
  const wantY = dy / d;
  p.mdx = (p.mdx ?? wantX) + (wantX - (p.mdx ?? wantX)) * turn;
  p.mdy = (p.mdy ?? wantY) + (wantY - (p.mdy ?? wantY)) * turn;
  const ml = Math.hypot(p.mdx, p.mdy) || 1;
  const step = Math.min(baseSpeed * mult * dt, d);
  p.x += (p.mdx / ml) * step;
  p.y += (p.mdy / ml) * step;
  p.x = Math.max(m, Math.min(w - m, p.x));
  p.y = Math.max(m, Math.min(h - m, p.y));

  // stuck / camp detection every ~800ms
  if (now - p.lastCheckT > 800) {
    const moved = Math.hypot(p.x - p.lastCheckX, p.y - p.lastCheckY);
    if (moved < 26) {
      p.stuckMs += now - p.lastCheckT;
    } else {
      p.stuckMs = 0;
    }
    p.lastCheckX = p.x;
    p.lastCheckY = p.y;
    p.lastCheckT = now;
    if (p.stuckMs > 900) {
      // force escape to center-ish random point, different per bot
      p.waypointX = w / 2 + (Math.random() - 0.5) * w * 0.5 + Math.sin(p.wobble * 3) * 80;
      p.waypointY = h / 2 + (Math.random() - 0.5) * h * 0.5;
      p.waypointUntil = now + 1400;
      p.stuckMs = 0;
    }
  }
}
function migrateLeader(lobby) {
  const humans = [...lobby.players.values()].filter((p) => !p.bot);
  if (humans.length === 0) return;
  if (!lobby.players.has(lobby.leaderId) || lobby.players.get(lobby.leaderId)?.bot) {
    lobby.leaderId = humans[0].id;
  }
}

function removePlayer(lobby, playerId) {
  lobby.players.delete(playerId);
  lobby.sockets.delete(playerId);
  if (lobby.leaderId === playerId) migrateLeader(lobby);
  const humans = [...lobby.players.values()].filter((p) => !p.bot);
  if (humans.length === 0) {
    lobbies.delete(lobby.code);
    return;
  }
  const eligible = [...lobby.players.values()].filter((p) => !p.spectate && !p.frozen);
  if (!eligible.some((p) => p.it) && eligible.length > 0) {
    eligible[Math.floor(Math.random() * eligible.length)].it = true;
  }
}

function resetForStart(lobby) {
  lobby.winnerId = null;
  lobby.winTeam = null;
  lobby.tagCooldownUntil = Date.now() + 1500;
  lobby.endsAt = lobby.settings.gameMode === "freeze" ? Date.now() + FREEZE_DURATION_MS : 0;
  const now = Date.now();
  for (const p of lobby.players.values()) {
    if (p.spectate) continue;
    const pos = spawnPos(lobby);
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.lastX = pos.x;
    p.lastY = pos.y;
    p.tags = 0;
    p.it = false;
    p.keys = {};
    p.moveVec = null;
    p.dashUntil = 0;
    p.dashCharges = DASH_MAX_CHARGES;
    p.dashNextAt = 0;
    p.dashDx = 0;
    p.dashDy = 0;
    p.dashGraceUntil = 0;
    p.lastDx = 1;
    p.lastDy = 0;
    p.frozen = false;
    p.ready = false;
    if (p.bot) {
      p.thinkAt = now + botReactMs(p) + Math.random() * 150;
      p.tx = pos.x;
      p.ty = pos.y;
      p.mdx = 1;
      p.mdy = 0;
      p.stuckMs = 0;
      p.lastCheckX = pos.x;
      p.lastCheckY = pos.y;
      p.lastCheckT = now;
      p.fleeBoostUntil = 0;
      p.frozenUntil = 0;
      p.jukeUntil = 0;
      p.waypointUntil = 0;
    }
  }
  const eligible = [...lobby.players.values()].filter((p) => !p.spectate && !p.bot);
  const pool = eligible.length > 0 ? eligible : [...lobby.players.values()].filter((p) => !p.spectate);
  if (pool.length > 0) pool[Math.floor(Math.random() * pool.length)].it = true;
}

// --- 30hz authoritative loop, only playing lobbies ---
setInterval(() => {
  const dt = 1 / 30;
  const now = Date.now();
  for (const lobby of lobbies.values()) {
    if (lobby.createdAt && now - lobby.createdAt > LOBBY_TTL_MS) {
      for (const ws of lobby.sockets.values()) send(ws, { t: "error", msg: "Lobby expired after 3 hours." });
      lobbies.delete(lobby.code);
      continue;
    }
    if (lobby.state !== "playing" || lobby.winnerId || lobby.winTeam) {
      continue;
    }
    const { w, h } = arenaSize(lobby);
    const speed = lobby.settings.speed;
    const freezeMode = lobby.settings.gameMode === "freeze";

    for (const p of lobby.players.values()) {
      regenDash(lobby, p, now);
      if (p.bot || p.spectate || p.frozen) continue;
      if (now < (p.frozenUntil || 0)) continue;
      if (now < (p.dashUntil || 0)) {
        p.x += (p.dashDx || 1) * speed * HUMAN_DASH_MULT * dt;
        p.y += (p.dashDy || 0) * speed * HUMAN_DASH_MULT * dt;
      } else {
        let dx = 0,
          dy = 0;
        const k = p.keys || {};
        if (k.up) dy -= 1;
        if (k.down) dy += 1;
        if (k.left) dx -= 1;
        if (k.right) dx += 1;
        if (p.moveVec) {
          dx += p.moveVec.x;
          dy += p.moveVec.y;
        }
        if (dx !== 0 || dy !== 0) {
          const len = Math.hypot(dx, dy);
          const nx = dx / len;
          const ny = dy / len;
          p.lastDx = nx;
          p.lastDy = ny;
          p.x += nx * speed * dt;
          p.y += ny * speed * dt;
        }
      }
      p.x = Math.max(RADIUS, Math.min(w - RADIUS, p.x));
      p.y = Math.max(RADIUS, Math.min(h - RADIUS, p.y));
    }

    estimateVelocities(lobby, dt);

    const all = [...lobby.players.values()];
    for (const p of all) {
      if (!p.bot || p.spectate || p.frozen) continue;
      thinkBot(p, lobby, now);
      moveBot(p, lobby, dt, now, speed);
    }

    if (freezeMode) {
      const itPlayer = all.find((p) => p.it && !p.spectate);
      // IT freezes runners, runners unfreeze each other
      if (itPlayer && !itPlayer.frozen && now >= lobby.tagCooldownUntil) {
        for (const q of all) {
          if (q === itPlayer || q.spectate) continue;
          if (q.frozen || q.it) continue;
          if (now < (q.dashGraceUntil || 0)) continue;
          if (Math.hypot(q.x - itPlayer.x, q.y - itPlayer.y) < RADIUS * 2) {
            q.frozen = true;
            q.keys = {};
            q.moveVec = null;
            itPlayer.tags = (itPlayer.tags || 0) + 1;
            lobby.tagCooldownUntil = now + lobby.settings.cooldownMs;
            break;
          }
        }
      }
      // unfreeze: non-IT, non-frozen touches frozen
      for (const f of all) {
        if (!f.frozen || f.spectate || f.it) continue;
        for (const q of all) {
          if (q === f || q.spectate || q.frozen || q.it) continue;
          if (Math.hypot(q.x - f.x, q.y - f.y) < RADIUS * 2) {
            f.frozen = false;
            break;
          }
        }
      }
      const runners = all.filter((p) => !p.it && !p.spectate && !p.bot);
      const frozenRunners = runners.filter((p) => p.frozen);
      const humansFrozen = runners.length > 0 && frozenRunners.length === runners.length;
      const botsAllFrozen = runners.length === 0 && all.filter((p) => !p.it && !p.spectate).every((p) => p.frozen);
      if ((humansFrozen || botsAllFrozen) && all.some((p) => !p.spectate && !p.it)) {
        lobby.winTeam = "it";
        lobby.winnerId = itPlayer ? itPlayer.id : null;
      } else if (lobby.settings.tagsToWin > 0 && itPlayer && (itPlayer.tags || 0) >= lobby.settings.tagsToWin) {
        lobby.winTeam = "it";
        lobby.winnerId = itPlayer.id;
      } else if (lobby.endsAt && now >= lobby.endsAt) {
        lobby.winTeam = "runners";
        lobby.winnerId = "runners";
      }
    } else {
      const itPlayer = all.find((p) => p.it && !p.spectate && !p.frozen);
      if (itPlayer && now >= lobby.tagCooldownUntil) {
        for (const q of all) {
          if (q === itPlayer || q.spectate || q.frozen) continue;
          if (now < (q.dashGraceUntil || 0)) continue;
          if (Math.hypot(q.x - itPlayer.x, q.y - itPlayer.y) < RADIUS * 2) {
            itPlayer.it = false;
            itPlayer.tags = (itPlayer.tags || 0) + 1;
            // anti-cycle: fleer gets a burst, new IT is briefly frozen (duration by new IT difficulty)
            itPlayer.fleeBoostUntil = now + 1200;
            if (q.bot) q.fleeBoostUntil = 0;
            q.it = true;
            const qDiff = q.bot ? BOT_DIFFS[q.difficulty] || BOT_DIFFS.hard : null;
            q.frozenUntil = now + (qDiff ? qDiff.frozenMs : 350);
          if (q.bot) {
            // new IT does not react instantly: wait out its difficulty delay
            q.thinkAt = now + botReactMs(q) + Math.random() * 60;
            q.mdx = q.lastDx || 1;
            q.mdy = q.lastDy || 0;
          }
          lobby.tagCooldownUntil = now + lobby.settings.cooldownMs;
          if (lobby.settings.tagsToWin > 0 && itPlayer.tags >= lobby.settings.tagsToWin) {
            lobby.winnerId = itPlayer.id;
            lobby.winTeam = "it";
          }
          break;
        }
      }
    }
    }

    broadcastState(lobby);
  }
}, 1000 / 30);

const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  if (urlPath === "/" || urlPath === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

const wss = new WebSocketServer({ server });

function leaveCurrent(socket) {
  const ctx = socket.ctx;
  if (!ctx || !ctx.code) return;
  const lobby = lobbies.get(ctx.code);
  socket.ctx = null;
  if (!lobby) return;
  // a refreshed tab leaves a stale socket behind: never evict the fresh connection
  if (ctx.playerId && lobby.sockets.get(ctx.playerId) !== socket) return;
  if (ctx.playerId && lobby.players.has(ctx.playerId) && !lobby.players.get(ctx.playerId).bot) {
    removePlayer(lobby, ctx.playerId);
    if (lobbies.has(lobby.code)) {
      if (lobby.state === "playing") broadcastState(lobby);
      else broadcastLobby(lobby);
    }
  }
}

wss.on("connection", (socket) => {
  socket.ctx = null;

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const ctx = socket.ctx || {};

    if (msg.t === "createLobby") {
      leaveCurrent(socket);
      const code = makeCode();
      const settings = cleanSettings(msg.settings);
      const lobby = {
        code,
        leaderId: null,
        state: "waiting",
        settings,
        players: new Map(),
        sockets: new Map(),
        tagCooldownUntil: 0,
        winnerId: null,
        winTeam: null,
        endsAt: 0,
        createdAt: Date.now(),
      };
      const id = String(msg.id || Math.random().toString(36).slice(2)).slice(0, 32);
      const look = cleanLook(msg.look, new Set());
      const pos = { x: 0, y: 0 }; // waiting, no position needed yet
      lobby.players.set(id, {
        id,
        name: cleanName(msg.name, false),
        color: look.color,
        shape: look.shape,
        trail: look.trail,
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
        lastX: pos.x,
        lastY: pos.y,
        keys: {},
        moveVec: null,
        it: false,
        bot: false,
        tags: 0,
        wobble: Math.random() * 10,
        dashUntil: 0,
        dashCharges: DASH_MAX_CHARGES,
        dashNextAt: 0,
        dashDx: 0,
        dashDy: 0,
        dashGraceUntil: 0,
        lastDx: 1,
        lastDy: 0,
        frozen: false,
        spectate: false,
        ready: true,
        lastActiveAt: Date.now(),
      });
      lobby.leaderId = id;
      lobby.sockets.set(id, socket);
      lobbies.set(code, lobby);
      socket.ctx = { code, playerId: id };
      broadcastLobby(lobby);
    } else if (msg.t === "joinLobby") {
      const code = String(msg.code || "").toUpperCase().trim().slice(0, 8);
      const lobby = lobbies.get(code);
      if (!lobby) {
        sendError(socket, "Lobby not found. Check the code.");
        return;
      }
      const id = String(msg.id || Math.random().toString(36).slice(2)).slice(0, 32);
      const isReconnect = lobby.players.has(id);
      // mid-game joins become spectators and auto-join next round
      if (lobby.state !== "waiting" && !lobby.winnerId && !lobby.winTeam) {
        if (isReconnect) {
          const p = lobby.players.get(id);
          lobby.sockets.set(id, socket);
          socket.ctx = { code, playerId: id };
          if (lobby.state === "playing") broadcastState(lobby);
          else broadcastLobby(lobby);
          return;
        }
        const specs = [...lobby.players.values()].filter((p) => p.spectate).length;
        if (specs >= 4) {
          sendError(socket, "Game in progress and spectator seats are full.");
          return;
        }
        leaveCurrent(socket);
        const taken = new Set([...lobby.players.values()].map((p) => p.color));
        const look = cleanLook(msg.look, taken);
        lobby.players.set(id, {
          id,
          name: cleanName(msg.name, false),
          color: look.color,
          shape: look.shape,
          trail: look.trail,
          x: -100,
          y: -100,
          vx: 0,
          vy: 0,
          lastX: -100,
          lastY: -100,
          keys: {},
          moveVec: null,
          it: false,
          bot: false,
          tags: 0,
          wobble: Math.random() * 10,
          dashUntil: 0,
          dashCharges: DASH_MAX_CHARGES,
          dashNextAt: 0,
          dashDx: 0,
          dashDy: 0,
          dashGraceUntil: 0,
          lastDx: 1,
          lastDy: 0,
          frozen: false,
          spectate: true,
          ready: false,
          lastActiveAt: Date.now(),
        });
        lobby.sockets.set(id, socket);
        socket.ctx = { code, playerId: id };
        if (lobby.state === "playing") broadcastState(lobby);
        else broadcastLobby(lobby);
        return;
      }
      if (lobby.winnerId || lobby.winTeam) {
        sendError(socket, "Game just finished. Ask the leader to press End or Play again, then join.");
        return;
      }
      const seated = [...lobby.players.values()].filter((p) => !p.spectate).length;
      if (!isReconnect && seated >= lobby.settings.maxPlayers) {
        sendError(socket, "Lobby is full.");
        return;
      }
      // rejoining the same seat must not delete it first (leaveCurrent would)
      if (!(isReconnect && ctx.code === code && ctx.playerId === id)) leaveCurrent(socket);
      const taken2 = new Set([...lobby.players.values()].filter((p) => p.id !== id).map((p) => p.color));
      const look2 = cleanLook(msg.look, taken2);
      if (isReconnect) {
        const p = lobby.players.get(id);
        p.name = cleanName(msg.name, false);
        p.color = look2.color;
        p.shape = look2.shape;
        p.trail = look2.trail;
        p.spectate = false;
        p.ready = false;
        p.lastActiveAt = Date.now();
        lobby.sockets.set(id, socket);
      } else {
        lobby.players.set(id, {
          id,
          name: cleanName(msg.name, false),
          color: look2.color,
          shape: look2.shape,
          trail: look2.trail,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          lastX: 0,
          lastY: 0,
          keys: {},
          moveVec: null,
          it: false,
          bot: false,
          tags: 0,
          wobble: Math.random() * 10,
          dashUntil: 0,
          dashCharges: DASH_MAX_CHARGES,
          dashNextAt: 0,
          dashDx: 0,
          dashDy: 0,
          dashGraceUntil: 0,
          lastDx: 1,
          lastDy: 0,
          frozen: false,
          spectate: false,
          ready: false,
          lastActiveAt: Date.now(),
        });
        lobby.sockets.set(id, socket);
      }
      migrateLeader(lobby);
      socket.ctx = { code, playerId: id };
      broadcastLobby(lobby);
    } else if (msg.t === "updateLook") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby || lobby.state !== "waiting") return;
      const p = lobby.players.get(ctx.playerId);
      if (!p) return;
      const taken = new Set([...lobby.players.values()].filter((q) => q.id !== p.id).map((q) => q.color));
      const look = cleanLook(msg.look, taken);
      p.name = cleanName(msg.name !== undefined ? msg.name : p.name, false);
      p.color = look.color;
      p.shape = look.shape;
      p.trail = look.trail;
      broadcastLobby(lobby);
    } else if (msg.t === "updateSettings") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby) return;
      if (lobby.leaderId !== ctx.playerId) {
        sendError(socket, "Only the leader can change settings.");
        return;
      }
      if (lobby.state !== "waiting") {
        sendError(socket, "Cannot change settings mid-game.");
        return;
      }
      const next = cleanSettings(Object.assign({}, lobby.settings, msg.settings));
      const seated = [...lobby.players.values()].filter((p) => !p.spectate).length;
      if (seated > next.maxPlayers) {
        sendError(socket, "Lobby has more players than the new max.");
        return;
      }
      lobby.settings = next;
      broadcastLobby(lobby);
    } else if (msg.t === "startGame") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby) return;
      if (lobby.leaderId !== ctx.playerId) {
        sendError(socket, "Only the leader can start.");
        return;
      }
      const isRestart = lobby.state === "playing" && (lobby.winnerId || lobby.winTeam);
      if (lobby.state !== "waiting" && !isRestart) return;
      const seated = [...lobby.players.values()].filter((p) => !p.spectate);
      if (seated.length < 2) {
        sendError(socket, "Need at least 2 players or add a bot.");
        return;
      }
      if (lobby.state === "waiting") {
        const notReady = seated.filter((p) => !p.bot && p.id !== lobby.leaderId && !p.ready);
        if (notReady.length > 0) {
          sendError(socket, "Waiting for " + notReady.map((p) => p.name).slice(0, 3).join(", ") + " to ready up.");
          return;
        }
      }
      lobby.state = "playing";
      resetForStart(lobby);
      broadcastState(lobby);
    } else if (msg.t === "toggleReady") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby || lobby.state !== "waiting") return;
      const p = lobby.players.get(ctx.playerId);
      if (!p || p.bot || p.spectate) return;
      p.ready = !p.ready;
      p.lastActiveAt = Date.now();
      broadcastLobby(lobby);
    } else if (msg.t === "endGame") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby) return;
      if (lobby.leaderId !== ctx.playerId) {
        sendError(socket, "Only the leader can end the game.");
        return;
      }
      lobby.state = "waiting";
      lobby.winnerId = null;
      lobby.winTeam = null;
      lobby.endsAt = 0;
      for (const p of lobby.players.values()) {
        p.tags = 0;
        p.it = false;
        p.keys = {};
        p.moveVec = null;
        p.frozen = false;
        p.dashUntil = 0;
        p.dashCharges = DASH_MAX_CHARGES;
        p.dashNextAt = 0;
        p.dashGraceUntil = 0;
        if (p.spectate) {
          p.spectate = false;
          p.ready = false;
          const pos = spawnPos(lobby);
          p.x = pos.x;
          p.y = pos.y;
        } else {
          p.ready = p.bot ? false : p.id === lobby.leaderId;
        }
      }
      migrateLeader(lobby);
      broadcastLobby(lobby);
    } else if (msg.t === "kick") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby) return;
      if (lobby.leaderId !== ctx.playerId) {
        sendError(socket, "Only the leader can kick.");
        return;
      }
      const target = String(msg.targetId || "");
      if (!target || target === lobby.leaderId || !lobby.players.has(target)) return;
      const targetSocket = lobby.sockets.get(target);
      if (targetSocket) {
        send(targetSocket, { t: "kicked" });
        targetSocket.ctx = null;
      }
      removePlayer(lobby, target);
      if (lobbies.has(lobby.code)) {
        if (lobby.state === "playing") broadcastState(lobby);
        else broadcastLobby(lobby);
      }
    } else if (msg.t === "addBot") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby) return;
      if (!lobby.settings.allowBots) {
        sendError(socket, "Bots are turned off in settings.");
        return;
      }
      const seated = [...lobby.players.values()].filter((p) => !p.spectate).length;
      if (seated >= lobby.settings.maxPlayers) {
        sendError(socket, "Lobby is full.");
        return;
      }
      const bots = [...lobby.players.values()].filter((p) => p.bot).length;
      if (bots >= 3) {
        sendError(socket, "Max 3 bots.");
        return;
      }
      const bot = makeBotPlayer(lobby, bots, cleanDifficulty(msg.difficulty));
      lobby.players.set(bot.id, bot);
      const list = [...lobby.players.values()];
      if (!list.some((p) => p.it)) {
        const humans = list.filter((p) => !p.bot);
        (humans[0] || list[0]).it = true;
      }
      if (lobby.state === "playing") broadcastState(lobby);
      else broadcastLobby(lobby);
    } else if (msg.t === "removeBot") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby) return;
      if (lobby.leaderId !== ctx.playerId) {
        sendError(socket, "Only the leader can remove bots.");
        return;
      }
      const target = String(msg.targetId || "");
      const p = lobby.players.get(target);
      if (!p || !p.bot) {
        sendError(socket, "That is not a bot.");
        return;
      }
      removePlayer(lobby, target);
      if (lobbies.has(lobby.code)) {
        if (lobby.state === "playing") broadcastState(lobby);
        else broadcastLobby(lobby);
      }
    } else if (msg.t === "leaveLobby") {
      leaveCurrent(socket);
      send(socket, { t: "left" });
    } else if (msg.t === "input") {
      if (!ctx.code) return;
      const lobby = lobbies.get(ctx.code);
      if (!lobby || lobby.state !== "playing" || lobby.winnerId || lobby.winTeam) return;
      const p = lobby.players.get(ctx.playerId);
      if (!p || p.bot || p.spectate || p.frozen) return;
      const now = Date.now();
      if (now < (p.frozenUntil || 0)) return;
      p.lastActiveAt = now;
      p.keys = {
        up: !!msg.keys?.up,
        down: !!msg.keys?.down,
        left: !!msg.keys?.left,
        right: !!msg.keys?.right,
      };
      if (msg.moveVec && Math.hypot(msg.moveVec.x, msg.moveVec.y) <= 1.5) {
        p.moveVec = msg.moveVec;
      } else if (!msg.moveVec) {
        p.moveVec = null;
      }
      if (msg.dash) {
        let dx = 0,
          dy = 0;
        const k = p.keys;
        if (k.up) dy -= 1;
        if (k.down) dy += 1;
        if (k.left) dx -= 1;
        if (k.right) dx += 1;
        if (p.moveVec) {
          dx += p.moveVec.x;
          dy += p.moveVec.y;
        }
        if (dx === 0 && dy === 0) {
          dx = p.lastDx || 1;
          dy = p.lastDy || 0;
        }
        tryDash(lobby, p, dx, dy, now);
      }
    }
  });

  socket.on("close", () => {
    leaveCurrent(socket);
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("tag arena lobbies on", server.address().port);
});
