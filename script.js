/* =====================================================
   NITRO KETIK – Balapan mengetik online (PeerJS / WebRTC)
   Host = pemain pembuat room, bertugas menyimpan state
   dan membagikannya ke semua pemain lain.
   ===================================================== */

/* ---------- Data ---------- */

const PREFIX = "nitroketik-";

const TEXTS = [
  "Belajar mengetik sepuluh jari membuat pekerjaan menjadi lebih cepat dan nyaman. Letakkan jari di baris tengah keyboard, jaga pandangan tetap ke layar, dan latihan setiap hari agar kecepatan terus meningkat.",
  "Pagi itu matahari bersinar cerah di atas kota Bogor. Hujan yang turun semalam meninggalkan udara sejuk dan aroma tanah basah yang menenangkan bagi siapa saja yang berjalan di taman.",
  "Teknologi berkembang sangat pesat dalam beberapa tahun terakhir. Hampir semua orang kini membawa komputer kecil di dalam saku mereka dan menggunakannya untuk belajar, bekerja, serta berkomunikasi.",
  "Kunci untuk menjadi pengetik yang handal adalah ketepatan terlebih dahulu, baru kemudian kecepatan. Pelan tetapi akurat akan membawa Anda jauh lebih cepat daripada terburu-buru lalu sering salah.",
];

const COLORS = ["#c9ccd6", "#a64cff", "#ffd23f", "#2fb8ff", "#ff4f8b"];

const BOTS = [
  ["Si Kilat",    [38, 52]],
  ["Juara Ketik", [30, 45]],
  ["Jari Ajaib",  [22, 36]],
  ["Santai Dulu", [15, 26]],
];


/* ---------- State ---------- */

let user = null;        // { name, color }
let peer = null;        // koneksi PeerJS milik kita
let hostConn = null;    // (guest) koneksi ke host
let conns = {};         // (host) koneksi ke tiap guest
let isHost = false;
let myId = null;
let roomCode = "";

let players = [];       // [{ id, name, color, prog, done, bot?, wpm? }]
let state = "lobby";    // "lobby" | "count" | "race" | "done"
let text = "";
let pos = 0;
let correct = 0;
let errors = 0;
let hasErr = false;
let myDone = null;
let t0 = 0;
let raf = null;
let statTimer = null;
let colorIdx = 0;


/* ---------- Fungsi bantu ---------- */

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => {
    s.classList.toggle("active", s.id === id);
  });
}

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").style.display = "block";
  setTimeout(() => ($("toast").style.display = "none"), 3000);
}

function carSVG(color) {
  return `
    <svg viewBox="0 0 64 38">
      <rect x="2"  y="6"  width="58" height="26" rx="10" fill="${color}"/>
      <rect x="26" y="9"  width="16" height="20" rx="4"  fill="#111a"/>
      <rect x="48" y="9"  width="8"  height="20" rx="3"  fill="#fff8"/>
      <rect x="4"  y="2"  width="12" height="6"  rx="2"  fill="#111"/>
      <rect x="4"  y="30" width="12" height="6"  rx="2"  fill="#111"/>
      <rect x="44" y="2"  width="12" height="6"  rx="2"  fill="#111"/>
      <rect x="44" y="30" width="12" height="6"  rx="2"  fill="#111"/>
    </svg>`;
}

function makePlayer(id, name, color) {
  return { id, name, color, prog: 0, done: null };
}

function freeColor(preferred) {
  const used = players.map((p) => p.color);
  if (!used.includes(preferred)) return preferred;
  return COLORS.find((c) => !used.includes(c)) || preferred;
}

function ranking() {
  return [...players].sort(
    (a, b) => (a.done ?? 1e9) - (b.done ?? 1e9) || b.prog - a.prog
  );
}


/* ---------- Login (disimpan di browser, tanpa database) ---------- */

function loadUser() {
  try {
    return JSON.parse(localStorage.getItem("nitroUser"));
  } catch (e) {
    return null;
  }
}

function saveUser() {
  try {
    localStorage.setItem("nitroUser", JSON.stringify(user));
  } catch (e) { /* abaikan */ }
}

function buildSwatches() {
  $("swatches").innerHTML = COLORS.map(
    (c, i) => `<button data-i="${i}" style="background:${c}" class="${i === colorIdx ? "sel" : ""}"></button>`
  ).join("");
}

$("swatches").addEventListener("click", (e) => {
  if (!e.target.dataset.i) return;
  colorIdx = +e.target.dataset.i;
  buildSwatches();
});

$("loginBtn").addEventListener("click", () => {
  const name = $("nameInput").value.trim();
  if (!name) return toast("Isi nama dulu");
  user = { name: name.slice(0, 12), color: COLORS[colorIdx] };
  saveUser();
  enterMenu();
});

$("logoutBtn").addEventListener("click", () => {
  try { localStorage.removeItem("nitroUser"); } catch (e) { /* abaikan */ }
  user = null;
  show("login");
});

function enterMenu() {
  $("hello").textContent = user.name;
  const link = new URLSearchParams(location.search).get("room");
  if (link) {
    history.replaceState(null, "", location.pathname);
    joinRoom(link);
  } else {
    show("menu");
  }
}


/* ---------- Room: host ---------- */

function createRoom() {
  roomCode = Math.random().toString(36).slice(2, 6).toUpperCase();
  peer = new Peer(PREFIX + roomCode);

  peer.on("open", (id) => {
    myId = id;
    isHost = true;
    state = "lobby";
    players = [makePlayer(id, user.name, user.color)];
    toLobby();
  });

  peer.on("connection", (c) => {
    c.on("data", (d) => hostReceive(c, d));
    c.on("close", () => removePlayer(c.peer));
  });

  peer.on("error", (e) => {
    if (e.type === "unavailable-id") return createRoom(); // kode bentrok, coba lagi
    toast("Koneksi bermasalah, coba lagi");
    leave();
  });
}

function broadcast(msg) {
  Object.values(conns).forEach((c) => c.open && c.send(msg));
}

function sendLobby() {
  broadcast({ t: "lobby", players });
  renderLobby();
}

function hostReceive(c, d) {
  if (d.t === "join") {
    if (state !== "lobby" || players.length >= COLORS.length) {
      c.send({ t: "full" });
      setTimeout(() => c.close(), 300);
      return;
    }
    const color = COLORS.includes(d.color) ? d.color : COLORS[0];
    conns[c.peer] = c;
    players.push(makePlayer(c.peer, String(d.name).slice(0, 12), freeColor(color)));
    sendLobby();
    return;
  }

  const p = players.find((x) => x.id === c.peer);
  if (!p) return;
  if (d.t === "prog") p.prog = Math.min(text.length, +d.pos || 0);
  if (d.t === "done" && p.done === null) p.done = +d.time;
}

function removePlayer(id) {
  players = players.filter((p) => p.id !== id);
  delete conns[id];
  if (state === "lobby") sendLobby();
}

function hostStart() {
  players = players.filter((p) => !p.bot);

  if ($("botsOn").checked) {
    BOTS.forEach((b, i) => {
      if (players.length >= COLORS.length) return;
      const [min, max] = b[1];
      players.push({
        id: "bot" + i, name: b[0], bot: true,
        color: freeColor(COLORS[i + 1]),
        wpm: min + Math.random() * (max - min),
        prog: 0, done: null,
      });
    });
  }

  text = TEXTS[Math.floor(Math.random() * TEXTS.length)];
  players.forEach((p) => { p.prog = 0; p.done = null; });
  broadcast({ t: "start", text, players });
  beginRace();
}

function hostBack() {
  players = players.filter((p) => !p.bot);
  broadcast({ t: "back", players });
  toLobby();
}


/* ---------- Room: guest ---------- */

function joinRoom(code) {
  roomCode = String(code).toUpperCase().trim();
  if (roomCode.length !== 4) return toast("Kode room harus 4 huruf");

  peer = new Peer();

  peer.on("open", (id) => {
    myId = id;
    isHost = false;
    hostConn = peer.connect(PREFIX + roomCode);
    hostConn.on("open", () => {
      hostConn.send({ t: "join", name: user.name, color: user.color });
    });
    hostConn.on("data", guestReceive);
    hostConn.on("close", () => {
      toast("Room ditutup oleh host");
      leave();
    });
  });

  peer.on("error", (e) => {
    toast(e.type === "peer-unavailable" ? "Room tidak ditemukan" : "Koneksi bermasalah");
    leave();
  });
}

function guestReceive(d) {
  if (d.t === "full") {
    toast("Room penuh atau sudah dimulai");
    return leave();
  }
  if (d.t === "lobby") { players = d.players; state = "lobby"; toLobby(); }
  if (d.t === "start") { players = d.players; text = d.text; beginRace(); }
  if (d.t === "state") players = d.players;
  if (d.t === "back")  { players = d.players; toLobby(); }
}

function leave() {
  cancelAnimationFrame(raf);
  clearInterval(statTimer);
  if (peer) peer.destroy();
  peer = hostConn = null;
  conns = {};
  players = [];
  isHost = false;
  state = "lobby";
  $("result").style.display = "none";
  if (user) show("menu");
}


/* ---------- Lobby ---------- */

function toLobby() {
  cancelAnimationFrame(raf);
  clearInterval(statTimer);
  state = "lobby";
  $("result").style.display = "none";
  renderLobby();
  show("lobby");
}

function renderLobby() {
  $("code").textContent = roomCode;
  $("plist").innerHTML = players
    .map((p) => `
      <div class="pitem">
        <span class="dot" style="background:${p.color}"></span>
        ${esc(p.name)}${p.id === myId ? " (Anda)" : ""}
      </div>`)
    .join("");
  $("hostCtl").style.display = isHost ? "" : "none";
  $("waitMsg").style.display = isHost ? "none" : "";
}

$("copyLink").addEventListener("click", (e) => {
  e.preventDefault();
  const link = `${location.origin}${location.pathname}?room=${roomCode}`;
  navigator.clipboard.writeText(link).then(() => toast("Link disalin!"));
});


/* ---------- Balapan ---------- */

function buildTrack() {
  $("track").innerHTML = players
    .map((p) => `
      <div class="lane ${p.id === myId ? "me" : ""}">
        <div class="name">${esc(p.name)}</div>
        <div class="rail">
          <div class="car" id="car-${p.id}">${carSVG(p.color)}</div>
        </div>
        <div class="finish"></div>
      </div>`)
    .join("");
}

function renderText() {
  let html = `<span class="ok">${esc(text.slice(0, pos))}</span>`;

  if (pos < text.length) {
    const current = text[pos] === " " ? "&nbsp;" : esc(text[pos]);
    html += `<span class="cur ${hasErr ? "err" : ""}">${current}</span>`;
    html += `<span class="rest">${esc(text.slice(pos + 1))}</span>`;
  }
  $("txt").innerHTML = html;
}

function beginRace() {
  pos = correct = errors = 0;
  hasErr = false;
  myDone = null;
  state = "count";

  buildTrack();
  renderText();
  updateHud(0);
  show("game");
  $("result").style.display = "none";
  $("hidden").focus();

  let count = 3;
  $("msg").textContent = count;

  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      $("msg").textContent = count;
      return;
    }

    clearInterval(timer);
    $("msg").textContent = "GO!";
    setTimeout(() => ($("msg").textContent = ""), 600);

    state = "race";
    t0 = performance.now();
    if (isHost) statTimer = setInterval(() => broadcast({ t: "state", players }), 100);
    loop();
  }, 900);
}

function loop() {
  const elapsed = (performance.now() - t0) / 1000;
  const me = players.find((p) => p.id === myId);

  if (me) {
    me.prog = pos;
    if (myDone !== null) me.done = myDone;
  }

  // Host menjalankan bot
  if (isHost) {
    players.filter((p) => p.bot && p.done === null).forEach((p, i) => {
      const jitter = 1 + 0.15 * Math.sin(elapsed * 1.3 + i * 2);
      p.prog = Math.min(text.length, (elapsed * p.wpm * jitter * 5) / 60);
      if (p.prog >= text.length) p.done = elapsed;
    });
  }

  players.forEach(moveCar);
  updateHud(elapsed);

  // Pemain selesai mengetik
  if (myDone === null && pos >= text.length) {
    myDone = elapsed;
    state = "done";
    if (me) me.done = elapsed;
    if (!isHost) hostConn.send({ t: "done", time: elapsed });
    $("result").style.display = "flex";
  }

  if (state === "done") fillResult();

  // Semua pemain selesai -> akhiri balapan
  if (players.every((p) => p.done !== null)) {
    if (isHost) {
      clearInterval(statTimer);
      broadcast({ t: "state", players });
    }
    return;
  }

  raf = requestAnimationFrame(loop);
}

function moveCar(p) {
  const car = $("car-" + p.id);
  if (!car) return;
  const rail = car.parentElement.clientWidth - 64;
  car.style.left = (p.prog / text.length) * rail + "px";
}

function updateHud(elapsed) {
  const wpm = elapsed > 1 ? Math.round(pos / 5 / (elapsed / 60)) : 0;
  const total = correct + errors;

  $("wpm").textContent = wpm;
  $("acc").textContent = (total ? Math.round((correct / total) * 100) : 100) + "%";
  $("time").textContent = elapsed.toFixed(1) + "s";

  if (state === "race" || state === "done") {
    const rank = ranking().findIndex((p) => p.id === myId) + 1;
    $("pos").textContent = rank + "/" + players.length;
  }
}

function fillResult() {
  const order = ranking();
  const rank = order.findIndex((p) => p.id === myId) + 1;
  const total = correct + errors;
  const wpm = Math.round(text.length / 5 / (myDone / 60));

  $("rtitle").textContent = rank === 1 ? "🏆 Juara 1!" : `Finis di posisi ${rank}`;
  $("rstats").innerHTML =
    `Kecepatan: <b>${wpm} KPM</b> · ` +
    `Akurasi: <b>${total ? Math.round((correct / total) * 100) : 100}%</b> · ` +
    `Waktu: <b>${myDone.toFixed(1)}s</b>`;

  $("rlist").innerHTML = order
    .map((p) => {
      const status = p.done !== null ? ` – ${p.done.toFixed(1)}s` : " – masih mengetik...";
      return `<li class="${p.id === myId ? "me" : ""}">${esc(p.name)}${status}</li>`;
    })
    .join("");

  $("backBtn").style.display = isHost ? "" : "none";
  $("rwait").style.display = isHost ? "none" : "";
}


/* ---------- Input pemain ---------- */

function press(ch) {
  if (state !== "race" || pos >= text.length) return;

  if (ch === text[pos]) {
    pos++;
    correct++;
    hasErr = false;
    if (!isHost) hostConn.send({ t: "prog", pos });
  } else {
    errors++;
    hasErr = true;
  }
  renderText();
}

$("hidden").addEventListener("input", (e) => {
  for (const ch of e.target.value) press(ch);
  e.target.value = "";
});

$("textbox").addEventListener("click", () => $("hidden").focus());


/* ---------- Tombol ---------- */

$("createBtn").addEventListener("click", createRoom);
$("joinBtn").addEventListener("click", () => joinRoom($("codeInput").value));
$("startBtn").addEventListener("click", hostStart);
$("backBtn").addEventListener("click", hostBack);
$("leaveBtn").addEventListener("click", leave);


/* ---------- Mulai ---------- */

buildSwatches();
user = loadUser();
if (user) {
  colorIdx = Math.max(0, COLORS.indexOf(user.color));
  enterMenu();
}