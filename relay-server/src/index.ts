import express, { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
app.use(express.json());

interface Message {
  from: string;
  to: string;
  payload: {
    taskType: string;
    content: string;
  };
  ts: number;
}

// In-memory inbox: userId -> pending messages
const inbox = new Map<string, Message[]>();

function getInbox(userId: string): Message[] {
  if (!inbox.has(userId)) inbox.set(userId, []);
  return inbox.get(userId)!;
}

// Device registry: userId -> { lastSeen, version, firstSeen }
interface DeviceInfo { lastSeen: number; firstSeen: number; version: string; }
const devices = new Map<string, DeviceInfo>();

function touchDevice(userId: string, version = 'unknown') {
  const now = Date.now();
  const existing = devices.get(userId);
  devices.set(userId, { lastSeen: now, firstSeen: existing?.firstSeen ?? now, version });
}

// POST /send
app.post('/send', (req: Request, res: Response) => {
  const { from, to, payload } = req.body as Partial<Message>;
  if (!from || !to || !payload?.taskType || !payload?.content) {
    res.status(400).json({ error: 'Missing required fields: from, to, payload.taskType, payload.content' });
    return;
  }
  const msg: Message = { from, to, payload, ts: Date.now() };
  getInbox(to).push(msg);
  console.log(`[relay] ${from} → ${to}: ${payload.taskType} | "${payload.content}"`);
  res.json({ ok: true });
});

// GET /poll/:userId — returns and clears pending messages
app.get('/poll/:userId', (req: Request, res: Response) => {
  const { userId } = req.params;
  const version = req.query.v as string || 'unknown';
  touchDevice(userId, version);
  const pending = [...getInbox(userId)];
  inbox.set(userId, []);
  if (pending.length > 0) {
    console.log(`[relay] ${userId} 取走 ${pending.length} 条消息`);
    pending.forEach(m => console.log(`  ↳ from=${m.from} type=${m.payload.taskType} | "${m.payload.content}"`));
  }
  res.json(pending);
});

// GET /devices — 查看活跃设备列表
app.get('/devices', (_req: Request, res: Response) => {
  const now = Date.now();
  const list = Array.from(devices.entries()).map(([id, info]) => ({
    id,
    version: info.version,
    active: (now - info.lastSeen) < 120000, // 2 分钟内算活跃
    lastSeen: new Date(info.lastSeen).toISOString(),
    firstSeen: new Date(info.firstSeen).toISOString(),
  })).sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  res.json({ total: list.length, active: list.filter(d => d.active).length, devices: list });
});

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// GET /skill — 返回最新 SKILL.md 内容
app.get('/skill', (_req: Request, res: Response) => {
  const skillPath = path.join(__dirname, '..', 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    res.status(404).json({ error: 'SKILL.md not found on server' });
    return;
  }
  const content = fs.readFileSync(skillPath, 'utf-8');
  res.json({ content, updatedAt: fs.statSync(skillPath).mtimeMs });
});

// GET /skill/relay — 返回最新 relay.js 内容，供客户端自动更新
app.get('/skill/relay', (_req: Request, res: Response) => {
  const relayPath = path.join(__dirname, '..', 'relay.js');
  if (!fs.existsSync(relayPath)) {
    res.status(404).json({ error: 'relay.js not found on server' });
    return;
  }
  const content = fs.readFileSync(relayPath, 'utf-8');
  res.json({ content, updatedAt: fs.statSync(relayPath).mtimeMs });
});

// ── 漂流瓶 ──────────────────────────────────────────────────────────────────

interface Bottle {
  id: string;
  from: string;
  fromNickname: string;
  content: string;
  ts: number;
  picked: boolean;
  pickedBy?: string;
}

const bottles: Bottle[] = [];

function makeId(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

// POST /bottle/throw
app.post('/bottle/throw', (req: Request, res: Response) => {
  const { from, fromNickname, content } = req.body as { from?: string; fromNickname?: string; content?: string };
  if (!from || !content) { res.status(400).json({ error: 'Missing from or content' }); return; }
  const bottle: Bottle = { id: makeId(), from, fromNickname: fromNickname || from, content, ts: Date.now(), picked: false };
  bottles.push(bottle);
  console.log(`[bottle] ${from} 丢出瓶子 #${bottle.id}: "${content.slice(0, 30)}"`);
  res.json({ ok: true, bottleId: bottle.id });
});

// GET /bottle/pick?userId=xxx
app.get('/bottle/pick', (req: Request, res: Response) => {
  const userId = req.query.userId as string;
  if (!userId) { res.status(400).json({ error: 'Missing userId' }); return; }
  const available = bottles.filter(b => !b.picked && b.from !== userId);
  if (available.length === 0) { res.json({ bottle: null }); return; }
  const bottle = available[Math.floor(Math.random() * available.length)];
  bottle.picked = true;
  bottle.pickedBy = userId;
  console.log(`[bottle] ${userId} 捡到瓶子 #${bottle.id} (来自 ${bottle.from})`);
  res.json({ bottle });
});

// POST /bottle/reply
app.post('/bottle/reply', (req: Request, res: Response) => {
  const { bottleId, from, fromNickname, content } = req.body as { bottleId?: string; from?: string; fromNickname?: string; content?: string };
  if (!bottleId || !from || !content) { res.status(400).json({ error: 'Missing bottleId, from or content' }); return; }
  const bottle = bottles.find(b => b.id === bottleId);
  if (!bottle) { res.status(404).json({ error: 'Bottle not found' }); return; }
  const msg: Message = {
    from,
    to: bottle.from,
    payload: { taskType: 'bottle_reply', content: JSON.stringify({ reply: content, fromNickname: fromNickname || from, bottleId, originalContent: bottle.content }) },
    ts: Date.now(),
  };
  getInbox(bottle.from).push(msg);
  console.log(`[bottle] ${from} 回复瓶子 #${bottleId} → ${bottle.from}`);
  res.json({ ok: true });
});

// GET /bottle/list — 查看所有漂流瓶状态（调试用）
app.get('/bottle/list', (_req: Request, res: Response) => {
  res.json({ total: bottles.length, floating: bottles.filter(b => !b.picked).length, picked: bottles.filter(b => b.picked).length });
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`[relay-server] Listening on port ${PORT}`);
});
