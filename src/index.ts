import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { Store } from './db.js';
import { normalizeNumber } from './util.js';

const store = new Store(config.dbPath);
const senderChains = new Map<string, Promise<void>>();
const scheduled = new Set<string>();
const maxBodyBytes = 1_000_000;
const requestTimeoutMs = 60_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function validSignature(raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', config.appSecret).update(raw).digest('hex');
  const actual = header.slice(7);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function extractMessages(payload: any): Array<{ id: string; sender: string; text: string }> {
  if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return [];
  const result: Array<{ id: string; sender: string; text: string }> = [];
  for (const entry of payload.entry) for (const change of entry?.changes ?? []) {
    for (const message of change?.value?.messages ?? []) {
      const sender = normalizeNumber(String(message?.from ?? ''));
      const text = typeof message?.text?.body === 'string' ? message.text.body.trim() : '';
      if (message?.type === 'text' && message?.id && sender && text && !String(message.from).includes('@g.us')) {
        result.push({ id: String(message.id), sender, text });
      }
    }
  }
  return result;
}

function enqueue(sender: string, task: () => Promise<void>): void {
  const previous = senderChains.get(sender) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task).finally(() => {
    if (senderChains.get(sender) === current) senderChains.delete(sender);
  });
  senderChains.set(sender, current);
}

function schedule(messageId: string): void {
  if (scheduled.has(messageId)) return;
  const message = store.getMessage(messageId);
  if (!message || message.status === 'sent' || message.nextAttemptAt > Date.now()) return;
  if (store.hasEarlierPending(message.senderId, messageId)) return;
  scheduled.add(messageId);
  enqueue(message.senderId, async () => {
    try {
      const current = store.getMessage(messageId);
      if (!current || current.status === 'sent') return;
      if (current.reply) await sendStored(messageId);
      else if (current.text) await processMessage(messageId, current.senderId, current.text);
    } finally { scheduled.delete(messageId); }
  });
}

async function dify(query: string, sender: string, conversationId: string | null): Promise<{ answer: string; conversationId: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const body: Record<string, unknown> = { inputs: {}, query, response_mode: 'blocking', user: sender };
    if (conversationId) body.conversation_id = conversationId;
    const response = await fetch(`${config.difyBaseUrl}/chat-messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.difyApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error('Dify request failed');
    const data = await response.json() as { answer?: unknown; conversation_id?: unknown };
    if (typeof data.answer !== 'string' || typeof data.conversation_id !== 'string' || !data.answer.trim()) throw new Error('Invalid Dify response');
    return { answer: data.answer.trim(), conversationId: data.conversation_id };
  } finally { clearTimeout(timer); }
}

async function sendWhatsApp(sender: string, text: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.metaAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: sender, type: 'text', text: { body: text } }), signal: controller.signal,
    });
    if (!response.ok) throw new Error('WhatsApp request failed');
  } finally { clearTimeout(timer); }
}

async function sendStored(messageId: string): Promise<void> {
  const message = store.getMessage(messageId);
  if (!message || message.status === 'sent' || !message.reply) return;
  try {
    await sendWhatsApp(message.senderId, message.reply);
    store.setMessage(messageId, 'sent');
  } catch (error) {
    const current = store.getMessage(messageId);
    store.retry(messageId, (current?.attempts ?? 0) + 1);
    console.error(JSON.stringify({ event: 'message_failed', stage: 'whatsapp', messageId, attempt: (current?.attempts ?? 0) + 1, error: error instanceof Error ? error.message : 'unknown' }));
  }
}

async function processMessage(messageId: string, sender: string, text: string): Promise<void> {
  if (text.toLowerCase() === '/reset') {
    store.resetSession(sender);
    store.setMessage(messageId, 'answered', '新对话已开始。');
    await sendStored(messageId);
    return;
  }
  try {
    const result = await dify(text, sender, store.getSession(sender, config.sessionTimeoutMs));
    store.setSession(sender, result.conversationId);
    store.setMessage(messageId, 'answered', result.answer);
    await sendStored(messageId);
  } catch (error) {
    const current = store.getMessage(messageId);
    store.retry(messageId, (current?.attempts ?? 0) + 1);
    console.error(JSON.stringify({ event: 'message_failed', stage: 'dify', messageId, attempt: (current?.attempts ?? 0) + 1, error: error instanceof Error ? error.message : 'unknown' }));
  }
}

function recover(): void {
  for (const message of store.dueMessages()) {
    schedule(message.messageId);
  }
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const signature = req.headers['x-hub-signature-256'];
  if (!validSignature(raw, Array.isArray(signature) ? signature[0] : signature)) return json(res, 401, { error: 'invalid signature' });
  let payload: unknown;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'invalid json' }); }
  const messages = extractMessages(payload);
  for (const message of messages) {
    if (!config.allowedNumbers.has(message.sender)) continue;
    if (store.claimMessage(message.id, message.sender, message.text)) {
      setImmediate(() => schedule(message.id));
    } else {
      const existing = store.getMessage(message.id);
      if (existing && existing.status !== 'sent') setImmediate(() => schedule(message.id));
    }
  }
  json(res, 200, { received: true });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/webhook') {
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === config.verifyToken) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(url.searchParams.get('hub.challenge') ?? '');
      }
      return json(res, 403, { error: 'verification failed' });
    }
    if (req.method === 'POST' && url.pathname === '/webhook') return await handleWebhook(req, res);
    json(res, 404, { error: 'not found' });
  } catch (error) { if (!res.headersSent) json(res, error instanceof Error && error.message === 'body too large' ? 413 : 500, { error: error instanceof Error && error.message === 'body too large' ? 'payload too large' : 'internal error' }); }
});

server.listen(config.port, () => { recover(); setInterval(recover, 5000); console.log(JSON.stringify({ event: 'started', port: config.port })); });
