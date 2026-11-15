// The REST v3 surface: repositories, contents on the real git store, branches, commits, labels,
// issues, comments and pull requests. Handlers are pure functions of the forge plus the request;
// app.ts owns auth, body reading and the wire format.

import {
  commitAncestors,
  parseCommit,
  parseTree,
  treeListDir,
  treeLookup,
} from './gitcore.ts';
import { Forge } from './store.ts';
import type { IssueRec, PullRec, Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): never => {
  throw new ApiError(404, 'Not Found');
};

function jsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// --------------------------------------------------------------------------- serializers

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login },
    comments: issue.comments.length,
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: repo.branchTip(pull.headRef) ?? '' },
    base: { ref: pull.baseRef, sha: repo.branchTip(pull.baseRef) ?? '' },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login },
  };
}

export function commentJson(comment: { dbId: number; body: string }): Record<string, unknown> {
  return { id: comment.dbId, body: comment.body, user: { login: VIEWER.login } };
}

// --------------------------------------------------------------------------- helpers

function requireRepo(forge: Forge, owner: string, name: string): Repo {
  const repo = forge.getRepo(owner, name);
  if (!repo) notFound();
  return repo as Repo;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> {
  const object = forge.store.get(oid);
  const info = object && object.type === 'commit' ? parseCommit(object.data) : null;
  const message = (info?.message ?? '').replace(/\n$/, '');
  const authorLine = info?.author ?? '';
  const match = /^(.*?) <(.*?)> (\d+) /.exec(authorLine);
  return {
    sha: oid,
    commit: {
      message,
      author: {
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: match ? new Date(Number(match[3]) * 1000).toISOString() : '',
      },
      tree: { sha: info?.tree ?? '' },
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// --------------------------------------------------------------------------- route groups

function userRepos(forge: Forge, method: string, query: URLSearchParams, raw: Buffer, host: string): RestResult {
  if (method === 'GET') {
    const all = forge.viewerRepos();
    const { page, perPage } = pageParams(query);
    const start = (page - 1) * perPage;
    const items = all.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    if (start + perPage < all.length) {
      const next = `http://${host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
      const last = `http://${host}/api/v3/user/repos?page=${Math.ceil(all.length / perPage)}&per_page=${perPage}`;
      headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    return { status: 200, body: items.map(repoJson), headers };
  }
  if (method === 'POST') {
    const body = jsonBody(raw);
    const name = str(body, 'name');
    if (!name) throw new ApiError(422, 'Validation Failed: name is required');
    const repo = forge.createRepo(VIEWER.login, name, body.private === true, str(body, 'description') ?? '');
    if (!repo) throw new ApiError(422, 'Validation Failed: name already exists on this account');
    return { status: 201, body: repoJson(repo) };
  }
  throw new ApiError(404, 'Not Found');
}

function repoRoot(forge: Forge, repo: Repo, method: string, raw: Buffer): RestResult {
  if (method === 'GET') return { status: 200, body: repoJson(repo) };
  if (method === 'PATCH') {
    const body = jsonBody(raw);
    const description = str(body, 'description');
    if (description !== undefined) repo.description = description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    return { status: 200, body: repoJson(repo) };
  }
  if (method === 'DELETE') {
    forge.deleteRepo(repo.owner, repo.name);
    return { status: 204 };
  }
  throw new ApiError(404, 'Not Found');
}

function branches(repo: Repo, method: string, tail: string[]): RestResult {
  if (method !== 'GET') throw new ApiError(404, 'Not Found');
  if (tail.length === 0) {
    const list: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { status: 200, body: list };
  }
  const name = tail.join('/');
  const tip = repo.branchTip(name);
  if (!tip) notFound();
  return { status: 200, body: { name, commit: { sha: tip }, protected: false } };
}

function commits(forge: Forge, repo: Repo, query: URLSearchParams): RestResult {
  const refish = query.get('sha');
  const at = forge.treeAt(repo, refish);
  if (!at) return { status: 200, body: [] };
  const { page, perPage } = pageParams(query);
  const all = commitAncestors(forge.store, at.commit);
  const items = all.slice((page - 1) * perPage, page * perPage);
  return { status: 200, body: items.map((oid) => commitJson(forge, oid)) };
}

function gitRefs(forge: Forge, repo: Repo, method: string, tail: string[], raw: Buffer): RestResult {
  if (method === 'POST' && tail.length === 0) {
    const body = jsonBody(raw);
    const ref = str(body, 'ref');
    const sha = str(body, 'sha');
    if (!ref || !sha) throw new ApiError(422, 'Validation Failed: ref and sha are required');
    const object = forge.store.get(sha);
    if (!object || object.type !== 'commit') throw new ApiError(422, 'Validation Failed: object is not a commit');
    if (repo.refs.has(ref)) throw new ApiError(422, 'Validation Failed: reference already exists');
    repo.setRef(ref, sha);
    return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
  }
  if (method === 'GET' && tail.length >= 2 && tail[0] === 'heads') {
    const name = tail.slice(1).join('/');
    const tip = repo.branchTip(name);
    if (!tip) notFound();
    return { status: 200, body: { ref: `refs/heads/${name}`, object: { sha: tip, type: 'commit' } } };
  }
  throw new ApiError(404, 'Not Found');
}

function contents(forge: Forge, repo: Repo, method: string, tail: string[], query: URLSearchParams, raw: Buffer): RestResult {
  const path = tail.join('/');
  if (method === 'GET') {
    const at = forge.treeAt(repo, query.get('ref'));
    if (!at) notFound();
    if (path === '') {
      const entries = treeListDir(forge.store, at.tree, '');
      if (!entries) notFound();
      return { status: 200, body: dirListing(forge, repo, entries, '') };
    }
    const found = treeLookup(forge.store, at.tree, path);
    if (!found) notFound();
    if (found.kind === 'dir') {
      const entries = treeListDir(forge.store, at.tree, path);
      if (!entries) notFound();
      return { status: 200, body: dirListing(forge, repo, entries, path) };
    }
    const blob = forge.store.get(found.oid);
    const data = blob ? blob.data : Buffer.alloc(0);
    const name = path.split('/').pop() as string;
    return {
      status: 200,
      body: {
        type: 'file',
        name,
        path,
        sha: found.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      },
    };
  }
  if (method === 'PUT') {
    const body = jsonBody(raw);
    const message = str(body, 'message') ?? 'Update file';
    const encoded = str(body, 'content');
    if (encoded === undefined) throw new ApiError(422, 'Validation Failed: content is required');
    const data = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const sha = str(body, 'sha') ?? null;
    const result = forge.putContent(repo, path, data, message, branch, sha);
    if (result.status === 'conflict') throw new ApiError(409, 'Conflict: the file has changed since the sha was read');
    if (result.status === 'missing') throw new ApiError(404, 'Not Found');
    const name = path.split('/').pop() as string;
    return {
      status: result.status === 'created' ? 201 : 200,
      body: {
        content: { type: 'file', name, path, sha: result.blobSha, size: data.length, encoding: 'base64' },
        commit: { sha: result.commitSha },
      },
    };
  }
  if (method === 'DELETE') {
    const body = jsonBody(raw);
    const message = str(body, 'message') ?? 'Delete file';
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const sha = str(body, 'sha') ?? null;
    const result = forge.deleteContent(repo, path, message, branch, sha);
    if (result.status === 'conflict') throw new ApiError(409, 'Conflict: the file has changed since the sha was read');
    if (result.status === 'missing') throw new ApiError(404, 'Not Found');
    return { status: 200, body: { content: null, commit: { sha: result.commitSha } } };
  }
  throw new ApiError(404, 'Not Found');
}

function dirListing(forge: Forge, repo: Repo, entries: ReturnType<typeof parseTree>, prefix: string): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const object = forge.store.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: isDir ? 0 : object ? object.data.length : 0,
    };
  });
}

function labels(repo: Repo, method: string, raw: Buffer): RestResult {
  if (method === 'GET') {
    return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
  }
  if (method === 'POST') {
    const body = jsonBody(raw);
    const name = str(body, 'name');
    if (!name) throw new ApiError(422, 'Validation Failed: name is required');
    const color = (str(body, 'color') ?? 'ededed').replace(/^#/, '');
    const existing = repo.labels.get(name);
    if (existing) return { status: 201, body: { name: existing.name, color: existing.color } };
    repo.labels.set(name, { name, color });
    return { status: 201, body: { name, color } };
  }
  throw new ApiError(404, 'Not Found');
}

function validateLabels(repo: Repo, names: readonly string[]): void {
  for (const name of names) {
    if (!repo.labels.has(name)) throw new ApiError(422, `Validation Failed: label "${name}" does not exist`);
  }
}

function labelNamesOf(body: Record<string, unknown>): string[] {
  const rawLabels = body.labels;
  if (!Array.isArray(rawLabels)) return [];
  const names: string[] = [];
  for (const entry of rawLabels) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function issues(forge: Forge, repo: Repo, method: string, tail: string[], query: URLSearchParams, raw: Buffer): RestResult {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, perPage } = pageParams(query);
      return { status: 200, body: list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(repo, issue)) };
    }
    if (method === 'POST') {
      const body = jsonBody(raw);
      const title = str(body, 'title');
      if (!title) throw new ApiError(422, 'Validation Failed: title is required');
      const names = labelNamesOf(body);
      validateLabels(repo, names);
      const issue = forge.createIssue(repo, title, str(body, 'body') ?? '', names);
      return { status: 201, body: issueJson(repo, issue) };
    }
    throw new ApiError(404, 'Not Found');
  }
  const number = Number(tail[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!item) notFound();
    if (method === 'GET') {
      return { status: 200, body: (item as IssueRec).comments.map(commentJson) };
    }
    if (method === 'POST') {
      const body = jsonBody(raw);
      const comment = forge.addComment(repo, item as IssueRec, str(body, 'body') ?? '');
      return { status: 201, body: commentJson(comment) };
    }
    throw new ApiError(404, 'Not Found');
  }
  if (tail.length === 1) {
    if (!item || item.kind !== 'issue') notFound();
    const issue = item as IssueRec;
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      const body = jsonBody(raw);
      const state = str(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = str(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = str(body, 'body');
      if (text !== undefined) issue.body = text;
      if (body.labels !== undefined) {
        const names = labelNamesOf(body);
        validateLabels(repo, names);
        issue.labels = names;
      }
      return { status: 200, body: issueJson(repo, issue) };
    }
    throw new ApiError(404, 'Not Found');
  }
  throw new ApiError(404, 'Not Found');
}

function pulls(forge: Forge, repo: Repo, method: string, tail: string[], query: URLSearchParams, raw: Buffer): RestResult {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
      if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => a.number - b.number);
      const { page, perPage } = pageParams(query);
      return { status: 200, body: list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(repo, pull)) };
    }
    if (method === 'POST') {
      const body = jsonBody(raw);
      const title = str(body, 'title');
      const head = str(body, 'head');
      const base = str(body, 'base');
      if (!title || !head || !base) throw new ApiError(422, 'Validation Failed: title, head and base are required');
      const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
      if (!repo.branchTip(headBranch)) throw new ApiError(422, `Validation Failed: head branch "${headBranch}" does not exist`);
      if (!repo.branchTip(base)) throw new ApiError(422, `Validation Failed: base branch "${base}" does not exist`);
      if (headBranch === base) throw new ApiError(422, 'Validation Failed: head and base are the same');
      const duplicate = [...repo.items.values()].some(
        (item) => item.kind === 'pull' && item.state === 'open' && item.headRef === headBranch && item.baseRef === base,
      );
      if (duplicate) throw new ApiError(422, 'Validation Failed: a pull request already exists for this head and base');
      const pull = forge.createPull(repo, title, str(body, 'body') ?? '', headBranch, base);
      return { status: 201, body: pullJson(repo, pull) };
    }
    throw new ApiError(404, 'Not Found');
  }
  const number = Number(tail[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (!item || item.kind !== 'pull') notFound();
  const pull = item as PullRec;
  if (tail.length === 1 && method === 'GET') return { status: 200, body: pullJson(repo, pull) };
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    return { status: 200, body: forge.pullFiles(repo, pull) };
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    jsonBody(raw);
    if (pull.state !== 'open') throw new ApiError(405, 'Pull Request is not mergeable: it is not open');
    const outcome = forge.squashMerge(repo, pull);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') throw new ApiError(405, 'Pull Request is not mergeable: merge conflict');
      throw new ApiError(405, 'Pull Request is not mergeable');
    }
    return { status: 200, body: { merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' } };
  }
  throw new ApiError(404, 'Not Found');
}

// --------------------------------------------------------------------------- entry

/** Route one /api/v3 request. `segments` are the decoded path segments after the prefix. */
export function handleRest(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  raw: Buffer,
  host: string,
): RestResult {
  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    throw new ApiError(404, 'Not Found');
  }
  const [first, ...rest] = segments as [string, ...string[]];
  if (first === 'meta' && rest.length === 0 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (first === 'user' && rest.length === 0 && method === 'GET') {
    return { status: 200, body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' } };
  }
  if (first === 'user' && rest.length === 1 && rest[0] === 'repos') {
    return userRepos(forge, method, query, raw, host);
  }
  if (first === 'repos' && rest.length >= 2) {
    const repo = requireRepo(forge, rest[0] as string, rest[1] as string);
    const tail = rest.slice(2);
    if (tail.length === 0) return repoRoot(forge, repo, method, raw);
    const [area, ...sub] = tail as [string, ...string[]];
    switch (area) {
      case 'branches':
        return branches(repo, method, sub);
      case 'commits':
        if (method === 'GET' && sub.length === 0) return commits(forge, repo, query);
        break;
      case 'git':
        if (sub[0] === 'refs') return gitRefs(forge, repo, method, sub.slice(1), raw);
        break;
      case 'contents':
        return contents(forge, repo, method, sub, query, raw);
      case 'labels':
        if (sub.length === 0) return labels(repo, method, raw);
        break;
      case 'issues':
        return issues(forge, repo, method, sub, query, raw);
      case 'pulls':
        return pulls(forge, repo, method, sub, query, raw);
      default:
        break;
    }
  }
  throw new ApiError(404, 'Not Found');
}
