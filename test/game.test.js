const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  lobbies,
  makeCode,
  cleanLook,
  cleanSettings,
  cleanDifficulty,
  cleanName,
  makeBotPlayer,
  tryDash,
  regenDash,
  resetForStart,
  removePlayer,
  publicPlayers,
  selectBotTarget,
  thinkBot,
  isTagTouch,
  classicTagTarget,
  classicPointsWinner,
  accruePoints,
  freezeOutcome,
  RADIUS,
  CLASSIC_DURATION_MS,
  POINTS_GAIN_PER_SEC,
  POINTS_LOSE_PER_SEC,
  HUMAN_FLEE_BOOST_MULT,
  IDLE_KICK_MS,
} = require("../server.js");

test("cleanSettings clamps to allowed values", () => {
  const d = cleanSettings({});
  assert.equal(d.maxPlayers, 6);
  assert.equal(d.pointsToWin, 1500);
  assert.equal(d.speed, 260);

  const bad = cleanSettings({ maxPlayers: 99, pointsToWin: 7, speed: 999, arena: "nope", gameMode: "nope", dashCdMs: 123 });
  assert.equal(bad.maxPlayers, 8);
  assert.equal(bad.pointsToWin, 1500);
  assert.equal(bad.speed, 260);
  assert.equal(bad.arena, "classic");
  assert.equal(bad.gameMode, "classic");
  assert.equal(bad.dashCdMs, 3000);

  const timedOnly = cleanSettings({ pointsToWin: 0, dashCdMs: 0 });
  assert.equal(timedOnly.pointsToWin, 0);
  assert.equal(timedOnly.dashCdMs, 0);

  // Legacy clients still send tagsToWin: convert roughly, timed-only stays timed-only.
  assert.equal(cleanSettings({ tagsToWin: 10 }).pointsToWin, 1500);
  assert.equal(cleanSettings({ tagsToWin: 0 }).pointsToWin, 0);
  assert.equal(cleanSettings({ tagsToWin: 3 }).pointsToWin, 450);
});

test("cleanLook rejects bad values and avoids taken colors", () => {
  const look = cleanLook({ color: "nope", shape: "nope", trail: "nope" }, new Set());
  assert.equal(look.shape, "circle");
  assert.equal(look.trail, "none");
  assert.ok(look.color);

  const taken = new Set([look.color]);
  const second = cleanLook({ color: look.color }, taken);
  assert.notEqual(second.color, look.color);
});

test("cleanDifficulty and cleanName behave", () => {
  assert.equal(cleanDifficulty("easy"), "easy");
  assert.equal(cleanDifficulty("bogus"), "hard");
  assert.equal(cleanName("Bot 1", false), "Player");
  assert.equal(cleanName("Bot_1", false), "Player");
  assert.equal(cleanName("BotX", false), "Player");
  assert.equal(cleanName("bot-2", false), "Player");
  assert.equal(cleanName("  ", false), "Player");
  assert.equal(cleanName("Ada", false), "Ada");
  assert.equal(cleanName("Bottle", false), "Player"); // overbroad by design, avoids impersonation
});

test("makeCode is unique against existing lobbies", () => {
  lobbies.set("ABCDE", {});
  try {
    for (let i = 0; i < 200; i++) {
      const c = makeCode();
      assert.ok(typeof c === "string" && c.length >= 5 && c.length <= 6, `len ${c}`);
      assert.ok(!lobbies.has(c), `collision on ${c}`);
    }
  } finally {
    lobbies.delete("ABCDE");
  }
});

test("classic tag transfer triggers on touch, respects cooldown and grace", () => {
  const it = { id: "it", x: 100, y: 100, spectate: false, frozen: false };
  const near = { id: "near", x: 100 + RADIUS, y: 100, spectate: false, frozen: false, dashGraceUntil: 0 };
  const far = { id: "far", x: 500, y: 500, spectate: false, frozen: false, dashGraceUntil: 0 };
  const now = 1_000_000;

  assert.ok(isTagTouch(it, near));
  assert.ok(!isTagTouch(it, far));
  assert.equal(classicTagTarget(it, [it, near, far], now, now - 1), "near");
  // Cooldown blocks tags.
  assert.equal(classicTagTarget(it, [it, near], now, now + 500), null);
  // Post-dash grace blocks tags.
  const graced = { ...near, dashGraceUntil: now + 100 };
  assert.equal(classicTagTarget(it, [it, graced], now, now - 1), null);
  // Frozen/spectating targets are skipped.
  const frozen = { ...near, frozen: true };
  assert.equal(classicTagTarget(it, [it, frozen], now, now - 1), null);
});

test("freeze outcome: all-frozen and timer paths", () => {
  const it = { id: "it", tags: 1, pts: 50 };
  const a = { id: "a", frozen: true, spectate: false };
  const b = { id: "b", frozen: true, spectate: false };
  assert.equal(freezeOutcome([it, a, b], it, false), "it");

  const c = { id: "c", frozen: false, spectate: false };
  assert.equal(freezeOutcome([it, a, c], it, false), null);
  assert.equal(freezeOutcome([it, a, c], it, true), "runners");
});

test("classic points: most points wins, tags break ties, spectators excluded", () => {
  assert.equal(CLASSIC_DURATION_MS, 180000);
  assert.equal(POINTS_GAIN_PER_SEC, 10);
  assert.equal(POINTS_LOSE_PER_SEC, 10);

  const a = { id: "a", pts: 700, tags: 2, spectate: false };
  const b = { id: "b", pts: 400, tags: 4, spectate: false };
  assert.deepEqual(classicPointsWinner([a, b]), { winnerId: "a", winTeam: "it" });

  // Exact points tie falls back to tags.
  const c = { id: "c", pts: 700, tags: 7, spectate: false };
  assert.deepEqual(classicPointsWinner([a, c]), { winnerId: "c", winTeam: "it" });

  // Full tie (points and tags) is a draw.
  const d = { id: "d", pts: 700, tags: 7, spectate: false };
  assert.deepEqual(classicPointsWinner([c, d]), { winnerId: null, winTeam: "draw" });

  // Spectators never win, even with more points.
  const spec = { id: "spec", pts: 9999, tags: 99, spectate: true };
  assert.deepEqual(classicPointsWinner([a, b, spec]), { winnerId: "a", winTeam: "it" });

  assert.equal(classicPointsWinner([]), null);
  assert.equal(classicPointsWinner([spec]), null);
});

test("accruePoints: runners gain, IT bleeds, frozen/spectating accrue nothing", () => {
  const dt = 1;
  const runner = { id: "r", it: false, frozen: false, spectate: false, pts: 100 };
  accruePoints(runner, dt);
  assert.equal(runner.pts, 100 + POINTS_GAIN_PER_SEC * dt);

  const it = { id: "i", it: true, frozen: false, spectate: false, pts: 100 };
  accruePoints(it, dt);
  assert.equal(it.pts, 100 - POINTS_LOSE_PER_SEC * dt);

  // Frozen runner accrues nothing (no reward for being caught in freeze).
  const frozen = { id: "f", it: false, frozen: true, spectate: false, pts: 100 };
  accruePoints(frozen, dt);
  assert.equal(frozen.pts, 100);

  // Spectators accrue nothing.
  const spec = { id: "s", it: false, frozen: false, spectate: true, pts: 100 };
  accruePoints(spec, dt);
  assert.equal(spec.pts, 100);

  // Symmetric rates: a full IT/runner swap nets zero (fair exchange).
  const x = { id: "x", it: false, frozen: false, spectate: false, pts: 0 };
  accruePoints(x, 10);
  x.it = true;
  accruePoints(x, 10);
  assert.equal(x.pts, 0);
});

test("dashMsLeft counts down the next charge while partially spent", () => {  const now = Date.now();
  const base = {
    id: "p", name: "P", color: "#fff", shape: "circle", trail: "none",
    x: 10, y: 10, it: false, bot: false, tags: 0,
    dashUntil: 0, frozen: false, spectate: false, ready: true, lastActiveAt: now,
  };
  const lobbyOf = (dashCdMs, player) => ({
    settings: { dashCdMs },
    players: new Map([[player.id, player]]),
  });

  // Full charges: nothing regenerating.
  const full = publicPlayers(lobbyOf(3000, { ...base, dashCharges: 2, dashNextAt: 0 }))[0];
  assert.equal(full.dashCharges, 2);
  assert.equal(full.dashMsLeft, 0);
  assert.equal(full.dashCdTotal, 3000);

  // One charge spent: ms left must be the live countdown, not 0.
  const partial = publicPlayers(lobbyOf(3000, { ...base, dashCharges: 1, dashNextAt: now + 2000 }))[0];
  assert.equal(partial.dashCharges, 1);
  assert.ok(partial.dashMsLeft > 1000 && partial.dashMsLeft <= 2000, `got ${partial.dashMsLeft}`);

  // Empty: still counts down the next charge.
  const empty = publicPlayers(lobbyOf(3000, { ...base, dashCharges: 0, dashNextAt: now + 2500 }))[0];
  assert.equal(empty.dashCharges, 0);
  assert.ok(empty.dashMsLeft > 1500 && empty.dashMsLeft <= 2500, `got ${empty.dashMsLeft}`);

  // Dash off: everything zeroed.
  const off = publicPlayers(lobbyOf(0, { ...base, dashCharges: 0, dashNextAt: now + 2500 }))[0];
  assert.equal(off.dashCharges, 0);
  assert.equal(off.dashMsLeft, 0);
  assert.equal(off.dashCdTotal, 0);
});

test("selectBotTarget: rotation, commitment, and hysteresis", () => {
  const now = 2_000_000;
  const bot = (over = {}) => ({
    id: "itbot", x: 0, y: 0, vx: 0, vy: 0, frozen: false, spectate: false,
    chaseId: null, chaseUntil: 0, avoidId: null, avoidUntil: 0, ...over,
  });
  const runner = (id, x, extra = {}) => ({
    id, x, y: 0, vx: 0, vy: 0, frozen: false, spectate: false, bot: true, ...extra,
  });

  // Identity-blind: nearer bot picked over farther human.
  const human = runner("human", 300, { bot: false });
  const nearBot = runner("near", 100);
  const self = bot();
  assert.equal(selectBotTarget(self, [self, nearBot, human], now).id, "near");

  // Rotation: recent victim excluded until expiry, then eligible again.
  const it = bot({ avoidId: "human", avoidUntil: now + 3000 });
  const closeHuman = runner("human", 50, { bot: false });
  const farBot = runner("farbot", 300);
  assert.equal(selectBotTarget(it, [it, farBot, closeHuman], now).id, "farbot");
  assert.equal(selectBotTarget(it, [it, farBot, closeHuman], now + 4000).id, "human");

  // Rotation never strands: victim is the only other player -> still chased.
  const solo = bot({ avoidId: "human", avoidUntil: now + 3000 });
  assert.equal(selectBotTarget(solo, [solo, human], now).id, "human");

  // Commitment: slightly closer newcomer does not steal the chase.
  const committed = bot({ chaseId: "far", chaseUntil: now + 1000 });
  const far = runner("far", 200);
  const slightlyNearer = runner("close", 170); // only 15% better, under the 25% margin
  assert.equal(selectBotTarget(committed, [committed, far, slightlyNearer], now).id, "far");

  // Hysteresis override: clearly better candidate (>25%) steals it.
  const muchNearer = runner("close", 100); // 50% better
  assert.equal(selectBotTarget(committed, [committed, far, muchNearer], now).id, "close");

  // Commitment expires -> free reselection.
  const expired = bot({ chaseId: "far", chaseUntil: now - 1 });
  assert.equal(selectBotTarget(expired, [expired, far, slightlyNearer], now).id, "close");

  // Stale chase target (left player) -> reselect among the rest.
  const stale = bot({ chaseId: "gone", chaseUntil: now + 1000 });
  assert.equal(selectBotTarget(stale, [stale, far, slightlyNearer], now).id, "close");

  // Frozen / spectating runners are never picked; nobody left -> null.
  const frozen = runner("f", 10, { frozen: true });
  const spec = runner("s", 10, { spectate: true });
  const self2 = bot();
  assert.equal(selectBotTarget(self2, [self2, frozen, spec], now), null);
  const lone = bot();
  assert.equal(selectBotTarget(lone, [lone], now), null);
});

test("thinkBot commits to the rotated target and aims at it", () => {
  const now = 3_000_000;
  const lobby = {
    settings: cleanSettings({}),
    players: new Map(),
  };
  const it = makeBotPlayer(lobby, 0, "hard");
  it.x = 0; it.y = 0; it.lastX = 0; it.lastY = 0;
  it.it = true;
  it.thinkAt = 0;
  const near = { id: "near", x: 100, y: 0, vx: 0, vy: 0, frozen: false, spectate: false, bot: true };
  const far = { id: "far", x: 400, y: 0, vx: 0, vy: 0, frozen: false, spectate: false, bot: true };
  lobby.players.set(it.id, it);
  lobby.players.set("near", near);
  lobby.players.set("far", far);

  // Stub randomness: hard bots have a 1% mistake roll that would flake this.
  const realRandom = Math.random;
  Math.random = () => 0.999;
  try {
    thinkBot(it, lobby, now);
    assert.equal(it.chaseId, "near");
    assert.ok(it.chaseUntil > now);
    // Aims toward the committed target (positive x direction).
    assert.ok(it.tx > it.x, `tx=${it.tx}`);

    // Rotation respected through thinkBot: avoided victim is skipped.
    it.chaseId = null;
    it.chaseUntil = 0;
    it.thinkAt = 0;
    it.avoidId = "near";
    it.avoidUntil = now + 3000;
    thinkBot(it, lobby, now);
    assert.equal(it.chaseId, "far");
  } finally {
    Math.random = realRandom;
  }
});

test("tryDash keeps the original regen clock when spending the second charge", () => {
  const lobby = { settings: cleanSettings({ dashCdMs: 3000 }) };
  const p = { dashCharges: 2, dashNextAt: 0, dashUntil: 0, dashGraceUntil: 0, lastDx: 1, lastDy: 0 };
  const t0 = 1_000_000;
  assert.ok(tryDash(lobby, p, 1, 0, t0));
  assert.equal(p.dashCharges, 1);
  const firstNext = p.dashNextAt;
  assert.equal(firstNext, t0 + 3000);
  // Second quick spend must not push the already-ticking regen later.
  assert.ok(tryDash(lobby, p, 1, 0, t0 + 500));
  assert.equal(p.dashCharges, 0);
  assert.equal(p.dashNextAt, firstNext);
  // Regen then fires sequentially.
  regenDash(lobby, p, firstNext);
  assert.equal(p.dashCharges, 1);
  assert.ok(p.dashNextAt > firstNext);
});

test("freezeOutcome matches tick rule: mixed human+bot needs everyone frozen", () => {
  const it = { id: "it", tags: 0 };
  const frozenHuman = { id: "h", frozen: true, spectate: false };
  const freeBot = { id: "b", frozen: false, spectate: false, bot: true };
  assert.equal(freezeOutcome([it, frozenHuman, freeBot], it, false), null);
  assert.equal(freezeOutcome([it, frozenHuman, { ...freeBot, frozen: true }], it, false), "it");
});

test("resetForStart auto-joins spectators (Play again parity with End)", () => {
  const lobby = { settings: cleanSettings({ maxPlayers: 8 }), players: new Map(), tagCooldownUntil: 0, endsAt: 0, winnerId: "x", winTeam: "it" };
  lobby.players.set("a", { id: "a", spectate: false, x: 0, y: 0, tags: 5, pts: 900, it: true, bot: false, ready: true });
  lobby.players.set("s", { id: "s", spectate: true, x: -100, y: -100, tags: 9, pts: 1200, it: false, bot: false, ready: false });
  resetForStart(lobby);
  const s = lobby.players.get("s");
  assert.equal(s.spectate, false);
  assert.equal(s.tags, 0);
  assert.equal(s.pts, 0);
  assert.equal(lobby.players.get("a").pts, 0);
  assert.ok(s.x >= 0 && s.y >= 0);
});

test("removePlayer sets a tag cooldown when reassigning IT", () => {
  const lobby = { code: "TEST1", leaderId: "a", settings: cleanSettings({}), players: new Map(), sockets: new Map(), tagCooldownUntil: 0 };
  lobby.players.set("a", { id: "a", it: true, spectate: false, frozen: false, bot: false });
  lobby.players.set("b", { id: "b", it: false, spectate: false, frozen: false, bot: false });
  const before = Date.now();
  removePlayer(lobby, "a");
  assert.ok(lobby.tagCooldownUntil >= before);
  assert.ok([...lobby.players.values()].some((p) => p.it));
});

test("human flee boost constant is sane", () => {
  assert.ok(HUMAN_FLEE_BOOST_MULT > 1 && HUMAN_FLEE_BOOST_MULT < 1.5);
  assert.ok(IDLE_KICK_MS >= 60000);
});
