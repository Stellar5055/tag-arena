# Tag Arena — Crescent Multiplayer

Small authoritative multiplayer tag game. Started from the Crescent multiplayer guide (Node + `ws`), now with lobbies, waiting room, leader settings, and look customization.

**Live demo:** https://tag-arena-2gu4.onrender.com (free Render host — first load can take ~60s if it was asleep, then create a lobby and open the invite in a second tab).

You must create or join a lobby. There is no quick play.

## Try with two tabs

1. `npm install` then `node server.js` (`npm run dev` is the same, `npm test` runs 15 unit tests, `npm run check` syntax-checks `server.js`/`client.js`/tests)
2. Open `http://localhost:3000` (`GET /healthz` returns `{ok:true, lobbies:n}` for hosts/load-balancers)
3. Tab A: set name, color, shape, trail. Keep default settings (1500 points). Press Create lobby. You are leader. Note the lobby code.
4. Tab B: set a different name and look. Enter the code, press Join. Both tabs land in the same waiting room.
5. Non-leaders press Ready up. Tab A (leader) presses Start game.
6. Move with WASD or arrows. On touch, drag on the arena. Space or the Dash button to dash (2 charges, 3s regen by default). Free players gain 10 points per second, IT bleeds 10 per second. Most points when the timer ends wins (or first to the points target).
7. Leader can End game back to waiting, kick players, add or remove bots (adding bots is leader-only). Spectators who joined mid-game auto-join next round (both via End and via Play again). If your socket drops (e.g. Render wake), the client auto-rejoins the same seat.

Solo: create a lobby, press Add bot, then Start (leader is auto-ready; no need to ready up).

## Modes

- Tag (classic): IT transfers on touch. Free players gain 10 points per second, IT bleeds 10 per second (frozen/spectating accrue nothing). Most points when the 3-minute timer ends wins (ties broken by tags, then a draw). First to the points target ends the game early. Timed-only mode (target 0) is decided by the timer alone.
- Freeze tag: IT stays IT and freezes runners on touch. Runners gain points while free (shown for MVP), IT wins by freezing everyone. Runners win by surviving the 2-minute timer.

## Bots

Server bots with three styles, assigned in order chaser, runner, trickster. Each bot also has Easy, Medium, or Hard difficulty picked at Add bot time. Hard is the old full-speed brain. Easy is slow, late, and never predicts. Medium is between.

All bots dash too: Easy only bursts away at very close range, Medium chases and flees in a mid window, Hard uses the full chase and flee windows. Dash uses charges like players.

- Chaser: predicts movement and cuts off near walls. Strong when IT, weaker when fleeing.
- Runner: fast flee, pulls to center, strong separation so it does not stack with others.
- Trickster: jukes sideways when IT is close, wanders more.

All bots steer with difficulty turn rates (easy turns slowly, hard snaps faster) and rethink on their difficulty clock: easy about 380-460ms, medium about 230-310ms, hard about 140-220ms. Easy bots also chase the wrong target 15% of the time. A bot that just became IT waits out its own reaction delay before chasing, instead of reacting instantly.

IT bots are identity-blind: they chase whoever is nearest, never the same player twice in a row (4s rotation), and commit to a target for about 2s before reconsidering (switching early only for a clearly better opportunity).

Leader manages bots with Add bot (pick Easy, Medium, or Hard, max 3, counts toward max players) and Remove per bot in the player list, in waiting and during play.

## Controls

- Move: WASD or arrow keys. Touch: drag on the arena (a joystick ring shows where you grabbed, half-drag = half speed). Dash: Space, Shift, or Dash button. 160ms burst at 3.1x speed, 2 charges, one regen per lobby dash setting (default 3s, sequential). The footer shows dash pips plus a refill bar (green ready, red refilling, black while dashing). Dashing players get a white outline and a bright streak. Old IT gets a brief 1.18x flee boost after a tag.
- Landing: name, color (8), shape (circle, square, triangle), trail (none, dots, line). Create with settings, or join by code. Follow the 3 steps on the page.
- Waiting: press Ready up, leader edits settings and starts when everyone is ready. Anyone can edit their own look. Leader can kick and add or remove bots.
- Game: YOU marker above your own character, frozen players are gray with a FROZEN label. Leader can end back to lobby. Sound and trail toggles are in the top bar.

## How the netcode works

- WebSocket via `ws` (`maxPayload: 8KB`, unknown message types dropped, `input` rate-limited to one per 20ms and fully validated, `createLobby`/`joinLobby`/`addBot`/`startGame` per-socket rate-limited). Client builds the URL from `location.protocol` (`wss:` on https). Heartbeat ping/pong every 30s drops half-open sockets.
- Server keeps `lobbies: Map<code, {leaderId, state, settings, players, sockets}>`. Codes are 5-6 chars (`crypto.randomInt`) and grow on collision. Lobbies expire after 3 hours. Idle humans are kicked after 2 minutes. Human names starting with "bot" (any casing) are reset to Player. Live seats cannot be hijacked: reconnect with the same id is rejected while the old socket is still open.
- Waiting: server sends `{t:"lobby", ...}` on every change. Playing: server ticks at 30Hz with clamped real-dt and sends `{t:"state", ...}`. One bad lobby throws inside try/catch so it can't kill the others. Bots think on their reaction clock and steer every tick.
- Server is authoritative. Clients send `{t:"input", keys, moveVec, dash}` at 20Hz. Server moves at `settings.speed`, preserves analog touch magnitude (<=1), clamps to arena, checks tags by distance with `settings.cooldownMs` and a 200ms post-dash grace for the dasher. Tags are kept as a stat and tiebreak; points (`pts`, runners +10/s, IT -10/s, frozen/spectating 0) decide classic games via `classicPointsWinner` (most points, tags tiebreak, draw last). Freeze needs every active runner (humans and bots) frozen; unfreeze is rate-limited per rescuer with brief grace for the rescued.
- Identity is a random id in `sessionStorage`, so two tabs stay two players. Last lobby code is also kept in `sessionStorage`, so a dropped socket auto-rejoins the same seat on reconnect (cleared on "not found" so stale codes don't retry forever).
- Mid-game joins become spectators (max 4) and auto-join as players on End or Play again. Leader migrates to oldest human on leave. New IT after a leave gets a fresh tag cooldown. Empty lobbies are deleted. Graceful `SIGTERM`/`SIGINT` shutdown closes sockets first.
- Screens switch via `.screen`/`.active` classes and all styling lives in `styles.css`: the strict CSP (`style-src 'self'`, no `unsafe-inline`) silently ignores static `style="..."` attributes, so no inline styles in `index.html`. Programmatic `el.style` sets from script are fine.
- Trails and the joystick ring are client-side. Shapes are drawn on canvas per player. Winner banner is built with `textContent`, never `innerHTML`, so player names cannot inject markup. Spectators are never drawn.
- Files: `server.js` (authoritative sim + lobby netcode, exports pure helpers when required), `client.js` (UI + canvas), `styles.css`, `index.html` (shell), `test/game.test.js` (16 tests).

## Settings (leader, waiting room only)

- maxPlayers 2-8, default 6
- pointsToWin 750/1500/3000/timed-only, default 1500 (classic race target; ignored in freeze)
- speed slow 200 / normal 260 / fast 320, default 260
- cooldown 0.5s / 1s / 2s, default 1s
- arena small 640x480 / classic 800x600 / large 960x720, default classic
- dash recharge off / 3s / 5s (per charge), default 3s. Off disables dash for everyone.
- mode tag / freeze tag, default tag
- bots allowed / off, default allowed (max 3 bots, counts toward maxPlayers)

## Hosting

Listens on `process.env.PORT || 3000`. Needs a long-lived socket server.

- Nest (Hack Club): preferred. Clone, `npm install`, run as a systemd service so it stays up. Free, no card.
- Render free: works, but the service sleeps after 15 min idle and takes about a minute to wake. Mention that in the ship description so reviewers do not think it is broken.
- Do not use Vercel, Netlify, or GitHub Pages for the server: they cannot hold a WebSocket open.

Ship checklist: public repo link, live demo link that stays up, README with the 2-tab test (create, copy invite into a new tab, both ready up, start), a screenshot of two windows side by side, and a note of the lobby settings used.

Ship artifacts here: `screenshot-landing.png` (landing page, default settings: 6 players / 1500 pts / normal / 1s / classic / 3s dash / tag / bots allowed). The two-windows gameplay shot is still manual: open the invite link in a second tab side-by-side, both ready up, leader starts, screenshot mid-chase.

## License

MIT. See [LICENSE](LICENSE).

