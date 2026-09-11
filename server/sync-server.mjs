// ============================================================
// Wotchly Sync Server — self-hosted room sync over WebSocket
// Replaces Firebase Realtime Database for rooms, chat and presence.
// Data lives in memory (watch rooms are ephemeral by design).
// ============================================================
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.SYNC_PORT || 8081);

// ---- In-memory store (plain nested object) ----
const store = {};

const parts = path => String(path || '').split('/').filter(Boolean);

function getAt(path) {
  let node = store;
  for (const k of parts(path)) {
    if (node === null || typeof node !== 'object') return null;
    node = node[k];
  }
  return node === undefined ? null : node;
}

function setAt(path, value) {
  const p = parts(path);
  if (!p.length) return;
  let node = store;
  for (let i = 0; i < p.length - 1; i++) {
    if (typeof node[p[i]] !== 'object' || node[p[i]] === null) node[p[i]] = {};
    node = node[p[i]];
  }
  if (value === null || value === undefined) delete node[p[p.length - 1]];
  else node[p[p.length - 1]] = value;
}

function updateAt(path, updates) {
  const p = parts(path);
  let node = store;
  for (const k of p) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  for (const [key, value] of Object.entries(updates || {})) {
    // Firebase-style: keys containing '/' address nested paths
    if (key.includes('/')) setAt(`${path}/${key}`, value);
    else if (value === null || value === undefined) delete node[key];
    else node[key] = value;
  }
}

let keyCounter = 0;
const genKey = () =>
  `k${Date.now().toString(36)}${(keyCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function pushAt(path, value) {
  const key = genKey();
  setAt(`${path}/${key}`, value);
  return key;
}

// ---- Broadcast: push changed values to overlapping subscriptions ----
function broadcast(changedPath) {
  const changed = parts(changedPath);
  for (const client of wss.clients) {
    if (!client.subscriptions) continue;
    for (const [subId, sub] of client.subscriptions) {
      const subP = parts(sub.path);
      // Fire when the subscription path is at/under the changed path,
      // or the changed path is under the subscription path.
      const overlap =
        changed.length <= subP.length
          ? changed.every((k, i) => subP[i] === k)
          : subP.every((k, i) => changed[i] === k);
      if (!overlap) continue;
      const value = getAt(sub.path);
      const json = JSON.stringify(value);
      if (json === sub.last) continue; // unchanged — skip
      sub.last = json;
      safeSend(client, { t: 'value', subId, value });
    }
  }
}

function safeSend(client, obj) {
  try {
    if (client.readyState === 1) client.send(JSON.stringify(obj));
  } catch { /* connection died mid-send */ }
}

// ---- Server ----
const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });
console.log(`[sync] Wotchly sync server listening on :${PORT}`);

wss.on('connection', ws => {
  ws.subscriptions = new Map(); // subId -> { path, last }
  ws.dcOps = [];                // { path, action, value } applied on close

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { id, op, path, subId, value, updates, action } = msg;
    switch (op) {
      case 'get':
        safeSend(ws, { t: 'ack', id, value: getAt(path) });
        break;
      case 'set':
        setAt(path, value);
        broadcast(path);
        safeSend(ws, { t: 'ack', id, ok: true });
        break;
      case 'update':
        updateAt(path, updates || {});
        broadcast(path);
        safeSend(ws, { t: 'ack', id, ok: true });
        break;
      case 'push': {
        const key = pushAt(path, value);
        broadcast(path);
        safeSend(ws, { t: 'ack', id, ok: true, key });
        break;
      }
      case 'remove':
        setAt(path, null);
        broadcast(path);
        safeSend(ws, { t: 'ack', id, ok: true });
        break;
      case 'sub': {
        const v = getAt(path);
        ws.subscriptions.set(subId, { path, last: JSON.stringify(v) });
        safeSend(ws, { t: 'value', subId, value: v });
        break;
      }
      case 'unsub':
        ws.subscriptions.delete(subId);
        break;
      case 'ondisconnect':
        ws.dcOps.push({ path, action: action || 'remove', value });
        break;
    }
  });

  ws.on('close', () => {
    // Apply onDisconnect handlers (presence cleanup), then notify subscribers.
    const touched = new Set();
    for (const { path, action, value } of ws.dcOps || []) {
      if (action === 'set') setAt(path, value);
      else setAt(path, null);
      touched.add(path);
    }
    for (const p of touched) broadcast(p);
  });
});
