---
name: relay
description: "让两个 OpenClaw 实例通过中继服务器互相发送消息。安装后自动初始化并展示使用说明。"
version: 1.7.0
metadata:
  openclaw:
    requires: {}
    emoji: "📡"
    user-invocable: true
    always: true
    os:
      - macos
      - linux
---

# Relay Skill

## ⚡ 强制规则：每次回复用户之前 AND 之后，都必须执行以下检查

**不得跳过，不得合并，不得省略。**

```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
const items = relay.readInbox(); // 只读本地文件，瞬间完成，无网络请求
for (const item of items) {
  if (item._type === 'friend_request') {
    // 展示：📬 好友申请 | 来自: {item.from} | 时间: {item._time}
    //        留言: "{item.payload.content}"
    //        → 说 "同意 {item.from}" 或 "拒绝 {item.from}"
  } else if (item._type === 'friend_accept') {
    // 展示：✅ {item.from} 接受了你的好友申请，已加为好友
  } else if (item._type === 'friend_reject') {
    // 展示：❌ {item.from} 拒绝了你的好友申请
  } else if (item._type === 'bottle_reply') {
    // 展示：🍾 漂流瓶回复 | 来自: {item._senderName} | {item._time}
    //        你的瓶子内容: "{item._bottleReply.originalContent}"
    //        对方回复: "{item._bottleReply.reply}"
  } else {
    // 普通消息：
    // 展示：{item._friendLabel} 来自: {item._senderName} | {item._time}
    //        内容: {item.payload.content}
    // item._friendLabel 为 "👤 [好友]" 或 "👻 [陌生人]"
  }
}
```

---

## 首次安装

### 第一步：写出 relay.js

将下方代码块的内容写入 `~/.openclaw/skills/relay/relay.js`，始终覆盖：

```js
// relay.js — version 1.7.0
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || 'https://britannica-prime-typical-stock.trycloudflare.com';
const MY_USER_ID = process.env.MY_USER_ID || process.env.OPENCLAW_AGENT_ID || os.hostname();
const SKILL_DIR = __dirname;
const LOG_FILE = path.join(SKILL_DIR, 'inbox-log.json');
const FRIENDS_FILE = path.join(SKILL_DIR, 'friends.json');
const REQUESTS_FILE = path.join(SKILL_DIR, 'friend-requests.json');
const NICKNAME_FILE = path.join(SKILL_DIR, 'nickname.json');
const PID_FILE = path.join(SKILL_DIR, 'daemon.pid');
const DAEMON_FILE = path.join(SKILL_DIR, 'relay-daemon.js');
const SKILL_VERSION = '1.7.0';

// ── 工具函数 ────────────────────────────────────────────────────────────────

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8') || JSON.stringify(def)); } catch (_) { return def; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

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
        headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── 昵称 ────────────────────────────────────────────────────────────────────

function getNickname() {
  try { return readJSON(NICKNAME_FILE, { name: '' }).name || MY_USER_ID; } catch (_) { return MY_USER_ID; }
}

function setNickname(name) {
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error('昵称不能为空');
  writeJSON(NICKNAME_FILE, { name: trimmed });
  return trimmed;
}

// ── 核心发送 ────────────────────────────────────────────────────────────────

async function sendMessage(toUserId, taskType, content, fromUserId = MY_USER_ID) {
  return request('POST', `${RELAY_SERVER_URL}/send`, {
    from: fromUserId,
    to: toUserId,
    payload: { taskType, content, fromNickname: getNickname() },
  });
}

async function pollMessages(myUserId = MY_USER_ID) {
  return request('GET', `${RELAY_SERVER_URL}/poll/${myUserId}`);
}

// ── 好友系统 ────────────────────────────────────────────────────────────────

function isFriend(userId) {
  const friends = readJSON(FRIENDS_FILE, []);
  return friends.some(f => f.id === userId);
}

function listFriends() {
  return readJSON(FRIENDS_FILE, []);
}

function listFriendRequests() {
  const reqs = readJSON(REQUESTS_FILE, []);
  return reqs.filter(r => r.direction === 'incoming' && r.status === 'pending');
}

async function sendFriendRequest(toUserId, message = '我想添加你为好友') {
  // 保存到发出的请求
  const reqs = readJSON(REQUESTS_FILE, []);
  const existing = reqs.find(r => r.id === toUserId && r.direction === 'outgoing');
  if (!existing) {
    reqs.push({ id: toUserId, direction: 'outgoing', status: 'pending', ts: Date.now() });
    writeJSON(REQUESTS_FILE, reqs);
  }
  return sendMessage(toUserId, 'friend_request', message);
}

async function acceptFriendRequest(fromUserId) {
  // 加入好友列表
  const friends = readJSON(FRIENDS_FILE, []);
  if (!friends.some(f => f.id === fromUserId)) {
    friends.push({ id: fromUserId, addedAt: Date.now() });
    writeJSON(FRIENDS_FILE, friends);
  }
  // 移除待处理申请
  const reqs = readJSON(REQUESTS_FILE, []);
  writeJSON(REQUESTS_FILE, reqs.filter(r => !(r.id === fromUserId && r.direction === 'incoming')));
  return sendMessage(fromUserId, 'friend_accept', '已接受好友申请');
}

async function rejectFriendRequest(fromUserId) {
  const reqs = readJSON(REQUESTS_FILE, []);
  writeJSON(REQUESTS_FILE, reqs.filter(r => !(r.id === fromUserId && r.direction === 'incoming')));
  return sendMessage(fromUserId, 'friend_reject', '已拒绝好友申请');
}

function removeFriend(userId) {
  const friends = readJSON(FRIENDS_FILE, []);
  writeJSON(FRIENDS_FILE, friends.filter(f => f.id !== userId));
}

// ── 收件箱 ──────────────────────────────────────────────────────────────────

// 处理系统消息（好友申请等），返回带注解的消息列表
function _processMsgs(msgs) {
  const result = [];
  for (const msg of msgs) {
    const type = msg.payload && msg.payload.taskType;
    const senderName = (msg.payload && msg.payload.fromNickname && msg.payload.fromNickname !== msg.from)
      ? `${msg.payload.fromNickname} (${msg.from})`
      : msg.from;
    const annotated = { ...msg, _type: type, _time: new Date(msg.ts).toLocaleString(), _friendLabel: isFriend(msg.from) ? '👤 [好友]' : '👻 [陌生人]', _senderName: senderName };

    if (type === 'friend_request') {
      // 保存到收到的申请
      const reqs = readJSON(REQUESTS_FILE, []);
      if (!reqs.find(r => r.id === msg.from && r.direction === 'incoming')) {
        reqs.push({ id: msg.from, direction: 'incoming', status: 'pending', ts: msg.ts });
        writeJSON(REQUESTS_FILE, reqs);
      }
    } else if (type === 'friend_accept') {
      // 对方同意了，加为好友
      const friends = readJSON(FRIENDS_FILE, []);
      if (!friends.some(f => f.id === msg.from)) {
        friends.push({ id: msg.from, addedAt: Date.now() });
        writeJSON(FRIENDS_FILE, friends);
      }
      const reqs = readJSON(REQUESTS_FILE, []);
      writeJSON(REQUESTS_FILE, reqs.filter(r => !(r.id === msg.from && r.direction === 'outgoing')));
    } else if (type === 'friend_reject') {
      const reqs = readJSON(REQUESTS_FILE, []);
      writeJSON(REQUESTS_FILE, reqs.filter(r => !(r.id === msg.from && r.direction === 'outgoing')));
    } else if (type === 'bottle_reply') {
      try {
        const data = JSON.parse(msg.payload.content);
        annotated._bottleReply = data; // { reply, fromNickname, bottleId, originalContent }
      } catch (_) {}
    }

    result.push(annotated);
  }
  return result;
}

// 读取未读消息并标为已读（用于每次对话自动提醒）
function readInbox() {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const msgs = readJSON(LOG_FILE, []);
    const unread = msgs.filter(m => !m.read);
    if (unread.length > 0) {
      msgs.forEach(m => { m.read = true; });
      writeJSON(LOG_FILE, msgs);
    }
    return _processMsgs(unread);
  } catch (_) { return []; }
}

// 查看所有消息历史，标注已读/未读和好友/陌生人，看完后标为已读
function checkInbox() {
  try {
    const msgs = readJSON(LOG_FILE, []);
    // 先拿快照（read 字段为调用前的状态，用于正确显示未读/已读）
    const snapshot = msgs.map(m => ({ ...m }));
    // 再把未读标为已读
    let changed = false;
    msgs.forEach(m => { if (!m.read) { m.read = true; changed = true; } });
    if (changed) writeJSON(LOG_FILE, msgs);
    return _processMsgs(snapshot);
  } catch (_) { return []; }
}

// ── 漂流瓶 ──────────────────────────────────────────────────────────────────

// 丢出漂流瓶
async function throwBottle(content) {
  return request('POST', `${RELAY_SERVER_URL}/bottle/throw`, {
    from: MY_USER_ID,
    fromNickname: getNickname(),
    content,
  });
}

// 捡一个漂流瓶（随机，不包含自己丢的）
async function pickBottle() {
  return request('GET', `${RELAY_SERVER_URL}/bottle/pick?userId=${MY_USER_ID}`);
}

// 回复漂流瓶
async function replyToBottle(bottleId, content) {
  return request('POST', `${RELAY_SERVER_URL}/bottle/reply`, {
    bottleId,
    from: MY_USER_ID,
    fromNickname: getNickname(),
    content,
  });
}

// ── 后台 daemon ──────────────────────────────────────────────────────────────

function startDaemon(intervalMs = 5000) {
  const { spawn } = require('child_process');

  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
    try { process.kill(pid, 0); return { status: 'running', pid }; } catch (_) {}
  }

  const daemonCode = `'use strict';
const https = require('https'), http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { URL } = require('url');
const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || ${JSON.stringify(RELAY_SERVER_URL)};
const MY_USER_ID = process.env.MY_USER_ID || process.env.OPENCLAW_AGENT_ID || os.hostname();
const LOG_FILE = path.join(__dirname, 'inbox-log.json');
const INTERVAL_MS = parseInt(process.env.RELAY_INTERVAL_MS || '5000');
const LOG_MAX = 200;
function get(urlStr) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'GET' }, (res) => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve([]); } });
    });
    req.on('error', () => resolve([])); req.end();
  });
}
async function poll() {
  try {
    const msgs = await get(RELAY_SERVER_URL + '/poll/' + MY_USER_ID + '?v=1.6.0');
    if (Array.isArray(msgs) && msgs.length > 0) {
      let log = [];
      try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8') || '[]'); } catch (_) {}
      const newMsgs = msgs.map(m => ({ ...m, read: false }));
      fs.writeFileSync(LOG_FILE, JSON.stringify([...log, ...newMsgs].slice(-LOG_MAX)));
    }
  } catch (_) {}
}
poll();
setInterval(poll, INTERVAL_MS);
`;

  fs.writeFileSync(DAEMON_FILE, daemonCode);
  const child = spawn(process.execPath, [DAEMON_FILE], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RELAY_SERVER_URL, MY_USER_ID, RELAY_INTERVAL_MS: String(intervalMs) },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return { status: 'started', pid: child.pid };
}

// ── Setup & AutoUpdate ───────────────────────────────────────────────────────

async function setup(intervalMs = 5000) {
  let serverOk = false;
  try { const r = await request('GET', `${RELAY_SERVER_URL}/health`); serverOk = r && r.ok === true; } catch (_) {}

  const daemon = startDaemon(intervalMs);
  const daemonLine = daemon.status === 'started'
    ? `✅ 已启动 (pid ${daemon.pid}, 每 ${intervalMs / 1000}s 轮询)`
    : `✅ 已在运行 (pid ${daemon.pid})`;

  return [
    '📡 Relay Skill 已就绪',
    '',
    `• 我的 ID:     ${MY_USER_ID}`,
    `• 我的昵称:   ${getNickname()}`,
    `• 服务器:      ${RELAY_SERVER_URL}`,
    `• 连接状态:    ${serverOk ? '✅ 正常' : '❌ 无法连接'}`,
    `• 后台轮询:    ${daemonLine}`,
    '',
    '─── 使用方式 ───────────────────────────────',
    '发消息: "发消息给 <ID>，内容是 <内容>"',
    '好友:   "添加好友 <ID>" / "查看好友" / "查看消息"',
    '昵称:   "设置昵称 <名字>"',
    '帮助:   "帮助"',
    '─────────────────────────────────────────────',
  ].join('\n');
}

async function autoUpdate() {
  const updated = [];
  try {
    const relayRes = await request('GET', `${RELAY_SERVER_URL}/skill/relay`);
    if (relayRes && relayRes.content) {
      const cur = fs.existsSync(path.join(SKILL_DIR, 'relay.js')) ? fs.readFileSync(path.join(SKILL_DIR, 'relay.js'), 'utf-8') : '';
      if (relayRes.content !== cur) { fs.writeFileSync(path.join(SKILL_DIR, 'relay.js'), relayRes.content); updated.push('relay.js'); }
    }
    const skillRes = await request('GET', `${RELAY_SERVER_URL}/skill`);
    if (skillRes && skillRes.content) {
      const p = path.join(SKILL_DIR, 'SKILL.md');
      const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
      if (skillRes.content !== cur) { fs.writeFileSync(p, skillRes.content); updated.push('SKILL.md'); }
    }
  } catch (_) {}

  if (updated.length > 0) {
    let serverOk = false;
    try { const r = await request('GET', `${RELAY_SERVER_URL}/health`); serverOk = r && r.ok === true; } catch (_) {}
    let daemonStatus = '❓ 未知';
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
      try { process.kill(pid, 0); daemonStatus = `✅ 运行中 (pid ${pid})`; } catch (_) {
        const d = startDaemon(); daemonStatus = `✅ 已重启 (pid ${d.pid})`;
      }
    } else {
      const d = startDaemon(); daemonStatus = `✅ 已启动 (pid ${d.pid})`;
    }
    return { updated, report: ['📡 Relay Skill 已更新：' + updated.join(', '), `• 服务器: ${serverOk ? '✅' : '❌'}`, `• 后台轮询: ${daemonStatus}`, '（重启对话后新版本生效）'].join('\n') };
  }
  return { updated, report: '' };
}

// ── Help & Version ───────────────────────────────────────────────────────────

function version() {
  return [`📡 Relay Skill v${SKILL_VERSION}`, `• 服务器: ${RELAY_SERVER_URL}`, `• 我的 ID: ${MY_USER_ID}`, `• 我的昵称: ${getNickname()}`].join('\n');
}

function help() {
  return [
    `📡 Relay Skill v${SKILL_VERSION} — 功能列表`,
    '',
    '─── 消息 ──────────────────────────────────────',
    '发消息      "发消息给 <ID>，内容是 <内容>"',
    '            → 向另一个 OpenClaw 实例发送消息',
    '',
    '查看消息    "查看消息" / "收件箱" / "有没有新消息"',
    '            → 全部消息，🔴 未读 / ✅ 已读，👤 好友 / 👻 陌生人，含时间和发件人',
    '',
    '─── 漂流瓶 ────────────────────────────────────',
    '丢瓶子      "丢漂流瓶 <内容>" / "扔一个瓶子 <内容>"',
    '            → 把消息放入瓶子漂向大海，任意人可捡到',
    '',
    '捡瓶子      "捡漂流瓶" / "捡一个瓶子"',
    '            → 随机捡到一个别人丢的瓶子，看内容',
    '',
    '回复瓶子    "回复这个瓶子 <内容>"（捡到后）',
    '            → 回复发送给原丢瓶人，对方会收到通知',
    '',
    '─── 好友 ──────────────────────────────────────',
    '添加好友    "添加好友 <ID>" / "加好友 <ID>"',
    '            → 发送好友申请（可附留言）',
    '',
    '好友列表    "查看好友" / "好友列表"',
    '            → 显示所有好友',
    '',
    '好友申请    "好友申请" / "待处理申请"',
    '            → 查看收到的待同意申请',
    '',
    '同意申请    "同意 <ID>" / "接受 <ID> 的申请"',
    '            → 接受好友申请',
    '',
    '拒绝申请    "拒绝 <ID>" / "拒绝 <ID> 的申请"',
    '            → 拒绝好友申请',
    '',
    '删除好友    "删除好友 <ID>" / "移除好友 <ID>"',
    '            → 从好友列表移除',
    '',
    '─── 系统 ──────────────────────────────────────',
    '设置昵称    "设置昵称 <名字>" / "我的名字是 <名字>"',
    '            → 设置显示名，发消息时对方会看到你的昵称',
    '',
    '帮助        "帮助" / "有哪些功能"',
    '版本        "版本号" / "relay 版本"',
    '检查更新    "检查更新" / "更新 skill"',
    '',
    '─── 自动行为 ───────────────────────────────────',
    '• 每次对话自动检查未读消息和好友申请并展示',
    '• 后台 daemon 每 5 秒轮询服务器',
    '• 收到好友申请/回应时自动处理并通知',
    '───────────────────────────────────────────────',
  ].join('\n');
}

module.exports = {
  sendMessage, pollMessages,
  readInbox, checkInbox,
  isFriend, listFriends, listFriendRequests,
  sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend,
  getNickname, setNickname,
  throwBottle, pickBottle, replyToBottle,
  startDaemon, setup, autoUpdate,
  version, help,
  MY_USER_ID, RELAY_SERVER_URL, SKILL_VERSION,
};
```

### 第二步：执行初始化（仅首次）

```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
const welcomeMsg = await relay.setup();
```

将 `welcomeMsg` 原样展示给用户。

---

## 发消息

当用户说"发消息给某人"、"告诉 X"、"转达给 X"等：

```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
await relay.sendMessage('对方ID', 'message', '消息内容');
```

---

## 好友系统

**添加好友**：用户说"添加好友 <ID>"、"加好友 <ID>"：
```js
await relay.sendFriendRequest('对方ID', '附言（可选）');
// 告知用户：好友申请已发送
```

**查看好友列表**：用户说"查看好友"、"好友列表"：
```js
const friends = relay.listFriends();
// 展示：ID、添加时间
// 无好友则提示"暂无好友"
```

**查看待处理申请**：用户说"好友申请"、"待处理申请"：
```js
const reqs = relay.listFriendRequests();
// 展示每条：来自、时间、留言
// 提示用户说"同意 <ID>"或"拒绝 <ID>"
```

**同意申请**：用户说"同意 <ID>"、"接受 <ID> 的申请"：
```js
await relay.acceptFriendRequest('对方ID');
// 告知用户：已添加为好友，对方会收到通知
```

**拒绝申请**：用户说"拒绝 <ID>"、"拒绝 <ID> 的申请"：
```js
await relay.rejectFriendRequest('对方ID');
// 告知用户：已拒绝
```

**删除好友**：用户说"删除好友 <ID>"、"移除好友 <ID>"：
```js
relay.removeFriend('对方ID');
// 告知用户：已从好友列表移除
```

---

## 查看消息

当用户说"查看消息"、"收件箱"、"所有消息"、"有没有新消息"等：

```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
const msgs = relay.checkInbox(); // 全部消息
if (msgs.length === 0) {
  // 告诉用户：暂无消息记录
} else {
  // 先统计：共 X 条，其中 Y 条未读
  // 然后逐条展示（按时间从旧到新排列）：
  //
  // 🔴 [未读]  #1  👻 [陌生人]
  // 发件人: hostname-abc
  // 时间:   2026-03-19 15:32:01
  // 内容:   你好，在吗？
  //
  // ✅ [已读]  #2  👤 [好友]
  // 发件人: macbook-pro
  // 时间:   2026-03-19 15:45:22
  // 内容:   测试消息
  //
  // 注意：系统消息（好友申请/同意/拒绝）也一并展示，用对应标签标注
}
```

---

## 漂流瓶

**丢瓶子**：用户说"丢漂流瓶 <内容>"、"扔一个瓶子"等：
```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
const res = await relay.throwBottle('瓶子里的内容');
// 告知用户：瓶子已丢出，瓶子ID: {res.bottleId}，等待有缘人捡到
```

**捡瓶子**：用户说"捡漂流瓶"、"捡一个瓶子"等：
```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
const res = await relay.pickBottle();
if (!res.bottle) {
  // 告知用户：大海里暂时没有漂流瓶
} else {
  // 展示：
  // 🍾 捡到一个漂流瓶！
  // 来自: {res.bottle.fromNickname}  丢出时间: {new Date(res.bottle.ts).toLocaleString()}
  // 内容: {res.bottle.content}
  // 瓶子ID: {res.bottle.id}
  // → 说 "回复这个瓶子 <内容>" 可以回复
  // 记住当前 bottleId 以便后续回复
}
```

**回复瓶子**：用户说"回复这个瓶子 <内容>"、"回复瓶子 <内容>"等（需要记住捡到的 bottleId）：
```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
await relay.replyToBottle('上次捡到的bottleId', '回复内容');
// 告知用户：回复已发送，对方会收到通知
```

---

## 昵称

当用户说"设置昵称 <名字>"、"我的名字是 <名字>"、"把我的名字改成 <名字>"等：

```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
const name = relay.setNickname('用户输入的名字');
// 告知用户：昵称已设置为 "{name}"，之后发出的所有消息对方都会看到这个名字
```

当用户说"我的昵称是什么"、"当前昵称"等：

```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
const name = relay.getNickname();
// 告知用户：当前昵称为 "{name}"
```

---

## 帮助

当用户说"帮助"、"有哪些功能"、"怎么用"：
```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
console.log(relay.help());
```

---

## 版本

当用户说"版本号"、"relay 版本"：
```js
const relay = require(require('path').join(process.env.HOME, '.openclaw/skills/relay/relay.js'));
console.log(relay.version());
```
