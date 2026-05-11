# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-05-01

### Bug Fixes

- **ci:** Resolve preview-publish PR by head ref instead of commit assoc (#327) ([#327](https://github.com/opentrace/opentrace/pull/327))
- **ci:** Correct artifact paths after upload LCA stripping (#328) ([#328](https://github.com/opentrace/opentrace/pull/328))
- **ui:** Make graph canvas reactive to theme and light/dark mode chan… (#330) ([#330](https://github.com/opentrace/opentrace/pull/330))
- **agent:** Allow concurrent index while MCP server is running (#323) ([#323](https://github.com/opentrace/opentrace/pull/323))
- **ui:** Reset buffered write counters in clearGraph (#341) ([#341](https://github.com/opentrace/opentrace/pull/341))
- **queue:** Clear graph abort pending queries (#345) ([#345](https://github.com/opentrace/opentrace/pull/345))
- **pixi:** Stabilize 3D rendering under spread-layout drift (OT-1691) (#342) ([#342](https://github.com/opentrace/opentrace/pull/342))
- **ui:** Left-drag pans in 3D mode, right-drag rotates (#346) ([#346](https://github.com/opentrace/opentrace/pull/346))
- **ui:** Flip 3D mouse controls — left-drag rotates, right-drag pans (#348) ([#348](https://github.com/opentrace/opentrace/pull/348))
- **ui:** Finish wiring PHP end-to-end in the browser runner (#350) ([#350](https://github.com/opentrace/opentrace/pull/350))
- **ui:** Disable already-indexed example repos in AddRepoModal (OT-1699) (#352) ([#352](https://github.com/opentrace/opentrace/pull/352))
- **ui:** Keep graph framed during indexing, not only after embeddings (OT-1712) (#353) ([#353](https://github.com/opentrace/opentrace/pull/353))
- **oss domain:** Text change in docs and code to app.opentrace.ai (#381) ([#381](https://github.com/opentrace/opentrace/pull/381))
- **plugins/opencode:** Declare @opencode-ai/plugin as runtime dep (#384) ([#384](https://github.com/opentrace/opentrace/pull/384))

### CI/CD

- Use pull_request_target for preview publish to fix fork OIDC (#324) ([#324](https://github.com/opentrace/opentrace/pull/324))
- Split preview publish into build + workflow_run publish (#326) ([#326](https://github.com/opentrace/opentrace/pull/326))
- Rename preview-publish label to preview-pypi (#334) ([#334](https://github.com/opentrace/opentrace/pull/334))
- Allow same-version npm bumps in release workflows (#385) ([#385](https://github.com/opentrace/opentrace/pull/385))

### Documentation

- Update README install command to uv tool install (#321) ([#321](https://github.com/opentrace/opentrace/pull/321))
- Restructure install paths into per-audience guides (#322) ([#322](https://github.com/opentrace/opentrace/pull/322))
- Add CLAUDE.md files throughout repo for agent context (#332) ([#332](https://github.com/opentrace/opentrace/pull/332))
- Readme updates (#331) ([#331](https://github.com/opentrace/opentrace/pull/331))

### Features

- **ui:** Add stop button and edit-and-resend to chat (#325) ([#325](https://github.com/opentrace/opentrace/pull/325))
- **auth:** Add user-scoped tokens and per-org token resolution (#296) ([#296](https://github.com/opentrace/opentrace/pull/296))
- **plugin:** Add debug mode via OPENTRACE_DEBUG (#333) ([#333](https://github.com/opentrace/opentrace/pull/333))
- **ui:** Add reindex-repo job to rebuild a single repo's graph (#347) ([#347](https://github.com/opentrace/opentrace/pull/347))
- **ui:** Add PHP support to browser tree-sitter pipeline (#349) ([#349](https://github.com/opentrace/opentrace/pull/349))
- **ui:** Fit graph on chat submit, clear highlights on done (OT-1717) (#355) ([#355](https://github.com/opentrace/opentrace/pull/355))
- **ui:** Resizable graph panels — horizontal, vertical, corner (OT-1716) (#354) ([#354](https://github.com/opentrace/opentrace/pull/354))
- **cli:** Headless cli (#377) ([#377](https://github.com/opentrace/opentrace/pull/377))
- **plugin:** Opencode plugin (#382) ([#382](https://github.com/opentrace/opentrace/pull/382))
- **app-components:** Extract useGraphViewer orchestration hook (#383) ([#383](https://github.com/opentrace/opentrace/pull/383))

### Refactoring

- **ui:** Lift graph state into context providers (#376) ([#376](https://github.com/opentrace/opentrace/pull/376))
- **ui:** Extract GraphViewer JSX into reusable components (#379) ([#379](https://github.com/opentrace/opentrace/pull/379))
- Move claude-code-plugin to plugins/claude-code (#380) ([#380](https://github.com/opentrace/opentrace/pull/380))
## [0.3.0] - 2026-04-10

### Bug Fixes

- **ci:** Handle pre-existing GitHub releases in release workflow (#311) ([#311](https://github.com/opentrace/opentrace/pull/311))
## [0.2.0] - 2026-04-10

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
- **ci:** Correct PyPI pre-release version ordering (#99) ([#99](https://github.com/opentrace/opentrace/pull/99))
- **ui:** Fix Gemini tool schema compat and make Gemini default provider (#101) ([#101](https://github.com/opentrace/opentrace/pull/101))
- **ui:** Update Anthropic 4.6 model IDs to remove dated suffixes (#107) ([#107](https://github.com/opentrace/opentrace/pull/107))
- **ui:** Handle sigma edge index race in batch attribute updates (#114) ([#114](https://github.com/opentrace/opentrace/pull/114))
- **ui:** Dedupe React to prevent dual-instance crash with linked components (#119) ([#119](https://github.com/opentrace/opentrace/pull/119))
- **components:** Restore edge indexation hints lost during extraction (#126) ([#126](https://github.com/opentrace/opentrace/pull/126))
- **store:** Handle dict-typed properties from KuzuDB (#130) ([#130](https://github.com/opentrace/opentrace/pull/130))
- **ui:** Toolbar overlaps chat panel when drawer is open (#132) ([#132](https://github.com/opentrace/opentrace/pull/132))
- **ui:** Show DEPENDS_ON relationships by default (#134) ([#134](https://github.com/opentrace/opentrace/pull/134))
- **store:** Parse LadybugDB MAP literal format, add MCP debug logging (#137) ([#137](https://github.com/opentrace/opentrace/pull/137))
- **ui:** Apply npm audit --fix security updates (#144) ([#144](https://github.com/opentrace/opentrace/pull/144))
- **ui:** Remove unused dev proxies, default archive URL to production (#146) ([#146](https://github.com/opentrace/opentrace/pull/146))
- **ui:** Fix indexing modal close behavior and simplify buttons (#167) ([#167](https://github.com/opentrace/opentrace/pull/167))
- **ui:** Fix PR "Index into Graph" for LadybugStore (#174) ([#174](https://github.com/opentrace/opentrace/pull/174))
- **ui:** Remove misleading +0-0 stats from PR list (#176) ([#176](https://github.com/opentrace/opentrace/pull/176))
- **ui:** Re-enable Add Repository toolbar button (#178) ([#178](https://github.com/opentrace/opentrace/pull/178))
- **ui:** Prevent loading screen from replacing visible graph (#181) ([#181](https://github.com/opentrace/opentrace/pull/181))
- **ui:** Theme the Save button on chat settings panel (#180) ([#180](https://github.com/opentrace/opentrace/pull/180))
- **ui:** Lazy-load parquet-wasm for production WASM init (#185) ([#185](https://github.com/opentrace/opentrace/pull/185))
- **pixi:** Label system overhaul — visibility, overlap culling, 3D depth sorting (#190) ([#190](https://github.com/opentrace/opentrace/pull/190))
- **pixi:** Decouple label sizing from zoom scaling exponent (#197) ([#197](https://github.com/opentrace/opentrace/pull/197))
- **ui:** Search autocomplete review fixes (#195) ([#195](https://github.com/opentrace/opentrace/pull/195))
- **ui:** Correct style.css export path in package.json (#210) ([#210](https://github.com/opentrace/opentrace/pull/210))
- **ui:** Truncate graph labels and strip control characters (#213) ([#213](https://github.com/opentrace/opentrace/pull/213))
- **ui:** Move OpenTraceLogo styles to CSS file to fix hydrateRoot crash (#214) ([#214](https://github.com/opentrace/opentrace/pull/214))
- **ui:** Filter panel sub-type toggle ignored after hide-all (#243) ([#243](https://github.com/opentrace/opentrace/pull/243))
- **ui:** Display edge type labels in uppercase in filter panel (#258) ([#258](https://github.com/opentrace/opentrace/pull/258))
- **docs:** Use app icon for MkDocs site logo and favicon (#262) ([#262](https://github.com/opentrace/opentrace/pull/262))
- **ui:** Raise modal z-index above mobile drawers (#266) ([#266](https://github.com/opentrace/opentrace/pull/266))
- **ui:** Reload page when pixi chunk fails to load after deploy (#267) ([#267](https://github.com/opentrace/opentrace/pull/267))
- **ui:** Show fallback page when cross-origin isolation is unavailable (#269) ([#269](https://github.com/opentrace/opentrace/pull/269))
- **ui:** Style export button as menu row in mobile burger menu (#268) ([#268](https://github.com/opentrace/opentrace/pull/268))
- **ui:** Use theme variables for graph control button active state (#270) ([#270](https://github.com/opentrace/opentrace/pull/270))
- **ui:** Mobile split layout with graph on top and chat below (#271) ([#271](https://github.com/opentrace/opentrace/pull/271))
- **ui:** Add missing Variable REL_PAIRS to prevent relationship loss (#287) ([#287](https://github.com/opentrace/opentrace/pull/287))
- Remove duplicate FROM-TO pairs in REL_PAIRS schema (#292) ([#292](https://github.com/opentrace/opentrace/pull/292))
- **ui:** Zoom to fit all nodes on deselect when zoom-to-node enabled (#298) ([#298](https://github.com/opentrace/opentrace/pull/298))
- Remove accidentally tracked vitest cache and add root node_modules to gitignore (#299) ([#299](https://github.com/opentrace/opentrace/pull/299))
- **agent:** MCP server gracefully handles missing database (#302) ([#302](https://github.com/opentrace/opentrace/pull/302))

### CI/CD

- Trigger deployment on push to main
- Move deployment trigger to standalone workflow
- Only run CI on pull requests, not on push to main (#24) ([#24](https://github.com/opentrace/opentrace/pull/24))
- Add semantic PR title validation workflow (#85) ([#85](https://github.com/opentrace/opentrace/pull/85))
- Add git-cliff changelog and release notes generation (#86) ([#86](https://github.com/opentrace/opentrace/pull/86))
- Add preview-npm workflow and components CI job (#112) ([#112](https://github.com/opentrace/opentrace/pull/112))
- Move changelog and version bumps into release workflow (#111) ([#111](https://github.com/opentrace/opentrace/pull/111))

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
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- Update CHANGELOG.md [skip ci]
- **ui:** Replace default Vite README with project documentation (#222) ([#222](https://github.com/opentrace/opentrace/pull/222))
- Add demo video and caption to README (#290) ([#290](https://github.com/opentrace/opentrace/pull/290))
- Update demo video in README (#295) ([#295](https://github.com/opentrace/opentrace/pull/295))
- Update all READMEs to reflect current project state (#305) ([#305](https://github.com/opentrace/opentrace/pull/305))
- Fix stale content and add missing reference pages (#307) ([#307](https://github.com/opentrace/opentrace/pull/307))

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
- **ui:** Add provider API key help and update models (#100) ([#100](https://github.com/opentrace/opentrace/pull/100))
- **ui:** Responsive design for iPhone/iPad/mobile (#96) ([#96](https://github.com/opentrace/opentrace/pull/96))
- **plugin:** Add hooks, skills, and agents for graph discovery (#106) ([#106](https://github.com/opentrace/opentrace/pull/106))
- **ui:** Improve graph selection UX with zoom, z-ordering, and visual hierarchy (#108) ([#108](https://github.com/opentrace/opentrace/pull/108))
- **ui:** Add @opentrace/components library build (#110) ([#110](https://github.com/opentrace/opentrace/pull/110))
- Add @opentrace/components library package (#116) ([#116](https://github.com/opentrace/opentrace/pull/116))
- **ui:** Add size indicators to example repos (#123) ([#123](https://github.com/opentrace/opentrace/pull/123))
- **plugin:** Broaden triggers, add catch-all @opentrace agent (#122) ([#122](https://github.com/opentrace/opentrace/pull/122))
- **components:** Extract <Graph> component, theme-aware graph colors (#128) ([#128](https://github.com/opentrace/opentrace/pull/128))
- **agent:** Auto-discover .opentrace/index.db with secure path walking (#125) ([#125](https://github.com/opentrace/opentrace/pull/125))
- **components:** Extract GraphToolbar into shared package (#129) ([#129](https://github.com/opentrace/opentrace/pull/129))
- **plugin:** Add PreToolUse/PostToolUse hook system with augment CLI (#131) ([#131](https://github.com/opentrace/opentrace/pull/131))
- **ui:** Add PR lookup input to load any PR by number or link (#138) ([#138](https://github.com/opentrace/opentrace/pull/138))
- **ui:** Enable source maps in production build (#141) ([#141](https://github.com/opentrace/opentrace/pull/141))
- **ui:** Vibrant colors, animated graph, improved layout (#143) ([#143](https://github.com/opentrace/opentrace/pull/143))
- **ui:** Add zoom-on-select toggle to graph controls (#145) ([#145](https://github.com/opentrace/opentrace/pull/145))
- **ui:** Add flat graph mode toggle (#156) ([#156](https://github.com/opentrace/opentrace/pull/156))
- **benchmarks:** 3-level test fixtures, SWE-bench agent, and benchmark CLI (#139) ([#139](https://github.com/opentrace/opentrace/pull/139))
- **ui:** Theme-aware labels, density culling, hover glow (#157) ([#157](https://github.com/opentrace/opentrace/pull/157))
- **ui:** Add database import/export (#158) ([#158](https://github.com/opentrace/opentrace/pull/158))
- Add /status slash command for session state reporting (#161) ([#161](https://github.com/opentrace/opentrace/pull/161))
- Add /devstatus slash command (#163) ([#163](https://github.com/opentrace/opentrace/pull/163))
- **ui:** Add node dragging with FA2 physics (#159) ([#159](https://github.com/opentrace/opentrace/pull/159))
- **ui:** Add Pixi.js v8 graph renderer (#165) ([#165](https://github.com/opentrace/opentrace/pull/165))
- **components:** Add Storybook with stories for all components (#169) ([#169](https://github.com/opentrace/opentrace/pull/169))
- **ui:** Support ?repo= query parameter for deep linking (#166) ([#166](https://github.com/opentrace/opentrace/pull/166))
- Concurrent pipeline, WASM memory fixes, lazy DB init (#91) ([#91](https://github.com/opentrace/opentrace/pull/91))
- **ui:** Add community focus target button in filter panel (#173) ([#173](https://github.com/opentrace/opentrace/pull/173))
- **ui:** Add collapse all / expand all controls to discover panel (#177) ([#177](https://github.com/opentrace/opentrace/pull/177))
- **pixi:** Add compact radial layout mode with community clustering (#175) ([#175](https://github.com/opentrace/opentrace/pull/175))
- **components:** Collapsible filter panel sections (#179) ([#179](https://github.com/opentrace/opentrace/pull/179))
- **ui:** Export/import graph as Parquet files (#182) ([#182](https://github.com/opentrace/opentrace/pull/182))
- **pixi:** Pseudo-3D rotation mode (#183) ([#183](https://github.com/opentrace/opentrace/pull/183))
- 2D/3D toolbar toggle, label scale slider, remove optimize button (#184) ([#184](https://github.com/opentrace/opentrace/pull/184))
- **ui:** Replace chat input with auto-resizing textarea (#192) ([#192](https://github.com/opentrace/opentrace/pull/192))
- **ui:** Add autocomplete to toolbar search (#187) ([#187](https://github.com/opentrace/opentrace/pull/187))
- **pixi:** Incremental graph updates for streaming node additions (#189) ([#189](https://github.com/opentrace/opentrace/pull/189))
- **ui:** Add persistent chat conversation history (#170) ([#170](https://github.com/opentrace/opentrace/pull/170))
- **ui:** Highlight graph nodes found by chat tool results (#200) ([#200](https://github.com/opentrace/opentrace/pull/200))
- **plugin:** Add /interrogate command for read-only codebase Q&A (#203) ([#203](https://github.com/opentrace/opentrace/pull/203))
- **ui:** Add OpenTraceApp component for embedding the full app (#211) ([#211](https://github.com/opentrace/opentrace/pull/211))
- **ui:** Export NodeDetailsPanel and EdgeDetailsPanel from barrel (#215) ([#215](https://github.com/opentrace/opentrace/pull/215))
- **ui:** Make StoreProvider accept a required store prop (#218) ([#218](https://github.com/opentrace/opentrace/pull/218))
- **ui:** Add optional toolbarActions prop to GraphViewer (#220) ([#220](https://github.com/opentrace/opentrace/pull/220))
- **ui:** Decouple DiscoverPanel data source with DiscoverDataProvider (#219) ([#219](https://github.com/opentrace/opentrace/pull/219))
- **ui:** Add --contrast theme token and use it for GitHub star button (#221) ([#221](https://github.com/opentrace/opentrace/pull/221))
- **ui:** Redesign chat sub-agents and add settingsFooter prop (#223) ([#223](https://github.com/opentrace/opentrace/pull/223))
- **proto:** Add code graph schema with protoc-gen-ladybug (#231) ([#231](https://github.com/opentrace/opentrace/pull/231))
- **ui:** Add image paste, upload & drag-drop to chat (#206) ([#206](https://github.com/opentrace/opentrace/pull/206))
- **ui:** Replace chat history popup with full panel (#205) ([#205](https://github.com/opentrace/opentrace/pull/205))
- **ui:** Search overhaul — content indexing, agent efficiency, fuzzy search (#225) ([#225](https://github.com/opentrace/opentrace/pull/225))
- **proto:** Add code graph schema with protoc-gen-ladybug (#232) ([#232](https://github.com/opentrace/opentrace/pull/232))
- **ui:** Persist chat graph highlights with conversation history (#235) ([#235](https://github.com/opentrace/opentrace/pull/235))
- **ui:** Generalize image upload to support file attachments (#238) ([#238](https://github.com/opentrace/opentrace/pull/238))
- **cli:** Add export/import commands for .parquet.zip archives (#239) ([#239](https://github.com/opentrace/opentrace/pull/239))
- **ui,agent:** Add server mode to connect UI to opentrace serve (#237) ([#237](https://github.com/opentrace/opentrace/pull/237))
- **ui:** Add help menu button and Getting Started drawer (#241) ([#241](https://github.com/opentrace/opentrace/pull/241))
- **ui:** Add session History tab to side panel (#242) ([#242](https://github.com/opentrace/opentrace/pull/242))
- **ui:** Make graph edges selectable (#256) ([#256](https://github.com/opentrace/opentrace/pull/256))
- **agent:** Add `config` CLI command for project settings (#257) ([#257](https://github.com/opentrace/opentrace/pull/257))
- **ui:** Add edges section to node details panel (#259) ([#259](https://github.com/opentrace/opentrace/pull/259))
- **agent,ui:** Variable nodes, data-flow tracking, fix DEFINES direction (#260) ([#260](https://github.com/opentrace/opentrace/pull/260))
- **cli:** Add OAuth login/logout/whoami commands (#261) ([#261](https://github.com/opentrace/opentrace/pull/261))
- **ui:** Rearrange chat input layout with full-width textarea (#236) ([#236](https://github.com/opentrace/opentrace/pull/236))
- **ui:** Display token usage in chat (#265) ([#265](https://github.com/opentrace/opentrace/pull/265))
- **agent:** Add `query` CLI command for arbitrary Cypher and FTS queries (#264) ([#264](https://github.com/opentrace/opentrace/pull/264))
- **plugin:** Add PostToolUse edit hook for impact analysis (#216) ([#216](https://github.com/opentrace/opentrace/pull/216))
- **plugin:** Add /index command to run OpenTrace indexer (#272) ([#272](https://github.com/opentrace/opentrace/pull/272))
- **plugin:** Use hookSpecificOutput in session-start hook (#274) ([#274](https://github.com/opentrace/opentrace/pull/274))
- Show dev server port and PR number in statusline (#275) ([#275](https://github.com/opentrace/opentrace/pull/275))
- **agent:** Derivation scoping fix, variable patterns, fixtures (#273) ([#273](https://github.com/opentrace/opentrace/pull/273))
- Add konductor envrc.sh for terminal environment setup (#285) ([#285](https://github.com/opentrace/opentrace/pull/285))
- Add IndexMetadata to track index provenance per repo (#284) ([#284](https://github.com/opentrace/opentrace/pull/284))
- **pipeline:** Overload-safe function IDs with Java-style type signatures (#286) ([#286](https://github.com/opentrace/opentrace/pull/286))
- Add post-build and post-deploy validation testing (#283) ([#283](https://github.com/opentrace/opentrace/pull/283))
- **plugin:** Auto-index on session start when no index exists (#301) ([#301](https://github.com/opentrace/opentrace/pull/301))
- **plugin:** Add /update command and session-start version check (#303) ([#303](https://github.com/opentrace/opentrace/pull/303))

### Miscellaneous

- **build:** Set branch on deploy trigger
- **build:** Set branch on deploy trigger
- Add Claude Code statusline script (#25) ([#25](https://github.com/opentrace/opentrace/pull/25))
- Remove .idea directory from version control (#66) ([#66](https://github.com/opentrace/opentrace/pull/66))
- **ui:** Add vite port to .env (#70) ([#70](https://github.com/opentrace/opentrace/pull/70))
- Add sparkles icon to AI Assistant header (#113) ([#113](https://github.com/opentrace/opentrace/pull/113))
- Remove API references, add components make targets (#120) ([#120](https://github.com/opentrace/opentrace/pull/120))
- Show branch and worktree name in statusline (#124) ([#124](https://github.com/opentrace/opentrace/pull/124))
- **ci:** Unify preview label names to `preview-*` prefix (#193) ([#193](https://github.com/opentrace/opentrace/pull/193))
- Add /reset command for hard reset to origin/main (#194) ([#194](https://github.com/opentrace/opentrace/pull/194))
- **ci:** Pin GitHub Actions to commit SHAs (#202) ([#202](https://github.com/opentrace/opentrace/pull/202))
- Fix ingores and package lock build (#234) ([#234](https://github.com/opentrace/opentrace/pull/234))
- Remove examples/go-client (#300) ([#300](https://github.com/opentrace/opentrace/pull/300))

### Performance

- **ui:** Optimize graph rendering for large graphs (15k+ nodes) (#30) ([#30](https://github.com/opentrace/opentrace/pull/30))
- Virtualize Discover panel tree with react-window (#48) ([#48](https://github.com/opentrace/opentrace/pull/48))
- **pixi:** Optimize renderer for 20k+ nodes (#171) ([#171](https://github.com/opentrace/opentrace/pull/171))
- **store:** Batch BFS queries, adjacency indexes, node cache, BM25 prefix matching (#204) ([#204](https://github.com/opentrace/opentrace/pull/204))

### Refactoring

- **ui:** Replace kuzu-wasm with @lbug/lbug-wasm (#69) ([#69](https://github.com/opentrace/opentrace/pull/69))
- **agent:** Simplify CLI to local-only KuzuDB indexer (#78) ([#78](https://github.com/opentrace/opentrace/pull/78))
- **ui:** Move FilterPanel, GraphLegend, DiscoverPanel to @opentrace/components (#118) ([#118](https://github.com/opentrace/opentrace/pull/118))
- **components:** Extract GraphBadge into shared library (#121) ([#121](https://github.com/opentrace/opentrace/pull/121))
- **components:** Extract AddRepoModal & IndexingProgress to shared library (#127) ([#127](https://github.com/opentrace/opentrace/pull/127))
- Rename kuzu references to ladybug/generic names (#133) ([#133](https://github.com/opentrace/opentrace/pull/133))
- **components:** Move ingest pipeline to @opentrace/components/pipeline (#136) ([#136](https://github.com/opentrace/opentrace/pull/136))
- **ui:** Move chat display components to @opentrace/components (#160) ([#160](https://github.com/opentrace/opentrace/pull/160))
- **ui:** Switch LadybugDB to in-memory mode with Parquet export/import (#168) ([#168](https://github.com/opentrace/opentrace/pull/168))
- Remove Sigma.js, use Pixi.js as sole graph renderer (#172) ([#172](https://github.com/opentrace/opentrace/pull/172))
- **ui:** Rename components/ to appComponents/ (#186) ([#186](https://github.com/opentrace/opentrace/pull/186))
- Inline @opentrace/components into ui/src/components (#188) ([#188](https://github.com/opentrace/opentrace/pull/188))
- **ui:** Remove dead IndexingManager pipeline (#289) ([#289](https://github.com/opentrace/opentrace/pull/289))
- **ui:** Make help drawer a flex participant instead of overlay (#297) ([#297](https://github.com/opentrace/opentrace/pull/297))

### Testing

- **ui:** Add tests for AddRepoModal Import tab (#164) ([#164](https://github.com/opentrace/opentrace/pull/164))

