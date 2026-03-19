import axios from 'axios';

export interface Message {
  from: string;
  to: string;
  payload: {
    taskType: string;
    content: string;
  };
  ts: number;
}

function resolveUrl(serverUrl?: string): string {
  return serverUrl || process.env.RELAY_SERVER_URL || 'http://localhost:3000';
}

/**
 * Send a message to another user via the relay server.
 */
export async function sendMessage(
  toUserId: string,
  taskType: string,
  content: string,
  fromUserId: string,
  serverUrl?: string,
): Promise<void> {
  const url = resolveUrl(serverUrl);
  await axios.post(`${url}/send`, {
    from: fromUserId,
    to: toUserId,
    payload: { taskType, content },
  });
}

/**
 * Poll and clear all pending messages for a user.
 */
export async function pollMessages(myUserId: string, serverUrl?: string): Promise<Message[]> {
  const url = resolveUrl(serverUrl);
  const res = await axios.get<Message[]>(`${url}/poll/${myUserId}`);
  return res.data;
}

/**
 * Start a polling loop that calls onMessage for each incoming message.
 * Returns the interval handle so you can clearInterval() to stop.
 */
export function startPolling(
  myUserId: string,
  onMessage: (msg: Message) => void,
  intervalMs = 30000,
  serverUrl?: string,
): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const msgs = await pollMessages(myUserId, serverUrl);
      for (const msg of msgs) onMessage(msg);
    } catch (err) {
      console.error(`[relay-skill] Poll error for ${myUserId}:`, err);
    }
  }, intervalMs);
}
