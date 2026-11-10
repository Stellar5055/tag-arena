# Tag Arena — Crescent Multiplayer

Small authoritative multiplayer tag game. Started from the Crescent multiplayer guide (Node + `ws`), now with lobbies, waiting room, leader settings, and look customization.

**Live demo:** https://tag-arena-2gu4.onrender.com (free Render host — first load can take ~60s if it was asleep, then create a lobby and open the invite in a second tab).

You must create or join a lobby. There is no quick play.

## Try with two tabs

1. `npm install` then `node server.js` (`npm run dev` is the same, `npm test` runs 6 unit tests, `npm run check` syntax-checks `server.js`/`client.js`/tests)
2. Open `http://localhost:3000` (`GET /healthz` returns `{ok:true, lobbies:n}` for hosts/load-balancers)
3. Tab A: set name, color, shape, trail. Keep default settings (tags to win 10). Press Create lobby. You are leader. Note the lobby code.
4. Tab B: set a different name and look. Enter the code, press Join. Both tabs land in the same waiting room.
5. Both tabs press Ready up. Tab A (leader) presses Start game.
6. Move with WASD or arrows. On touch, drag on the arena. Space or the Dash button to dash (2 charges, 4s regen). If IT touches you, you become IT. First to 10 tags wins.
7. Leader can End game back to waiting, kick players, add or remove bots (adding bots is leader-only). Spectators who joined mid-game auto-join next round. If your socket drops (e.g. Render wake), the client auto-rejoins the same seat.

Solo: create a lobby, press Add bot, Ready up, then Start.

## Modes

- Tag (classic): IT transfers on touch. First to tagsToWin wins, or most tags when the 3-minute timer ends (tie is a draw). Endless mode (tagsToWin 0) is decided by the timer alone.
- Freeze tag: IT stays IT and freezes runners on touch. Frozen runners stop moving until a free teammate touches them. IT wins by freezing everyone or reaching tagsToWin. Runners win by surviving the 2-minute timer.

## Bots

Server bots with three styles, assigned in order chaser, runner, trickster. Each bot also has Easy, Medium, or Hard difficulty picked at Add bot time. Hard is the old full-speed brain. Easy is slow, late, and never predicts. Medium is between.

All bots dash too: Easy only bursts away at very close range, Medium chases and flees in a mid window, Hard uses the full chase and flee windows. Dash uses charges like players.

- Chaser: predicts movement and cuts off near walls. Strong when IT, weaker when fleeing.
- Runner: fast flee, pulls to center, strong separation so it does not stack with others.
- Trickster: jukes sideways when IT is close, wanders more.

All bots steer with difficulty turn rates (easy turns slowly, hard snaps faster) and rethink on their difficulty clock: easy about 380-460ms, medium about 230-310ms, hard about 140-220ms. Easy bots also chase the wrong target 15% of the time. A bot that just became IT waits out its own reaction delay before chasing, instead of reacting instantly.

Leader manages bots with Add bot (pick Easy, Medium, or Hard, max 3, counts toward max players) and Remove per bot in the player list, in waiting and during play.

## Controls

- Move: WASD or arrow keys. Touch: drag on the arena (a joystick ring shows where you grabbed). Dash: Space, Shift, or Dash button. 160ms burst at 3.1x speed, 2 charges, one regen every 4s (or per lobby dash setting). The footer shows dash pips plus a refill bar (green ready, red refilling, black while dashing). Dashing players get a white outline and a bright streak.
- Landing: name, color (8), shape (circle, square, triangle), trail (none, dots, line). Create with settings, or join by code. Follow the 3 steps on the page.
- Waiting: press Ready up, leader edits settings and starts when everyone is ready. Anyone can edit their own look. Leader can kick and add or remove bots.
- Game: YOU marker above your own character, frozen players are gray with a FROZEN label. Leader can end back to lobby. Sound and trail toggles are in the top bar.

## How the netcode works

- WebSocket via `ws` (`maxPayload: 8KB`, unknown message types dropped, `input` rate-limited to one per 20ms and fully validated). Client builds the URL with `location.origin.replace("http","ws")`.
- Server keeps `lobbies: Map<code, {leaderId, state, settings, players, sockets}>`. Codes start at 4 chars and grow to 6 on collision. Lobbies expire after 3 hours. Human names starting with "bot" are reset to Player.
- Waiting: server sends `{t:"lobby", ...}` on every change. Playing: server ticks at 30Hz and sends `{t:"state", ...}`. Bots think on their reaction clock and steer every tick.
- Server is authoritative. Clients send `{t:"input", keys, moveVec, dash}` at 20Hz. Server moves at `settings.speed`, clamps to arena, checks tags by distance with `settings.cooldownMs` and a 200ms post-dash grace for the dasher, increments `tags`, sets `winnerId` at `settings.tagsToWin` (0 is endless). Tag helpers (`isTagTouch`, `classicTagTarget`, `freezeOutcome`) live in `server.js` and are covered by `test/game.test.js`.
- Identity is a random id in `sessionStorage`, so two tabs stay two players. Last lobby code is also kept in `sessionStorage`, so a dropped socket auto-rejoins the same seat on reconnect.
- Mid-game joins become spectators (max 4) and auto-join as players on End. Leader migrates to oldest human on leave. Empty lobbies are deleted.
- Trails and the joystick ring are client-side. Shapes are drawn on canvas per player. Winner banner is built with `textContent`, never `innerHTML`, so player names cannot inject markup.
- Files: `server.js` (authoritative sim + lobby netcode, exports pure helpers when required), `client.js` (UI + canvas), `styles.css`, `index.html` (shell), `test/game.test.js` (6 tests).

## Settings (leader, waiting room only)

- maxPlayers 2-8, default 6
- tagsToWin 3/5/10/20/endless, default 10
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

Ship artifacts here: `screenshot-landing.png` (landing page, default settings: 6 players / 10 tags / normal / 1s / classic / 3s dash / tag / bots allowed). The two-windows gameplay shot is still manual: open the invite link in a second tab side-by-side, both ready up, leader starts, screenshot mid-chase.

## License

MIT. See [LICENSE](LICENSE).

