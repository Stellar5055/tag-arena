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
  publicPlayers,
  selectBotTarget,
  thinkBot,
  isTagTouch,
  classicTagTarget,
  classicTimeWinner,
  freezeOutcome,
  RADIUS,
  CLASSIC_DURATION_MS,
} = require("../server.js");

test("cleanSettings clamps to allowed values", () => {
  const d = cleanSettings({});
  assert.equal(d.maxPlayers, 6);
  assert.equal(d.tagsToWin, 10);
  assert.equal(d.speed, 260);

  const bad = cleanSettings({ maxPlayers: 99, tagsToWin: 7, speed: 999, arena: "nope", gameMode: "nope", dashCdMs: 123 });
  assert.equal(bad.maxPlayers, 8);
  assert.equal(bad.tagsToWin, 10);
  assert.equal(bad.speed, 260);
  assert.equal(bad.arena, "classic");
  assert.equal(bad.gameMode, "classic");
  assert.equal(bad.dashCdMs, 3000);

  const endless = cleanSettings({ tagsToWin: 0, dashCdMs: 0 });
  assert.equal(endless.tagsToWin, 0);
  assert.equal(endless.dashCdMs, 0);
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
  assert.equal(cleanName("  ", false), "Player");
  assert.equal(cleanName("Ada", false), "Ada");
});

test("makeCode is unique against existing lobbies", () => {
  lobbies.set("ABCD", {});
  try {
    for (let i = 0; i < 200; i++) {
      const c = makeCode();
      assert.ok(typeof c === "string" && c.length >= 4 && c.length <= 8);
      assert.ok(!lobbies.has(c), `collision on ${c}`);
    }
  } finally {
    lobbies.delete("ABCD");
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
  const it = { id: "it", tags: 1 };
  const a = { id: "a", frozen: true, spectate: false };
  const b = { id: "b", frozen: true, spectate: false };
  assert.equal(freezeOutcome([it, a, b], it, 10, false), "it");

  const c = { id: "c", frozen: false, spectate: false };
  assert.equal(freezeOutcome([it, a, c], it, 10, false), null);
  assert.equal(freezeOutcome([it, a, c], it, 10, true), "runners");

  const scorer = { id: "it", tags: 10 };
  assert.equal(freezeOutcome([scorer, c], scorer, 10, false), "it");
});

test("classic timer: most tags wins, ties draw, spectators excluded", () => {
  assert.equal(CLASSIC_DURATION_MS, 180000);

  const a = { id: "a", tags: 7, spectate: false };
  const b = { id: "b", tags: 4, spectate: false };
  assert.deepEqual(classicTimeWinner([a, b]), { winnerId: "a", winTeam: "it" });

  const c = { id: "c", tags: 7, spectate: false };
  assert.deepEqual(classicTimeWinner([a, c]), { winnerId: null, winTeam: "draw" });

  // Spectators never win, even with more tags.
  const spec = { id: "spec", tags: 99, spectate: true };
  assert.deepEqual(classicTimeWinner([a, b, spec]), { winnerId: "a", winTeam: "it" });

  assert.equal(classicTimeWinner([]), null);
  assert.equal(classicTimeWinner([spec]), null);
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
