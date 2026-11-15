// The forge's data model: repositories (refs over the shared object store), issues and pull requests
// sharing one number sequence per repository, labels and comments. All state is in-memory; every
// derived value (ids, timestamps) comes from counters, never a clock, so live and replay agree.

import {
  ObjectStore,
  buildCommit,
  collectReachable,
  flattenTree,
  isAncestor,
  lineChangeCounts,
  mergeBase,
  mergeTrees,
  parseCommit,
  treeLookup,
  treeSetPath,
  unflattenTree,
  ZERO_OID,
} from './gitcore.ts';
import { VIEWER } from './scenario.ts';

export const FORGE_AUTHOR = 'Forge Bot <forge@example.invalid>';
/** Logical epoch the forge's own commits count up from (deterministic timestamps). */
const FORGE_EPOCH = 1_700_000_000;

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  dbId: number;
  body: string;
}

export interface IssueRec {
  kind: 'issue';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  kind: 'pull';
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
}

export type NumberedRec = IssueRec | PullRec;

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch = 'main';
  readonly refs = new Map<string, string>();
  /** Bumped on every ref change; advertisement and ls-refs caches key on it. */
  refsVersion = 0;
  readonly labels = new Map<string, LabelRec>();
  readonly items = new Map<number, NumberedRec>();
  nextNumber = 1;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.refsVersion += 1;
  }

  deleteRef(ref: string): void {
    if (this.refs.delete(ref)) this.refsVersion += 1;
  }
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-open' | 'missing' };

export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextDbId = 1;
  private clockSeq = 0;

  /** A deterministic timestamp for the forge's own commits and merge records. */
  nextTimestamp(): number {
    this.clockSeq += 1;
    return FORGE_EPOCH + this.clockSeq;
  }

  /** ISO text for a forge timestamp (merged_at and friends). */
  isoOf(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
  }

  allocDbId(): number {
    const id = this.nextDbId;
    this.nextDbId += 1;
    return id;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId, owner, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
  }

  // --------------------------------------------------------------------- git-backed content

  /** The tree oid at a ref-ish (branch name, full ref, or commit oid); null when unborn/unknown. */
  treeAt(repo: Repo, refish: string | null): { commit: string; tree: string } | null {
    let commit: string | null = null;
    if (refish === null) commit = repo.branchTip(repo.defaultBranch);
    else if (refish.startsWith('refs/')) commit = repo.refs.get(refish) ?? null;
    else if (/^[0-9a-f]{40}$/.test(refish) && this.store.has(refish)) commit = refish;
    else commit = repo.branchTip(refish);
    if (!commit) return null;
    const object = this.store.get(commit);
    if (!object || object.type !== 'commit') return null;
    return { commit, tree: parseCommit(object.data).tree };
  }

  /** Create a commit on a branch from a new tree; returns the commit oid. */
  commitOnBranch(repo: Repo, branch: string, tree: string, message: string): string {
    const parent = repo.branchTip(branch);
    const timestamp = this.nextTimestamp();
    const data = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp,
    });
    const oid = this.store.put('commit', data);
    repo.setRef(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** PUT /contents semantics: write one file on a branch (created from the default tip if new). */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string,
    expectedSha: string | null,
  ): { status: 'created' | 'updated' | 'conflict' | 'missing'; blobSha: string; commitSha: string } {
    let tip = repo.branchTip(branch);
    if (tip === null && branch !== repo.defaultBranch) {
      const fallback = repo.branchTip(repo.defaultBranch);
      if (fallback !== null) repo.setRef(`refs/heads/${branch}`, fallback);
      tip = fallback;
    }
    const baseTree = tip ? parseCommit((this.store.get(tip) as { data: Buffer }).data).tree : null;
    const existing = baseTree ? treeLookup(this.store, baseTree, path) : null;
    if (expectedSha !== null) {
      if (!existing || existing.kind !== 'file') return { status: 'missing', blobSha: '', commitSha: '' };
      if (existing.oid !== expectedSha) return { status: 'conflict', blobSha: '', commitSha: '' };
    }
    const blobSha = this.store.put('blob', content);
    const newTree = treeSetPath(this.store, baseTree ?? this.store.put('tree', Buffer.alloc(0)), path, {
      oid: blobSha,
      mode: '100644',
    });
    const commitSha = this.commitOnBranch(repo, branch, newTree, message);
    return { status: existing ? 'updated' : 'created', blobSha, commitSha };
  }

  /** DELETE /contents semantics. */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string,
    expectedSha: string | null,
  ): { status: 'deleted' | 'conflict' | 'missing'; commitSha: string } {
    const tip = repo.branchTip(branch);
    if (tip === null) return { status: 'missing', commitSha: '' };
    const baseTree = parseCommit((this.store.get(tip) as { data: Buffer }).data).tree;
    const existing = treeLookup(this.store, baseTree, path);
    if (!existing || existing.kind !== 'file') return { status: 'missing', commitSha: '' };
    if (expectedSha !== null && existing.oid !== expectedSha) return { status: 'conflict', commitSha: '' };
    const newTree = treeSetPath(this.store, baseTree, path, null);
    const commitSha = this.commitOnBranch(repo, branch, newTree, message);
    return { status: 'deleted', commitSha };
  }

  // --------------------------------------------------------------------- issues & pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      kind: 'issue',
      dbId: this.allocDbId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
    };
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const pull: PullRec = {
      kind: 'pull',
      dbId: this.allocDbId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  addComment(repo: Repo, item: NumberedRec, body: string): CommentRec {
    const comment: CommentRec = { dbId: this.allocDbId(), body };
    item.comments.push(comment);
    return comment;
  }

  /** The changed files of a pull request: merge-base tree -> head tree, with line counts. */
  pullFiles(repo: Repo, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (!headTip || !baseTip) return [];
    const base = mergeBase(this.store, baseTip, headTip) ?? baseTip;
    const fromTree = parseCommit((this.store.get(base) as { data: Buffer }).data).tree;
    const toTree = parseCommit((this.store.get(headTip) as { data: Buffer }).data).tree;
    const from = flattenTree(this.store, fromTree);
    const to = flattenTree(this.store, toTree);
    const paths = new Set([...from.keys(), ...to.keys()]);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const text = (oid: string | undefined): string => {
      if (!oid) return '';
      const object = this.store.get(oid);
      return object ? object.data.toString('utf8') : '';
    };
    for (const path of [...paths].sort()) {
      const before = from.get(path);
      const after = to.get(path);
      if (before?.oid === after?.oid) continue;
      const counts = lineChangeCounts(text(before?.oid), text(after?.oid));
      files.push({
        filename: path,
        status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return files;
  }

  /** Whether a squash merge of the pull would apply cleanly right now (GraphQL mergeable). */
  pullMergeable(repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const outcome = this.trySquashTree(repo, pull);
    return outcome === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** The tree a squash of the pull onto its base would produce, or null on conflict. */
  private trySquashTree(repo: Repo, pull: PullRec): string | null {
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (!headTip || !baseTip) return null;
    const headTree = parseCommit((this.store.get(headTip) as { data: Buffer }).data).tree;
    if (isAncestor(this.store, baseTip, headTip)) return headTree;
    const base = mergeBase(this.store, baseTip, headTip);
    if (base === null) return null;
    if (base === baseTip) return headTree;
    const ancestorTree = parseCommit((this.store.get(base) as { data: Buffer }).data).tree;
    const baseTree = parseCommit((this.store.get(baseTip) as { data: Buffer }).data).tree;
    const merged = mergeTrees(this.store, ancestorTree, baseTree, headTree);
    if (merged === null) return null;
    return unflattenTree(this.store, merged);
  }

  /** Squash-merge a pull request onto its base branch. */
  squashMerge(repo: Repo, pull: PullRec): MergeOutcome {
    if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'not-open' };
    const headTip = repo.branchTip(pull.headRef);
    const baseTip = repo.branchTip(pull.baseRef);
    if (!headTip || !baseTip) return { ok: false, reason: 'missing' };
    const tree = this.trySquashTree(repo, pull);
    if (tree === null) return { ok: false, reason: 'conflict' };
    const timestamp = this.nextTimestamp();
    const message = pull.body ? `${pull.title}\n\n${pull.body}\n` : `${pull.title}\n`;
    const data = buildCommit({
      tree,
      parents: [baseTip],
      message,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp,
    });
    const sha = this.store.put('commit', data);
    repo.setRef(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.isoOf(timestamp);
    pull.mergeCommitSha = sha;
    return { ok: true, sha };
  }
}

// --------------------------------------------------------------------------- global ids

/** Opaque, stable GraphQL global ids: base64url of a typed key, never the plain database id. */
export function globalId(type: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([type, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { type: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export { ZERO_OID };
