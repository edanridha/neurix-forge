// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp. The forge speaks the current
// revision (2026-07-28, via server/discover) and the handshake revisions before it (initialize), and
// its tools act on the same store as the REST surface, so objects made over MCP read back over
// /api/v3 unchanged. Stateless: no session is required or handed out.

import { ForgeError, type Forge, type IssueRec, type PullRec, type RepoRec } from './forge.ts';

const SERVER_INFO = { name: 'neurix-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list, built once so two tools/list answers are byte-for-byte identical. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
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
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function repoPayload(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issuePayload(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.author },
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullPayload(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation },
    base: { ref: pull.baseRef, sha: forge.branchTip(repo, pull.baseRef) ?? '' },
    user: { login: pull.author },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

interface ToolOutcome {
  payload: unknown;
  isError: boolean;
}

function requireRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === null) throw new ForgeError(404, 'Not Found');
  return repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo(
          forge.viewer.login,
          String(args.name ?? ''),
          typeof args.description === 'string' ? args.description : '',
          args.private === true,
        );
        return { payload: repoPayload(repo), isError: false };
      }
      case 'get_repo':
        return { payload: repoPayload(requireRepo(forge, args)), isError: false };
      case 'create_issue': {
        const repo = requireRepo(forge, args);
        const issue = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
        return { payload: issuePayload(repo, issue), isError: false };
      }
      case 'list_issues': {
        const repo = requireRepo(forge, args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => b.seq - a.seq)
          .map((issue) => issuePayload(repo, issue));
        return { payload: issues, isError: false };
      }
      case 'get_issue': {
        const repo = requireRepo(forge, args);
        const issue = repo.issues.get(Number(args.issue_number));
        if (issue === undefined) throw new ForgeError(404, 'Not Found');
        return { payload: issuePayload(repo, issue), isError: false };
      }
      case 'create_pull_request': {
        const repo = requireRepo(forge, args);
        const pull = forge.createPull(
          repo,
          String(args.title ?? ''),
          typeof args.body === 'string' ? args.body : '',
          String(args.head ?? ''),
          String(args.base ?? ''),
        );
        return { payload: pullPayload(forge, repo, pull), isError: false };
      }
      case 'list_pull_requests': {
        const repo = requireRepo(forge, args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const pulls = [...repo.pulls.values()]
          .filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open' && !pull.merged))
          .sort((a, b) => b.seq - a.seq)
          .map((pull) => pullPayload(forge, repo, pull));
        return { payload: pulls, isError: false };
      }
      case 'merge_pull_request': {
        const repo = requireRepo(forge, args);
        const pull = repo.pulls.get(Number(args.pull_number));
        if (pull === undefined) throw new ForgeError(404, 'Not Found');
        forge.mergePull(repo, pull);
        return { payload: pullPayload(forge, repo, pull), isError: false };
      }
      default:
        return { payload: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    if (err instanceof ForgeError) return { payload: err.message, isError: true };
    return { payload: err instanceof Error ? err.message : String(err), isError: true };
  }
}

export interface McpAnswer {
  status: number;
  body: string;
  contentType: string;
}

const JSON_TYPE = 'application/json';

function rpcResult(id: unknown, result: unknown): McpAnswer {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), contentType: JSON_TYPE };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpAnswer {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), contentType: JSON_TYPE };
}

/** Handle one POST /mcp body (already authenticated by the caller). Never throws. */
export function handleMcp(forge: Forge, bodyText: string): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleOne(forge, entry));
    const bodies = answers.filter((answer) => answer !== null).map((answer) => answer!.body);
    return { status: 200, body: `[${bodies.join(',')}]`, contentType: JSON_TYPE };
  }
  const answer = handleOne(forge, parsed);
  if (answer === null) return { status: 202, body: '', contentType: JSON_TYPE };
  return answer;
}

function handleOne(forge: Forge, entry: unknown): McpAnswer | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return rpcError(null, -32600, 'Invalid Request');
  const request = entry as { id?: unknown; method?: unknown; params?: unknown };
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(request.id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(request.id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return isNotification ? null : rpcResult(request.id, {});
    case 'tools/list':
      return rpcResult(request.id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS_BY_NAME.get(name);
      if (tool === undefined) return rpcError(request.id, -32602, `Unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(request.id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
      const outcome = callTool(forge, name, args);
      const text = typeof outcome.payload === 'string' ? outcome.payload : JSON.stringify(outcome.payload);
      const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError: outcome.isError };
      if (typeof outcome.payload === 'object' && outcome.payload !== null) result.structuredContent = outcome.payload;
      return rpcResult(request.id, result);
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(request.id, -32601, `Method not found: ${method}`);
  }
}
