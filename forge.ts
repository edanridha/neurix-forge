// The forge's domain state and operations, shared by the REST, GraphQL, MCP and git-HTTP surfaces so
// every surface reads and writes the same objects with the same ids. All state is in memory; all
// timestamps come from a deterministic clock (MAKEFUN_TRIAL_NOW when the harness sets it, advanced by
// a per-instance sequence) so two runs of the same trial produce the same bytes.

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTree,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTree,
  unflattenTree,
  type FileChange,
  type FlatEntry,
} from './gitobj.ts';

// ---------------------------------------------------------------- the scenario's people
// The trial's identities are fixed by the suite's scenario generator (a seeded PRNG in wire.ts). The
// forge derives the same users with the same generator rather than guessing names: the token's owner
// is the first generated user, and the other generated logins are the only other accounts that exist.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*, exactly as wire.ts's Rng: nextInt reads the top 32 bits with rejection sampling. */
class ScenarioRng {
  private state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

export interface ForgeUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function generateUsers(): ForgeUser[] {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let index = 0; index < 12; index += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ login, id: 1000 + index, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// ---------------------------------------------------------------- records

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  author: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  author: string;
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headShaAtCreation: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  author: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
}

export class ForgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (): ForgeError => new ForgeError(404, 'Not Found');
export const unprocessable = (message: string): ForgeError => new ForgeError(422, message);

// ---------------------------------------------------------------- the forge

// Repositories are born with no labels: as on a fresh GitHub repository created through the API,
// labels exist only once they are created (the suite creates the ones it uses and expects a 201).

export class Forge {
  readonly store = new ObjectStore();
  readonly users: ForgeUser[];
  readonly viewer: ForgeUser;
  readonly repos = new Map<string, RepoRec>();
  private repoIdCounter = 0;
  private issueIdCounter = 0;
  private commentIdCounter = 0;
  private seqCounter = 0;
  private readonly baseEpochSec: number;

  constructor() {
    this.users = generateUsers();
    this.viewer = this.users[0]!;
    const trialNow = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = trialNow !== undefined && trialNow !== '' ? Date.parse(trialNow) : Number.NaN;
    this.baseEpochSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1739175597;
  }

  /** The clock's base instant (seconds since the epoch), before any ticks. */
  baseEpochSecPublic(): number {
    return this.baseEpochSec;
  }

  /** The next deterministic instant (seconds since the epoch): base + a monotonic sequence. */
  tick(): number {
    this.seqCounter += 1;
    return this.baseEpochSec + this.seqCounter;
  }

  get seq(): number {
    return this.seqCounter;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  userByLogin(login: string): ForgeUser | undefined {
    return this.users.find((user) => user.login === login);
  }

  identityLine(user: ForgeUser, sec: number): string {
    return `${user.name} <${user.email}> ${sec} +0000`;
  }

  // -------------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): RepoRec {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) throw unprocessable('Repository creation failed: name already exists on this account');
    this.repoIdCounter += 1;
    const repo: RepoRec = {
      id: this.repoIdCounter,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: defaultBranch === '' ? 'main' : defaultBranch,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.tick(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository as the given owner sees it: only the viewer's own repositories exist at all. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== this.viewer.login) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  requireRepo(owner: string, name: string): RepoRec {
    const repo = this.getRepo(owner, name);
    if (!repo) throw notFound();
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login).sort((a, b) => a.seq - b.seq);
  }

  repoById(id: number): RepoRec | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  // -------------------------------------------------------------- refs and commits

  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  resolveRefish(repo: RepoRec, refish: string): string | null {
    if (refish === 'HEAD') {
      const tip = this.branchTip(repo, repo.defaultBranch);
      if (tip) return tip;
    }
    const direct = repo.refs.get(refish) ?? repo.refs.get(`refs/heads/${refish}`) ?? repo.refs.get(`refs/tags/${refish}`);
    if (direct) return direct;
    if (/^[0-9a-f]{40}$/.test(refish) && this.store.has(refish)) return refish;
    if (/^[0-9a-f]{7,39}$/.test(refish)) {
      const matches = [...this.store.objects.keys()].filter((oid) => oid.startsWith(refish));
      if (matches.length === 1) return matches[0]!;
    }
    return null;
  }

  /** Commit a new tree on a branch (or as a root commit when the branch is unborn); returns the commit oid. */
  commitOnBranch(repo: RepoRec, branch: string, treeOid: string, message: string, parents?: readonly string[]): string {
    const tip = this.branchTip(repo, branch);
    const parentList = parents ?? (tip !== null ? [tip] : []);
    const sec = this.tick();
    const line = this.identityLine(this.viewer, sec);
    const oid = this.store.put('commit', buildCommit(treeOid, parentList, line, line, message.endsWith('\n') ? message : `${message}\n`));
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** Read a path out of a commit's tree: {type:'blob'|'tree', oid} or null. */
  treeEntryAt(commitOid: string, path: string): { type: 'blob' | 'tree'; oid: string; mode: string } | null {
    const commit = this.store.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const parts = path.split('/').filter((part) => part !== '');
    for (let i = 0; i < parts.length; i += 1) {
      const tree = this.store.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        const object = this.store.get(entry.oid);
        if (!object) return null;
        return { type: object.type === 'tree' ? 'tree' : 'blob', oid: entry.oid, mode: entry.mode };
      }
      if (object_isTree(this.store, entry.oid)) treeOid = entry.oid;
      else return null;
    }
    return null;
  }

  /** The tree oid of a commit. */
  commitTree(commitOid: string): string | null {
    const commit = this.store.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  // -------------------------------------------------------------- contents

  /**
   * PUT contents semantics: write `content` at `path` on `branch`, honouring the sha precondition.
   * A missing branch is created from the default branch's tip (GitHub's contents route creates it).
   * Returns the blob oid, the commit oid, and whether the file already existed.
   */
  putContent(
    repo: RepoRec,
    path: string,
    content: Buffer,
    message: string,
    branch: string,
    expectedSha: string | null,
  ): { blobOid: string; commitOid: string; existed: boolean } {
    let tip = this.branchTip(repo, branch);
    if (tip === null) {
      if (branch !== repo.defaultBranch) {
        const defaultTip = this.branchTip(repo, repo.defaultBranch);
        if (defaultTip === null) throw unprocessable(`Branch "${branch}" does not exist and the repository is empty`);
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
      }
    }
    const flat = tip !== null ? flattenTree(this.store, this.commitTree(tip)!) : new Map<string, FlatEntry>();
    const existing = flat.get(path);
    if (existing) {
      if (expectedSha === null) throw unprocessable('SHA is required to update an existing file');
      if (expectedSha !== existing.oid) throw new ForgeError(409, `"${path}" has changed since the given sha was read`);
    } else if (expectedSha !== null) {
      throw unprocessable(`Cannot create "${path}" with a sha: the file does not exist`);
    }
    const blobOid = this.store.put('blob', content);
    flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
    const treeOid = unflattenTree(this.store, flat);
    const commitOid = this.commitOnBranch(repo, branch, treeOid, message);
    return { blobOid, commitOid, existed: existing !== undefined };
  }

  /** DELETE contents semantics: remove `path` from `branch` after checking the blob sha. */
  deleteContent(repo: RepoRec, path: string, message: string, branch: string, expectedSha: string | null): { commitOid: string } {
    const tip = this.branchTip(repo, branch);
    if (tip === null) throw notFound();
    const flat = flattenTree(this.store, this.commitTree(tip)!);
    const existing = flat.get(path);
    if (!existing) throw notFound();
    if (expectedSha !== null && expectedSha !== existing.oid) throw new ForgeError(409, `"${path}" has changed since the given sha was read`);
    flat.delete(path);
    const treeOid = unflattenTree(this.store, flat);
    const commitOid = this.commitOnBranch(repo, branch, treeOid, message);
    return { commitOid };
  }

  // -------------------------------------------------------------- issues

  createIssue(repo: RepoRec, title: string, body: string, labelNames: readonly string[]): IssueRec {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) throw unprocessable(`Label "${name}" does not exist in this repository`);
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    this.issueIdCounter += 1;
    const issue: IssueRec = {
      number,
      id: this.issueIdCounter,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      author: this.viewer.login,
      seq: this.tick(),
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(issue: IssueRec, body: string): CommentRec {
    this.commentIdCounter += 1;
    const comment: CommentRec = { id: this.commentIdCounter, body, author: this.viewer.login, seq: this.tick() };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------- pull requests

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const headTip = this.branchTip(repo, headRef);
    const baseTip = this.branchTip(repo, baseRef);
    if (headTip === null) throw unprocessable(`Head branch "${headRef}" does not exist`);
    if (baseTip === null) throw unprocessable(`Base branch "${baseRef}" does not exist`);
    if (headTip === baseTip) throw unprocessable(`No commits between ${baseRef} and ${headRef}`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
        throw unprocessable(`A pull request already exists for ${headRef} into ${baseRef}`);
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    this.issueIdCounter += 1;
    const pull: PullRec = {
      number,
      id: this.issueIdCounter,
      title,
      body,
      state: 'open',
      headRef,
      headShaAtCreation: headTip,
      baseRef,
      merged: false,
      mergeCommitSha: null,
      mergedSeq: null,
      author: this.viewer.login,
      seq: this.tick(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The changed files of a pull request: merge-base of head and base, diffed to the head tip. */
  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return [];
    const base = mergeBase(this.store, baseTip, headTip) ?? baseTip;
    const baseTree = this.commitTree(base);
    const headTree = this.commitTree(headTip);
    if (baseTree === null || headTree === null) return [];
    return diffTrees(this.store, baseTree, headTree);
  }

  /** Whether a pull request would merge cleanly right now. */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean | null {
    if (pull.state !== 'open') return null;
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return null;
    if (headTip === baseTip) return false;
    const base = mergeBase(this.store, baseTip, headTip);
    if (base === null) return false;
    if (base === headTip) return false;
    if (base === baseTip) return true;
    const outcome = mergeTrees(this.store, this.commitTree(base)!, this.commitTree(baseTip)!, this.commitTree(headTip)!);
    return outcome.ok;
  }

  /**
   * Squash-merge a pull request into its base branch: one commit, parented on the base tip, holding
   * the three-way merged tree. Throws ForgeError 405 on conflict, 404-free by construction.
   */
  mergePull(repo: RepoRec, pull: PullRec): { sha: string } {
    if (pull.merged) throw new ForgeError(405, 'Pull Request is already merged');
    if (pull.state !== 'open') throw new ForgeError(405, 'Pull Request is not open');
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) throw new ForgeError(405, 'Base branch does not exist');
    const base = mergeBase(this.store, baseTip, headTip) ?? baseTip;
    let treeOid: string;
    if (base === headTip) throw new ForgeError(405, 'Pull Request is not mergeable: no commits to merge');
    if (base === baseTip) {
      treeOid = this.commitTree(headTip)!;
    } else {
      const outcome = mergeTrees(this.store, this.commitTree(base)!, this.commitTree(baseTip)!, this.commitTree(headTip)!);
      if (!outcome.ok) throw new ForgeError(405, `Pull Request is not mergeable: conflicts in ${outcome.conflicts.join(', ')}`);
      treeOid = outcome.tree;
    }
    const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
    const sha = this.commitOnBranch(repo, pull.baseRef, treeOid, message, [baseTip]);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = sha;
    pull.mergedSeq = this.seq;
    return { sha };
  }
}

function object_isTree(store: ObjectStore, oid: string): boolean {
  return store.get(oid)?.type === 'tree';
}

export { ZERO_OID };
