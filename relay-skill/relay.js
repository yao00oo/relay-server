/**
 * OpenClaw Relay Skill
 * Drop this file into your OpenClaw skills directory.
 *
 * Config (env vars):
 *   RELAY_SERVER_URL  — e.g. http://your-vps-ip:3000
 *   MY_USER_ID        — e.g. user-a
 *
 * Usage:
 *   const relay = require('./relay');
 *   await relay.sendMessage('user-b', 'schedule_check', 'Are you free Friday?');
 *   const msgs = await relay.pollMessages();
 *   relay.startPolling((msg) => console.log(msg));
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const RELAY_SERVER_URL = process.env.RELAY_SERVER_URL || 'https://limit-troy-demonstration-example.trycloudflare.com';
const MY_USER_ID = process.env.MY_USER_ID || 'unknown';

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
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
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        });
      }
    );

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Send a message to another user.
 * @param {string} toUserId
 * @param {string} taskType
 * @param {string} content
 * @param {string} [fromUserId]  defaults to MY_USER_ID env var
 */
async function sendMessage(toUserId, taskType, content, fromUserId = MY_USER_ID) {
  return request('POST', `${RELAY_SERVER_URL}/send`, {
    from: fromUserId,
    to: toUserId,
    payload: { taskType, content },
  });
}

/**
 * Poll and clear all pending messages for this user.
 * @param {string} [myUserId]  defaults to MY_USER_ID env var
 * @returns {Promise<Array>}
 */
async function pollMessages(myUserId = MY_USER_ID) {
  return request('GET', `${RELAY_SERVER_URL}/poll/${myUserId}`);
}

/**
 * Start a polling loop. Calls onMessage(msg) for each incoming message.
 * @param {(msg: object) => void} onMessage
 * @param {number} [intervalMs]  default 30000
 * @param {string} [myUserId]   defaults to MY_USER_ID env var
 * @returns {NodeJS.Timeout}    call clearInterval() to stop
 */
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

module.exports = { sendMessage, pollMessages, startPolling };
