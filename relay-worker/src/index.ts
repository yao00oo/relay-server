export interface Env {
  DB: D1Database;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // GET /health
    if (method === 'GET' && path === '/health') {
      return json({ ok: true });
    }

    // POST /send
    if (method === 'POST' && path === '/send') {
      const body = await request.json() as any;
      const { from, to, payload } = body;
      if (!from || !to || !payload?.taskType || !payload?.content) {
        return json({ error: 'Missing required fields' }, 400);
      }
      const id = makeId();
      await env.DB.prepare(
        'INSERT INTO messages (id, from_id, to_id, task_type, content, from_nickname, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, from, to, payload.taskType, payload.content, payload.fromNickname || '', Date.now()).run();
      return json({ ok: true });
    }

    // GET /poll/:userId
    const pollMatch = path.match(/^\/poll\/(.+)$/);
    if (method === 'GET' && pollMatch) {
      const userId = pollMatch[1];
      const version = url.searchParams.get('v') || 'unknown';
      const now = Date.now();

      // upsert device
      await env.DB.prepare(
        'INSERT INTO devices (user_id, version, last_seen, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version, last_seen=excluded.last_seen'
      ).bind(userId, version, now, now).run();

      // fetch and delete pending messages
      const msgs = await env.DB.prepare(
        'SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY ts ASC'
      ).bind(userId).all();

      if (msgs.results.length > 0) {
        await env.DB.prepare('UPDATE messages SET delivered = 1 WHERE to_id = ? AND delivered = 0')
          .bind(userId).run();
      }

      return json(msgs.results.map((m: any) => ({
        from: m.from_id,
        to: m.to_id,
        payload: { taskType: m.task_type, content: m.content, fromNickname: m.from_nickname },
        ts: m.ts,
      })));
    }

    // GET /devices
    if (method === 'GET' && path === '/devices') {
      const now = Date.now();
      const result = await env.DB.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all();
      const devices = result.results.map((d: any) => ({
        id: d.user_id,
        version: d.version,
        active: (now - d.last_seen) < 120000,
        lastSeen: new Date(d.last_seen).toISOString(),
        firstSeen: new Date(d.first_seen).toISOString(),
      }));
      return json({ total: devices.length, active: devices.filter((d: any) => d.active).length, devices });
    }

    // POST /bottle/throw
    if (method === 'POST' && path === '/bottle/throw') {
      const body = await request.json() as any;
      const { from, fromNickname, content } = body;
      if (!from || !content) return json({ error: 'Missing from or content' }, 400);
      const id = makeId();
      await env.DB.prepare(
        'INSERT INTO bottles (id, from_id, from_nickname, content, ts) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, from, fromNickname || from, content, Date.now()).run();
      return json({ ok: true, bottleId: id });
    }

    // GET /bottle/pick
    if (method === 'GET' && path === '/bottle/pick') {
      const userId = url.searchParams.get('userId');
      if (!userId) return json({ error: 'Missing userId' }, 400);
      const result = await env.DB.prepare(
        'SELECT * FROM bottles WHERE picked = 0 AND from_id != ? ORDER BY RANDOM() LIMIT 1'
      ).bind(userId).first() as any;
      if (!result) return json({ bottle: null });
      await env.DB.prepare('UPDATE bottles SET picked = 1, picked_by = ? WHERE id = ?')
        .bind(userId, result.id).run();
      return json({ bottle: { id: result.id, from: result.from_id, fromNickname: result.from_nickname, content: result.content, ts: result.ts } });
    }

    // POST /bottle/reply
    if (method === 'POST' && path === '/bottle/reply') {
      const body = await request.json() as any;
      const { bottleId, from, fromNickname, content } = body;
      if (!bottleId || !from || !content) return json({ error: 'Missing fields' }, 400);
      const bottle = await env.DB.prepare('SELECT * FROM bottles WHERE id = ?').bind(bottleId).first() as any;
      if (!bottle) return json({ error: 'Bottle not found' }, 404);
      const id = makeId();
      const replyContent = JSON.stringify({ reply: content, fromNickname: fromNickname || from, bottleId, originalContent: bottle.content });
      await env.DB.prepare(
        'INSERT INTO messages (id, from_id, to_id, task_type, content, from_nickname, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, from, bottle.from_id, 'bottle_reply', replyContent, fromNickname || from, Date.now()).run();
      return json({ ok: true });
    }

    // GET /bottle/list
    if (method === 'GET' && path === '/bottle/list') {
      const total = await env.DB.prepare('SELECT COUNT(*) as c FROM bottles').first() as any;
      const floating = await env.DB.prepare('SELECT COUNT(*) as c FROM bottles WHERE picked = 0').first() as any;
      const picked = await env.DB.prepare('SELECT COUNT(*) as c FROM bottles WHERE picked = 1').first() as any;
      return json({ total: total.c, floating: floating.c, picked: picked.c });
    }

    // GET /skill — 返回 SKILL.md
    if (method === 'GET' && path === '/skill') {
      const result = await env.DB.prepare("SELECT value FROM kv WHERE key = 'SKILL.md'").first() as any;
      if (!result) return json({ error: 'SKILL.md not found' }, 404);
      return json({ content: result.value, updatedAt: Date.now() });
    }

    // GET /skill/relay — 返回 relay.js
    if (method === 'GET' && path === '/skill/relay') {
      const result = await env.DB.prepare("SELECT value FROM kv WHERE key = 'relay.js'").first() as any;
      if (!result) return json({ error: 'relay.js not found' }, 404);
      return json({ content: result.value, updatedAt: Date.now() });
    }

    // POST /skill/update — 上传最新 skill 文件（内部用）
    if (method === 'POST' && path === '/skill/update') {
      const body = await request.json() as any;
      const secret = request.headers.get('x-admin-secret');
      if (secret !== env.ADMIN_SECRET) return json({ error: 'Unauthorized' }, 401);
      if (body.relay) {
        await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('relay.js', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(body.relay).run();
      }
      if (body.skill) {
        await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('SKILL.md', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(body.skill).run();
      }
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  },
};
