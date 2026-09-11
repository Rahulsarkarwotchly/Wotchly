// ============================================================
// Wotchly Sync — self-hosted WebSocket room sync client.
// Drop-in replacement for the old firebase.js module: exports the
// exact same API surface the app already uses.
// ============================================================

const SYNC_WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const CONNECTED_PATH = '.info/connected';
const REQUEST_TIMEOUT = 10000;

let socket = null;
let connecting = null;
let msgId = 0;

const pending = new Map();    // id -> { resolve, reject, timer }
const subs = new Map();        // subId -> { path, cb }
const connectedCbs = new Set(); // .info/connected subscribers

function snapshot(path, value) {
  const key = parts(path).pop() || null;
  return {
    exists: () => value !== null && value !== undefined,
    val: () => value,
    key,
  };
}

const parts = path => String(path || '').split('/').filter(Boolean);

function fireConnected(value) {
  for (const cb of connectedCbs) {
    try { cb(snapshot(CONNECTED_PATH, value)); } catch (e) { console.warn('[sync] connected callback failed:', e); }
  }
}

function connect() {
  if (socket && socket.readyState === 1) return Promise.resolve();
  if (connecting) return connecting;

  socket = new WebSocket(SYNC_WS_URL);
  connecting = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => {
      connecting = null;
      // Re-subscribe all live listeners (server sends fresh values)
      for (const [subId, sub] of subs) {
        try { socket.send(JSON.stringify({ op: 'sub', subId, path: sub.path })); } catch {}
      }
      // Re-queue presence: '.info/connected' flips true → app re-registers
      fireConnected(true);
      resolve();
    });
    socket.addEventListener('error', () => {
      connecting = null;
      reject(new Error('sync connection failed'));
    });
  });

  socket.addEventListener('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.data); } catch { return; }
    if (msg.t === 'ack' && msg.id !== undefined) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve({ value: msg.value, key: msg.key });
      }
    } else if (msg.t === 'value' && msg.subId !== undefined) {
      const sub = subs.get(msg.subId);
      if (sub) {
        sub.lastValue = msg.value;
        try { sub.cb(snapshot(sub.path, msg.value)); } catch (e) { console.warn('[sync] listener callback failed:', e); }
      }
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    connecting = null;
    // Fail in-flight requests so callers' try/catch can handle it
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error('sync disconnected'));
    }
    fireConnected(false);
    setTimeout(connect, 1000).unref?.(); // auto-reconnect
  });

  return connecting;
}

function request(msg, expectValue = false) {
  return new Promise((resolve, reject) => {
    connect().then(() => {
      if (!socket || socket.readyState !== 1) { reject(new Error('sync not connected')); return; }
      const id = `r${++msgId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('sync request timeout'));
      }, REQUEST_TIMEOUT);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...msg, id }));
    }).catch(reject);
  });
}

// ---- Firebase-compatible API ----

export const db = Symbol('wotchly-sync');

export function ref(_db, path) {
  return { __ref: true, path: String(path || '') };
}

export async function set(r, value) {
  await request({ op: 'set', path: r.path, value });
}

export async function get(r) {
  if (r.path === CONNECTED_PATH) return snapshot(r.path, socket && socket.readyState === 1);
  const { value } = await request({ op: 'get', path: r.path }, true);
  return snapshot(r.path, value);
}

export async function push(r, value) {
  const { key } = await request({ op: 'push', path: r.path, value });
  return { __ref: true, path: r.path ? `${r.path}/${key}` : key, key };
}

export async function update(r, updates) {
  await request({ op: 'update', path: r.path, updates });
}

export async function remove(r) {
  await request({ op: 'remove', path: r.path });
}

export function onValue(r, cb) {
  if (r.path === CONNECTED_PATH) {
    connectedCbs.add(cb);
    // Fire immediately with current state so callers get an initial value
    setTimeout(() => {
      try { cb(snapshot(CONNECTED_PATH, socket && socket.readyState === 1)); } catch {}
    }, 0);
    return () => connectedCbs.delete(cb);
  }
  const subId = `s${++msgId}`;
  subs.set(subId, { path: r.path, cb });
  connect().then(() => {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ op: 'sub', subId, path: r.path }));
  }).catch(() => {});
  return () => {
    subs.delete(subId);
    if (socket && socket.readyState === 1) {
      try { socket.send(JSON.stringify({ op: 'unsub', subId })); } catch {}
    }
  };
}

export function onDisconnect(r) {
  const queue = (action, value) => {
    if (socket && socket.readyState === 1) {
      try { socket.send(JSON.stringify({ op: 'ondisconnect', path: r.path, action, value })); } catch {}
    }
  };
  return {
    set: value => queue('set', value),
    remove: () => queue('remove'),
  };
}
