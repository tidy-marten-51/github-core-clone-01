// The git object core: SHA-1 object store, pack read/write (plain objects out, deltas resolved in),
// pkt-line framing, tree/commit/tag codecs, ancestry, tree diffs and the 3-way merges a squash needs.
// Everything is in-memory and deterministic: no clocks, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { blob: 3, commit: 1, tree: 2, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The forge-wide object database: every repository's objects in one map, keyed by oid. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// --------------------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Parse a whole pkt-line stream; throws on malformed framing (callers turn that into a 400). */
export function parsePktLines(buffer: Buffer, start = 0): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break; // a flush ends the pkt-line portion; the rest (a pack) is the caller's
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

// --------------------------------------------------------------------------- trees & commits

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const stamp = `${info.timestamp} +0000`;
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author} ${stamp}`);
  lines.push(`committer ${info.committer} ${stamp}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    if (line === '') break;
  }
  return { object, type, tag };
}

/** Peel an oid through annotated tags to the commit beneath (or return the oid itself). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// --------------------------------------------------------------------------- graph walks

/** Every object reachable from the tips (commits walk parents + trees, tags walk their target). */
export function collectReachable(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Ancestor commits of a tip, breadth-first (tip first), following parents. */
export function commitAncestors(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return order;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return new Set(commitAncestors(store, tip)).has(ancestor);
}

/** The best common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Set(commitAncestors(store, a));
  for (const candidate of commitAncestors(store, b)) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return null;
}

// --------------------------------------------------------------------------- tree flattening & diffs

/** A tree flattened to path -> {oid, mode} for files (blobs) only. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid && store.has(treeOid)) walk(treeOid, '');
  return out;
}

/** Rebuild a tree from a flattened path map, creating intermediate trees. Returns the root tree oid. */
export function unflattenTree(store: ObjectStore, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** Set (or remove, with oid null) one path in a tree; returns the new root tree oid. */
export function treeSetPath(
  store: ObjectStore,
  treeOid: string,
  path: string,
  blob: { oid: string; mode: string } | null,
): string {
  const flat = flattenTree(store, treeOid);
  if (blob === null) flat.delete(path);
  else flat.set(path, blob);
  return unflattenTree(store, flat);
}

/** Look up one path in a tree: a blob entry, a subtree oid, or null. */
export function treeLookup(
  store: ObjectStore,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string; mode: string; size: number } | { kind: 'dir'; oid: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = store.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000' || entry.mode === '040000') return { kind: 'dir', oid: entry.oid };
      const blobObject = store.get(entry.oid);
      return { kind: 'file', oid: entry.oid, mode: entry.mode, size: blobObject ? blobObject.data.length : 0 };
    }
    if (entry.mode !== '40000' && entry.mode !== '040000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: treeOid };
}

/** List one directory level of a tree (root when dirPath is ''). */
export function treeListDir(store: ObjectStore, treeOid: string, dirPath: string): TreeEntry[] | null {
  if (dirPath === '') {
    const object = store.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }
  const found = treeLookup(store, treeOid, dirPath);
  if (!found || found.kind !== 'dir') return null;
  const object = store.get(found.oid);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

// --------------------------------------------------------------------------- line diffs & 3-way merge

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS-based line diff: returns per-line ops from a to b. */
function diffLines(a: readonly string[], b: readonly string[]): Array<{ kind: 'keep' | 'del' | 'add'; line: string }> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Array<{ kind: 'keep' | 'del' | 'add'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'keep', line: a[i] as string });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: 'add', line: b[j] as string });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ kind: 'del', line: a[i] as string });
    i += 1;
  }
  while (j < n) {
    ops.push({ kind: 'add', line: b[j] as string });
    j += 1;
  }
  return ops;
}

export function lineChangeCounts(before: string, after: string): { additions: number; deletions: number } {
  const ops = diffLines(splitLines(before), splitLines(after));
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === 'add') additions += 1;
    else if (op.kind === 'del') deletions += 1;
  }
  return { additions, deletions };
}

/**
 * A diff3-style line merge. Returns the merged text, or null on a real conflict (both sides changed
 * the same region differently). Identical changes on both sides merge cleanly.
 */
export function mergeLines(ancestor: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (ancestor === ours) return theirs;
  if (ancestor === theirs) return ours;
  const a = splitLines(ancestor);
  // Changed regions of ancestor -> side, as [start, end) ancestor spans with replacement lines.
  const regions = (side: readonly string[]): Array<{ start: number; end: number; lines: string[] }> => {
    const ops = diffLines(a, side);
    const out: Array<{ start: number; end: number; lines: string[] }> = [];
    let index = 0;
    let current: { start: number; end: number; lines: string[] } | null = null;
    for (const op of ops) {
      if (op.kind === 'keep') {
        if (current) {
          out.push(current);
          current = null;
        }
        index += 1;
      } else if (op.kind === 'del') {
        if (!current) current = { start: index, end: index, lines: [] };
        current.end = index + 1;
        index += 1;
      } else {
        if (!current) current = { start: index, end: index, lines: [] };
        current.lines.push(op.line);
      }
    }
    if (current) out.push(current);
    return out;
  };
  const oursRegions = regions(splitLines(ours));
  const theirsRegions = regions(splitLines(theirs));
  const result: string[] = [];
  let cursor = 0;
  let oi = 0;
  let ti = 0;
  const sameRegion = (
    x: { start: number; end: number; lines: string[] },
    y: { start: number; end: number; lines: string[] },
  ): boolean => x.start === y.start && x.end === y.end && x.lines.join('\n') === y.lines.join('\n');
  while (oi < oursRegions.length || ti < theirsRegions.length) {
    const o = oursRegions[oi];
    const t = theirsRegions[ti];
    if (o && t && sameRegion(o, t)) {
      for (let i = cursor; i < o.start; i += 1) result.push(a[i] as string);
      result.push(...o.lines);
      cursor = o.end;
      oi += 1;
      ti += 1;
      continue;
    }
    if (o && t && o.start < t.end && t.start < o.end) return null; // overlapping, different edits
    const next = o && (!t || o.start < t.start || (o.start === t.start && o.end <= t.end)) ? o : t;
    if (!next) break;
    for (let i = cursor; i < next.start; i += 1) result.push(a[i] as string);
    result.push(...next.lines);
    cursor = next.end;
    if (next === o) oi += 1;
    else ti += 1;
  }
  for (let i = cursor; i < a.length; i += 1) result.push(a[i] as string);
  const trailing = ancestor.endsWith('\n') || ours.endsWith('\n') || theirs.endsWith('\n');
  const joined = result.join('\n');
  return trailing && joined !== '' ? `${joined}\n` : joined;
}

/**
 * Merge two trees against their ancestor, path by path. Returns the merged flat map, or null when
 * any path conflicts (both sides changed it differently, or one deleted what the other modified).
 */
export function mergeTrees(
  store: ObjectStore,
  ancestorTree: string,
  oursTree: string,
  theirsTree: string,
): Map<string, { oid: string; mode: string }> | null {
  const ancestor = flattenTree(store, ancestorTree);
  const ours = flattenTree(store, oursTree);
  const theirs = flattenTree(store, theirsTree);
  const paths = new Set([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  const out = new Map<string, { oid: string; mode: string }>();
  const text = (entry: { oid: string } | undefined): string | null => {
    if (!entry) return null;
    const object = store.get(entry.oid);
    return object ? object.data.toString('utf8') : null;
  };
  for (const path of paths) {
    const a = ancestor.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const aOid = a?.oid ?? null;
    const oOid = o?.oid ?? null;
    const tOid = t?.oid ?? null;
    if (oOid === tOid) {
      if (o) out.set(path, o);
      continue;
    }
    if (aOid === oOid) {
      if (t) out.set(path, t);
      continue;
    }
    if (aOid === tOid) {
      if (o) out.set(path, o);
      continue;
    }
    // Both sides changed the path differently.
    if (o && t) {
      const merged = mergeLines(text(a) ?? '', text(o) ?? '', text(t) ?? '');
      if (merged === null) return null;
      const oid = store.put('blob', Buffer.from(merged, 'utf8'));
      out.set(path, { oid, mode: o.mode });
      continue;
    }
    return null; // deleted on one side, modified on the other
  }
  return out;
}

// --------------------------------------------------------------------------- packs

/** Write a plain (delta-free) pack of the given objects. */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (!object) throw new Error(`pack write: unknown object ${oid}`);
    const size = object.data.length;
    const bytes: number[] = [];
    let first = (TYPE_CODES[object.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    while (rest > 0) {
      bytes.push(first | 0x80);
      first = rest & 0x7f;
      rest >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      written += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (written !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Read a pack into the store (resolving OFS/REF deltas, including bases the store already holds).
 * Returns the oids ingested. Throws on structural errors; the trailer is verified when present.
 */
export function readPackInto(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart);
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!trailer.equals(computed)) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry & { resolvedType?: GitObjectType; resolved?: Buffer }>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry & { resolvedType?: GitObjectType; resolved?: Buffer } = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let base = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    entry.data = inflated.buffer;
    if (entry.data.length !== size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const ingested: string[] = [];
  const resolve = (entry: RawEntry & { resolvedType?: GitObjectType; resolved?: Buffer }): { type: GitObjectType; data: Buffer } => {
    if (entry.resolved && entry.resolvedType) return { type: entry.resolvedType, data: entry.resolved };
    let result: { type: GitObjectType; data: Buffer };
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let baseType: GitObjectType;
      let baseData: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (!baseEntry) throw new Error('ofs-delta base missing');
        const resolved = resolve(baseEntry);
        baseType = resolved.type;
        baseData = resolved.data;
      } else {
        const baseObject = store.get(entry.baseOid as string);
        if (!baseObject) throw new Error('ref-delta base missing');
        baseType = baseObject.type;
        baseData = baseObject.data;
      }
      result = { type: baseType, data: applyDelta(baseData, entry.data) };
    } else {
      const type = CODE_TYPES[entry.typeCode];
      if (!type) throw new Error(`unknown pack type code ${entry.typeCode}`);
      result = { type, data: entry.data };
    }
    entry.resolved = result.data;
    entry.resolvedType = result.type;
    return result;
  };
  for (const entry of raw) {
    const { type, data } = resolve(entry as RawEntry & { resolvedType?: GitObjectType; resolved?: Buffer });
    ingested.push(store.put(type, data));
  }
  return ingested;
}
