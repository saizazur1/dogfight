/**
 * net.js — rooms over PeerJS (README "Online contract", lane NET). Star topology: every client talks only to the host, over one
 * reliable, ordered PeerJS DataConnection with binary serialization (BinaryPack: typed snapshots go as ArrayBuffers, rare lobby /
 * event messages as small objects). Free cloud signalling (0.peerjs.com) and PeerJS's default STUN / TURN.
 *
 *   const net = createNet();
 *   const code = await net.host({ name, color });      // a 5-character room (no 0/O/1/I/L); host peer id `dogfightio-<code>`
 *   await net.join(code, { name, color });              // throws { code: 'not-found'|'full'|'failed', message }
 *   net.code, net.isHost, net.seat, net.players         // players: [{ seat, name, color, ping (ms), isHost, isMe }] by seat
 *   net.onPlayers = (players) => {};  net.onStart = (cfg) => {};  net.onClose = (reason) => {};   // reason 'host-left' | 'lost'
 *   net.start({ minutes, bots })      // host only; again after a match = a rematch. cfg = { minutes, bots, seed, players }; fires
 *                                     // onStart on the host too, and on every client
 *   net.leave()                       // safe twice; never fires our own onClose
 * For game.js / netgame.js (lane NET):
 *   net.listen(fn) -> off             // fn(type, data, seat): 'msg' (a game message from that seat; the host's are seat 0),
 *                                     // 'join' (a player joined a running match: data = player), 'leave' (seat left)
 *                                     // game messages that arrive before anyone listens are kept (up to 512) for the next listener
 *   net.send(to, msg)                 // host: to a seat, or -1 = every client; client: to the host
 *   net.endMatch()                    // host: the match is over (late joiners wait in the room again)
 *   net.connected, net.started, net.cfg, await net.traffic() -> { sent, received } bytes so far (WebRTC stats)
 * Joining a RUNNING match is allowed: the joiner takes the lowest free seat (an AI's seat if AIs fill the field) and gets the
 * start message at once. join() throws 'full' only when 8 people are in. Seats 0..7, the host is 0. Pings every 2 s (players[].ping);
 * 10 s of silence drops a client (its jet goes to an AI) or, on a client, closes with 'lost'.
 * RELAY FALLBACK (config.js SUPABASE): when a client can't open a direct connection (office / school networks, phone carriers)
 * it joins through a Supabase Realtime broadcast channel instead. The host listens on `df-<code>` for knocks; each relayed client
 * gets its own channel `df-<code>-<id>` with a DataConnection look-alike (relayConn) on both ends, so everything above is
 * unchanged. Supabase's free plan allows 100 messages/s per project (sent + received), so a relay packet goes at most RELAY_HZ
 * times a second each way: the newest binary snapshot/state (older ones are dropped: they are full states) plus every object
 * message queued since, in order. ~40 messages/s per relayed friend; direct friends cost nothing. `?relayonly` (test) skips direct.
 */
import * as PJ from 'peerjs';
import { RELAY, SUPABASE } from './config.js';

let relayP = null;
/** STUN + the Metered TURN relay's servers (config.js RELAY), fetched once per page; null = PeerJS's defaults (no relay). */
function relayServers() {
  if (!RELAY.app || !RELAY.apiKey) return Promise.resolve(null);
  return relayP ||= (async () => {
    try {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 5000);
      const r = await fetch(`https://${RELAY.app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(RELAY.apiKey)}`, { signal: ac.signal });
      clearTimeout(to);
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) throw new Error(`relay answered ${r.status}`);
      return [{ urls: 'stun:stun.l.google.com:19302' }, ...list];
    } catch (e) { console.warn('net: relay unavailable, direct connections only', e); relayP = null; return null; }
  })();
}

const Peer = PJ.Peer || PJ.default;
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0 O 1 I L
export const SEATS = 8;
const PALETTE = ['#c8362c', '#2b62cf', '#e0a020', '#3a9d5a', '#8a4fd0', '#e7e7ea', '#2a2d33', '#e0663a'];   // the start screen's 8 colours (menu.js COLORS): a clash moves to another one of them
const RELAY_HZ = 10, DIRECT_MS = 9000, HAS_SB = !!(SUPABASE.url && SUPABASE.anonKey);
const PREFIX = 'dogfightio-', PING_MS = 2000, SILENT_MS = 10000, JOIN_MS = 15000, OPEN_MS = 12000, BACKLOG = 512;

const err = (code, message) => { const e = new Error(message || code); e.code = code; return e; };
/** a random room code */
let sbP = null;
/** the Supabase client, loaded on first use (only a relayed game pays for the download) */
function supabase() {
  return sbP ||= import('@supabase/supabase-js').then(({ createClient }) => createClient(SUPABASE.url, SUPABASE.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: { eventsPerSecond: 40 } } }));
}
const toB64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b) => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
/** Opens a Supabase broadcast channel and calls back when subscribed (or failed). */
async function sbChannel(topic, onStatus) {
  const sb = await supabase(), ch = sb.channel(topic, { config: { broadcast: { self: false, ack: false } } });
  return { sb, ch, go: () => ch.subscribe(onStatus) };
}
/**
 * A PeerJS DataConnection look-alike over one Supabase broadcast channel: on('open'|'data'|'close'|'error'), send(msg), close(),
 * open, relay: true. Batched at RELAY_HZ: { o: [objects in order], b: newest ArrayBuffer as base64 }.
 */
export async function relayConn(topic) {
  const ev = { open: [], data: [], close: [], error: [] }, objs = [];
  const fire = (k, a) => { for (const f of ev[k]) try { f(a); } catch (e) { console.error('net: relay listener', e); } };
  let bin = null, iv = 0, dead = false;
  const c = {
    open: false, relay: true, peerConnection: null,
    on(k, f) { ev[k]?.push(f); return c; },
    send(msg) { if (msg instanceof ArrayBuffer) bin = msg; else if (ArrayBuffer.isView(msg)) bin = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength); else objs.push(msg); },
    close() { if (dead) return; dead = true; flush(); clearInterval(iv); setTimeout(() => { try { S.sb.removeChannel(S.ch); } catch { /* gone */ } }, 300); const was = c.open; c.open = false; if (was) fire('close'); },
  };
  function flush() {
    if (!c.open || (!bin && !objs.length)) return;
    const payload = {};
    if (objs.length) payload.o = objs.splice(0);
    if (bin) { payload.b = toB64(bin); bin = null; }
    S.ch.send({ type: 'broadcast', event: 'p', payload }).catch?.((e) => console.warn('net: relay send', e));
  }
  const S = await sbChannel(topic, (status) => {
    if (status === 'SUBSCRIBED') { if (!c.open && !dead) { c.open = true; iv = setInterval(flush, 1000 / RELAY_HZ); fire('open'); } }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { if (c.open) c.close(); else if (!dead) fire('error', { type: `relay-${status.toLowerCase()}` }); }
  });
  S.ch.on('broadcast', { event: 'p' }, ({ payload }) => {
    if (dead || !payload) return;
    if (Array.isArray(payload.o)) for (const m of payload.o) fire('data', m);
    if (typeof payload.b === 'string') { let b = null; try { b = fromB64(payload.b); } catch { /* bad packet */ } if (b) fire('data', b); }
  });
  S.go();
  return c;
}

export function newCode() {
  const r = new Uint32Array(5); crypto.getRandomValues(r);
  let s = ''; for (let i = 0; i < 5; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}
const cleanName = (n) => String(n ?? '').replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Pilot';
const cleanColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#e7e7ea');
const nowMs = () => performance.now();

export function createNet() {
  let peer = null, hostConn = null, timer = 0, closed = true, lastHeard = 0, me = null, knock = null;   // knock: the host's relay door
  const recs = new Set(), listeners = new Set(), backlog = [];
  let list = [];   // players (internal records), by seat

  const net = {
    code: null, isHost: false, seat: -1, connected: false, started: false, cfg: null,
    get players() { return list.map((p) => ({ seat: p.seat, name: p.name, color: p.color, ping: p.ping, isHost: p.seat === 0, isMe: p.seat === net.seat })); },
    onPlayers: null, onStart: null, onClose: null,
    host, join, start, leave, send, listen, endMatch() { net.started = false; }, traffic,
  };

  const call = (name, arg) => { try { net[name]?.(arg); } catch (e) { console.error(`net: ${name} handler`, e); } };
  const emitPlayers = () => call('onPlayers', net.players);
  function deliver(type, data, seat) {
    if (!listeners.size) { if (type === 'msg' && backlog.length < BACKLOG) backlog.push([type, data, seat]); return; }
    for (const fn of listeners) try { fn(type, data, seat); } catch (e) { console.error('net: listener', e); }
  }
  function listen(fn) {
    listeners.add(fn);
    while (backlog.length) { const [t, d, s] = backlog.shift(); try { fn(t, d, s); } catch (e) { console.error('net: listener', e); } }
    return () => listeners.delete(fn);
  }

  /** a Peer with this id (or a random one), open on the signalling server (with the relay's servers when configured) */
  async function openPeer(id) {
    const iceServers = await relayServers();
    const opts = iceServers ? { debug: 1, config: { iceServers } } : { debug: 1 };
    return new Promise((resolve, reject) => {
      const p = id ? new Peer(id, opts) : new Peer(opts);
      const to = setTimeout(() => { done(); p.destroy(); reject(err('failed', 'signalling timeout')); }, OPEN_MS);
      const onOpen = () => { done(); resolve(p); };
      const onErr = (e) => { done(); p.destroy(); reject(e); };
      const done = () => { clearTimeout(to); p.off('open', onOpen); p.off('error', onErr); };
      p.on('open', onOpen); p.on('error', onErr);
    });
  }
  function reset() {
    leave();
    closed = false; backlog.length = 0;
    net.code = null; net.isHost = false; net.seat = -1; net.started = false; net.cfg = null; list = [];
  }

  // ================================================================================================ host
  async function host({ name, color } = {}) {
    reset();
    net.isHost = true; net.seat = 0;
    me = { seat: 0, name: cleanName(name), color: cleanColor(color), ping: 0 };
    for (let tries = 0; ; tries++) {
      const code = newCode();
      try { peer = await openPeer(PREFIX + code); net.code = code; break; }
      catch (e) {
        if (closed) throw err('failed', 'left');
        if (e?.type !== 'unavailable-id' || tries >= 5) { leave(); throw err('failed', `Could not open a room (${e?.type || e?.message || e})`); }
      }
    }
    if (closed) { leave(); throw err('failed', 'left'); }
    peer.on('connection', onConnection);
    peer.on('disconnected', () => { if (!closed) try { peer.reconnect(); } catch { /* destroyed */ } });   // signalling only: open games go on
    peer.on('error', (e) => console.warn('net: peer', e?.type, e?.message));
    timer = setInterval(hostTick, PING_MS);
    net.connected = true;
    list = [me];
    if (HAS_SB) listenKnocks(net.code).catch((e) => console.warn('net: relay off (host)', e));
    emitPlayers();
    return net.code;
  }
  /** host: relayed clients knock on `df-<code>`; each gets a relayConn on its own channel, then the usual hello / welcome */
  async function listenKnocks(code) {
    const seen = new Set();
    knock = await sbChannel(`df-${code}`, (st) => { if (st !== 'SUBSCRIBED') console.info('net: knock channel', st); });
    knock.ch.on('broadcast', { event: 'knock' }, async ({ payload }) => {
      const id = String(payload?.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
      if (!id || seen.has(id) || closed) return;
      seen.add(id);
      try { const conn = await relayConn(`df-${code}-${id}`); if (!closed) onConnection(conn); else conn.close(); } catch (e) { console.warn('net: relay conn', e); }
    });
    knock.go();
  }
  function onConnection(conn) {
    const rec = { conn, seat: -1, player: null, last: nowMs(), dropped: false };
    recs.add(rec);
    conn.on('data', (d) => onHostData(rec, d));
    conn.on('close', () => drop(rec));
    conn.on('error', (e) => { console.warn('net: conn', e?.type, e?.message); drop(rec); });
  }
  const seatTaken = (s) => s === 0 || [...recs].some((r) => r.seat === s && !r.dropped);
  function onHostData(rec, d) {
    rec.last = nowMs();
    if (d instanceof ArrayBuffer) { if (rec.seat > 0) deliver('msg', d, rec.seat); return; }
    if (!d || typeof d !== 'object') return;
    if (d.k === 'hello') {
      if (rec.seat >= 0) return;
      let seat = -1;
      for (let s = 1; s < SEATS && seat < 0; s++) if (!seatTaken(s)) seat = s;
      if (seat < 0) { safeSend(rec.conn, { k: 'reject', code: 'full' }); setTimeout(() => drop(rec), 1500); return; }
      let color = cleanColor(d.color);   // two players in one colour can't tell each other apart: the next free one
      if (list.some((p) => p.color.toLowerCase() === color.toLowerCase())) color = PALETTE.find((c) => !list.some((p) => p.color.toLowerCase() === c)) || color;
      rec.seat = seat; rec.player = { seat, name: cleanName(d.name), color, ping: NaN };
      list = [me, ...[...recs].filter((r) => r.player && !r.dropped).map((r) => r.player)].sort((a, b) => a.seat - b.seat);
      safeSend(rec.conn, { k: 'welcome', seat, code: net.code, players: wirePlayers() });
      ping(rec);
      broadcast({ k: 'players', players: wirePlayers() });
      emitPlayers();
      if (net.started && net.cfg) {   // a running match: in at once (game.js hands this seat over from its AI)
        safeSend(rec.conn, { k: 'start', cfg: { ...net.cfg, players: wirePlayers(), late: true } });
        deliver('join', { ...rec.player }, seat);
      }
    } else if (d.k === 'pong') { if (rec.player && Number.isFinite(d.t)) rec.player.ping = nowMs() - d.t; }
    else if (d.k === 'bye') drop(rec);
    else if (rec.seat > 0) deliver('msg', d, rec.seat);
  }
  const wirePlayers = () => list.map((p) => ({ seat: p.seat, name: p.name, color: p.color, ping: Number.isFinite(p.ping) ? Math.round(p.ping) : null }));
  const ping = (rec) => safeSend(rec.conn, { k: 'ping', t: nowMs() });
  function hostTick() {
    const t = nowMs();
    for (const rec of recs) {
      if (t - rec.last > SILENT_MS) { drop(rec); continue; }
      if (rec.seat > 0) ping(rec);
    }
    if (list.length > 1) { broadcast({ k: 'players', players: wirePlayers() }); emitPlayers(); }
  }
  function drop(rec) {
    if (rec.dropped) return;
    rec.dropped = true; recs.delete(rec);
    try { rec.conn.close(); } catch { /* already */ }
    if (rec.seat > 0 && !closed) {
      list = list.filter((p) => p.seat !== rec.seat);
      broadcast({ k: 'players', players: wirePlayers() });
      emitPlayers();
      deliver('leave', null, rec.seat);
    }
  }
  function broadcast(msg) { for (const rec of recs) if (rec.seat > 0 && !rec.dropped) safeSend(rec.conn, msg); }
  function safeSend(conn, msg) { try { if (conn && conn.open) conn.send(msg); } catch (e) { console.warn('net: send', e?.message || e); } }

  /** host: everyone's game starts (again, for a rematch) */
  function start({ minutes = 3, bots = true } = {}) {
    if (!net.isHost || closed) throw err('failed', 'Only the host can start');
    const cfg = { minutes: Math.min(30, Math.max(0.25, +minutes || 3)), bots: !!bots, seed: (Math.random() * 1e9) | 0, players: wirePlayers() };
    net.cfg = cfg; net.started = true;
    broadcast({ k: 'start', cfg });
    call('onStart', cfg);
    return cfg;
  }

  // ================================================================================================ client
  async function join(code, { name, color } = {}) {
    reset();
    const c = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (c.length !== 5 || [...c].some((ch) => !ALPHABET.includes(ch))) { leave(); throw err('not-found', `No room ${c}`); }
    const relayOnly = HAS_SB && /[?&]relayonly\b/.test(globalThis.location?.search || '');
    let direct = null;
    if (!relayOnly) {
      try { peer = await openPeer(null); direct = await handshake(c, name, color, () => peer.connect(PREFIX + c, { reliable: true, serialization: 'binary' }), HAS_SB ? DIRECT_MS : JOIN_MS); return; }
      catch (e) { direct = e; if (closed) throw err('failed', 'left'); if (!HAS_SB || e.code === 'not-found' || e.code === 'full') { leave(); throw e; } }
      console.info(`net: direct connection failed (${direct?.message}); trying the relay`);
      try { peer?.destroy(); } catch { /* gone */ } peer = null; closed = false;
    }
    const id = Math.random().toString(36).slice(2, 12);
    try {
      await handshake(c, name, color, () => null, JOIN_MS, async () => {
        const conn = await relayConn(`df-${c}-${id}`);
        conn.on('open', () => knockOn(c, id));
        return conn;
      });
    } catch (e) { leave(); throw e.code ? e : err('failed', `Could not connect (relay: ${e?.message || e})`); }
  }
  /** client: rings the host's knock channel (a few times: the host may still be subscribing to our channel) */
  async function knockOn(code, id) {
    const k = await sbChannel(`df-${code}`, (st) => {
      if (st !== 'SUBSCRIBED') return;
      let n = 0, t = 0;
      const ring = () => { if (closed || net.connected || n++ > 8) { clearInterval(t); setTimeout(() => k.sb.removeChannel(k.ch), 500); return; } k.ch.send({ type: 'broadcast', event: 'knock', payload: { id } }); };
      t = setInterval(ring, 1500); ring();
    });
    k.go();
  }
  /**
   * The hello / welcome exchange on one connection. connect() gives a PeerJS connection (direct), or makeConn() a relayConn.
   * Resolves once welcomed (hostConn set, net.connected); rejects with { code } on reject / error / timeout (the caller cleans up).
   */
  function handshake(c, name, color, connect, ms, makeConn) {
    return new Promise(async (resolve, reject) => {
      let pending = true, hi = 0;
      const finish = (e) => {
        if (!pending) return;
        pending = false; clearTimeout(to); clearInterval(hi);
        if (e) { try { hostConn?.close(); } catch { /* gone */ } hostConn = null; reject(e); return; }
        net.connected = true; lastHeard = nowMs();
        timer = setInterval(() => { if (nowMs() - lastHeard > SILENT_MS) lost('lost'); }, PING_MS);
        resolve();
      };
      const to = setTimeout(() => finish(err('failed', 'Timed out joining (failed)')), ms);
      if (peer) peer.on('error', (e) => {
        if (pending) finish(e?.type === 'peer-unavailable' ? err('not-found', `No room ${c}`) : err('failed', `Could not connect (${e?.type || e?.message || e})`));
        else console.warn('net: peer', e?.type, e?.message);
      });
      let conn;
      try { conn = hostConn = makeConn ? await makeConn() : connect(); } catch (e) { finish(err('failed', `Could not connect (${e?.message || e})`)); return; }
      if (!conn) { finish(err('failed', 'Could not connect (no connection)')); return; }
      const hello = () => safeSend(conn, { k: 'hello', v: 1, name: cleanName(name), color: cleanColor(color) });
      conn.on('open', () => { hello(); if (conn.relay) hi = setInterval(() => pending && hello(), 1500); });   // a relay hello can land before the host listens
      conn.on('data', (d) => {
        lastHeard = nowMs();
        if (pending) {
          if (d && d.k === 'welcome') {
            net.seat = d.seat | 0; net.code = c; setPlayers(d.players); finish(null);
          } else if (d && d.k === 'reject') finish(err(d.code === 'full' ? 'full' : 'failed', `Room ${c}: ${d.code}`));
          return;
        }
        onClientData(conn, d);
      });
      conn.on('close', () => { if (pending) finish(err('failed', 'Could not connect (closed)')); else lost('host-left'); });
      conn.on('error', (e) => { if (pending) finish(err('failed', `Could not connect (${e?.type || e?.message || e})`)); });
    });
  }
  function setPlayers(ps) {
    if (!Array.isArray(ps)) return;
    list = ps.filter((p) => p && p.seat >= 0 && p.seat < SEATS)
      .map((p) => ({ seat: p.seat | 0, name: cleanName(p.name), color: cleanColor(p.color), ping: p.seat === 0 ? 0 : Number.isFinite(p.ping) ? p.ping : NaN }))
      .sort((a, b) => a.seat - b.seat);
  }
  function onClientData(conn, d) {
    if (d instanceof ArrayBuffer) { deliver('msg', d, 0); return; }
    if (!d || typeof d !== 'object') return;
    switch (d.k) {
      case 'ping': safeSend(conn, { k: 'pong', t: d.t }); break;
      case 'players': setPlayers(d.players); emitPlayers(); break;
      case 'start': if (d.cfg && typeof d.cfg === 'object') { net.cfg = d.cfg; net.started = true; call('onStart', d.cfg); } break;
      case 'bye': lost('host-left'); break;
      default: deliver('msg', d, 0);
    }
  }
  function lost(reason) {
    if (closed) return;
    leave();
    call('onClose', reason);
  }

  // ================================================================================================ both
  function send(to, msg) {
    if (closed) return;
    if (net.isHost) { if (to === -1) broadcast(msg); else for (const rec of recs) if (rec.seat === to) safeSend(rec.conn, msg); }
    else safeSend(hostConn, msg);
  }
  function leave() {
    if (closed && !peer) return;
    closed = true;
    clearInterval(timer); timer = 0;
    if (net.isHost) for (const rec of recs) { safeSend(rec.conn, { k: 'bye' }); rec.dropped = true; }
    else safeSend(hostConn, { k: 'bye' });
    const conns = [...recs].map((r) => r.conn).concat(hostConn ? [hostConn] : []), p = peer;
    recs.clear(); hostConn = null; peer = null;
    if (knock) { const k = knock; knock = null; setTimeout(() => { try { k.sb.removeChannel(k.ch); } catch { /* gone */ } }, 150); }
    net.connected = false; net.started = false; list = [];
    setTimeout(() => { for (const c of conns) try { c.close(); } catch { /* gone */ } try { p?.destroy(); } catch { /* gone */ } }, 150);   // let the byes leave first
  }
  /** bytes sent / received on every data channel so far (WebRTC stats) */
  async function traffic() {
    let sent = 0, received = 0;
    const conns = [...recs].map((r) => r.conn).concat(hostConn ? [hostConn] : []);
    for (const c of conns) {
      try {
        const st = await c.peerConnection.getStats();
        st.forEach((r) => { if (r.type === 'data-channel') { sent += r.bytesSent || 0; received += r.bytesReceived || 0; } });
      } catch { /* closed */ }
    }
    return { sent, received };
  }

  return net;
}
