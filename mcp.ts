// The MCP endpoint at /mcp: both protocol eras the suite negotiates. Modern servers answer
// server/discover with a DiscoverResult; the legacy initialize handshake is served too. Tool calls
// run against the same forge the REST surface serves, so ids and objects agree across surfaces.

import { Forge } from './store.ts';
import type { Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { VIEWER } from './scenario.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The repository owner login (defaults to the viewer).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list payload: a pre-serialized constant, byte-identical across calls. */
const TOOLS_LIST_JSON = JSON.stringify(
  TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
);

export interface McpResult {
  status: number;
  body: string | null; // null: no body (a notification acknowledgement)
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolOk(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value as Record<string, unknown>, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcCode: number; message: string } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (!def) return { rpcCode: -32602, message: `unknown tool: ${name}` };
  for (const required of def.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { rpcCode: -32602, message: `missing required argument: ${required}` };
    }
  }
  const needRepo = (): Repo | null => forge.getRepo(strArg(args, 'owner') || VIEWER.login, strArg(args, 'repo'));
  switch (name) {
    case 'create_repo': {
      const owner = strArg(args, 'owner') || VIEWER.login;
      const repo = forge.createRepo(owner, strArg(args, 'name'), args.private === true, strArg(args, 'description'));
      if (!repo) return toolError(`repository ${owner}/${strArg(args, 'name')} already exists`);
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = needRepo();
      if (!repo) return toolError(`repository ${strArg(args, 'owner')}/${strArg(args, 'repo')} not found`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = needRepo();
      if (!repo) return toolError('repository not found');
      const issue = forge.createIssue(repo, strArg(args, 'title'), strArg(args, 'body'), []);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo();
      if (!repo) return toolError('repository not found');
      const state = strArg(args, 'state') || 'open';
      const list = [...repo.items.values()].filter(
        (item) => item.kind === 'issue' && (state === 'all' || item.state === state),
      );
      return toolOk(list.map((issue) => issueJson(repo, issue as never)));
    }
    case 'create_pull_request': {
      const repo = needRepo();
      if (!repo) return toolError('repository not found');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (!repo.branchTip(head)) return toolError(`head branch "${head}" does not exist`);
      if (!repo.branchTip(base)) return toolError(`base branch "${base}" does not exist`);
      const pull = forge.createPull(repo, strArg(args, 'title'), strArg(args, 'body'), head, base);
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      if (!repo) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const item = repo.items.get(number);
      if (!item || item.kind !== 'pull') return toolError(`pull request ${number} not found`);
      if (item.state !== 'open') return toolError(`pull request ${number} is not open`);
      const outcome = forge.squashMerge(repo, item);
      if (!outcome.ok) return toolError('pull request is not mergeable: merge conflict');
      return toolOk(pullJson(repo, item));
    }
    default:
      return { rpcCode: -32602, message: `unknown tool: ${name}` };
  }
}

/** Handle one decoded JSON-RPC request object. */
function handleRpc(forge: Forge, request: Record<string, unknown>): McpResult {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  if (id === undefined || id === null) {
    // A notification: acknowledged, never answered.
    return { status: 202, body: null };
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return {
        status: 200,
        body: `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":{"tools":${TOOLS_LIST_JSON}}}`,
      };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<
        string,
        unknown
      >;
      const outcome = callTool(forge, toolName, args);
      if ('rpcCode' in outcome) return rpcError(id, outcome.rpcCode, outcome.message);
      return rpcResult(id, outcome);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Handle a raw /mcp request body (a single JSON-RPC request or a batch). */
export function handleMcp(forge: Forge, raw: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const results: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const result = handleRpc(forge, entry as Record<string, unknown>);
      if (result.body !== null) results.push(result.body);
    }
    return { status: 200, body: `[${results.join(',')}]` };
  }
  if (typeof parsed !== 'object' || parsed === null) return rpcError(null, -32600, 'Invalid Request', 400);
  return handleRpc(forge, parsed as Record<string, unknown>);
}
