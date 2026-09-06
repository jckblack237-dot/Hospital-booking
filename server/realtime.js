/**
 * Realtime fanout.
 *
 * WebSocket for the clinic dashboard and the patient app; Server-Sent Events
 * for the Partner API, which is what the published contract promises.
 * Subscriptions are channel strings: `clinic:<id>`, `session:<id>`, `patient:<id>`.
 */
import { WebSocketServer } from 'ws';

const channels = new Map(); // channel -> Set<ws>
const sseClients = new Map(); // channel -> Set<res>

export function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.subscriptions = new Set();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
        for (const ch of msg.channels.slice(0, 40)) {
          if (typeof ch !== 'string') continue;
          ws.subscriptions.add(ch);
          if (!channels.has(ch)) channels.set(ch, new Set());
          channels.get(ch).add(ws);
        }
        ws.send(JSON.stringify({ type: 'subscribed', channels: [...ws.subscriptions] }));
      } else if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
        for (const ch of msg.channels) {
          ws.subscriptions.delete(ch);
          channels.get(ch)?.delete(ws);
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
      }
    });

    ws.on('close', () => {
      for (const ch of ws.subscriptions) channels.get(ch)?.delete(ws);
    });
  });

  // Reconnect-and-reconcile is the client's job; ours is to notice dead sockets.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, 30_000);
  heartbeat.unref?.();

  return wss;
}

export function publish(channel, payload) {
  const body = JSON.stringify(payload);
  const set = channels.get(channel);
  if (set) {
    for (const ws of set) {
      if (ws.readyState === 1) {
        try { ws.send(body); } catch { /* dropped */ }
      }
    }
  }
  const sse = sseClients.get(channel);
  if (sse) {
    for (const res of sse) {
      try {
        res.write(`id: ${payload.version ?? Date.now()}\n`);
        res.write(`event: ${payload.type || 'message'}\n`);
        res.write(`data: ${body}\n\n`);
      } catch { /* dropped */ }
    }
  }
}

export function addSse(channel, res) {
  if (!sseClients.has(channel)) sseClients.set(channel, new Set());
  sseClients.get(channel).add(res);
  res.on('close', () => sseClients.get(channel)?.delete(res));
}

export function stats() {
  return {
    channels: channels.size,
    sockets: [...channels.values()].reduce((s, set) => s + set.size, 0),
    sse: [...sseClients.values()].reduce((s, set) => s + set.size, 0),
  };
}
