// A small, self-contained GraphQL v4 surface: a lexer/parser for the documents gh and
// github-mcp-server send (operations, variables, aliases, inline fragments, input objects, enums,
// lists, batched operations) and an executor over the forge's store, with Relay global ids and the
// introspection answers the clients feature-detect on. No dependencies.

import { Forge, ForgeError, type IssueRec, type PullRec, type RepoRec } from './forge.ts';

// ---------------------------------------------------------------- global ids

export function globalId(kind: 'R' | 'I' | 'P' | 'C' | 'U', parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || !/^[RIPCU]$/.test(kind)) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
          if (esc === 'u') value = value.slice(0, -1) + String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
          j += esc === 'u' ? 6 : 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

export interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, ValueNode>;
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ type: type === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName(); // the type condition
        this.parseDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.parseDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.parseDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', field: { name, alias, args, selection } };
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = valueOf(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

/** A wrapped object value: its GraphQL type plus the record it wraps. */
interface GObj {
  __t: string;
  [key: string]: unknown;
}

const obj = (type: string, fields: Record<string, unknown>): GObj => ({ __t: type, ...fields });

type Resolver = (source: GObj, args: Map<string, unknown>, ctx: Ctx) => unknown;

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'prefix', 'repository'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'repository'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function issueObj(forge: Forge, repo: RepoRec, issue: IssueRec): GObj {
  return obj('Issue', { repo, issue });
}

function pullObj(forge: Forge, repo: RepoRec, pull: PullRec): GObj {
  return obj('PullRequest', { repo, pull });
}

function userObj(forge: Forge, login: string): GObj {
  const user = forge.userByLogin(login) ?? forge.viewer;
  return obj('User', { user });
}

/** Paginate a list of items by (first, after-cursor over each item's seq). */
function paginate<T extends { seq: number }>(items: readonly T[], args: Map<string, unknown>): { page: T[]; hasNext: boolean; endCursor: string | null } {
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' && Number.isFinite(firstRaw) ? Math.max(0, Math.trunc(firstRaw)) : items.length;
  const after = args.get('after');
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const seq = Number(decoded.replace(/^c:/, ''));
      const index = items.findIndex((item) => item.seq === seq);
      if (index !== -1) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  const endCursor = page.length > 0 ? Buffer.from(`c:${page[page.length - 1]!.seq}`, 'utf8').toString('base64url') : null;
  return { page, hasNext, endCursor };
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: (_s, _a, ctx) => userObj(ctx.forge, ctx.forge.viewer.login),
    repository: (_s, args, ctx) => {
      const owner = String(args.get('owner') ?? '');
      const name = String(args.get('name') ?? '');
      const repo = ctx.forge.getRepo(owner, name);
      return repo === null ? null : obj('Repository', { repo });
    },
    node: (_s, args, ctx) => nodeById(ctx, String(args.get('id') ?? '')),
    __type: (_s, args) => {
      const name = String(args.get('name') ?? '');
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return obj('__Type', { typeName: name });
    },
    __schema: () => obj('__Schema', {}),
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = asRecord(args.get('input'));
      const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const labels = Array.isArray(input.labelIds) ? [] : [];
      void labels;
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return obj('CreateIssuePayload', { issue: issueObj(ctx.forge, repo, issue) });
    },
    closeIssue: (_s, args, ctx) => {
      const input = asRecord(args.get('input'));
      const found = issueFromGlobalId(ctx, String(input.issueId ?? ''));
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueObj(ctx.forge, found.repo, found.issue) });
    },
    createPullRequest: (_s, args, ctx) => {
      const input = asRecord(args.get('input'));
      const repo = repoFromGlobalId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) throw new Error('repository not found');
      const pull = ctx.forge.createPull(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      return obj('CreatePullRequestPayload', { pullRequest: pullObj(ctx.forge, repo, pull) });
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = asRecord(args.get('input'));
      const found = pullFromGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (found === null) throw new Error('pull request not found');
      ctx.forge.mergePull(found.repo, found.pull);
      return obj('MergePullRequestPayload', { pullRequest: pullObj(ctx.forge, found.repo, found.pull) });
    },
    addComment: (_s, args, ctx) => {
      const input = asRecord(args.get('input'));
      const found = issueFromGlobalId(ctx, String(input.subjectId ?? ''));
      if (found === null) throw new Error('subject not found');
      const comment = ctx.forge.addComment(found.issue, String(input.body ?? ''));
      const node = obj('IssueComment', { repo: found.repo, issue: found.issue, comment });
      return obj('AddCommentPayload', { commentEdge: obj('IssueCommentEdge', { node, cursor: '' }), subject: issueObj(ctx.forge, found.repo, found.issue) });
    },
  },
  User: {
    id: (s) => globalId('U', [(s.user as { id: number }).id]),
    login: (s) => (s.user as { login: string }).login,
    name: (s) => (s.user as { name: string }).name,
    email: (s) => (s.user as { email: string }).email,
    url: (s) => `https://github.com/${(s.user as { login: string }).login}`,
    createdAt: (_s, _a, ctx) => ctx.forge.iso(ctx.forge.baseEpochSecPublic()),
    updatedAt: (_s, _a, ctx) => ctx.forge.iso(ctx.forge.baseEpochSecPublic()),
  },
  Repository: {
    id: (s) => globalId('R', [(s.repo as RepoRec).id]),
    databaseId: (s) => (s.repo as RepoRec).id,
    name: (s) => (s.repo as RepoRec).name,
    nameWithOwner: (s) => `${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}`,
    owner: (s, _a, ctx) => userObj(ctx.forge, (s.repo as RepoRec).owner),
    description: (s) => (s.repo as RepoRec).description,
    isPrivate: (s) => (s.repo as RepoRec).isPrivate,
    defaultBranchRef: (s, _a, ctx) => {
      const repo = s.repo as RepoRec;
      const tip = ctx.forge.branchTip(repo, repo.defaultBranch);
      return tip === null ? null : obj('Ref', { name: repo.defaultBranch, repo });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (s, args, ctx) => {
      const repo = s.repo as RepoRec;
      const issue = repo.issues.get(Number(args.get('number')));
      return issue === undefined ? null : issueObj(ctx.forge, repo, issue);
    },
    issues: (s, args, ctx) => {
      const repo = s.repo as RepoRec;
      let items = [...repo.issues.values()];
      const states = args.get('states');
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = asRecord(args.get('orderBy'));
      const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const { page, hasNext, endCursor } = paginate(items, args);
      return obj('IssueConnection', {
        nodes: page.map((issue) => issueObj(ctx.forge, repo, issue)),
        edges: page.map((issue) => obj('IssueEdge', { node: issueObj(ctx.forge, repo, issue), cursor: Buffer.from(`c:${issue.seq}`).toString('base64url') })),
        pageInfo: obj('PageInfo', { hasNextPage: hasNext, hasPreviousPage: false, startCursor: endCursor, endCursor }),
        totalCount: items.length,
      });
    },
    pullRequest: (s, args, ctx) => {
      const repo = s.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.get('number')));
      return pull === undefined ? null : pullObj(ctx.forge, repo, pull);
    },
    pullRequests: (s, args, ctx) => {
      const repo = s.repo as RepoRec;
      let items = [...repo.pulls.values()];
      const states = args.get('states');
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        items = items.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      items.sort((a, b) => b.seq - a.seq);
      const { page, hasNext, endCursor } = paginate(items, args);
      return obj('PullRequestConnection', {
        nodes: page.map((pull) => pullObj(ctx.forge, repo, pull)),
        edges: page.map((pull) => obj('PullRequestEdge', { node: pullObj(ctx.forge, repo, pull), cursor: Buffer.from(`c:${pull.seq}`).toString('base64url') })),
        pageInfo: obj('PageInfo', { hasNextPage: hasNext, hasPreviousPage: false, startCursor: endCursor, endCursor }),
        totalCount: items.length,
      });
    },
    createdAt: (s, _a, ctx) => ctx.forge.iso((s.repo as RepoRec).seq),
    updatedAt: (s, _a, ctx) => ctx.forge.iso((s.repo as RepoRec).seq),
    url: (s) => `https://github.com/${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}`,
  },
  Ref: {
    name: (s) => s.name as string,
    prefix: () => 'refs/heads/',
    repository: (s, _a, _ctx) => obj('Repository', { repo: s.repo as RepoRec }),
  },
  Issue: {
    id: (s) => globalId('I', [(s.repo as RepoRec).id, (s.issue as IssueRec).number]),
    number: (s) => (s.issue as IssueRec).number,
    title: (s) => (s.issue as IssueRec).title,
    state: (s) => ((s.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (s) => (s.issue as IssueRec).body,
    url: (s) => `https://github.com/${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}/issues/${(s.issue as IssueRec).number}`,
    createdAt: (s, _a, ctx) => ctx.forge.iso((s.issue as IssueRec).seq),
    updatedAt: (s, _a, ctx) => ctx.forge.iso((s.issue as IssueRec).seq),
    author: (s, _a, ctx) => userObj(ctx.forge, (s.issue as IssueRec).author),
    repository: (s) => obj('Repository', { repo: s.repo as RepoRec }),
  },
  PullRequest: {
    id: (s) => globalId('P', [(s.repo as RepoRec).id, (s.pull as PullRec).number]),
    number: (s) => (s.pull as PullRec).number,
    title: (s) => (s.pull as PullRec).title,
    body: (s) => (s.pull as PullRec).body,
    state: (s) => {
      const pull = s.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (s) => (s.pull as PullRec).merged,
    mergeable: (s, _a, ctx) => {
      const mergeable = ctx.forge.pullMergeable(s.repo as RepoRec, s.pull as PullRec);
      return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (s) => (s.pull as PullRec).headRef,
    baseRefName: (s) => (s.pull as PullRec).baseRef,
    files: (s, args, ctx) => {
      const repo = s.repo as RepoRec;
      const pull = s.pull as PullRec;
      const files = ctx.forge.pullFiles(repo, pull).map((file, index) =>
        obj('PullRequestChangedFile', { path: file.path, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED', seq: pull.seq + index / 1000 }),
      );
      const { page, hasNext, endCursor } = paginate(files as unknown as { seq: number }[], args);
      return obj('PullRequestFileConnection', {
        nodes: page,
        edges: [],
        pageInfo: obj('PageInfo', { hasNextPage: hasNext, hasPreviousPage: false, startCursor: endCursor, endCursor }),
        totalCount: files.length,
      });
    },
    url: (s) => `https://github.com/${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}/pull/${(s.pull as PullRec).number}`,
    createdAt: (s, _a, ctx) => ctx.forge.iso((s.pull as PullRec).seq),
    updatedAt: (s, _a, ctx) => ctx.forge.iso((s.pull as PullRec).mergedSeq ?? (s.pull as PullRec).seq),
    author: (s, _a, ctx) => userObj(ctx.forge, (s.pull as PullRec).author),
    repository: (s) => obj('Repository', { repo: s.repo as RepoRec }),
  },
  IssueComment: {
    id: (s) => globalId('C', [(s.comment as { id: number }).id]),
    body: (s) => (s.comment as { body: string }).body,
    createdAt: (s, _a, ctx) => ctx.forge.iso((s.comment as { seq: number }).seq),
    updatedAt: (s, _a, ctx) => ctx.forge.iso((s.comment as { seq: number }).seq),
    author: (s, _a, ctx) => userObj(ctx.forge, (s.comment as { author: string }).author),
  },
  IssueConnection: connectionResolvers(),
  PullRequestConnection: connectionResolvers(),
  PullRequestFileConnection: connectionResolvers(),
  IssueEdge: edgeResolvers(),
  PullRequestEdge: edgeResolvers(),
  PullRequestFileEdge: edgeResolvers(),
  IssueCommentEdge: edgeResolvers(),
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage as boolean,
    hasPreviousPage: (s) => s.hasPreviousPage as boolean,
    startCursor: (s) => (s.startCursor as string | null) ?? null,
    endCursor: (s) => (s.endCursor as string | null) ?? null,
  },
  PullRequestChangedFile: {
    path: (s) => s.path as string,
    additions: (s) => s.additions as number,
    deletions: (s) => s.deletions as number,
    changeType: (s) => s.changeType as string,
  },
  CreateIssuePayload: { issue: (s) => s.issue as GObj, clientMutationId: () => null },
  CloseIssuePayload: { issue: (s) => s.issue as GObj, clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (s) => s.pullRequest as GObj, clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (s) => s.pullRequest as GObj, clientMutationId: () => null },
  AddCommentPayload: {
    commentEdge: (s) => s.commentEdge as GObj,
    subject: (s) => (s.subject as GObj | undefined) ?? null,
    clientMutationId: () => null,
  },
  __Type: {
    name: (s) => s.typeName as string,
    kind: (s) => (ENUM_VALUES[s.typeName as string] !== undefined ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (s) => {
      const fields = TYPE_FIELDS[s.typeName as string];
      if (fields === undefined) return null;
      return fields.map((name) => obj('__Field', { fieldName: name }));
    },
    enumValues: (s) => {
      const values = ENUM_VALUES[s.typeName as string];
      if (values === undefined) return null;
      return values.map((name) => obj('__EnumValue', { enumName: name }));
    },
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => null,
    ofType: () => null,
  },
  __Field: {
    name: (s) => s.fieldName as string,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (s) => s.enumName as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => [],
    queryType: () => obj('__Type', { typeName: 'Query' }),
    mutationType: () => obj('__Type', { typeName: 'Mutation' }),
    directives: () => [],
  },
};

function connectionResolvers(): Readonly<Record<string, Resolver>> {
  return {
    nodes: (s) => s.nodes as unknown[],
    edges: (s) => s.edges as unknown[],
    pageInfo: (s) => s.pageInfo as GObj,
    totalCount: (s) => s.totalCount as number,
  };
}

function edgeResolvers(): Readonly<Record<string, Resolver>> {
  return {
    node: (s) => (s.node as GObj | undefined) ?? null,
    cursor: (s) => (s.cursor as string | undefined) ?? '',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function repoFromGlobalId(ctx: Ctx, id: string): RepoRec | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  return ctx.forge.repoById(Number(decoded.parts[0]));
}

function issueFromGlobalId(ctx: Ctx, id: string): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I') return null;
  const repo = ctx.forge.repoById(Number(decoded.parts[0]));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(ctx: Ctx, id: string): { repo: RepoRec; pull: PullRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'P') return null;
  const repo = ctx.forge.repoById(Number(decoded.parts[0]));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

function nodeById(ctx: Ctx, id: string): GObj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'R') {
    const repo = ctx.forge.repoById(Number(decoded.parts[0]));
    return repo === null ? null : obj('Repository', { repo });
  }
  if (decoded.kind === 'I') {
    const found = issueFromGlobalId(ctx, id);
    return found === null ? null : issueObj(ctx.forge, found.repo, found.issue);
  }
  if (decoded.kind === 'P') {
    const found = pullFromGlobalId(ctx, id);
    return found === null ? null : pullObj(ctx.forge, found.repo, found.pull);
  }
  if (decoded.kind === 'U') {
    const user = ctx.forge.users.find((candidate) => candidate.id === Number(decoded.parts[0]));
    return user === undefined ? null : obj('User', { user });
  }
  return null;
}

// ---------------------------------------------------------------- executor

function executeSelectionSet(ctx: Ctx, typeName: string, source: GObj, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, source, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(ctx, typeName, source, fragment));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args = new Map<string, unknown>();
    for (const [argName, argNode] of field.args) args.set(argName, valueOf(argNode, ctx.variables));
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      if (err instanceof ForgeError) ctx.errors.push({ message: err.message });
      else ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field.selection);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, selection: SelectionNode[] | null): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selection));
  if (typeof value === 'object' && '__t' in (value as Record<string, unknown>)) {
    const wrapped = value as GObj;
    if (selection === null) return null;
    return executeSelectionSet(ctx, wrapped.__t, wrapped, selection);
  }
  return value;
}

export interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

/** Execute one GraphQL operation document (one entry of a possibly batched request). */
export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResponse {
  let document: DocumentNode;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = document.operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, obj(rootType, {}), operation.selection);
  const response: GraphQLResponse = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}
