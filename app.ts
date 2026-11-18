// The forge's HTTP surface: /healthz, the REST v3 API under /api/v3, GraphQL at /api/graphql, MCP
// at /mcp, and git smart HTTP at /<owner>/<repo>.git/... — all over one in-memory Forge. Every API
// answer is JSON with an X-GitHub-Request-Id header; unknown routes answer GitHub's 404 body.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  ForgeError,
  type CommentRec,
  type ForgeUser,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './forge.ts';
import {
  PktReader,
  ZERO_OID,
  flattenTree,
  isAncestor,
  isOid,
  objectClosure,
  parseCommit,
  parsePack,
  parseTree,
  peelTag,
  pktDelim,
  pktLine,
  reachableCommits,
  sidebandPackets,
  writePack,
} from './gitobj.ts';
import { executeGraphQL, globalId } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- plumbing

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `NEURIX-${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer-token rule: the trial's token is in our environment; without one configured, any bearer token answers. */
function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || presented === expected;
}

// ---------------------------------------------------------------- serializers

function userJson(user: ForgeUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('U', [user.id]),
    type: 'User',
    name: user.name,
    email: user.email,
    avatar_url: '',
    html_url: `https://github.com/${user.login}`,
    url: `https://api.github.com/users/${user.login}`,
  };
}

function ownerJson(login: string, forge: Forge): Record<string, unknown> {
  const user = forge.userByLogin(login) ?? forge.viewer;
  return { login: user.login, id: user.id, node_id: globalId('U', [user.id]), type: 'User', html_url: `https://github.com/${user.login}`, url: `https://api.github.com/users/${user.login}` };
}

function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('R', [repo.id]),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerJson(repo.owner, forge),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    created_at: forge.iso(repo.seq),
    updated_at: forge.iso(repo.seq),
    pushed_at: forge.iso(repo.seq),
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues + openPulls,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
  };
}

function labelJson(label: LabelRec, index: number): Record<string, unknown> {
  return { id: index + 1, node_id: '', name: label.name, color: label.color, description: label.description, default: true, url: '' };
}

function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const labels = issue.labels
    .map((name) => repo.labels.get(name))
    .filter((label): label is LabelRec => label !== undefined)
    .map((label, index) => labelJson(label, index));
  return {
    id: issue.id,
    node_id: globalId('I', [repo.id, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: ownerJson(issue.author, forge),
    comments: issue.comments.length,
    created_at: forge.iso(issue.seq),
    updated_at: forge.iso(issue.seq),
    closed_at: null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
}

function commentJson(forge: Forge, repo: RepoRec, issue: IssueRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('C', [comment.id]),
    body: comment.body,
    user: ownerJson(comment.author, forge),
    created_at: forge.iso(comment.seq),
    updated_at: forge.iso(comment.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? ZERO_OID;
  const repoRef = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: ownerJson(repo.owner, forge),
    repo: repoJson(forge, repo),
  });
  return {
    id: pull.id,
    node_id: globalId('P', [repo.id, pull.number]),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: ownerJson(pull.author, forge),
    created_at: forge.iso(pull.seq),
    updated_at: forge.iso(pull.mergedSeq ?? pull.seq),
    closed_at: pull.state === 'closed' ? forge.iso(pull.mergedSeq ?? pull.seq) : null,
    merged_at: pull.merged ? forge.iso(pull.mergedSeq ?? pull.seq) : null,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: repoRef(pull.headRef, headSha),
    base: repoRef(pull.baseRef, baseSha),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function parseIdentityLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> | null {
  const object = forge.store.get(oid);
  if (!object || object.type !== 'commit') return null;
  const info = parseCommit(object.data);
  const author = parseIdentityLine(info.authorLine);
  const committer = parseIdentityLine(info.committerLine);
  const userFor = (email: string): Record<string, unknown> | null => {
    const user = forge.users.find((candidate) => candidate.email === email);
    return user === undefined ? null : ownerJson(user.login, forge);
  };
  return {
    sha: oid,
    node_id: '',
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: info.message.replace(/\n$/, ''),
      tree: { sha: info.tree, url: '' },
      comment_count: 0,
    },
    url: '',
    html_url: '',
    parents: info.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
    author: userFor(author.email),
    committer: userFor(committer.email),
  };
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): Page<T> {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const host = req.headers.host ?? 'localhost';
  const buildUrl = (targetPage: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `http://${host}${url.pathname}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${buildUrl(page + 1)}>; rel="next"`);
    links.push(`<${buildUrl(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${buildUrl(page - 1)}>; rel="prev"`);
    links.push(`<${buildUrl(1)}>; rel="first"`);
  }
  return { items: slice, link: links.length > 0 ? links.join(', ') : null };
}

function sendPage<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly T[], status = 200): void {
  const page = paginate(req, url, items);
  sendJson(res, status, page.items, page.link !== null ? { link: page.link } : {});
}

// ---------------------------------------------------------------- REST

type Json = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function labelNamesOf(body: Json): string[] {
  const labels = body.labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as Json).name === 'string') names.push((entry as Json).name as string);
  }
  return names;
}

async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  const bodyText = method === 'GET' || method === 'HEAD' ? '' : (await readBody(req)).toString('utf8');
  let body: Json = {};
  if (bodyText.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Json;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  }
  try {
    routeRest(forge, req, res, url, segments, method, body);
  } catch (err) {
    if (err instanceof ForgeError) sendJson(res, err.status, { message: err.message });
    else sendJson(res, 500, { message: 'Internal Server Error' });
  }
}

function routeRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, seg: string[], method: string, body: Json): void {
  const rest = seg.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
          issue_search_url: '/api/v3/search/issues',
          repository_search_url: '/api/v3/search/repositories',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '1.0.0-neurix', hooks: [], pages: [] });
    return;
  }

  if (rest[0] === 'rate_limit' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      resources: { core: { limit: 5000, remaining: 5000, reset: forge.baseEpochSecPublic() + 3600, used: 0 }, search: { limit: 30, remaining: 30, reset: forge.baseEpochSecPublic() + 60, used: 0 } },
      rate: { limit: 5000, remaining: 5000, reset: forge.baseEpochSecPublic() + 3600, used: 0 },
    });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, userJson(forge.viewer));
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      sendPage(req, res, url, forge.listViewerRepos().map((repo) => repoJson(forge, repo)));
      return;
    }
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === '') throw new ForgeError(422, 'Repository creation failed: name is required');
      const repo = forge.createRepo(forge.viewer.login, name, asString(body.description), body.private === true, asString(body.default_branch) || 'main');
      sendJson(res, 201, repoJson(forge, repo));
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (rest[0] !== 'repos' || rest.length < 3) throw new ForgeError(404, 'Not Found');
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = forge.requireRepo(owner, repoName);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = body.name;
        forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
      }
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      sendJson(res, 204, undefined);
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  routeRepoTail(forge, req, res, url, repo, tail, method, body);
}

function routeRepoTail(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, tail: string[], method: string, body: Json): void {
  const [head, ...restTail] = tail;

  if (head === 'branches') {
    if (restTail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)!, url: '' }, protected: false }));
      sendPage(req, res, url, branches);
      return;
    }
    if (method === 'GET') {
      const branch = restTail.join('/');
      const tip = forge.branchTip(repo, branch);
      if (tip === null) throw new ForgeError(404, 'Branch not found');
      sendJson(res, 200, { name: branch, commit: commitJson(forge, tip) ?? { sha: tip }, protected: false, _links: {} });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (head === 'commits') {
    if (restTail.length === 0 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      const start = shaParam !== null && shaParam !== '' ? forge.resolveRefish(repo, shaParam) : forge.branchTip(repo, repo.defaultBranch);
      if (start === null) {
        sendPage(req, res, url, []);
        return;
      }
      const commits = [...reachableCommits(forge.store, [start])]
        .map((oid) => ({ oid, time: parseCommit(forge.store.get(oid)!.data).time }))
        .sort((a, b) => b.time - a.time || (a.oid < b.oid ? -1 : 1))
        .map((entry) => commitJson(forge, entry.oid))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      sendPage(req, res, url, commits);
      return;
    }
    if (restTail.length === 1 && method === 'GET') {
      const commit = commitJson(forge, restTail[0]!);
      if (commit === null) throw new ForgeError(404, 'Not Found');
      sendJson(res, 200, commit);
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (head === 'git' && restTail[0] === 'refs') {
    const refPath = restTail.slice(1).join('/');
    if (restTail.length === 1) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, oid]) => ({ ref, node_id: '', url: '', object: { type: forge.store.get(oid)?.type ?? 'commit', sha: oid } }));
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'POST') {
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !forge.store.has(sha)) throw new ForgeError(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: '', url: '', object: { type: forge.store.get(sha)?.type ?? 'commit', sha } });
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    const fullRef = `refs/${refPath}`;
    if (method === 'GET') {
      const oid = repo.refs.get(fullRef);
      if (oid === undefined) throw new ForgeError(404, 'Not Found');
      sendJson(res, 200, { ref: fullRef, node_id: '', url: '', object: { type: forge.store.get(oid)?.type ?? 'commit', sha: oid } });
      return;
    }
    if (method === 'DELETE') {
      if (!repo.refs.delete(fullRef)) throw new ForgeError(404, 'Not Found');
      sendJson(res, 204, undefined);
      return;
    }
    if (method === 'PATCH') {
      const sha = asString(body.sha);
      if (!repo.refs.has(fullRef)) throw new ForgeError(404, 'Not Found');
      if (!isOid(sha) || !forge.store.has(sha)) throw new ForgeError(422, 'Invalid sha');
      repo.refs.set(fullRef, sha);
      sendJson(res, 200, { ref: fullRef, node_id: '', url: '', object: { type: forge.store.get(sha)?.type ?? 'commit', sha } });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (head === 'contents') {
    const path = restTail.join('/');
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref');
      const commitOid = refParam !== null && refParam !== '' ? forge.resolveRefish(repo, refParam) : forge.branchTip(repo, repo.defaultBranch);
      if (commitOid === null) throw new ForgeError(404, 'Not Found');
      if (path === '') {
        sendJson(res, 200, dirListing(forge, repo, commitOid, ''));
        return;
      }
      const entry = forge.treeEntryAt(commitOid, path);
      if (entry === null) throw new ForgeError(404, 'Not Found');
      if (entry.type === 'tree') {
        sendJson(res, 200, dirListing(forge, repo, commitOid, path));
        return;
      }
      const blob = forge.store.get(entry.oid)!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        content: blob.data.toString('base64'),
        url: '',
        html_url: '',
        git_url: '',
        download_url: null,
        _links: { self: '', git: '', html: '' },
      });
      return;
    }
    if (method === 'PUT') {
      const branch = asString(body.branch) || repo.defaultBranch;
      const content = Buffer.from(asString(body.content).replace(/\s+/g, ''), 'base64');
      const message = asString(body.message) || `Update ${path}`;
      const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : null;
      const result = forge.putContent(repo, path, content, message, branch, sha);
      const commit = commitJson(forge, result.commitOid);
      sendJson(res, result.existed ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: result.blobOid, size: content.length, type: 'file', encoding: 'base64', url: '', html_url: '', git_url: '', download_url: null, _links: { self: '', git: '', html: '' } },
        commit,
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = asString(body.branch) || repo.defaultBranch;
      const message = asString(body.message) || `Delete ${path}`;
      const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : null;
      const result = forge.deleteContent(repo, path, message, branch, sha);
      sendJson(res, 200, { content: null, commit: commitJson(forge, result.commitOid) });
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (head === 'labels') {
    if (restTail.length === 0) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((label, index) => labelJson(label, index));
        sendJson(res, 200, labels);
        return;
      }
      if (method === 'POST') {
        const name = asString(body.name);
        if (name === '') throw new ForgeError(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) throw new ForgeError(422, 'Validation Failed: label already exists');
        const label: LabelRec = {
          name,
          color: asString(body.color).replace(/^#/, '') || 'ededed',
          description: typeof body.description === 'string' ? body.description : null,
        };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label, repo.labels.size - 1));
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    if (restTail.length === 1 && method === 'GET') {
      const label = repo.labels.get(restTail[0]!);
      if (label === undefined) throw new ForgeError(404, 'Not Found');
      sendJson(res, 200, labelJson(label, 0));
      return;
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (head === 'issues') {
    if (restTail.length === 0) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let items = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
        items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const labelFilter = url.searchParams.get('labels');
        if (labelFilter !== null && labelFilter !== '') {
          const wanted = labelFilter.split(',');
          items = items.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
        }
        sendPage(req, res, url, items.map((issue) => issueJson(forge, repo, issue)));
        return;
      }
      if (method === 'POST') {
        const title = asString(body.title);
        if (title === '') throw new ForgeError(422, 'Validation Failed: title is required');
        const issue = forge.createIssue(repo, title, asString(body.body), labelNamesOf(body));
        sendJson(res, 201, issueJson(forge, repo, issue));
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    const number = Number(restTail[0]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (restTail.length === 1) {
      if (issue === undefined) throw new ForgeError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, issueJson(forge, repo, issue));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const names = labelNamesOf(body);
          for (const name of names) if (!repo.labels.has(name)) throw new ForgeError(422, `Label "${name}" does not exist`);
          issue.labels = names;
        }
        sendJson(res, 200, issueJson(forge, repo, issue));
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    if (restTail.length === 2 && restTail[1] === 'comments') {
      if (issue === undefined) throw new ForgeError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentJson(forge, repo, issue, comment)));
        return;
      }
      if (method === 'POST') {
        const comment = forge.addComment(issue, asString(body.body));
        sendJson(res, 201, commentJson(forge, repo, issue, comment));
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    throw new ForgeError(404, 'Not Found');
  }

  if (head === 'pulls') {
    if (restTail.length === 0) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let items = [...repo.pulls.values()];
        if (state === 'open') items = items.filter((pull) => pull.state === 'open');
        else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
        items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        sendPage(req, res, url, items.map((pull) => pullJson(forge, repo, pull)));
        return;
      }
      if (method === 'POST') {
        const title = asString(body.title);
        const headRef = asString(body.head).split(':').pop()!;
        const baseRef = asString(body.base).split(':').pop()!;
        if (title === '' || headRef === '' || baseRef === '') throw new ForgeError(422, 'Validation Failed: title, head and base are required');
        const pull = forge.createPull(repo, title, asString(body.body), headRef, baseRef);
        sendJson(res, 201, pullJson(forge, repo, pull));
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    const number = Number(restTail[0]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (restTail.length === 1) {
      if (pull === undefined) throw new ForgeError(404, 'Not Found');
      if (method === 'GET') {
        sendJson(res, 200, pullJson(forge, repo, pull));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if ((body.state === 'closed' || body.state === 'open') && !pull.merged) pull.state = body.state;
        sendJson(res, 200, pullJson(forge, repo, pull));
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    if (restTail.length === 2 && restTail[1] === 'files' && method === 'GET') {
      if (pull === undefined) throw new ForgeError(404, 'Not Found');
      const changes = forge.pullFiles(repo, pull);
      const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
      const headTree = forge.commitTree(headTip);
      const flat = headTree !== null ? flattenTree(forge.store, headTree) : new Map<string, { oid: string }>();
      sendPage(
        req,
        res,
        url,
        changes.map((change) => ({
          sha: flat.get(change.path)?.oid ?? '',
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        })),
      );
      return;
    }
    if (restTail.length === 2 && restTail[1] === 'merge') {
      if (pull === undefined) throw new ForgeError(404, 'Not Found');
      if (method === 'PUT') {
        const result = forge.mergePull(repo, pull);
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      if (method === 'GET') {
        if (pull.merged) sendJson(res, 204, undefined);
        else sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      throw new ForgeError(404, 'Not Found');
    }
    throw new ForgeError(404, 'Not Found');
  }

  throw new ForgeError(404, 'Not Found');
}

function dirListing(forge: Forge, repo: RepoRec, commitOid: string, path: string): Record<string, unknown>[] {
  const treeOid = path === '' ? forge.commitTree(commitOid) : forge.treeEntryAt(commitOid, path)?.oid;
  if (treeOid === null || treeOid === undefined) throw new ForgeError(404, 'Not Found');
  const tree = forge.store.get(treeOid);
  if (!tree || tree.type !== 'tree') throw new ForgeError(404, 'Not Found');
  void repo;
  return parseTree(tree.data)
    .map((entry) => {
      const isDir = entry.mode === '40000';
      const object = forge.store.get(entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: !isDir && object?.type === 'blob' ? object.data.length : 0,
        url: '',
        html_url: '',
        git_url: '',
        download_url: null,
        _links: { self: '', git: '', html: '' },
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow agent=neurix-forge/1.0.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=neurix-forge/1.0.0';

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function advertisementV0(forge: Forge, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktLine(null)];
  const headTip = forge.branchTip(repo, repo.defaultBranch);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headTip !== null) {
      parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      first = false;
      const object = forge.store.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelTag(forge.store, oid);
        if (peeled !== oid) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=neurix-forge/1.0.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(null),
  ]);
}

function lsRefsAnswer(forge: Forge, repo: RepoRec, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTip = forge.branchTip(repo, repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== null) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = forge.store.get(oid);
      if (object?.type === 'tag') line += ` peeled:${peelTag(forge.store, oid)}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktLine(null)]);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: Set<string>;
  deepen?: number;
  deepenSince?: number;
  deepenNot: string[];
}

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
}

/** Trees-and-blobs closure of a set of commits (not following commit parents). */
function treeClosure(forge: Forge, commits: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const commit of commits) {
    const object = forge.store.get(commit);
    if (!object || object.type !== 'commit') continue;
    out.add(commit);
    const tree = parseCommit(object.data).tree;
    if (!out.has(tree)) {
      out.add(tree);
      stack.push(tree);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const object = forge.store.get(oid);
    if (!object) continue;
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (!out.has(entry.oid)) {
          out.add(entry.oid);
          stack.push(entry.oid);
        }
      }
    } else if (object.type === 'tag') {
      const peeled = peelTag(forge.store, oid);
      if (!out.has(peeled)) {
        out.add(peeled);
        stack.push(peeled);
      }
    }
  }
  return out;
}

function typeRank(type: string | undefined): number {
  return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3;
}

function planFetch(forge: Forge, request: FetchRequest): FetchPlan {
  const store = forge.store;
  const wants = request.wants.filter((oid) => store.has(oid));

  if (request.deepen === undefined && request.deepenSince === undefined) {
    const wantCommits = reachableCommits(store, wants.map((oid) => peelTag(store, oid)));
    const haveCommits = reachableCommits(store, request.haves.filter((oid) => store.has(oid)));
    // Seed the closure with the wants themselves as well as their commits, so an annotated tag a
    // ref points at travels with the clone (the tag object is no commit's ancestor).
    const include = objectClosure(store, new Set([...wants, ...wantCommits]));
    const exclude = objectClosure(store, haveCommits);
    const objects = [...include].filter((oid) => !exclude.has(oid));
    objects.sort((a, b) => typeRank(store.get(a)?.type) - typeRank(store.get(b)?.type));
    const shallow: string[] = [];
    const unshallow: string[] = [];
    for (const oid of request.clientShallow) {
      if (!include.has(oid) || store.get(oid)?.type !== 'commit') continue;
      const info = parseCommit(store.get(oid)!.data);
      if (info.parents.every((parent) => include.has(parent) && !exclude.has(parent))) unshallow.push(oid);
    }
    return { objects, shallow, unshallow };
  }

  // Deepened fetch: BFS layers from the wants.
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const oid of wants) {
    const commit = peelTag(store, oid);
    if (store.get(commit)?.type === 'commit' && !depthOf.has(commit)) {
      depthOf.set(commit, 1);
      queue.push(commit);
    }
  }
  const timeOf = (oid: string): number => parseCommit(store.get(oid)!.data).time;
  let queueHead = 0;
  while (queueHead < queue.length) {
    const current = queue[queueHead++]!;
    const currentDepth = depthOf.get(current)!;
    // A numeric deepen never includes anything deeper than the limit: do not walk past it (a depth-1
    // clone of a long history then costs one commit parse, not the whole ancestry).
    if (request.deepen !== undefined && currentDepth >= request.deepen) continue;
    const info = parseCommit(store.get(current)!.data);
    for (const parent of info.parents) {
      const next = currentDepth + 1;
      if (!depthOf.has(parent) || depthOf.get(parent)! > next) {
        depthOf.set(parent, next);
        queue.push(parent);
      }
    }
  }
  const included = new Set<string>();
  for (const [oid, depth] of depthOf) {
    if (request.deepen !== undefined && depth > request.deepen) continue;
    if (request.deepenSince !== undefined && timeOf(oid) < request.deepenSince) continue;
    included.add(oid);
  }
  if (request.deepenNot.length > 0) {
    const excluded = reachableCommits(store, request.deepenNot.filter((oid) => store.has(oid)));
    for (const oid of excluded) included.delete(oid);
  }
  const objectSet = treeClosure(forge, included);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included) {
    const info = parseCommit(store.get(oid)!.data);
    if (info.parents.length > 0 && info.parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  for (const oid of request.clientShallow) {
    if (!included.has(oid) || store.get(oid)?.type !== 'commit') continue;
    const info = parseCommit(store.get(oid)!.data);
    if (info.parents.every((parent) => included.has(parent))) unshallow.push(oid);
  }
  const objects = [...objectSet];
  objects.sort((a, b) => typeRank(store.get(a)?.type) - typeRank(store.get(b)?.type));
  return { objects, shallow, unshallow };
}

function packSection(forge: Forge, objects: readonly string[]): Buffer {
  const pack = writePack(forge.store, objects);
  return Buffer.concat(sidebandPackets(pack, 1));
}

function fetchAnswerV2(forge: Forge, request: FetchRequest): Buffer {
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (request.haves.length > 0) {
    const acked = request.haves.find((oid) => forge.store.has(oid));
    parts.push(pktLine(acked !== undefined ? `ACK ${acked}\n` : 'NAK\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (request.deepen !== undefined || request.deepenSince !== undefined || request.clientShallow.size > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(packSection(forge, plan.objects));
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

function fetchAnswerV0(forge: Forge, request: FetchRequest): Buffer {
  const plan = planFetch(forge, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(packSection(forge, plan.objects));
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], clientShallow: new Set(), deepenNot: [] };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
  }
  return request;
}

async function handleUploadPack(forge: Forge, repo: RepoRec, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  try {
    if (v2) {
      const reader = new PktReader(body);
      const commandLines: string[] = [];
      let packet = reader.next();
      while (packet !== null && packet !== 'flush' && packet !== 'delim') {
        commandLines.push(packet.toString('utf8'));
        packet = reader.next();
      }
      const command = (commandLines[0] ?? '').replace(/\n$/, '');
      const args: string[] = [];
      if (packet === 'delim') {
        packet = reader.next();
        while (packet !== null && packet !== 'flush') {
          if (packet !== 'delim' && packet !== 'response-end') args.push(packet.toString('utf8'));
          packet = reader.next();
        }
      }
      if (command === 'command=ls-refs') {
        sendRaw(res, 200, lsRefsAnswer(forge, repo, args.map((arg) => arg.replace(/\n$/, ''))), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'command=fetch') {
        sendRaw(res, 200, fetchAnswerV2(forge, parseFetchArgs(args)), 'application/x-git-upload-pack-result');
        return;
      }
      sendRaw(res, 200, pktLine(null), 'application/x-git-upload-pack-result');
      return;
    }
    // Protocol v0: wants (capabilities ride the first line), flush, haves, done.
    const reader = new PktReader(body);
    const lines: string[] = [];
    let packet = reader.next();
    while (packet !== null) {
      if (packet === 'flush' || packet === 'delim' || packet === 'response-end') {
        packet = reader.next();
        continue;
      }
      let line = packet.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul !== -1) line = line.slice(0, nul);
      line = line.replace(/\n$/, '');
      if (line === 'done') break;
      lines.push(line);
      packet = reader.next();
    }
    sendRaw(res, 200, fetchAnswerV0(forge, parseFetchArgs(lines)), 'application/x-git-upload-pack-result');
  } catch {
    sendRaw(res, 200, pktLine(null), 'application/x-git-upload-pack-result');
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function handleReceivePack(forge: Forge, repo: RepoRec, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let unpackLine = 'unpack ok';
  try {
    const reader = new PktReader(body);
    let packet = reader.next();
    let first = true;
    while (packet !== null && packet !== 'flush') {
      if (packet === 'delim' || packet === 'response-end') break;
      let line = packet.toString('utf8');
      if (first) {
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          for (const cap of line.slice(nul + 1).replace(/\n$/, '').split(' ')) if (cap !== '') capabilities.add(cap);
          line = line.slice(0, nul);
        }
        first = false;
      }
      const parts = line.replace(/\n$/, '').split(' ');
      if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      }
      packet = reader.next();
    }
    const rest = reader.rest();
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    if (needsPack && rest.length > 0) {
      try {
        parsePack(forge.store, rest);
      } catch (err) {
        unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}`;
      }
    } else if (needsPack && rest.length === 0) {
      unpackLine = 'unpack no packfile given';
    }
  } catch {
    commands = [];
    unpackLine = 'unpack malformed request';
  }

  const reportStatus = capabilities.has('report-status') || capabilities.has('report-status-v2');
  const sideBand = capabilities.has('side-band-64k') || capabilities.has('side-band');
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackLine === 'unpack ok') {
    for (const command of commands) results.push(applyPushCommand(forge, repo, command));
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  }

  if (!reportStatus) {
    sendRaw(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const lines = [`${unpackLine}\n`, ...results.map((result) => (result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`))];
  let payload: Buffer;
  if (sideBand) {
    const reportBytes = Buffer.concat(lines.map((line) => pktLine(line)));
    payload = Buffer.concat([...sidebandPackets(reportBytes, 1), pktLine(null)]);
  } else {
    payload = Buffer.concat([...lines.map((line) => pktLine(line)), pktLine(null)]);
  }
  sendRaw(res, 200, payload, 'application/x-git-receive-pack-result');
}

function applyPushCommand(forge: Forge, repo: RepoRec, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/')) return { ref, ok: false, reason: 'invalid ref name' };
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return { ref, ok: false, reason: 'stale info' };
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return { ref, ok: false, reason: 'reference does not exist' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const object = forge.store.get(newOid);
  if (object === undefined) return { ref, ok: false, reason: 'unknown object' };
  if (ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit') return { ref, ok: false, reason: 'object is not a commit' };
    if (current !== ZERO_OID && !isAncestor(forge.store, current, newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

async function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, owner: string, repoName: string, kind: string): Promise<void> {
  const method = req.method ?? 'GET';
  const repo = forge.getRepo(owner, repoName);
  if (kind === 'info/refs') {
    const service = url.searchParams.get('service');
    if ((service !== 'git-upload-pack' && service !== 'git-receive-pack') || repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2')) {
      sendRaw(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    sendRaw(res, 200, advertisementV0(forge, repo, service), `application/x-${service}-advertisement`);
    return;
  }
  if (repo === null || method !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (kind === 'git-upload-pack') {
    await handleUploadPack(forge, repo, req, res);
    return;
  }
  await handleReceivePack(forge, repo, req, res);
}

// ---------------------------------------------------------------- GraphQL

async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const text = (await readBody(req)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { errors: [{ message: 'invalid operation' }] };
    const record = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    return executeGraphQL(forge, query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const method = req.method ?? 'GET';
        let pathname = url.pathname;
        if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');

        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (pathname === '/mcp') {
          if (method === 'DELETE' || method === 'GET') {
            sendJson(res, method === 'DELETE' ? 200 : 405, method === 'DELETE' ? {} : { message: 'Method Not Allowed' });
            return;
          }
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const answer = handleMcp(forge, (await readBody(req)).toString('utf8'));
          res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': Buffer.byteLength(answer.body) });
          res.end(answer.body);
          return;
        }

        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          await handleGraphQL(forge, req, res);
          return;
        }

        const segments = pathname.split('/').filter((segment) => segment !== '').map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return segment;
          }
        });

        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          await handleRest(forge, req, res, url, segments);
          return;
        }

        const gitKind =
          segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs'
            ? 'info/refs'
            : segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
              ? segments[2]
              : null;
        if (gitKind !== null && segments[1]!.endsWith('.git')) {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          await handleGit(forge, req, res, url, segments[0]!, segments[1]!.slice(0, -'.git'.length), gitKind);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
