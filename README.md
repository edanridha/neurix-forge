# neurix-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/edanridha/neurix-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/edanridha/neurix-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Neurix Forge is a standalone, GitHub-compatible git forge written in TypeScript for Node 22, using the standard library only — no dependencies, no git binary, no network at runtime. It implements the git object model itself (blobs, trees, commits and annotated tags in a content-addressed SHA-1 store, with packfile writing and parsing, including ofs/ref deltas) and serves git smart HTTP (protocol v0 and v2: info/refs, ls-refs, fetch with shallow/deepen support, and receive-pack with fast-forward enforcement and report-status). On top of that store it serves the REST v3 API (repositories, branches, commits, contents, labels, issues, comments and pull requests with three-way squash merges), the GraphQL v4 documents gh and github-mcp-server send (Relay global ids, cursor pagination, introspection, batched operations), and an MCP endpoint over Streamable HTTP (server/discover for the 2026-07-28 revision plus the initialize handshake, with repo/issue/pull-request tools that act on the same store as REST). State lives in memory and every timestamp derives from a deterministic clock, so a trial replays byte for byte.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=m9m70xh5&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
