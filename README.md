# Tag Arena — Crescent Multiplayer

Small authoritative multiplayer tag game. Started from the Crescent multiplayer guide (Node + `ws`), now with lobbies, waiting room, leader settings, and look customization.

You must create or join a lobby. There is no quick play.

## Try with two tabs

1. `npm install` then `node server.js`
2. Open `http://localhost:3000`
3. Tab A: set name, color, shape, trail. Keep default settings (tags to win 10). Press Create lobby. You are leader. Note the 4-letter code.
4. Tab B: set a different name and look. Enter the code, press Join. Both tabs land in the same waiting room.
5. Tab A (leader): optionally change max players, speed, arena, cooldown. Press Start game.
6. Move with WASD or arrows. On touch, drag on the arena. Each tab is one player. If IT touches you, you become IT. First to 10 tags wins.
7. Leader can End game back to waiting, kick players, add or remove bots.

Solo: create a lobby, press Add bot, then Start.

## Bots

Server bots with three styles, assigned in order chaser, runner, trickster:

- Chaser: predicts movement and cuts off near walls. Strong when IT, weaker when fleeing.
- Runner: fast flee, pulls to center, strong separation so it does not stack with others.
- Trickster: jukes sideways when IT is close, wanders more.

All bots avoid walls instead of pushing into corners, spread from each other, get a short flee boost after being tagged, and freeze new IT for 350ms to break instant re-tag loops. If a bot barely moves for ~1s it picks a center escape waypoint.

Leader manages bots with Add bot (pick Easy, Medium, or Hard, max 3, counts toward max players) and Remove per bot in the player list, in waiting and during play.

Easy is slow, reacts late, never predicts or jukes, wanders a lot. Medium is in between. Hard is the previous behavior and is meant to be hard to tag.

## Controls

- Move: WASD or arrow keys. Touch: drag on arena.
- Landing: name, color (8), shape (circle, square, triangle), trail (none, dots, line). Create with settings, or join by code.
- Waiting: leader edits settings, starts. Anyone can edit their own look. Leader can kick and add or remove bots.
- Game: YOU marker above your own character. Leader can end back to lobby.

## How the netcode works

- WebSocket via `ws`. Client builds the URL with `location.origin.replace("http","ws")`.
- Server keeps `lobbies: Map<code, {leaderId, state, settings, players, sockets}>`. Code is 4 chars.
- Waiting: server sends `{t:"lobby", ...}` on every change. Playing: server ticks at 30Hz and sends `{t:"state", ...}`. Bots think at ~6Hz (reaction delay per style) and steer every tick.
- Server is authoritative. Clients send `{t:"input", keys, moveVec}` at 20Hz. Server moves at `settings.speed`, clamps to arena, checks tags by distance with `settings.cooldownMs`, increments `tags`, sets `winnerId` at `settings.tagsToWin` (0 is endless).
- Identity is a random id in `sessionStorage`, so two tabs stay two players.
- Mid-game joins are rejected for now. Leader migrates to oldest human on leave. Empty lobbies are deleted.
- Trails are client-side: each client keeps last 24 render positions per player and draws dots or a line if that player chose it. Shapes are drawn on canvas per player.

## Settings (leader, waiting room only)

- maxPlayers 2-8, default 6
- tagsToWin 3/5/10/20/endless, default 10
- speed slow 200 / normal 260 / fast 320, default 260
- cooldown 0.5s / 1s / 2s, default 1s
- arena small 640x480 / classic 800x600 / large 960x720, default classic
- bots allowed / off, default allowed (max 3 bots, counts toward maxPlayers)

## Hosting

Listens on `process.env.PORT || 3000`. Needs a long-lived socket server, so Render or Nest, not Vercel or GitHub Pages.
