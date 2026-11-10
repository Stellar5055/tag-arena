const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  lobbies,
  makeCode,
  cleanLook,
  cleanSettings,
  cleanDifficulty,
  cleanName,
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
