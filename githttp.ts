// Git smart HTTP: v0/v2 advertisements, v2 ls-refs and fetch (with shallow/deepen), v0 fetch, and
// receive-pack with report-status. Packs out are always plain objects; packs in may carry deltas.

import {
  PKT_DELIM,
  PKT_FLUSH,
  collectReachable,
  isAncestor,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  readPackInto,
  writePack,
  ZERO_OID,
  type PktPacket,
} from './gitcore.ts';
import { Forge } from './store.ts';
import type { Repo } from './store.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0';

/** The v2 capability advertisement never changes: built once. */
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

/** Advertisement and ls-refs bodies per repository, valid while its refsVersion stands. */
const repoResponseCache = new WeakMap<Repo, { version: number; upload?: Buffer; receive?: Buffer; lsRefs: Map<string, Buffer> }>();

function repoCache(repo: Repo): { version: number; upload?: Buffer; receive?: Buffer; lsRefs: Map<string, Buffer> } {
  let entry = repoResponseCache.get(repo);
  if (!entry || entry.version !== repo.refsVersion) {
    entry = { version: repo.refsVersion, lsRefs: new Map() };
    repoResponseCache.set(repo, entry);
  }
  return entry;
}

/**
 * Fetch response bodies, memoized by the request's object-level fingerprint. The object graph is
 * immutable and content-addressed, so a body computed once stays correct forever; the cache is
 * bounded and simply forgets cold entries.
 */
const fetchBodyCache = new Map<string, Buffer>();
const FETCH_CACHE_LIMIT = 512;

function fetchCacheGet(key: string): Buffer | null {
  return fetchBodyCache.get(key) ?? null;
}

function fetchCachePut(key: string, body: Buffer): void {
  if (fetchBodyCache.size >= FETCH_CACHE_LIMIT) {
    const oldest = fetchBodyCache.keys().next().value;
    if (oldest !== undefined) fetchBodyCache.delete(oldest);
  }
  fetchBodyCache.set(key, body);
}

function jsonError(status: number, message: string): GitResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** All refs of a repo as [name, oid], sorted by name (tags included), plus HEAD's target. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function infoRefs(forge: Forge, repo: Repo, service: string, gitProtocol: string): GitResult {
  if (service === 'git-upload-pack' && gitProtocol.includes('version=2')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
  }
  const isUpload = service === 'git-upload-pack';
  const cache = repoCache(repo);
  const cached = isUpload ? cache.upload : cache.receive;
  if (cached) {
    return {
      status: 200,
      contentType: isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
      body: cached,
    };
  }
  const capabilities = isUpload
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}`));
  } else {
    let first = true;
    const headTip = repo.branchTip(repo.defaultBranch);
    if (headTip) {
      lines.push(pktLine(`${headTip} HEAD\0${capabilities}`));
      first = false;
    }
    for (const [name, oid] of refs) {
      lines.push(pktLine(first ? `${oid} ${name}\0${capabilities}` : `${oid} ${name}`));
      first = false;
      const object = forge.store.get(oid);
      if (object && object.type === 'tag') {
        lines.push(pktLine(`${peelToCommit(forge.store, oid)} ${name}^{}`));
      }
    }
  }
  lines.push(PKT_FLUSH);
  const body = Buffer.concat(lines);
  if (isUpload) cache.upload = body;
  else cache.receive = body;
  return {
    status: 200,
    contentType: isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body,
  };
}

// --------------------------------------------------------------------------- ls-refs

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(raw: Buffer): V2Request {
  const { packets } = parsePktLines(raw);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

function lsRefs(forge: Forge, repo: Repo, args: readonly string[]): GitResult {
  const cacheKey = args.join('\n');
  const cache = repoCache(repo);
  const cachedBody = cache.lsRefs.get(cacheKey);
  if (cachedBody) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cachedBody };
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip) {
      lines.push(pktLine(`${headTip} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let suffix = '';
    if (wantPeel) {
      const object = forge.store.get(oid);
      if (object && object.type === 'tag') suffix = ` peeled:${peelToCommit(forge.store, oid)}`;
    }
    lines.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  lines.push(PKT_FLUSH);
  const body = Buffer.concat(lines);
  cache.lsRefs.set(cacheKey, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// --------------------------------------------------------------------------- fetch planning

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
}

/** Objects the client already holds: closure of haves, with commit ancestry cut at the shallow set. */
function heldObjects(forge: Forge, haves: readonly string[], shallowBoundary: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (held.has(oid) || oid === ZERO_OID) continue;
    const object = forge.store.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!shallowBoundary.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return held;
}

function planFetch(
  forge: Forge,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundary: readonly string[],
  depth: number | null,
): FetchPlan {
  const boundarySet = new Set(shallowBoundary);
  const held = heldObjects(forge, haves, boundarySet);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  let include: Set<string>;
  if (depth !== null && depth > 0) {
    // Commits within `depth` of a want, plus their trees and blobs.
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = [];
    for (const want of wants) {
      const commit = peelToCommit(forge.store, want);
      if (!distance.has(commit)) {
        distance.set(commit, 1);
        queue.push({ oid: commit, dist: 1 });
      }
    }
    while (queue.length) {
      const { oid, dist } = queue.shift() as { oid: string; dist: number };
      if (dist >= depth) continue;
      const object = forge.store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push({ oid: parent, dist: dist + 1 });
        }
      }
    }
    include = new Set<string>();
    for (const want of wants) include.add(want);
    for (const commit of distance.keys()) {
      include.add(commit);
      const object = forge.store.get(commit);
      if (object && object.type === 'commit') include.add(parseCommit(object.data).tree);
    }
    // Trees and blobs beneath the included trees.
    const stack = [...include];
    while (stack.length) {
      const oid = stack.pop() as string;
      const object = forge.store.get(oid);
      if (!object) continue;
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (!include.has(entry.oid)) {
            include.add(entry.oid);
            stack.push(entry.oid);
          }
        }
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (!include.has(target)) include.add(target);
      }
    }
    for (const commit of distance.keys()) {
      const object = forge.store.get(commit);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const cut = parents.some((parent) => !distance.has(parent));
      if (cut && parents.length > 0) shallow.push(commit);
      if (boundarySet.has(commit) && !cut) unshallow.push(commit);
    }
  } else {
    include = collectReachable(forge.store, wants);
  }
  const send = [...include].filter((oid) => !held.has(oid) && forge.store.has(oid));
  return { send, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function fetchV2(forge: Forge, repo: Repo, args: readonly string[]): GitResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || null;
  }
  const cacheKey = `v2|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallow].sort().join(',')}|${depth ?? ''}`;
  const cached = fetchCacheGet(cacheKey);
  if (cached) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  const plan = planFetch(forge, wants, haves, shallow, depth);
  const pack = writePack(forge.store, plan.send);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM];
  if (depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'), ...sidebandPackets(pack), PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(cacheKey, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function fetchV0(forge: Forge, repo: Repo, raw: Buffer): GitResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let offset = 0;
  let section = 0;
  while (offset < raw.length) {
    const { packets, next } = parsePktLines(raw, offset);
    offset = next;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5, 45).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim()) || null;
    }
    if (section >= 2) break;
    if (packets.length === 0) break;
  }
  const cacheKey = `v0|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallow].sort().join(',')}|${depth ?? ''}`;
  const cached = fetchCacheGet(cacheKey);
  if (cached) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  const plan = planFetch(forge, wants, haves, shallow, depth);
  const pack = writePack(forge.store, plan.send);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'), ...sidebandPackets(pack), PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(cacheKey, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function uploadPack(forge: Forge, repo: Repo, raw: Buffer): GitResult {
  // A v2 request starts with a command= pkt-line; anything else is a v0 want list (or garbage).
  let firstText = '';
  try {
    const { packets } = parsePktLines(raw);
    const first = packets.find((packet): packet is Extract<PktPacket, { kind: 'data' }> => packet.kind === 'data');
    firstText = first ? first.payload.toString('utf8') : '';
  } catch {
    return jsonError(400, 'malformed pkt-line request');
  }
  if (firstText.startsWith('command=')) {
    const { command, args } = parseV2Request(raw);
    if (command === 'ls-refs') return lsRefs(forge, repo, args);
    if (command === 'fetch') return fetchV2(forge, repo, args);
    return jsonError(400, `unknown command ${command}`);
  }
  try {
    return fetchV0(forge, repo, raw);
  } catch {
    return jsonError(400, 'malformed upload-pack request');
  }
}

// --------------------------------------------------------------------------- receive-pack

function receivePack(forge: Forge, repo: Repo, raw: Buffer): GitResult {
  let packets: PktPacket[];
  let packStart: number;
  try {
    const parsed = parsePktLines(raw);
    packets = parsed.packets;
    packStart = parsed.next;
  } catch {
    return jsonError(400, 'malformed pkt-line request');
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length !== 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const wantsReport = capabilities.split(' ').includes('report-status') || capabilities.split(' ').includes('report-status-v2');

  let unpackError: string | null = null;
  const packBytes = raw.subarray(packStart);
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length > 0) {
    try {
      readPackInto(forge.store, Buffer.from(packBytes));
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (hasUpdates && packBytes.length === 0) {
    unpackError = 'no pack sent for a ref update';
  }

  const report: string[] = [unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n'];
  for (const command of commands) {
    const fail = (reason: string): void => {
      report.push(`ng ${command.ref} ${reason}\n`);
    };
    if (unpackError) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) {
        fail('reference not found');
        continue;
      }
      repo.deleteRef(command.ref);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    const object = forge.store.get(command.newOid);
    if (!object) {
      fail('unknown object');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== ZERO_OID) {
        fail('reference already exists');
        continue;
      }
    } else {
      if (current === ZERO_OID) {
        fail('reference not found');
        continue;
      }
      if (current !== command.oldOid) {
        fail('stale reference value');
        continue;
      }
      if (command.ref.startsWith('refs/heads/')) {
        const newCommit = peelToCommit(forge.store, command.newOid);
        const oldCommit = peelToCommit(forge.store, current);
        if (!isAncestor(forge.store, oldCommit, newCommit)) {
          fail('non-fast-forward');
          continue;
        }
      }
    }
    repo.setRef(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }

  if (!wantsReport) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const framed = report.map((line) => {
    const payload = Buffer.from(line, 'utf8');
    return useSideband ? pktLine(Buffer.concat([Buffer.from([1]), payload])) : pktLine(payload);
  });
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat([...framed, PKT_FLUSH]),
  };
}

// --------------------------------------------------------------------------- entry

/** Route one git smart-HTTP request. Segments: [owner, '<repo>.git', ...tail]. */
export function handleGit(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  raw: Buffer,
): GitResult {
  const owner = segments[0] as string;
  const repoSegment = segments[1] as string;
  const name = repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : repoSegment;
  const repo = forge.getRepo(owner, name);
  if (!repo) return jsonError(404, 'Not Found');
  const tail = segments.slice(2);
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonError(400, 'unknown service');
    const gitProtocol = String(headers['git-protocol'] ?? '');
    return infoRefs(forge, repo, service, gitProtocol);
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    try {
      return uploadPack(forge, repo, raw);
    } catch {
      return jsonError(400, 'malformed upload-pack request');
    }
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    try {
      return receivePack(forge, repo, raw);
    } catch {
      return jsonError(400, 'malformed receive-pack request');
    }
  }
  return jsonError(404, 'Not Found');
}
