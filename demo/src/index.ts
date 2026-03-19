import { spawn } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import { sendMessage, pollMessages } from 'relay-skill';

const RELAY_PORT = 3099;
const SERVER_URL = `http://localhost:${RELAY_PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForServer(retries = 30): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    function attempt() {
      http
        .get(`${SERVER_URL}/health`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        })
        .on('error', retry);
    }
    function retry() {
      attempts++;
      if (attempts >= retries) {
        reject(new Error('Relay server did not start in time'));
      } else {
        setTimeout(attempt, 300);
      }
    }
    attempt();
  });
}

async function main() {
  // ── Start relay server ────────────────────────────────────────────────────
  const serverPath = path.resolve(__dirname, '../../relay-server/dist/index.js');
  const server = spawn('node', [serverPath], {
    env: { ...process.env, PORT: String(RELAY_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (d: Buffer) => process.stdout.write(`  ${d.toString()}`));
  server.stderr.on('data', (d: Buffer) => process.stderr.write(`  ${d.toString()}`));
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[relay-server] exited with code ${code}`);
  });

  process.on('exit', () => server.kill());

  console.log('\nWaiting for relay server...');
  await waitForServer();
  console.log('Relay server ready.\n');
  console.log('='.repeat(60));

  // ── user-a sends a schedule_check ─────────────────────────────────────────
  const msgA = 'Are you free this Friday?';
  console.log(`\n[user-a → relay]  taskType=schedule_check  "${msgA}"`);
  await sendMessage('user-b', 'schedule_check', msgA, 'user-a', SERVER_URL);

  await sleep(200);

  // ── user-b polls and auto-replies ─────────────────────────────────────────
  console.log('\n[relay → user-b]  Polling messages for user-b...');
  const msgsForB = await pollMessages('user-b', SERVER_URL);

  for (const msg of msgsForB) {
    console.log(
      `[user-b received]  from=${msg.from}  taskType=${msg.payload.taskType}  "${msg.payload.content}"`,
    );

    const reply = "Yes I'm free Friday afternoon";
    console.log(`\n[user-b → relay]  taskType=schedule_reply  "${reply}"`);
    await sendMessage(msg.from, 'schedule_reply', reply, 'user-b', SERVER_URL);
  }

  await sleep(200);

  // ── user-a polls for the reply ────────────────────────────────────────────
  console.log('\n[relay → user-a]  Polling messages for user-a...');
  const msgsForA = await pollMessages('user-a', SERVER_URL);

  for (const msg of msgsForA) {
    console.log(
      `[user-a received]  from=${msg.from}  taskType=${msg.payload.taskType}  "${msg.payload.content}"`,
    );
  }

  console.log('\n' + '='.repeat(60));
  console.log('Demo complete.\n');

  server.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
