// 소울파이어 멀티 서버
// 1단계: 접속 · 위치 공유 · 채팅
// 2단계: 같이 몹 잡기 — 가까이 있는 플레이어끼리 자동으로 무리를 만들고, 무리마다 한 명(담당자)이 몹을 계산해 나눠 줌
// Render 무료 웹 서비스에서 실행: node server.js  (PORT는 Render가 넣어 줌)
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
// 접속을 허용할 게임 주소 (쉼표로 여러 개)
const ORIGINS = (process.env.ORIGINS || 'https://soul-fire.onrender.com,https://dnjfldk63-source.github.io,http://localhost:5192,http://127.0.0.1:5192').split(',').map(s => s.trim());
const MAX_PLAYERS = 200;
const GROUP_R = 1600; // 이 거리(px, 약 50칸) 안에 있으면 같은 무리

const players = new Map();
let seq = 0;

const srv = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(`soulfire server · ${players.size} online`);
});

const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 64 * 1024 });

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const num = (v, lo, hi, d = 0) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
const MAPS = new Set(['main', 'snow', 'crypt']);
const VD = new Set(['S', 'F', 'B']);

function profile(m) {
  const o = {};
  if (m.name != null) o.name = clean(m.name, 16) || '모험가';
  if (m.cls != null) o.cls = clean(m.cls, 12);
  if (m.skin != null) o.skin = clean(m.skin, 16);
  if (m.lv != null) o.lv = num(m.lv, 1, 200, 1) | 0;
  if (m.map != null && MAPS.has(m.map)) o.map = m.map;
  return o;
}
const pub = p => ({ id: p.id, name: p.name, cls: p.cls, skin: p.skin, lv: p.lv, map: p.map, x: Math.round(p.x), y: Math.round(p.y), f: p.face, m: p.mv, vd: p.vd, i: p.inst, d: p.dead });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };
const broadcast = (o, except) => { const s = JSON.stringify(o); for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };
const toId = (id, o) => { const q = players.get(id); if (q) send(q.ws, o); };

// 끊긴 연결 정리: 5초마다 ping, 응답 없으면 종료
setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 5000);
wss.on('connection', (ws, req) => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  const origin = req.headers.origin || '';
  if (!ORIGINS.includes(origin)) { ws.close(1008, 'origin'); return; }
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'full'); return; }
  const p = { id: ++seq, ws, name: '모험가', cls: 'mun', skin: '', lv: 1, map: 'main', inst: 0, dead: 0, x: 0, y: 0, face: 0, mv: 0, vd: 'S', dirty: false, last: Date.now(), chatT: 0, msgs: 0, hello: false, owner: 0, mem: [] };

  ws.on('message', buf => {
    p.last = Date.now();
    if (++p.msgs > 60) return; // 0.1초당 메시지 제한
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !p.hello) {
      Object.assign(p, profile(m)); p.x = num(m.x, 0, 20000); p.y = num(m.y, 0, 20000); p.v = num(m.v, 0, 99) | 0; p.hello = true; players.set(p.id, p);
      send(ws, { t: 'welcome', id: p.id, players: [...players.values()].filter(o => o !== p && o.hello).map(pub) });
      broadcast({ t: 'join', p: pub(p) }, p);
      return;
    }
    if (!p.hello) return;
    if (m.t === 'st') { Object.assign(p, profile(m)); broadcast({ t: 'st', p: pub(p) }, p); return; }
    if (m.t === 'pos') {
      p.x = num(m.x, 0, 20000, p.x); p.y = num(m.y, 0, 20000, p.y); p.face = Math.round(num(m.f, -7, 7) * 100) / 100; p.mv = m.m ? 1 : 0;
      p.vd = VD.has(m.vd) ? m.vd : 'S'; if (MAPS.has(m.map)) p.map = m.map; p.inst = m.i ? 1 : 0; p.dead = m.d ? 1 : 0; p.dirty = true; return;
    }
    if (m.t === 'chat') {
      const now = Date.now(); if (now - p.chatT < 700) return; p.chatT = now;
      const text = clean(m.text, 80); if (!text) return;
      broadcast({ t: 'chat', id: p.id, name: p.name, text });
      return;
    }
    // ── 같이 몹 잡기: 담당자 ↔ 무리원 중계 (같은 무리 안에서만)
    if (m.t === 'mobs' && p.owner === p.id && Array.isArray(m.L)) { p.mobAt = Date.now(); const s = JSON.stringify({ t: 'mobs', L: m.L.slice(0, 160) }); for (const id of p.mem) toId(id, s); return; }
    if (m.t === 'fx' && p.owner === p.id) { const s = JSON.stringify({ t: 'fx', k: clean(m.k, 12), a: Array.isArray(m.a) ? m.a.slice(0, 12) : [] }); for (const id of p.mem) toId(id, s); return; }
    if (m.t === 'kill' && p.owner === p.id) { const s = JSON.stringify({ t: 'kill', n: m.n, by: Array.isArray(m.by) ? m.by.slice(0, 20) : [] }); for (const id of p.mem) toId(id, s); return; }
    if (m.t === 'hurt' && p.owner === p.id && p.mem.includes(m.to)) { toId(m.to, { t: 'hurt', v: num(m.v, 0, 1e9), n: m.n }); return; }
    if (m.t === 'dmg' && p.owner && p.owner !== p.id) { toId(p.owner, { t: 'dmg', from: p.id, n: m.n, v: num(m.v, 0, 1e9), c: m.c ? 1 : 0, kb: m.kb ? 1 : 0, x: num(m.x, 0, 20000), y: num(m.y, 0, 20000) }); return; }
  });
  ws.on('close', () => { if (players.delete(p.id)) { broadcast({ t: 'leave', id: p.id }, p); regroup(); } });
  ws.on('error', () => {});
});

// 무리 나누기: 같은 맵·레이드/폐가 밖·서로 GROUP_R 안이면 이어진 한 무리 → 가장 먼저 들어온 사람(아이디가 가장 작은 사람)이 담당
function regroup() {
  const now = Date.now(), L = [...players.values()].filter(p => p.hello && p.v >= 2), par = new Map(L.map(p => [p.id, p.id]));
  const find = a => { while (par.get(a) !== a) { par.set(a, par.get(par.get(a))); a = par.get(a); } return a; };
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], b = L[j]; if (a.inst || b.inst || a.map !== b.map) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) < GROUP_R) { const ra = find(a.id), rb = find(b.id); if (ra !== rb) par.set(Math.max(ra, rb), Math.min(ra, rb)); }
  }
  const groups = new Map(); for (const p of L) { const r = find(p.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); }
  for (const G of groups.values()) {
    // 담당자: 아이디 순서대로, 최근에 몹 데이터를 안 보내 '응답 없음' 처리된 사람은 건너뜀
    const order = G.map(p => p.id).sort((a, b) => a - b), ok = order.filter(id => !(players.get(id).badUntil > now)), owner = (ok.length ? ok : order)[0], ids = G.map(p => p.id), op = players.get(owner);
    if (G.length > 1) { if (op.ownSince == null || op.owner !== owner) op.ownSince = now; if (now - op.ownSince > 3000 && now - (op.mobAt || 0) > 3000) { op.badUntil = now + 30000; op.ownSince = null; } } else op.ownSince = null;
    for (const p of G) { const mem = ids.filter(id => id !== p.id), key = owner + '|' + mem.join(','); if (key !== p.gkey) { p.gkey = key; p.owner = owner; p.mem = mem; send(p.ws, { t: 'own', o: owner, mem }); } }
  }
}

// 위치는 0.1초마다 같은 맵 사람에게만 묶어서 보냄
setInterval(() => {
  const by = {};
  for (const p of players.values()) { p.msgs = 0; if (p.dirty) { p.dirty = false; (by[p.map] = by[p.map] || []).push([p.id, Math.round(p.x), Math.round(p.y), p.face, p.mv, p.vd, p.inst, p.map, p.dead]); } }
  for (const p of players.values()) { const L = by[p.map]; if (!L) continue; const rows = L.filter(r => r[0] !== p.id); if (rows.length) send(p.ws, { t: 'pos', L: rows }); }
}, 100);
setInterval(regroup, 300);
// 1분 동안 아무 신호가 없으면 끊음
setInterval(() => { const now = Date.now(); for (const p of players.values()) if (now - p.last > 60000) p.ws.terminate(); }, 15000);

srv.listen(PORT, () => console.log('soulfire server on', PORT, 'origins', ORIGINS.join(' ')));
