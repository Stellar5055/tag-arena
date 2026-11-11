const COLORS = ["#ffe066","#8ce99a","#74c0fc","#ffa8a8","#da77f2","#ff922b","#63e6be","#e599f7"];
const SHAPES = ["circle","square","triangle"];
const TRAILS = ["none","dots","line"];

if (!sessionStorage.getItem("tag-id")) sessionStorage.setItem("tag-id", Math.random().toString(36).slice(2));
const myId = sessionStorage.getItem("tag-id");

const profile = {
  name: sessionStorage.getItem("tag-name") || ("Player-" + myId.slice(0,4)),
  color: sessionStorage.getItem("tag-color") || COLORS[Math.floor(Math.random()*COLORS.length)],
  shape: sessionStorage.getItem("tag-shape") || "circle",
  trail: sessionStorage.getItem("tag-trail") || "none",
};
if (!COLORS.includes(profile.color)) profile.color = COLORS[0];
if (!SHAPES.includes(profile.shape)) profile.shape = "circle";
if (!TRAILS.includes(profile.trail)) profile.trail = "none";

function saveProfile() {
  sessionStorage.setItem("tag-name", profile.name);
  sessionStorage.setItem("tag-color", profile.color);
  sessionStorage.setItem("tag-shape", profile.shape);
  sessionStorage.setItem("tag-trail", profile.trail);
}

const $ = (id) => document.getElementById(id);
const canvas = $("game"), ctx = canvas.getContext("2d");
const errBox = $("error");
let errTimer = null;
function showError(m) {
  errBox.textContent = m; errBox.classList.add("show");
  clearTimeout(errTimer); errTimer = setTimeout(()=>errBox.classList.remove("show"), 3500);
}

let socket = null;
let lobby = null; // last lobby msg
let game = null; // last state msg
let screen = "landing";
let renderPos = {};
let trailHist = {};

function setConn(on, text) {
  $("connDot").className = "dot" + (on===true?" on":on===false?" off":"");
  $("connText").textContent = text;
}
function show(which) {
  screen = which;
  // Class-driven (see .screen/.screen.active in styles.css): inline
  // style="display" is ignored under a strict style-src CSP, so toggling
  // classes is the only robust switcher. classList is script-set, CSP-fine.
  $("screen-landing").classList.toggle("active", which==="landing");
  $("screen-waiting").classList.toggle("active", which==="waiting");
  $("screen-game").classList.toggle("active", which==="game");
  if (which==="landing") $("roomLabel").textContent = "lobby select";
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host;
}

function resetRoundUiState() {
  lastMyTags = 0;
  lastWinnerSeen = false;
  for (const k of Object.keys(lastDashingMap)) delete lastDashingMap[k];
  renderPos = {};
  trailHist = {};
  lastRosterSig = "";
  lastBoardSig = "";
}

function connect() {
  setConn(null, "connecting");
  socket = new WebSocket(wsUrl());
  socket.addEventListener("open", ()=> {
    setConn(true,"connected");
    // Auto-rejoin after a drop / Render wake: re-announce the same seat.
    try {
      const lastCode = sessionStorage.getItem("tag-lobby");
      if (lastCode && !lobby && !game) {
        send({ t:"joinLobby", code: lastCode, id: myId, name: profile.name,
          look:{ color: profile.color, shape: profile.shape, trail: profile.trail } });
      }
    } catch {}
  });
  socket.addEventListener("close", ()=> { setConn(false,"offline — retrying"); setTimeout(connect,1200); });
  socket.addEventListener("message", (e)=>{
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t==="lobby") {
      if (!lobby || lobby.code !== m.code) resetRoundUiState();
      lobby = m; game = null;
      try { sessionStorage.setItem("tag-lobby", m.code); } catch {}
      renderWaiting(); show("waiting");
    }
    else if (m.t==="state") {
      if (!game || game.code !== m.code) resetRoundUiState();
      game = m; lobby = m;
      try { sessionStorage.setItem("tag-lobby", m.code); } catch {}
      renderGame(); show("game");
    }
    else if (m.t==="error") {
      showError(m.msg);
      // Stale invite/reconnect codes otherwise retry forever on every reconnect.
      if (/not found/i.test(m.msg)) { try { sessionStorage.removeItem("tag-lobby"); } catch {} }
    }
    else if (m.t==="kicked") { lobby=null; game=null; resetRoundUiState(); try { sessionStorage.removeItem("tag-lobby"); } catch {} showError("You were kicked."); show("landing"); }
    else if (m.t==="left") { lobby=null; game=null; resetRoundUiState(); try { sessionStorage.removeItem("tag-lobby"); } catch {} show("landing"); }
  });
}

function send(o){ if (socket && socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify(o)); }
function currentSettings() {
  return {
    maxPlayers: parseInt($("s-max").value,10),
    pointsToWin: parseInt($("s-win").value,10),
    speed: parseInt($("s-speed").value,10),
    cooldownMs: parseInt($("s-cool").value,10),
    arena: $("s-arena").value,
    allowBots: $("s-bots").value==="on",
    dashCdMs: parseInt($("s-dash").value,10),
    gameMode: $("s-mode").value,
  };
}
// Points race is classic-only: the target row hides entirely in freeze.
function syncTargetRow() {
  const freeze = $("s-mode").value === "freeze";
  $("s-winrow").style.display = freeze ? "none" : "";
  $("s-win").disabled = freeze;
}

// pickers
function buildPickers() {
  const mk = (el, items, get, set, render) => {
    const box = $(el); box.innerHTML="";
    items.forEach(v=>{
      const b=document.createElement("button");
      if (el.includes("color")) { b.className="sw"+(get()===v?" sel":""); b.style.background=v; b.title=v; }
      else { b.textContent=v; b.className=get()===v?"sel":""; }
      b.onclick=()=>{ set(v); saveProfile(); buildPickers(); pushLook(); };
      box.appendChild(b);
    });
  };
  mk("colors", COLORS, ()=>profile.color, v=>profile.color=v);
  mk("shapes", SHAPES, ()=>profile.shape, v=>profile.shape=v);
  mk("trails", TRAILS, ()=>profile.trail, v=>profile.trail=v);
  mk("wcolors", COLORS, ()=>profile.color, v=>profile.color=v);
  mk("wshapes", SHAPES, ()=>profile.shape, v=>profile.shape=v);
  mk("wtrails", TRAILS, ()=>profile.trail, v=>profile.trail=v);
  $("name").value = profile.name;
  $("wname").value = profile.name;
}
function pushLook(){
  if (screen!=="waiting") return;
  send({ t:"updateLook", name: profile.name, look:{ color:profile.color, shape:profile.shape, trail:profile.trail } });
}

$("name").addEventListener("change", ()=>{ profile.name=$("name").value.slice(0,16)||profile.name; saveProfile(); });
$("wname").addEventListener("change", ()=>{ profile.name=$("wname").value.slice(0,16)||profile.name; saveProfile(); $("name").value=profile.name; pushLook(); });

$("create").onclick = ()=>{
  profile.name = $("name").value.slice(0,16).trim() || profile.name; saveProfile();
  send({ t:"createLobby", id: myId, name: profile.name, look:{color:profile.color,shape:profile.shape,trail:profile.trail}, settings: currentSettings() });
};
$("join").onclick = ()=>{
  profile.name = $("name").value.slice(0,16).trim() || profile.name; saveProfile();
  const code = $("code").value.toUpperCase().trim();
  if (!code) { showError("Enter a lobby code."); return; }
  send({ t:"joinLobby", code, id: myId, name: profile.name, look:{color:profile.color,shape:profile.shape,trail:profile.trail} });
};
$("code").addEventListener("keydown",(e)=>{ if(e.key==="Enter") $("join").click(); });
$("s-mode").addEventListener("change", syncTargetRow);

["w-max","w-win","w-speed","w-cool","w-arena","w-bots","w-dash","w-mode"].forEach(id=>{
  $(id).addEventListener("change", ()=>{
    if (!lobby) return;
    if (lobby.leaderId!==myId) return;
    send({ t:"updateSettings", settings:{
      maxPlayers: parseInt($("w-max").value,10),
      pointsToWin: parseInt($("w-win").value,10),
      speed: parseInt($("w-speed").value,10),
      cooldownMs: parseInt($("w-cool").value,10),
      arena: $("w-arena").value,
      allowBots: $("w-bots").value==="on",
      dashCdMs: parseInt($("w-dash").value,10),
      gameMode: $("w-mode").value,
    }});
  });
});

$("start").onclick = ()=> send({t:"startGame"});
$("readyBtn").onclick = ()=> send({t:"toggleReady"});
$("gend").onclick = ()=> send({t:"endGame"});
$("again").onclick = ()=> send({t:"startGame"});
$("tobby").onclick = ()=> send({t:"endGame"});
$("wleave").onclick = ()=> send({t:"leaveLobby"});
$("gleave").onclick = ()=> send({t:"leaveLobby"});
$("wbot").onclick = ()=> send({t:"addBot", difficulty: $("wbotdiff").value});
$("gaddbot").onclick = ()=> send({t:"addBot", difficulty: $("gbotdiff").value});

// sound + reduced motion prefs
let soundOn = (sessionStorage.getItem("tag-sound") || "on") === "on";
let trailsOn = (sessionStorage.getItem("tag-trails") || "on") === "on";
function syncPrefButtons(){
  $("soundBtn").textContent = soundOn ? "Sound on" : "Sound off";
  $("soundBtn").setAttribute("aria-pressed", soundOn ? "true" : "false");
  $("motionBtn").textContent = trailsOn ? "Trails on" : "Trails off";
  $("motionBtn").setAttribute("aria-pressed", trailsOn ? "true" : "false");
}
let audioCtx = null;
function beep(freq, durMs, vol) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.value = vol || 0.05;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    setTimeout(()=>{ try { o.stop(); } catch {} }, durMs);
  } catch {}
}
$("copy").onclick = async ()=>{
  if (!lobby) return;
  const url = location.origin + location.pathname + "?lobby=" + lobby.code;
  try { await navigator.clipboard.writeText(url); $("copy").textContent="Copied!"; setTimeout(()=>{ try { $("copy").textContent="Copy invite link"; } catch {} },1200); }
  catch { showError("Copy this link: " + url); }
};
errBox.addEventListener("click", ()=>{ errBox.classList.remove("show"); clearTimeout(errTimer); });

// waiting render: keep IT/you/watching as badges; lead/ready/idle/difficulty
// are demoted to quiet text so rows stay scannable.
function playerRow(p, isLead, canKick){
  const li=document.createElement("li");
  const sw=document.createElement("span"); sw.className="swatch"; sw.style.background=p.color;
  const sh=document.createElement("span"); sh.className="shape-ico"; sh.textContent=p.shape==="circle"?"O":p.shape==="square"?"S":"T";
  const nm=document.createElement("span"); nm.className="pname"; nm.textContent=p.name;
  li.append(sw,sh,nm);
  if (p.bot) {
    const df=document.createElement("span"); df.className="tags"; df.textContent=p.difficulty||"bot"; li.appendChild(df);
  }
  const tg=document.createElement("span"); tg.className="tags"; tg.textContent=(p.tags||0)+" tags"; li.appendChild(tg);
  if (p.id===lobby.leaderId){ const t=document.createElement("span"); t.className="tags"; t.textContent="· lead"; li.appendChild(t); }
  if (p.id===myId){ const b=document.createElement("span"); b.className="badge you"; b.textContent="you"; li.appendChild(b); }
  if (p.spectate){ const b=document.createElement("span"); b.className="badge"; b.textContent="watching"; li.appendChild(b); }
  if (!p.bot && !p.spectate && p.ready){ const t=document.createElement("span"); t.className="tags"; t.textContent="· ready"; li.appendChild(t); }
  if (p.idle){ const t=document.createElement("span"); t.className="tags"; t.textContent="· idle"; li.appendChild(t); }
  if (p.away){ const t=document.createElement("span"); t.className="tags"; t.textContent="· reconnecting"; li.appendChild(t); }
  if (canKick && p.id!==myId){
    if (p.bot) {
      const k=document.createElement("button"); k.className="kick"; k.textContent="remove";
      k.onclick=()=>send({t:"removeBot",targetId:p.id}); li.appendChild(k);
    } else {
      const k=document.createElement("button"); k.className="kick"; k.textContent="kick";
      k.onclick=()=>send({t:"kick",targetId:p.id}); li.appendChild(k);
    }
  }
  return li;
}

function renderWaiting(){
  if (!lobby) return;
  $("roomLabel").textContent = "lobby " + lobby.code;
  $("wcode").textContent = lobby.code;
  const isLead = lobby.leaderId===myId;
  // Role-split actions: non-leaders only ready up; the start button never
  // shows disabled to someone who can't press it.
  $("readyBtn").style.display = isLead ? "none" : "";
  $("start").style.display = isLead ? "" : "none";
  $("start").disabled = !isLead;
  $("lockHint").textContent = isLead ? "You are leader. Changes apply to everyone." : "Only the leader can edit.";
  ["w-max","w-win","w-speed","w-cool","w-arena","w-bots","w-dash","w-mode"].forEach(id=>{ $(id).disabled=!isLead; });
  // Non-leaders get a one-line read-only summary instead of dead controls.
  $("wsettingsCard").style.display = isLead ? "" : "none";
  const sum = $("wsettingsSummary");
  if (isLead) {
    sum.style.display = "none";
  } else {
    const s = lobby.settings;
    sum.style.display = "";
    sum.textContent = "Room: " + s.maxPlayers + " max · " +
      (s.gameMode === "freeze" ? "freeze tag" : s.pointsToWin > 0 ? "first to " + s.pointsToWin + " pts" : "most points") +
      " · " + (s.arena === "small" ? "small" : s.arena === "large" ? "large" : "classic") + " arena · " +
      (s.speed >= 320 ? "fast" : s.speed <= 200 ? "slow" : "normal") + " speed";
  }
  $("wsettingsCard").classList.toggle("is-locked", !isLead);
  $("w-max").value=String(lobby.settings.maxPlayers);
  $("w-win").value=String(lobby.settings.pointsToWin);
  $("w-speed").value=String(lobby.settings.speed);
  $("w-cool").value=String(lobby.settings.cooldownMs);
  $("w-arena").value=lobby.settings.arena;
  $("w-bots").value=lobby.settings.allowBots?"on":"off";
  $("w-dash").value=String(lobby.settings.dashCdMs ?? 3000);
  $("w-mode").value=lobby.settings.gameMode || "classic";
  // Points race is classic-only: the target row hides entirely in freeze.
  const freezePicked = (lobby.settings.gameMode || "classic") === "freeze";
  $("w-winrow").style.display = freezePicked ? "none" : "";
  $("w-win").disabled = !isLead || freezePicked;
  // Bot management is leader-only and hidden entirely when bots are off.
  $("wbotrow").style.display = (!isLead || !lobby.settings.allowBots) ? "none" : "";
  const ul=$("wplayers"); ul.innerHTML="";
  const seated = lobby.players.filter(p=>!p.spectate);
  seated.forEach(p=>ul.appendChild(playerRow(p,true,isLead)));
  const watchers = lobby.players.filter(p=>p.spectate);
  if (watchers.length > 0) {
    const li=document.createElement("li"); li.className="spec-note";
    li.textContent = "Watching next round: " + watchers.map(p=>p.name).join(", ");
    ul.appendChild(li);
  }
  const me = lobby.players.find(p=>p.id===myId);
  $("readyBtn").textContent = me && me.ready ? "Unready" : "Ready up";
  $("readyBtn").disabled = !me || me.bot || me.spectate;
  if (seated.length<2) {
    $("whint").textContent="Need at least 2 in the room (or add a bot), then leader starts.";
  } else {
    const waiting = seated.filter(p=>!p.bot && p.id!==lobby.leaderId && !p.ready);
    if (waiting.length > 0) $("whint").textContent="Waiting for " + waiting.map(p=>p.name).slice(0,3).join(", ") + " to ready up.";
    else $("whint").textContent = isLead ? "Everyone is ready. Press Start." : "Everyone is ready. Waiting for leader to start.";
  }
  history.replaceState(null,"","?lobby="+lobby.code);
}

// game render + draw
const keys={};
let pendingDash=false;
let lastMyTags=0, lastWinnerSeen=false;
// Roster/board rebuild guards: renderGame runs at 30Hz, but rebuilding the
// player list DOM on every tick destroys remove buttons mid-click (mousedown
// lands, innerHTML wipes it, mouseup lands nowhere -> click never fires).
// Rebuild only when the visible content actually changes.
let lastRosterSig="", lastBoardSig="";
let bannerTimer=null, lastBannerKey="";
const lastDashingMap={};
let dragStartXY=null;
addEventListener("keydown",(e)=>{
  const k=e.key.toLowerCase();
  if(k==="arrowup"||k==="w")keys.up=true;
  if(k==="arrowdown"||k==="s")keys.down=true;
  if(k==="arrowleft"||k==="a")keys.left=true;
  if(k==="arrowright"||k==="d")keys.right=true;
  if(k===" "||k==="shift"){ if(!e.repeat) pendingDash=true; }
  if(["arrowup","arrowdown","arrowleft","arrowright"," "].includes(k))e.preventDefault();
});
addEventListener("keyup",(e)=>{
  const k=e.key.toLowerCase();
  if(k==="arrowup"||k==="w")keys.up=false;
  if(k==="arrowdown"||k==="s")keys.down=false;
  if(k==="arrowleft"||k==="a")keys.left=false;
  if(k==="arrowright"||k==="d")keys.right=false;
});
let dragVec=null, dragging=false;
function canvasPos(e){ const r=canvas.getBoundingClientRect(); return {x:(e.clientX-r.left)*(canvas.width/r.width), y:(e.clientY-r.top)*(canvas.height/r.height)}; }
canvas.addEventListener("pointerdown",(e)=>{dragging=true;dragStartXY={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener("pointermove",(e)=>{
  if(!dragging)return;
  const p=canvasPos(e), me=renderPos[myId];
  if(!me)return;
  const dx=p.x-me.x, dy=p.y-me.y, d=Math.hypot(dx,dy);
  dragVec = d>12 ? {x:dx/d*Math.min(1,d/120), y:dy/d*Math.min(1,d/120)} : null;
});
addEventListener("pointerup",()=>{dragging=false;dragVec=null;dragStartXY=null;});
$("dashBtn").onclick=()=>{ pendingDash=true; };
$("soundBtn").onclick=()=>{ soundOn=!soundOn; sessionStorage.setItem("tag-sound",soundOn?"on":"off"); syncPrefButtons(); };
$("motionBtn").onclick=()=>{ trailsOn=!trailsOn; sessionStorage.setItem("tag-trails",trailsOn?"on":"off"); syncPrefButtons(); };
// Delegated: the #players roster is rebuilt on change, so per-button onclick
// handlers would die with the old DOM. One persistent listener survives.
$("players").addEventListener("click",(e)=>{
  const b=e.target && e.target.closest ? e.target.closest("[data-remove-bot]") : null;
  if(b && b.getAttribute("data-remove-bot")) send({t:"removeBot",targetId:b.getAttribute("data-remove-bot")});
});
setInterval(()=>{ if(screen==="game") { send({t:"input",keys,moveVec:dragVec,dash:pendingDash||undefined}); pendingDash=false; } },50);

function renderGame(){
  if(!game)return;
  $("roomLabel").textContent="lobby "+game.code;
  if (game.arena && (canvas.width!==game.arena.w || canvas.height!==game.arena.h)) {
    canvas.width=game.arena.w; canvas.height=game.arena.h;
  }
  $("gtitle").textContent="Arena — "+game.code;
  const it=game.players.find(p=>p.it);
  const me=game.players.find(p=>p.id===myId);
  const mode = game.settings ? game.settings.gameMode : "classic";
  const sorted = mode === "freeze"
    ? game.players.filter(p=>!p.spectate).slice().sort((a,b)=>(b.tags||0)-(a.tags||0))
    : game.players.filter(p=>!p.spectate).slice().sort((a,b)=>((b.pts||0)-(a.pts||0)) || ((b.tags||0)-(a.tags||0)));
  // One pill for IT status: persistent, glanceable, no banner parsing needed.
  const itEl = $("itLabel");
  if (it && it.id === myId) {
    itEl.textContent = "YOU'RE IT";
    itEl.classList.add("is-it");
  } else if (it) {
    itEl.textContent = "IT: " + it.name;
    itEl.classList.remove("is-it");
  } else {
    itEl.textContent = "";
    itEl.classList.remove("is-it");
  }
  // Clock lives in the head; the foot target is static text (no wrapping).
  const fmtClock=(ms)=>{ const s=Math.ceil(ms/1000); return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); };
  $("clockLabel").textContent = (game.timeLeft != null && !game.winnerId && !game.winTeam) ? fmtClock(game.timeLeft) : "--:--";
  if (mode === "freeze") {
    $("scoreLabel").textContent = "freeze everyone";
  } else {
    const ptw=game.settings?game.settings.pointsToWin:1500;
    $("scoreLabel").textContent = ptw>0 ? ("first to "+ptw+" pts") : "most points";
  }
  // Single dash meter: pips only. The recharging pip shows live fill.
  // dashHud stays empty mid-game (only dash-off / spectating states).
  if (me && !me.spectate) {
    const charges = me.dashCharges ?? 2;
    const max = me.dashMax || 2;
    const left = me.dashMsLeft || 0;
    const total = me.dashCdTotal || 4000;
    const pips = $("dashPips");
    if (total === 0) {
      $("dashHud").textContent = "dash off";
      pips.innerHTML = "";
      const btn = $("dashBtn");
      if (btn) btn.disabled = true;
    } else {
      $("dashHud").textContent = "";
      pips.innerHTML = "";
      for (let i = 0; i < max; i++) {
        const d = document.createElement("span");
        if (i < charges) {
          d.className = "pip full";
        } else if (i === charges) {
          // Next charge up: fill 0→100% as dashMsLeft counts down.
          const pct = total > 0 ? Math.max(4, Math.min(100, Math.round((1 - left / total) * 100))) : 4;
          d.className = "pip";
          const f = document.createElement("span");
          f.className = "fill";
          f.style.width = pct + "%";
          d.appendChild(f);
        } else {
          d.className = "pip";
        }
        pips.appendChild(d);
      }
      const btn = $("dashBtn");
      if (btn) btn.disabled = charges <= 0 || !!game.winnerId || !!game.winTeam;
    }
  } else {
    $("dashHud").textContent = me && me.spectate ? "spectating" : "";
    const pips = $("dashPips");
    if (pips) pips.innerHTML = "";
  }
  // sound triggers: track last tags + dashing + winner
  if (me) {
    const myTags = (game.players.find(p=>p.id===myId)||{}).tags || 0;
    if (myTags > (lastMyTags||0)) beep(660, 90, 0.06);
    lastMyTags = myTags;
    const wasDashing = !!lastDashingMap[myId];
    if (!!me.dashing && !wasDashing) beep(220, 70, 0.04);
  }
  const wasWinner = !!lastWinnerSeen;
  if ((game.winnerId || game.winTeam) && !wasWinner) beep(880, 140, 0.06);
  lastWinnerSeen = !!(game.winnerId || game.winTeam);
  for (const p of game.players) lastDashingMap[p.id] = !!p.dashing;
  const bn=$("banner");
  const w=$("winner");
  if (game.winnerId || game.winTeam){
    w.classList.add("show");
    // Built with textContent (no innerHTML) so player names cannot inject markup.
    const wt = $("winnerText");
    wt.textContent = "";
    const head = document.createElement("b");
    const detail = document.createElement("span");
    if (game.winTeam === "runners") {
      head.textContent = "Runners survive the timer.";
      detail.textContent = " " +
        (game.leaderId===myId ? "Press Play again or Back to lobby." : "Waiting for leader.");
    } else if (game.winTeam === "draw") {
      const scored = game.players.filter(p=>!p.spectate);
      let best = -Infinity;
      for (const p of scored) best = Math.max(best, p.pts || 0);
      const tied = scored.filter(p=>(p.pts||0)===best).map(p=>p.name).slice(0,3).join(", ");
      head.textContent = "Draw — " + (tied || "nobody") + " tied at " + best + " points.";
      detail.textContent = " " +
        (game.leaderId===myId ? "Press Play again or Back to lobby." : "Waiting for leader.");
    } else {
      const winp=game.players.find(p=>p.id===game.winnerId);
      const frozenNote = mode === "freeze" ? "froze everyone" : "with "+(winp?winp.pts:0)+" points ("+(winp?winp.tags:0)+" tags)";
      head.textContent = (winp?winp.name:"Someone")+" wins ("+frozenNote+").";
      detail.textContent = " " +
        (game.leaderId===myId ? "Press Play again or Back to lobby so others can join." : "Waiting for leader. New players can join once leader goes back to lobby.");
    }
    wt.append(head, detail);
    // Final standings, textContent-built so names cannot inject markup.
    // Styled like the player lists: rank + swatch + shape + name + tags + badges.
    // Gated on a signature: state arrives at 30Hz but standings are static
    // once the winner is set, so skip the rebuild when nothing changed.
    const boardSig = (game.winTeam || "") + "|" + (game.winnerId || "") + "|" +
      sorted.map(p=>[p.id,p.pts,p.color,p.name].join(":")).join("|") +
      "|" + game.leaderId + "|" + myId;
    if (boardSig !== lastBoardSig) {
      lastBoardSig = boardSig;
    const board = $("winBoard");
    board.textContent = "";
    let topPts = -Infinity;
    for (const p of sorted) topPts = Math.max(topPts, p.pts || 0);
    // Trimmed standings: top 3 plus your own row so the overlay stays small.
    const selfPos = sorted.findIndex(p=>p.id===myId);
    const rows = sorted.slice(0, 3).map(p=>({p, rank: sorted.indexOf(p)+1, sep:false}));
    if (selfPos >= 3) {
      rows.push({sep:true});
      rows.push({p: sorted[selfPos], rank: selfPos+1, sep:false});
    }
    const addBoardRow = (p, rank) => {
      const li = document.createElement("li");
      const isWon = game.winTeam === "draw" ? (p.pts || 0) === topPts : p.id === game.winnerId;
      if (isWon) li.className = "won";
      const rk = document.createElement("span");
      rk.className = "rank";
      rk.textContent = String(rank).padStart(2, "0");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = p.color;
      const nm = document.createElement("span");
      nm.className = "pname";
      nm.textContent = p.name;
      const pt = document.createElement("span");
      pt.className = "pts";
      pt.textContent = (p.pts || 0) + " pts";
      li.append(rk, sw, nm, pt);
      if (isWon) {
        const b = document.createElement("span");
        b.className = "badge win";
        b.textContent = game.winTeam === "draw" ? "tied" : "winner";
        li.appendChild(b);
      }
      if (p.id === myId) {
        const b = document.createElement("span");
        b.className = "badge you";
        b.textContent = "you";
        li.appendChild(b);
      }
      board.appendChild(li);
    };
    rows.forEach(r => {
      if (r.sep) {
        const li = document.createElement("li");
        li.className = "ellipsis";
        li.textContent = "···";
        board.appendChild(li);
      } else {
        addBoardRow(r.p, r.rank);
      }
    });
    }
    $("again").style.display = game.leaderId===myId ? "" : "none";
    $("tobby").style.display = game.leaderId===myId ? "" : "none";
    bn.textContent="Game over."; bn.className="";
  } else {
    w.classList.remove("show");
    if(!me){bn.textContent="You are out of this round.";bn.className="";}
    else if(me.spectate){bn.textContent="Spectating — you join next round.";bn.className="";}
    else if(me.frozen){bn.textContent="Frozen — a free teammate must touch you.";bn.className="safe";}
    else if(mode==="freeze" && me.id===(it&&it.id)){bn.textContent="You are IT — freeze everyone before time runs out.";bn.className="is-it";}
    else if(me.id===(it&&it.id)){bn.textContent="You are IT — go tag someone.";bn.className="is-it";}
    else if(it){bn.textContent=it.name+" is IT — keep your distance.";bn.className="safe";}
  }
  // Slim roster: rank + swatch + name + pts, plus you/frozen markers and the
  // leader's bot-remove. Tags, idle, difficulty and the IT badge are gone:
  // the arena (ring + labels) already shows who's IT.
  const rosterSig = sorted.map(p=>[p.id,p.pts,p.it,p.frozen,p.away,p.color,p.name].join(":")).join("|") +
    "|" + game.players.filter(p=>p.spectate).map(p=>p.id+":"+p.name).join("|") +
    "|" + game.leaderId + "|" + myId;
  if (rosterSig !== lastRosterSig) {
    lastRosterSig = rosterSig;
  const ul=$("players"); ul.innerHTML="";
  const isLeadGame = game.leaderId===myId;
  sorted.forEach((p,i)=>{
    const li=document.createElement("li");
    if (p.it) li.className = "is-it-row";
    const rk=document.createElement("span");rk.className="rank";rk.textContent=String(i+1).padStart(2,"0");li.appendChild(rk);
    const sw=document.createElement("span");sw.className="swatch";sw.style.background=p.color;
    const nm=document.createElement("span");nm.className="pname";nm.textContent=p.name;
    li.append(sw,nm);
    const pt=document.createElement("span");pt.className="pts";pt.textContent=(p.pts||0)+" pts";li.appendChild(pt);
    if(p.frozen){const b=document.createElement("span");b.className="badge";b.textContent="frozen";li.appendChild(b);}
    if(p.away){const t=document.createElement("span");t.className="tags";t.textContent="· reconnecting";li.appendChild(t);}
    if(p.id===myId){const b=document.createElement("span");b.className="badge you";b.textContent="you";li.appendChild(b);}
    if (isLeadGame && p.bot) {
      const k=document.createElement("button");k.className="kick";k.textContent="remove";
      k.setAttribute("data-remove-bot", p.id);li.appendChild(k);
    }
    ul.appendChild(li);
  });
  const specs = game.players.filter(p=>p.spectate);
  if (specs.length > 0) {
    const li=document.createElement("li"); li.className="spec-note";
    li.textContent = "Watching: " + specs.map(p=>p.name).join(", ");
    ul.appendChild(li);
  }
  }
  // Transient toast: re-arm the fade whenever the message changes so the
  // banner never blocks the canvas mid-chase. The IT pill carries state.
  const bannerKey = bn.textContent + "|" + bn.className;
  if (bannerKey !== lastBannerKey) {
    lastBannerKey = bannerKey;
    bn.classList.remove("fade");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(()=>{ bn.classList.add("fade"); }, 2800);
  }
  // Bot management is leader-only.
  $("gbotrow").style.display = game.leaderId===myId ? "" : "none";
  $("gend").disabled = !(game.leaderId===myId);
  history.replaceState(null,"","?lobby="+game.code);
}

function drawShape(x,y,size,shape,color,isIt,dashing){
  ctx.beginPath();
  if(shape==="square"){ ctx.rect(x-size,y-size,size*2,size*2); }
  else if(shape==="triangle"){ ctx.moveTo(x,y-size-2); ctx.lineTo(x+size+2,y+size); ctx.lineTo(x-size-2,y+size); ctx.closePath(); }
  else { ctx.arc(x,y,size,0,Math.PI*2); }
  ctx.fillStyle=color; ctx.fill();
  ctx.lineWidth=dashing?4:2.5; ctx.strokeStyle=dashing?"#fffdf7":"#000"; ctx.stroke();
  if(isIt){
    ctx.beginPath(); ctx.arc(x,y,size+9,0,Math.PI*2);
    ctx.strokeStyle="#ff6b6b"; ctx.lineWidth=2; ctx.setLineDash([7,5]); ctx.stroke(); ctx.setLineDash([]);
  }
}
function drawGrid(){
  ctx.fillStyle="#131109"; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle="rgba(255,253,247,0.09)";
  for(let x=40;x<canvas.width;x+=40) for(let y=40;y<canvas.height;y+=40) ctx.fillRect(x-1,y-1,2,2);
  ctx.strokeStyle="rgba(255,253,247,0.22)"; ctx.lineWidth=2; ctx.strokeRect(4,4,canvas.width-8,canvas.height-8);
}
function draw(){
  drawGrid();
  const rawList = game?game.players:(lobby?lobby.players:[]);
  // Spectators live at -100,-100 and must never render or leave trails.
  const list = rawList.filter(p=>!p.spectate);
  for(const p of list){
    if(!renderPos[p.id]){renderPos[p.id]={x:p.x,y:p.y};trailHist[p.id]=[];}
    renderPos[p.id].x+=(p.x-renderPos[p.id].x)*0.3;
    renderPos[p.id].y+=(p.y-renderPos[p.id].y)*0.3;
    const h=trailHist[p.id]||(trailHist[p.id]=[]);
    h.push({x:renderPos[p.id].x,y:renderPos[p.id].y});
    if(h.length>24)h.shift();
  }
  for(const id of Object.keys(renderPos)){
    if(!list.some(p=>p.id===id)){delete renderPos[id];delete trailHist[id];}
  }
  // trails under players (off when reduced motion is on)
  for(const p of list){
    if (!trailsOn) continue;
    const h=trailHist[p.id]||[];
    if(p.trail==="dots"&&h.length>1){
      for(let i=0;i<h.length;i+=3){
        const a=i/h.length*0.5;
        ctx.beginPath();ctx.arc(h[i].x,h[i].y,3,0,Math.PI*2);
        ctx.fillStyle=p.color+"";ctx.globalAlpha=a;ctx.fill();ctx.globalAlpha=1;
      }
    } else if(p.trail==="line"&&h.length>1){
      ctx.beginPath();ctx.moveTo(h[0].x,h[0].y);
      for(let i=1;i<h.length;i++)ctx.lineTo(h[i].x,h[i].y);
      ctx.strokeStyle=p.color;ctx.globalAlpha=0.6;ctx.lineWidth=3;ctx.stroke();ctx.globalAlpha=1;
    }
    // dash leaves a bright streak for everyone
    if (p.dashing && h.length > 1) {
      const n = h.length;
      ctx.beginPath();ctx.moveTo(h[Math.max(0,n-6)].x,h[Math.max(0,n-6)].y);
      ctx.lineTo(h[n-1].x,h[n-1].y);
      ctx.strokeStyle="#fffdf7";ctx.globalAlpha=0.9;ctx.lineWidth=4;ctx.stroke();ctx.globalAlpha=1;
    }
  }
  // players, me last so self stays on top
  const ordered=list.slice().sort((a,b)=>(a.id===myId?1:0)-(b.id===myId?1:0));
  for(const p of ordered){
    const r=renderPos[p.id]||p;
    const frozen = !!p.frozen;
    drawShape(r.x,r.y,15,p.shape||"circle",frozen?"#868e96":p.color,p.it && !frozen,!!p.dashing);
    // Labels stay minimal mid-chase: IT, yourself, and frozen runners only.
    // Everyone else is color + shape (full names live in the roster).
    const showLabel = screen==="game" && (p.id===myId || (p.it && !frozen) || frozen);
    if (showLabel) {
      ctx.font="12px ui-monospace, Menlo, Consolas, monospace";ctx.textAlign="center";
      const label=(p.it && !frozen ?"IT ":"")+(frozen?"FROZEN ":"")+p.name;
      ctx.lineWidth=3;ctx.strokeStyle="rgba(0,0,0,0.85)";ctx.strokeText(label,r.x,r.y-24);
      ctx.fillStyle="#fffdf7";ctx.fillText(label,r.x,r.y-24);
    }
    if(p.id===myId&&screen==="game"){
      // Subtle under-glow marks you; no boxed tag pulling eyes downward.
      ctx.beginPath();ctx.arc(r.x,r.y+2,19,0,Math.PI*2);
      ctx.strokeStyle="rgba(255,224,102,0.85)";ctx.lineWidth=2;ctx.stroke();
    }
  }
  // touch joystick visual (small + faint so it never covers the action)
  if (dragging && dragStartXY && screen==="game") {
    const r=canvas.getBoundingClientRect();
    const sx=dragStartXY.x-r.left, sy=dragStartXY.y-r.top;
    ctx.beginPath();ctx.arc(sx,sy,18,0,Math.PI*2);
    ctx.strokeStyle="rgba(255,253,247,0.35)";ctx.lineWidth=1.5;ctx.stroke();
    if (dragVec) {
      ctx.beginPath();ctx.arc(sx+dragVec.x*28,sy+dragVec.y*28,9,0,Math.PI*2);
      ctx.fillStyle="rgba(255,253,247,0.5)";ctx.fill();
    }
  }
  requestAnimationFrame(draw);
}

// init
(function init(){
  show("landing");
  const q=new URLSearchParams(location.search).get("lobby");
  if(q) { $("code").value=q.toUpperCase(); $("code").focus(); }
  buildPickers();
  syncPrefButtons();
  syncTargetRow();
  connect();
  draw();
})();
