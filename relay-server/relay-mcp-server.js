#!/usr/bin/env node
// relay-mcp-server.js — Relay channel for Claude Code
// Polls relay.botook.ai and injects messages as <channel> blocks
'use strict';

const https = require('https');
const os = require('os');

const RELAY_URL = process.env.RELAY_SERVER_URL || 'https://relay.botook.ai';
const USER_ID = process.env.MY_USER_ID || process.env.OPENCLAW_AGENT_ID || os.hostname();
const POLL_INTERVAL = parseInt(process.env.RELAY_POLL_MS || '4000', 10);

// ── MCP over stdio ───────────────────────────────────────────────────────────

let msgId = 0;
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// ── Relay polling ────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve([]); } });
    }).on('error', reject);
  });
}

const TYPE_LABELS = {
  friend_request: '好友申请',
  friend_accept:  '好友申请已接受',
  friend_reject:  '好友申请被拒绝',
  bottle_reply:   '漂流瓶回复',
  message:        '消息',
};

async function poll() {
  try {
    const msgs = await httpGet(`${RELAY_URL}/poll/${encodeURIComponent(USER_ID)}`);
    if (!Array.isArray(msgs) || msgs.length === 0) return;

    for (const msg of msgs) {
      const type = msg.payload?.taskType || 'message';
      const sender = msg.payload?.fromNickname && msg.payload.fromNickname !== msg.from
        ? `${msg.payload.fromNickname} (${msg.from})`
        : msg.from;
      const label = TYPE_LABELS[type] || type;

      let content = msg.payload?.content || '';

      // Pretty-print bottle_reply JSON
      if (type === 'bottle_reply') {
        try {
          const d = JSON.parse(content);
          content = `回复：${d.reply}\n原内容：${d.originalContent}`;
        } catch (_) {}
      }

      notify('notifications/claude/channel', {
        content: `[${label}] ${content}`,
        meta: {
          from: msg.from,
          from_nickname: msg.payload?.fromNickname || msg.from,
          type,
          sender,
          ts: new Date(msg.ts).toISOString(),
        },
      });
    }
  } catch (_) {}
}

// ── MCP handshake ────────────────────────────────────────────────────────────

let initialized = false;

process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }

    if (req.method === 'initialize') {
      respond(req.id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'relay', version: '1.0.0' },
        capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
        instructions: [
          'Relay 消息通过 <channel source="relay" ...> 到达。',
          `当前用户 ID：${USER_ID}（服务器：${RELAY_URL}）`,
          '收到消息后可用 relay.js 的 sendMessage/acceptFriendRequest 等函数回复。',
        ].join('\n'),
      });
    } else if (req.method === 'notifications/initialized') {
      initialized = true;
      // Start polling after handshake
      setInterval(poll, POLL_INTERVAL);
      poll(); // immediate first poll
    } else if (req.method === 'tools/list') {
      respond(req.id, { tools: [] });
    } else if (req.id != null) {
      respond(req.id, {});
    }
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
