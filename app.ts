// The forge's HTTP server: one in-memory Forge behind four surfaces — REST v3, GraphQL, MCP and
// git smart HTTP — with the protocol discipline the suite checks on every reply (JSON bodies,
// {message} errors, an X-GitHub-Request-Id, 401 without the token). main.ts owns the lifecycle;
// this file is only the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { ApiError, handleRest } from './rest.ts';
import { executeGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(36)}`;
}

function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  requestId: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Readonly<Record<string, string>> = {}): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, requestId, extra);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  if (EXPECTED_TOKEN !== '') return header === `Bearer ${EXPECTED_TOKEN}` || header === `token ${EXPECTED_TOKEN}`;
  return header.startsWith('Bearer ') || header.startsWith('token ');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Path segments, decoded; a segment that fails to decode is kept raw (routing will 404 it). */
function segmentsOf(pathname: string): string[] {
  const pieces = pathname.split('/');
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece === '') continue;
    if (!piece.includes('%')) {
      out.push(piece);
      continue;
    }
    try {
      out.push(decodeURIComponent(piece));
    } catch {
      out.push(piece);
    }
  }
  return out;
}

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? '' : rawUrl.slice(qIndex + 1));
  const segments = segmentsOf(pathname);

  // The env's boot probe: open, tiny, constant.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' }, requestId);
    return;
  }

  try {
    // Git smart HTTP: /<owner>/<repo>.git/...
    if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
      const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      const result = handleGit(forge, method, segments, query, req.headers, raw);
      sendBuffer(res, result.status, result.body, result.contentType, requestId);
      return;
    }

    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
        return;
      }
      if (Array.isArray(parsed)) {
        const results = parsed.map((entry) =>
          executeGraphQL(forge, (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>),
        );
        sendJson(res, 200, results, requestId);
        return;
      }
      const result = executeGraphQL(forge, (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>);
      sendJson(res, 200, result, requestId);
      return;
    }

    if (pathname === '/mcp') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      const raw = await readBody(req);
      const result = handleMcp(forge, raw);
      if (result.body === null) {
        res.writeHead(result.status, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendBuffer(res, result.status, Buffer.from(result.body, 'utf8'), JSON_TYPE, requestId);
      return;
    }

    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const raw = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
      const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : '127.0.0.1';
      const result = handleRest(forge, method, segments.slice(2), query, raw, host);
      if (result.status === 204 || result.body === undefined) {
        res.writeHead(result.status, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
        res.end();
        return;
      }
      sendJson(res, result.status, result.body, requestId, result.headers);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { message: err.message }, requestId);
      return;
    }
    process.stderr.write(`[forge] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    void dispatch(forge, req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] dispatch failure: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, nextRequestId());
        else res.end();
      } catch {
        // the socket is gone; nothing more to do
      }
    });
  });
  return server;
}
