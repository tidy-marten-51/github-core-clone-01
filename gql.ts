// A small GraphQL executor covering exactly the suite's surface: queries, mutations, variables,
// aliases, inline/named fragments, enum and input-object arguments, batched operations, Relay
// node(id:), cursor connections, and the __type introspection gh probes. Unknown fields answer
// HTTP 200 with an errors array naming the field, as GitHub does.

import { Forge, globalId, parseGlobalId } from './store.ts';
import type { IssueRec, PullRec, Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

// --------------------------------------------------------------------------- lexer

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = source.slice(i + 3, end === -1 ? source.length : end);
        tokens.push({ kind: 'string', value: text });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().value === '(') this.arguments(); // parsed and ignored
    }
  }

  private value(): Value {
    const token = this.next();
    if (token.value === '$') {
      const name = this.next();
      return { kind: 'var', name: name.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.value === '[') {
      const items: Value[] = [];
      while (this.peek().value !== ']') items.push(this.value());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields = new Map<string, Value>();
      while (this.peek().value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields.set(key, this.value());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  private arguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expect('(');
    while (this.peek().value !== ')') {
      const key = this.next().value;
      this.expect(':');
      args.set(key, this.value());
    }
    this.expect(')');
    return args;
  }

  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') selections.push(this.selection());
    this.expect('}');
    return selections;
  }

  private selection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      const head = this.peek();
      if (head.kind === 'name' && head.value === 'on') {
        this.next();
        const typeName = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition: typeName, selectionSet: this.selectionSet() };
      }
      const name = this.next().value;
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.next().value;
    let alias: string | null = null;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.peek().value === '(' ? this.arguments() : new Map<string, Value>();
    this.skipDirectives();
    const set = this.peek().value === '{' ? this.selectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet: set };
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const head = this.peek();
      if (head.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.selectionSet() });
        continue;
      }
      if (head.kind === 'name' && (head.value === 'query' || head.value === 'mutation' || head.value === 'subscription')) {
        this.next();
        const type = head.value === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') {
          // variable definitions: skip the balanced list (types are not enforced)
          let depth = 0;
          do {
            const token = this.next();
            if (token.value === '(') depth += 1;
            else if (token.value === ')') depth -= 1;
          } while (depth > 0);
        }
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.selectionSet() });
        continue;
      }
      if (head.kind === 'name' && head.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        this.next(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.selectionSet());
        continue;
      }
      throw new Error(`unexpected token ${head.value} in GraphQL document`);
    }
    return { operations, fragments };
  }
}

// --------------------------------------------------------------------------- schema surface

const FIELD_LISTS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Organization: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'commits', 'author', 'createdAt', 'url', 'mergeCommit',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['name', 'prefix', 'target', 'repository'],
  Commit: ['oid', 'message', 'authoredDate'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Label: ['name', 'color'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'specifiedByURL', 'isOneOf'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// --------------------------------------------------------------------------- execution

type GqlObject = { __type: string; [key: string]: unknown };

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name] ?? null;
    case 'string':
    case 'number':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, ctx);
      return out;
    }
  }
}

function argsOf(node: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of node.args) out[key] = resolveValue(value, ctx);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

interface Connection {
  nodes: GqlObject[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginate(items: GqlObject[], args: Record<string, unknown>): Connection {
  const start = indexFromCursor(args.after);
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const nextIndex = start + slice.length;
  return {
    nodes: slice,
    totalCount: items.length,
    hasNextPage: nextIndex < items.length,
    endCursor: slice.length ? cursorFor(nextIndex) : null,
    startCursor: slice.length ? cursorFor(start) : null,
  };
}

// --------------------------------------------------------------------------- object factories

function userObject(login: string): GqlObject {
  return { __type: 'User', login };
}

function repoObject(repo: Repo): GqlObject {
  return { __type: 'Repository', repo };
}

function issueObject(repo: Repo, issue: IssueRec): GqlObject {
  return { __type: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: PullRec): GqlObject {
  return { __type: 'PullRequest', repo, pull };
}

function typeObject(name: string): GqlObject {
  return { __type: '__Type', name };
}

// --------------------------------------------------------------------------- field resolvers

function repoByGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  const dbId = Number(parsed.parts[0]);
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function itemByGlobalId(
  forge: Forge,
  id: unknown,
  type: 'Issue' | 'PullRequest',
): { repo: Repo; item: IssueRec | PullRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== type) return null;
  const repo = repoByGlobalId(forge, globalId('Repository', Number(parsed.parts[0])));
  if (!repo) return null;
  const item = repo.items.get(Number(parsed.parts[1]));
  if (!item) return null;
  if (type === 'Issue' && item.kind !== 'issue') return null;
  if (type === 'PullRequest' && item.kind !== 'pull') return null;
  return { repo, item };
}

function resolveField(ctx: Ctx, typeName: string, source: GqlObject | null, node: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(node, ctx);
  const name = node.name;

  if (name === '__typename') return typeName;
  if (typeName === 'Query' && name === '__type') {
    const typeName2 = typeof args.name === 'string' ? args.name : '';
    if (FIELD_LISTS[typeName2] || ENUM_VALUES[typeName2]) return typeObject(typeName2);
    return null;
  }
  if (typeName === 'Query' && name === '__schema') return { __type: '__Schema' };

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return userObject(VIEWER.login);
      if (name === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObject(repo) : null;
      }
      if (name === 'node') {
        const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
        if (!parsed) return null;
        if (parsed.type === 'Repository') {
          const repo = repoByGlobalId(forge, args.id);
          return repo ? repoObject(repo) : null;
        }
        if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
          const found = itemByGlobalId(forge, args.id, parsed.type);
          if (!found) return null;
          return found.item.kind === 'issue'
            ? issueObject(found.repo, found.item as IssueRec)
            : pullObject(found.repo, found.item as PullRec);
        }
        return null;
      }
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, input.repositoryId);
        if (!repo) throw new Error('createIssue: repository not found');
        const issue = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue) };
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = itemByGlobalId(forge, input.issueId, 'Issue');
        if (!found) throw new Error('closeIssue: issue not found');
        (found.item as IssueRec).state = 'closed';
        return { __type: 'CloseIssuePayload', issue: issueObject(found.repo, found.item as IssueRec) };
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, input.repositoryId);
        if (!repo) throw new Error('createPullRequest: repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!repo.branchTip(head)) throw new Error(`createPullRequest: head branch "${head}" does not exist`);
        if (!repo.branchTip(base)) throw new Error(`createPullRequest: base branch "${base}" does not exist`);
        const pull = forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = itemByGlobalId(forge, input.pullRequestId, 'PullRequest');
        if (!found) throw new Error('mergePullRequest: pull request not found');
        const pull = found.item as PullRec;
        if (pull.state === 'open') {
          const outcome = forge.squashMerge(found.repo, pull);
          if (!outcome.ok) throw new Error('mergePullRequest: pull request is not mergeable');
        }
        return { __type: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, pull) };
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found =
          itemByGlobalId(forge, input.subjectId, 'Issue') ?? itemByGlobalId(forge, input.subjectId, 'PullRequest');
        if (!found) throw new Error('addComment: subject not found');
        const comment = forge.addComment(found.repo, found.item, String(input.body ?? ''));
        return {
          __type: 'AddCommentPayload',
          commentEdge: {
            __type: 'CommentEdge',
            node: { __type: 'IssueComment', comment },
            cursor: cursorFor(0),
          },
        };
      }
      break;
    }
    case 'User':
    case 'Organization': {
      const login = String(source?.login ?? '');
      if (name === 'login') return login;
      if (name === 'id') return globalId('User', login === VIEWER.login ? VIEWER.id : login);
      if (name === 'name') return login === VIEWER.login ? VIEWER.name : login;
      if (name === 'email') return login === VIEWER.login ? VIEWER.email : null;
      break;
    }
    case 'Repository': {
      const repo = source?.repo as Repo;
      switch (name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'owner':
          return userObject(repo.owner);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          return tip ? { __type: 'Ref', name: repo.defaultBranch, repo, oid: tip } : null;
        }
        case 'issue': {
          const item = repo.items.get(Number(args.number));
          return item && item.kind === 'issue' ? issueObject(repo, item) : null;
        }
        case 'pullRequest': {
          const item = repo.items.get(Number(args.number));
          return item && item.kind === 'pull' ? pullObject(repo, item) : null;
        }
        case 'issues': {
          let list = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
          if (states) list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
          const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
          const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
          list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
          const connection = paginate(list.map((issue) => issueObject(repo, issue)), args);
          return { __type: 'IssueConnection', connection };
        }
        case 'pullRequests': {
          let list = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
          const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : ['OPEN'];
          list = list.filter((pull) => {
            const stateName = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
            return states.includes(stateName);
          });
          list.sort((a, b) => a.number - b.number);
          const connection = paginate(list.map((pull) => pullObject(repo, pull)), args);
          return { __type: 'PullRequestConnection', connection };
        }
        default:
          break;
      }
      break;
    }
    case 'Issue': {
      const issue = source?.issue as IssueRec;
      const repo = source?.repo as Repo;
      switch (name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return userObject(VIEWER.login);
        case 'repository':
          return repoObject(repo);
        case 'labels': {
          const labels = issue.labels.map((labelName) => ({
            __type: 'Label',
            name: labelName,
            color: repo.labels.get(labelName)?.color ?? 'ededed',
          }));
          return { __type: 'LabelConnection', connection: paginate(labels as GqlObject[], args) };
        }
        case 'comments': {
          const comments = issue.comments.map((comment) => ({ __type: 'IssueComment', comment }));
          return { __type: 'IssueCommentConnection', connection: paginate(comments as GqlObject[], args) };
        }
        default:
          break;
      }
      break;
    }
    case 'PullRequest': {
      const pull = source?.pull as PullRec;
      const repo = source?.repo as Repo;
      switch (name) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return forge.pullMergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'author':
          return userObject(VIEWER.login);
        case 'files': {
          const files = forge.pullFiles(repo, pull).map((file) => ({
            __type: 'PullRequestFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          const connection = paginate(files as GqlObject[], args);
          return { __type: 'PullRequestFileConnection', connection };
        }
        default:
          break;
      }
      break;
    }
    case 'IssueComment': {
      const comment = source?.comment as { dbId: number; body: string };
      if (name === 'id') return globalId('IssueComment', comment.dbId);
      if (name === 'body') return comment.body;
      if (name === 'author') return userObject(VIEWER.login);
      break;
    }
    case 'Ref': {
      if (name === 'name') return String(source?.name ?? '');
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'target') return { __type: 'Commit', oid: String(source?.oid ?? '') };
      if (name === 'repository') return repoObject(source?.repo as Repo);
      break;
    }
    case 'Commit': {
      if (name === 'oid') return String(source?.oid ?? '');
      break;
    }
    case '__Type': {
      const typeName = String(source?.name ?? '');
      if (name === 'name') return typeName;
      if (name === 'kind') return ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
      if (name === 'description') return null;
      if (name === 'fields') {
        return (FIELD_LISTS[typeName] ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName }));
      }
      if (name === 'enumValues') {
        return (ENUM_VALUES[typeName] ?? []).map((valueName) => ({ __type: '__EnumValue', name: valueName }));
      }
      if (name === 'possibleTypes' || name === 'interfaces' || name === 'inputFields') return [];
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return String(source?.name ?? '');
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      if (name === 'args') return [];
      if (name === 'type') return typeObject('String');
      break;
    }
    case '__Schema': {
      if (name === 'queryType') return typeObject('Query');
      if (name === 'mutationType') return typeObject('Mutation');
      if (name === 'types') return Object.keys(FIELD_LISTS).map(typeObject);
      if (name === 'directives') return [];
      break;
    }
    default:
      break;
  }

  // Payload and connection plumbing shared by several types.
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (name === 'issue') return source?.issue ?? null;
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return source?.pullRequest ?? null;
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'AddCommentPayload') {
    if (name === 'commentEdge') return source?.commentEdge ?? null;
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'CommentEdge') {
    if (name === 'node') return source?.node ?? null;
    if (name === 'cursor') return String(source?.cursor ?? '');
  }
  if (
    typeName === 'IssueConnection' ||
    typeName === 'PullRequestConnection' ||
    typeName === 'PullRequestFileConnection' ||
    typeName === 'LabelConnection' ||
    typeName === 'IssueCommentConnection'
  ) {
    const connection = source?.connection as Connection;
    if (name === 'nodes') return connection.nodes;
    if (name === 'totalCount') return connection.totalCount;
    if (name === 'pageInfo') {
      return {
        __type: 'PageInfo',
        hasNextPage: connection.hasNextPage,
        hasPreviousPage: false,
        startCursor: connection.startCursor,
        endCursor: connection.endCursor,
      };
    }
    if (name === 'edges') {
      return connection.nodes.map((node, index) => ({
        __type: typeName === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge',
        node,
        cursor: cursorFor(index),
      }));
    }
  }
  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
    if (name === 'node') return source?.node ?? null;
    if (name === 'cursor') return String(source?.cursor ?? '');
  }
  if (typeName === 'PullRequestFile') {
    if (name === 'path') return String(source?.path ?? '');
    if (name === 'additions') return Number(source?.additions ?? 0);
    if (name === 'deletions') return Number(source?.deletions ?? 0);
    if (name === 'changeType') return String(source?.changeType ?? 'MODIFIED');
  }
  if (typeName === 'Label') {
    if (name === 'name') return String(source?.name ?? '');
    if (name === 'color') return String(source?.color ?? '');
  }
  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return Boolean(source?.hasNextPage);
    if (name === 'hasPreviousPage') return Boolean(source?.hasPreviousPage);
    if (name === 'startCursor') return (source?.startCursor as string | null) ?? null;
    if (name === 'endCursor') return (source?.endCursor as string | null) ?? null;
  }

  // A field the schema declares but this forge does not model resolves null without an error;
  // only a field the type does not hold at all is an error (the invalid-field check reads it).
  if ((FIELD_LISTS[typeName] ?? []).includes(name)) return null;
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
  return null;
}

function executeSelectionSet(
  ctx: Ctx,
  typeName: string,
  source: GqlObject | null,
  selections: readonly SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(ctx, typeName, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    let value: unknown;
    try {
      value = resolveField(ctx, typeName, source, selection);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      value = null;
    }
    if (selection.selectionSet && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        value = value.map((entry) =>
          typeof entry === 'object' && entry !== null && '__type' in (entry as GqlObject)
            ? executeSelectionSet(ctx, (entry as GqlObject).__type, entry as GqlObject, selection.selectionSet as SelectionNode[])
            : entry,
        );
      } else if (typeof value === 'object' && '__type' in (value as GqlObject)) {
        value = executeSelectionSet(ctx, (value as GqlObject).__type, value as GqlObject, selection.selectionSet);
      }
    }
    out[key] = value ?? null;
  }
  return out;
}

// --------------------------------------------------------------------------- entry

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL operation document (already JSON-decoded request fields). */
export function executeGraphQL(
  forge: Forge,
  request: { query?: unknown; variables?: unknown; operationName?: unknown },
): GraphQLResult {
  const query = typeof request.query === 'string' ? request.query : '';
  if (query === '') return { errors: [{ message: 'No query provided' }] };
  let document: { operations: Operation[]; fragments: Map<string, SelectionNode[]> };
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const variables =
    typeof request.variables === 'object' && request.variables !== null ? (request.variables as Record<string, unknown>) : {};
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation =
    document.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? document.operations[0];
  if (!operation) return { errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, operation.selectionSet);
  const result: GraphQLResult = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
