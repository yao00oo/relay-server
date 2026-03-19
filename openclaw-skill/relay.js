'use strict';

const http = require('http');
const https = require('https');
const os = require('os');
const { URL } = require('url');

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || 'https://britannica-prime-typical-stock.trycloudflare.com';
const MY_USER_ID = process.env.MY_USER_ID || process.env.OPENCLAW_AGENT_ID || os.hostname();

// ── HTTP helper ────────────────────────────────────────────────────────────

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Core functions ─────────────────────────────────────────────────────────

async function sendMessage(toUserId, taskType, content, fromUserId = MY_USER_ID) {
  return request('POST', `${RELAY_SERVER_URL}/send`, {
    from: fromUserId,
    to: toUserId,
    payload: { taskType, content },
  });
}

async function pollMessages(myUserId = MY_USER_ID) {
  return request('GET', `${RELAY_SERVER_URL}/poll/${myUserId}`);
}

function startPolling(onMessage, intervalMs = 30000, myUserId = MY_USER_ID) {
  return setInterval(async () => {
    try {
      const msgs = await pollMessages(myUserId);
      for (const msg of msgs) onMessage(msg);
    } catch (err) {
      console.error('[relay] poll error:', err.message);
    }
  }, intervalMs);
}

// ── Setup: called automatically on skill load ──────────────────────────────

async function setup() {
  // 1. Test relay server connection
  let serverOk = false;
  try {
    const res = await request('GET', `${RELAY_SERVER_URL}/health`);
    serverOk = res && res.ok === true;
  } catch (_) {}

  // 2. Auto-start polling — surface incoming messages to agent output
  startPolling((msg) => {
    const line = '─'.repeat(50);
    console.log(`\n${line}`);
    console.log(`📡 RELAY: 收到新消息`);
    console.log(`发件人: ${msg.from}`);
    console.log(`类型:   ${msg.payload.taskType}`);
    console.log(`内容:   ${msg.payload.content}`);
    console.log(`时间:   ${new Date(msg.ts).toLocaleString()}`);
    console.log(`${line}\n`);
  }, 30000);

  // 3. Return welcome message for agent to show user
  return [
    '📡 Relay Skill 已就绪',
    '',
    `• 我的 ID:     ${MY_USER_ID}`,
    `• 服务器:      ${RELAY_SERVER_URL}`,
    `• 连接状态:    ${serverOk ? '✅ 正常' : '❌ 无法连接（请检查 relay server 是否在运行）'}`,
    `• 消息监听:    ✅ 已启动（每 30 秒轮询）`,
    '',
    '─── 使用方式 ───────────────────────────────',
    '',
    '发消息给另一个 OpenClaw 实例：',
    '  告诉我: "发消息给 <对方ID>，内容是 <内容>"',
    '',
    '查收消息：',
    '  告诉我: "查收消息" 或 "有没有新消息"',
    '  （新消息到达时也会自动提示）',
    '',
    '对方的 ID 是对方机器的 hostname，',
    `或者让对方也安装此 skill，他们的 ID 会在他们的欢迎消息里显示。`,
    '─────────────────────────────────────────────',
  ].join('\n');
}

module.exports = { sendMessage, pollMessages, startPolling, setup, MY_USER_ID, RELAY_SERVER_URL };
