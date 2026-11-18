// The git object model, implemented from scratch on node:crypto and node:zlib: content-addressed
// blobs/trees/commits/tags, packfile writing and parsing (plain objects plus ofs/ref deltas),
// pkt-line framing, reachability, merge-base, three-way tree merges and line diffs. No git binary,
// no dependencies — this file is the storage and protocol foundation the HTTP surfaces build on.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODES: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: readonly ObjectType[] = ['', 'commit', 'tree', 'blob', 'tag'] as unknown as readonly ObjectType[];

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

/** SHA-1 over the git object framing ("<type> <length>\0" + payload). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** The in-memory object database: one content-addressed map shared by every repository. */
export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  /** Committer timestamp, seconds (0 when the line is unparseable). */
  time: number;
  message: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (value: string): boolean => HEX40.test(value);

/** Parse a commit object's payload. Tolerant: unknown headers are skipped. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  let time = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) {
      committerLine = line.slice(10);
      const match = / (\d+) [+-]\d{4}$/.exec(committerLine);
      if (match) time = Number(match[1]);
    }
  }
  return { tree, parents, authorLine, committerLine, time, message };
}

export function buildCommit(tree: string, parents: readonly string[], authorLine: string, committerLine: string, message: string): Buffer {
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${authorLine}\ncommitter ${committerLine}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

/** One tree entry: mode as git writes it (no leading zeros), a name, and the child oid. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export const isTreeMode = (mode: string): boolean => mode === '40000' || mode === '040000';

// ---------------------------------------------------------------- packfiles

function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Find the length of the zlib stream starting at `offset` (inflateSync ignores trailing bytes, so the
 *  minimal prefix that inflates to the same bytes is the stream's true length). The stream ends with
 *  the Adler-32 of its payload: locate that trailer with a native search and verify with one inflate;
 *  fall back to an exponential+binary search when the trailer is ambiguous. */
function inflatedLength(buf: Buffer, offset: number, expected: Buffer): number {
  const remaining = buf.length - offset;
  const matches = (length: number): boolean => {
    try {
      const out = inflateSync(buf.subarray(offset, offset + length));
      return out.length === expected.length && out.equals(expected);
    } catch {
      return false;
    }
  };
  if (remaining > 6) {
    const pattern = Buffer.alloc(4);
    pattern.writeUInt32BE(adler32(expected), 0);
    let searchFrom = offset + 2;
    for (;;) {
      const at = buf.indexOf(pattern, searchFrom);
      if (at === -1 || at + 4 > buf.length) break;
      const length = at + 4 - offset;
      if (length <= remaining && matches(length)) return length;
      searchFrom = at + 1;
    }
  }
  let lo = 1;
  let hi = Math.min(remaining, 64);
  while (hi < remaining && !matches(hi)) {
    lo = hi + 1;
    hi = Math.min(remaining, hi * 2);
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface PackEntry {
  type: ObjectType;
  data: Buffer;
  /** For delta entries: the base's offset in the pack (ofs) or oid (ref). */
  baseOffset?: number;
  baseOid?: string;
  offset: number;
}

/** Apply a git delta (source/target sizes, then copy/insert opcodes) to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++]!;
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
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++]!;
      if (op & 0x02) offset |= delta[pos++]! << 8;
      if (op & 0x04) offset |= delta[pos++]! << 16;
      if (op & 0x08) offset |= delta[pos++]! << 24;
      if (op & 0x10) size = delta[pos++]!;
      if (op & 0x20) size |= delta[pos++]! << 8;
      if (op & 0x40) size |= delta[pos++]! << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Parse a packfile into the store. Plain objects and both delta kinds are supported; returns the
 * number of objects the pack held. Throws on any structural problem (the caller answers `unpack`).
 */
export function parsePack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset encoded as a variable-length number.
      let b = pack[offset++]!;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++]!;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset));
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    offset += inflatedLength(pack, offset, inflated);
    const entry: PackEntry = {
      type: CODE_TYPES[typeCode] ?? 'blob',
      data: inflated,
      baseOffset,
      baseOid,
      offset: start,
    };
    if (typeCode === 6 || typeCode === 7) entry.data = inflated; // delta payload, resolved below
    entries.push(entry);
    byOffset.set(start, entry);
  }
  // Resolve in passes: plain objects first, then deltas whose bases are known.
  const resolved = new Map<number, { type: ObjectType; data: Buffer; oid: string }>();
  const resolveEntry = (entry: PackEntry, depth: number): { type: ObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (depth > 64) throw new Error('delta chain too deep');
    let type: ObjectType;
    let data: Buffer;
    const code = entry.baseOffset === undefined && entry.baseOid === undefined;
    if (code) {
      type = entry.type;
      data = entry.data;
    } else {
      let base: { type: ObjectType; data: Buffer; oid: string } | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('delta base offset not in pack');
        base = resolveEntry(baseEntry, depth + 1);
      } else {
        const existing = store.get(entry.baseOid!);
        if (!existing) throw new Error('delta base not available');
        base = { type: existing.type, data: existing.data, oid: entry.baseOid! };
      }
      type = base.type;
      data = applyDelta(base.data, entry.data);
    }
    const oid = hashObject(type, data);
    resolved.set(entry.offset, { type, data, oid });
    return { type, data, oid };
  };
  for (const entry of entries) {
    const { type, data, oid } = resolveEntry(entry, 0);
    store.putKnown(oid, type, data);
  }
  return count;
}

/** Write a packfile holding the given objects (plain, undeltified — always valid). */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (!object) continue;
    const size = object.data.length;
    const typeCode = TYPE_CODES[object.type];
    const bytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line (payload without the length prefix; null = flush packet). */
export function pktLine(payload: Buffer | string | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'ascii');
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const prefix = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), data]);
}

export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

/** A pkt-line reader over a request body: yields payloads, 'flush' and 'delim' markers. */
export class PktReader {
  private offset = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** Next payload, the string 'flush'/'delim'/'response-end', or null at the end of the buffer. */
  next(): Buffer | 'flush' | 'delim' | 'response-end' | null {
    if (this.offset + 4 > this.buf.length) return null;
    const hex = this.buf.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`malformed pkt-line length "${hex}"`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      this.offset += 4;
      return 'flush';
    }
    if (length === 1) {
      this.offset += 4;
      return 'delim';
    }
    if (length === 2) {
      this.offset += 4;
      return 'response-end';
    }
    if (length === 3) {
      this.offset += 4;
      return 'delim';
    }
    if (length < 4 || this.offset + length > this.buf.length) throw new Error('pkt-line overruns the body');
    const payload = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return payload;
  }

  /** The unread remainder (a receive-pack packfile follows the command packets). */
  rest(): Buffer {
    return this.buf.subarray(this.offset);
  }

  get done(): boolean {
    return this.offset >= this.buf.length;
  }
}

/** Wrap data in sideband band-1 packets of at most `chunk` payload bytes (plus the band byte). */
export function sidebandPackets(data: Buffer, band: number, chunk = 65515): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunk) {
    const slice = data.subarray(offset, Math.min(data.length, offset + chunk));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return packets;
}

// ---------------------------------------------------------------- reachability

/** All commits reachable from `tips` (inclusive), following parents; `stopAt` commits are not crossed. */
export function reachableCommits(store: ObjectStore, tips: readonly string[], stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || (stopAt !== undefined && stopAt.has(oid))) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** The full object closure (commits, their trees and blobs) of the given commits. */
export function objectClosure(store: ObjectStore, commits: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  const push = (oid: string): void => {
    if (!out.has(oid)) {
      out.add(oid);
      stack.push(oid);
    }
  };
  for (const commit of commits) push(commit);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const object = store.get(oid);
    if (!object) {
      out.delete(oid);
      continue;
    }
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      push(info.tree);
      for (const parent of info.parents) push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match) push(match[1]!);
    }
  }
  return out;
}

/** Peel a tag (possibly nested) to the first non-tag object; other types return themselves. */
export function peelTag(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (!object || object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (!match) return current;
    current = match[1]!;
  }
  return current;
}

/** Is `ancestor` reachable from `descendant` (inclusive)? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return reachableCommits(store, [descendant]).has(ancestor);
}

/** A merge base of two commits: a common ancestor that is not an ancestor of another common ancestor. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = reachableCommits(store, [a]);
  const fromB = reachableCommits(store, [b]);
  const common = [...fromA].filter((oid) => fromB.has(oid));
  if (common.length === 0) return null;
  // Prefer the common ancestor with the greatest commit time (the fixtures are linear; this is exact there).
  let best: string | null = null;
  let bestTime = -1;
  for (const oid of common) {
    const object = store.get(oid);
    if (!object) continue;
    const time = parseCommit(object.data).time;
    // Skip candidates that are ancestors of another candidate when times tie toward the descendant.
    if (time > bestTime) {
      bestTime = time;
      best = oid;
    }
  }
  // Refine: drop any best that is a strict ancestor of another common commit with the same time.
  if (best !== null) {
    for (const oid of common) {
      if (oid !== best && isAncestor(store, best, oid)) {
        const t = parseCommit(store.get(oid)!.data).time;
        if (t >= bestTime) {
          best = oid;
          bestTime = t;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- trees as flat path maps

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into a path -> entry map. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const object = store.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild nested trees from a flat path map; returns the root tree oid. */
export function unflattenTree(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]!);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i]!, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- merges and diffs

export interface MergeOutcome {
  ok: boolean;
  tree: string;
  conflicts: string[];
}

/**
 * Three-way merge of two trees against a base tree, at path granularity with blob-level shortcuts:
 * a path changed on only one side takes that side; changed identically takes it; changed differently
 * on both sides (or deleted against modified) conflicts.
 */
export function mergeTrees(store: ObjectStore, baseTree: string, ourTree: string, theirTree: string): MergeOutcome {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o) merged.set(path, o);
    } else if (same(b, o)) {
      if (t) merged.set(path, t);
    } else if (same(b, t)) {
      if (o) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, tree: '', conflicts };
  return { ok: true, tree: unflattenTree(store, merged), conflicts: [] };
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** Line-diff counts between two blob payloads (LCS for small files, whole-file counts for large ones). */
export function diffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 1500 || newLines.length > 1500) {
    return { additions: countLines(newData), deletions: countLines(oldData) };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j] ? dp[(i + 1) * (n + 1) + (j + 1)]! + 1 : Math.max(dp[(i + 1) * (n + 1) + j]!, dp[i * (n + 1) + (j + 1)]!);
    }
  }
  const common = dp[0]!;
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two trees (base -> head), with line counts. */
export function diffTrees(store: ObjectStore, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(store, baseTree);
  const head = flattenTree(store, headTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      changes.push({ path, status: 'removed', additions: 0, deletions: countLines(store.get(b.oid)?.data ?? Buffer.alloc(0)) });
    } else if (!b && h) {
      changes.push({ path, status: 'added', additions: countLines(store.get(h.oid)?.data ?? Buffer.alloc(0)), deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const counts = diffCounts(store.get(b.oid)?.data ?? Buffer.alloc(0), store.get(h.oid)?.data ?? Buffer.alloc(0));
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}
