# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Bug Fixes

- **claude:** Correct statusline config (#28) ([#28](https://github.com/opentrace/opentrace/pull/28))
- **ui:** Skip doomed group COPY RELATES, use per-subtable COPY directly (#29) ([#29](https://github.com/opentrace/opentrace/pull/29))
- Go import resolver dir index filtering and collision safety (#31) ([#31](https://github.com/opentrace/opentrace/pull/31))
- Strip newlines in KuzuDB CSV escape to avoid COPY FROM failure (#43) ([#43](https://github.com/opentrace/opentrace/pull/43))
- Hide expand icon on non-parseable files in Discover panel (#44) ([#44](https://github.com/opentrace/opentrace/pull/44))
- **ui:** Remove unused node types and consolidate Repo→Repository (#51) ([#51](https://github.com/opentrace/opentrace/pull/51))
- Update README and Makefile to reflect open-source repo state (#55) ([#55](https://github.com/opentrace/opentrace/pull/55))
- **ci:** Add contents:read permission and fix checkout action version (#60) ([#60](https://github.com/opentrace/opentrace/pull/60))
- **ui:** Show config fields when switching to Local LLM provider (#61) ([#61](https://github.com/opentrace/opentrace/pull/61))
- Merge summaries into existing nodes instead of emitting duplicates (#50) ([#50](https://github.com/opentrace/opentrace/pull/50))
- **ui:** Keep indexing modal open until graph data is ready (#83) ([#83](https://github.com/opentrace/opentrace/pull/83))
- **ci:** Use GitHub App token for changelog push to main (#88) ([#88](https://github.com/opentrace/opentrace/pull/88))
- **ci:** Skip non-conventional commits in changelog generation (#89) ([#89](https://github.com/opentrace/opentrace/pull/89))

### CI/CD

- Trigger deployment on push to main
- Move deployment trigger to standalone workflow
- Only run CI on pull requests, not on push to main (#24) ([#24](https://github.com/opentrace/opentrace/pull/24))
- Add semantic PR title validation workflow (#85) ([#85](https://github.com/opentrace/opentrace/pull/85))
- Add git-cliff changelog and release notes generation (#86) ([#86](https://github.com/opentrace/opentrace/pull/86))

### Documentation

- Update README with repo structure, Claude Code plugin, and static build
- Add open-source README, CONTRIBUTING, and SECURITY guides (#65) ([#65](https://github.com/opentrace/opentrace/pull/65))
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]

### Features

- **ui:** Louvain community detection coloring (#46) ([#46](https://github.com/opentrace/opentrace/pull/46))
- Detect already-indexed repos in Add Repository modal (#45) ([#45](https://github.com/opentrace/opentrace/pull/45))
- **ui:** Community-aware graph layout, filtering, and legend (#49) ([#49](https://github.com/opentrace/opentrace/pull/49))
- Add Bitbucket Cloud & Azure DevOps provider support (#53) ([#53](https://github.com/opentrace/opentrace/pull/53))
- **ui:** Add Star on GitHub button to header toolbar (#56) ([#56](https://github.com/opentrace/opentrace/pull/56))
- **ui:** Add GitHub logo and primary styling to star button (#58) ([#58](https://github.com/opentrace/opentrace/pull/58))
- **ci:** Trigger deploy workflow on labeled PRs (#62) ([#62](https://github.com/opentrace/opentrace/pull/62))
- **agent:** Align indexer output with UI for graph parity (#52) ([#52](https://github.com/opentrace/opentrace/pull/52))
- **ci:** Publish opentraceai package to PyPI on release, main, and PR (#68) ([#68](https://github.com/opentrace/opentrace/pull/68))
- **agent:** Add stdio MCP server for querying indexed codebases (#81) ([#81](https://github.com/opentrace/opentrace/pull/81))
- **ui:** Responsive toolbar redesign with three-tier breakpoints (#74) ([#74](https://github.com/opentrace/opentrace/pull/74))
- **ui:** Responsive chat panel with full-screen mobile overlay (#87) ([#87](https://github.com/opentrace/opentrace/pull/87))
- **ui:** Modular graph layout architecture with community-aware pipeline (#84) ([#84](https://github.com/opentrace/opentrace/pull/84))
- **plugin:** Switch to stdio MCP and fix agent/command tool references (#92) ([#92](https://github.com/opentrace/opentrace/pull/92))
- **plugin:** Add marketplace.json for plugin discovery (#95) ([#95](https://github.com/opentrace/opentrace/pull/95))
- **agent:** Add opentraceai CLI alias (#97) ([#97](https://github.com/opentrace/opentrace/pull/97))

### Miscellaneous

- **build:** Set branch on deploy trigger
- **build:** Set branch on deploy trigger
- Add Claude Code statusline script (#25) ([#25](https://github.com/opentrace/opentrace/pull/25))
- Remove .idea directory from version control (#66) ([#66](https://github.com/opentrace/opentrace/pull/66))
- **ui:** Add vite port to .env (#70) ([#70](https://github.com/opentrace/opentrace/pull/70))

### Performance

- **ui:** Optimize graph rendering for large graphs (15k+ nodes) (#30) ([#30](https://github.com/opentrace/opentrace/pull/30))
- Virtualize Discover panel tree with react-window (#48) ([#48](https://github.com/opentrace/opentrace/pull/48))

### Refactoring

- **ui:** Replace kuzu-wasm with @lbug/lbug-wasm (#69) ([#69](https://github.com/opentrace/opentrace/pull/69))
- **agent:** Simplify CLI to local-only KuzuDB indexer (#78) ([#78](https://github.com/opentrace/opentrace/pull/78))

