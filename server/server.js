// 소울파이어 멀티 서버 (1단계: 접속 · 위치 공유 · 채팅)
// Render 무료 웹 서비스에서 실행: node server.js  (PORT는 Render가 넣어 줌)
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
// 접속을 허용할 게임 주소 (쉼표로 여러 개)
const ORIGINS = (process.env.ORIGINS || 'https://dnjfldk63-source.github.io,http://localhost:5192,http://127.0.0.1:5192').split(',').map(s => s.trim());
const MAX_PLAYERS = 200;

const players = new Map();
let seq = 0;

const srv = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(`soulfire server · ${players.size} online`);
});

const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 4096 });

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
const pub = p => ({ id: p.id, name: p.name, cls: p.cls, skin: p.skin, lv: p.lv, map: p.map, x: Math.round(p.x), y: Math.round(p.y), f: p.face, m: p.mv, vd: p.vd, i: p.inst });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = (o, except) => { const s = JSON.stringify(o); for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (!ORIGINS.includes(origin)) { ws.close(1008, 'origin'); return; }
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'full'); return; }
  const p = { id: ++seq, ws, name: '모험가', cls: 'mun', skin: '', lv: 1, map: 'main', inst: 0, x: 0, y: 0, face: 0, mv: 0, vd: 'S', dirty: false, last: Date.now(), chatT: 0, msgs: 0, hello: false };

  ws.on('message', buf => {
    p.last = Date.now();
    if (++p.msgs > 40) return; // 초당 메시지 제한 (아래에서 1초마다 초기화)
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !p.hello) {
      Object.assign(p, profile(m)); p.x = num(m.x, 0, 20000); p.y = num(m.y, 0, 20000); p.hello = true; players.set(p.id, p);
      send(ws, { t: 'welcome', id: p.id, players: [...players.values()].filter(o => o !== p && o.hello).map(pub) });
      broadcast({ t: 'join', p: pub(p) }, p);
      return;
    }
    if (!p.hello) return;
    if (m.t === 'st') { Object.assign(p, profile(m)); broadcast({ t: 'st', p: pub(p) }, p); return; }
    if (m.t === 'pos') {
      p.x = num(m.x, 0, 20000, p.x); p.y = num(m.y, 0, 20000, p.y); p.face = Math.round(num(m.f, -7, 7) * 100) / 100; p.mv = m.m ? 1 : 0;
      p.vd = VD.has(m.vd) ? m.vd : 'S'; if (MAPS.has(m.map)) p.map = m.map; p.inst = m.i ? 1 : 0; p.dirty = true; return;
    }
    if (m.t === 'chat') {
      const now = Date.now(); if (now - p.chatT < 700) return; p.chatT = now;
      const text = clean(m.text, 80); if (!text) return;
      broadcast({ t: 'chat', id: p.id, name: p.name, text });
      return;
    }
  });
  ws.on('close', () => { if (players.delete(p.id)) broadcast({ t: 'leave', id: p.id }, p); });
  ws.on('error', () => {});
});

// 위치는 0.1초마다 같은 맵 사람에게만 묶어서 보냄
setInterval(() => {
  const by = {};
  for (const p of players.values()) { p.msgs = 0; if (p.dirty) { p.dirty = false; (by[p.map] = by[p.map] || []).push([p.id, Math.round(p.x), Math.round(p.y), p.face, p.mv, p.vd, p.inst, p.map]); } }
  for (const p of players.values()) { const L = by[p.map]; if (!L) continue; const rows = L.filter(r => r[0] !== p.id); if (rows.length) send(p.ws, { t: 'pos', L: rows }); }
}, 100);
// 1분 동안 아무 신호가 없으면 끊음
setInterval(() => { const now = Date.now(); for (const p of players.values()) if (now - p.last > 60000) p.ws.terminate(); }, 15000);

srv.listen(PORT, () => console.log('soulfire server on', PORT, 'origins', ORIGINS.join(' ')));
