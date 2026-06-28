# Changelog

All notable changes to Portcode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Version sync.** The release version lives in **three** files and they must
> match for every tagged release: `package.json`, `src-tauri/Cargo.toml`, and
> `src-tauri/tauri.conf.json`. See [`docs/RELEASE.md`](docs/RELEASE.md) (added in
> a later phase) for the bump procedure.

## [5.1.0](https://github.com/porthex/portcode/compare/v5.0.0...v5.1.0) (2026-06-28)


### Features

* **agent:** background shell tasks — backend (Phase 2 PR5a) ([de2a119](https://github.com/porthex/portcode/commit/de2a1194e4b962bbfedc645e8ab84a267cc40915))
* **agent:** live agents panel — lifecycle events, per-agent cancel, panel UI (Phase 2 PR2) ([91ac246](https://github.com/porthex/portcode/commit/91ac246f8bdeb9f274ef369efaf64d203179ae9a))
* **agent:** plan mode — read-only run + design steer + approve-to-exit ([0aff19d](https://github.com/porthex/portcode/commit/0aff19dd00a1a2c40d6d7d5af81b21f02e907d79))
* **agent:** run subagents in parallel within a batch (Phase 2 PR3) ([a00d1e0](https://github.com/porthex/portcode/commit/a00d1e04807c1377ed7ffcc9d549b4a3d7850105))
* **agent:** subagent runtime + `task` tool (Phase 2 PR1, sequential) ([5ff2708](https://github.com/porthex/portcode/commit/5ff27087bfc48a06d6ca884ffe47ad31fe2fda7d))
* **android:** Phone Sync mobile remote client — pairing, remote session, security split, keyring, over-internet ([#39](https://github.com/porthex/portcode/issues/39)) ([c02abfd](https://github.com/porthex/portcode/commit/c02abfd52bd9f4f3f80ff0f22e3973499dde2e9f))
* **android:** real QR pairing — generate on desktop, scan on phone ([#41](https://github.com/porthex/portcode/issues/41)) ([714c4d3](https://github.com/porthex/portcode/commit/714c4d3cca82763b17c16a61011f8651697395c1))
* **android:** Tauri mobile scaffold + sync-client primitives + plan ([#34](https://github.com/porthex/portcode/issues/34)) ([8ee15d5](https://github.com/porthex/portcode/commit/8ee15d549bfece8fc03bca505ee63da0268ea9e2))
* build and test on Linux (CI matrix + AppImage/deb) ([#4](https://github.com/porthex/portcode/issues/4)) ([e0bccff](https://github.com/porthex/portcode/commit/e0bccffde0a28f301961abad3af0acfe52851756))
* **chat:** decode streaming assistant replies word-by-word ([#40](https://github.com/porthex/portcode/issues/40)) ([da88876](https://github.com/porthex/portcode/commit/da88876e2f93ebfb71a8f9eb1ed1e2c76740dd0c))
* Claude Pro/Max subscription sign-in (OAuth) as an API-key alternative ([#20](https://github.com/porthex/portcode/issues/20)) ([5e29de3](https://github.com/porthex/portcode/commit/5e29de365ea7336af491310790bf3cc387e8a578))
* **composer:** live tool sub-phase + ⌘K message search ([#92](https://github.com/porthex/portcode/issues/92)) ([2cd541e](https://github.com/porthex/portcode/commit/2cd541e954639fb0fe321cefa9d4b23ee48a74ee))
* **composer:** per-session drafts, live presence, send↔stop crossfade + persisted usage ([2953948](https://github.com/porthex/portcode/commit/29539484262d4dcbafa5dac2c97f441ca0722b79))
* **dx:** project-scoped PII-safe memory + web/iOS dev tooling ([#70](https://github.com/porthex/portcode/issues/70)) ([0d4439c](https://github.com/porthex/portcode/commit/0d4439c0fd57ced184fa65d552733593bdc132eb))
* **dx:** project-scoped, PII-safe persistent memory + web/iOS dev tooling ([0d4439c](https://github.com/porthex/portcode/commit/0d4439c0fd57ced184fa65d552733593bdc132eb))
* **dx:** project-scoped, PII-safe persistent memory + web/iOS dev tooling ([ac876af](https://github.com/porthex/portcode/commit/ac876af89dc68b87ecc1872e1ef4b060064855c7))
* **dx:** self-dev mode Phase 1 — Portcode Dev channel + bacon + live dogfooding ([cf69c2d](https://github.com/porthex/portcode/commit/cf69c2d989c7355c9ea3282334938eb47c528bf4))
* **llm:** add LlmProvider provider seam (Phase 0) - agent core is now provider-agnostic and Claude-first; AnthropicProvider wraps the unchanged stream_turn client, provider_for dispatches on settings.provider, and save_settings persists the provider field ([4034b1f](https://github.com/porthex/portcode/commit/4034b1f176a82d6218b0d7dc849b5100320d180e))
* **mobile:** adopt the RemoteShell mobile design for the phone/web client ([1541314](https://github.com/porthex/portcode/commit/1541314a82a55be9a7e6a166f248b172a793e01b))
* **mobile:** remember the paired desktop across launches ([#46](https://github.com/porthex/portcode/issues/46)) ([ef509d4](https://github.com/porthex/portcode/commit/ef509d4abf5152ceb1b91114575dfc98bf3e8e15))
* **mobile:** session list as a drawer on the phone ([#43](https://github.com/porthex/portcode/issues/43)) ([3ea76e1](https://github.com/porthex/portcode/commit/3ea76e117cb7f36c46bbe76015951be0a7a5352c))
* **mobile:** strip desktop-only chrome from the phone session view ([#44](https://github.com/porthex/portcode/issues/44)) ([6222c96](https://github.com/porthex/portcode/commit/6222c96c43d5afc971dfdce03e5f1c5f43555184))
* **permissions:** permission modes + per-tool/command rules (gate core) ([170d17f](https://github.com/porthex/portcode/commit/170d17f5c6cd346839f61b684fcb06e8c07f8e82))
* **permissions:** pre-apply diff — show the change before it's written ([d5229a7](https://github.com/porthex/portcode/commit/d5229a7bda99b27af5aa5aca3f6b323d03f853c8))
* **phone-sync:** pairing payload carries the desktop iroh node address ([#35](https://github.com/porthex/portcode/issues/35)) ([7fb9754](https://github.com/porthex/portcode/commit/7fb9754745357fe69ab96b0ad55eea2e44c0a680))
* **relay:** Phase 6 — self-hosted iroh-relay deploy artifacts + launch docs ([5ef764b](https://github.com/porthex/portcode/commit/5ef764bad8ccca5776145520a40d27efb56417d4))
* **sync:** desktop sync server — channel split + listener + command handler ([7aa9dc5](https://github.com/porthex/portcode/commit/7aa9dc5d84935f1d44dc7b8775dd380a8a01239d))
* **sync:** detect dropped sessions + one-tap reconnect (cellular resilience) ([#45](https://github.com/porthex/portcode/issues/45)) ([f71f937](https://github.com/porthex/portcode/commit/f71f937f73127c9a4143c3728ae8178a416f2dd5))
* **sync:** Phase 5 desktop — Web Push sender (VAPID, web-push) + RegisterPush protocol ([2c5fb52](https://github.com/porthex/portcode/commit/2c5fb5216356e8b0ebb0a2dbb28591923edacfca))
* **sync:** Phone Sync foundations — event-log spine + Noise crypto + pairing (Phase 0-1) ([db50582](https://github.com/porthex/portcode/commit/db5058254ba44c11e8819a40dc753b13f9756f70))
* **sync:** Phone Sync transport + session protocol + pairing UI (Phase 2) ([dd0d06d](https://github.com/porthex/portcode/commit/dd0d06d5b7bfd95a3a2813bba61e3edeadfefbab))
* **telemetry:** Android-native Sentry crash reporting (Phase 3) ([8e34a53](https://github.com/porthex/portcode/commit/8e34a53c75315931e11833d11b62744e7585b081))
* **telemetry:** desktop minidump capture + symbolication CI (Sentry Phase 2) ([a4457d1](https://github.com/porthex/portcode/commit/a4457d19d74547eaf21cce0e5cd5866a4a0675d8))
* **telemetry:** opt-in, scrubbed crash + performance reporting (Phase 1a, frontend) ([5d6e54f](https://github.com/porthex/portcode/commit/5d6e54fd2e34d7107a52aaa9636c847f1a71a1f4))
* **telemetry:** Rust host crash capture (Sentry Phase 1b) ([34b4f63](https://github.com/porthex/portcode/commit/34b4f6324cc4e8b37663cbfe5d3b1d48213a78ed))
* **ui:** background task panel + persistent session listener (Phase 2 PR5b) ([5c43871](https://github.com/porthex/portcode/commit/5c43871c25f4e4889ea41a52c56297a5ad9ee964))
* **ui:** context menu, fix folder drag-and-drop, IBM Plex + text-crispness ([f05f6e3](https://github.com/porthex/portcode/commit/f05f6e3d8936610beead58ccbaece6c543f9e3a8))
* **ui:** full-width layout + exhaustive UX/a11y/stability hardening (7 audit passes) ([#57](https://github.com/porthex/portcode/issues/57)) ([170e27f](https://github.com/porthex/portcode/commit/170e27fd6cf1d09c6ef2f3b9d6e2fb43bcff2a82))
* **ui:** inline session rename in the reworked sidebar ([52a77c4](https://github.com/porthex/portcode/commit/52a77c48c259bc561efae432ee59fc15116f8811))
* **ui:** inline session rename in the reworked sidebar ([#90](https://github.com/porthex/portcode/issues/90)) ([15baab4](https://github.com/porthex/portcode/commit/15baab48d8b08875f8202874ea4869d165a66ee8))
* **ui:** inline session rename in the sidebar (Phase 3) ([b46d0d3](https://github.com/porthex/portcode/commit/b46d0d3538102151b35b4311fbb977d0431a1a25))
* **ui:** keep Chakra Petch for the PORTCODE wordmark only ([ade4bcd](https://github.com/porthex/portcode/commit/ade4bcd517407617a0fd6fefd497e58b5c64a2a2))
* **ui:** Neon-Noir redesign + typing animation, OAuth-integrated ([#29](https://github.com/porthex/portcode/issues/29)) ([f265d02](https://github.com/porthex/portcode/commit/f265d02b370f4b3362e8ce3d482b98d18f3a785c))
* **ui:** per-session model selection with provider-grouped catalogue ([7404047](https://github.com/porthex/portcode/commit/740404767c60c48bf7a969e3703506f0149e8c6b))
* **ui:** permission mode selector + per-tool/command rule editor ([096a6f6](https://github.com/porthex/portcode/commit/096a6f656412b5d66fb2638035bf59aff8e60d54))
* **ui:** permission-mode indicator + cycle pill + scoped "always allow" ([650dc9a](https://github.com/porthex/portcode/commit/650dc9a5e2ee0b303cbce032c27e3e98ef818703))
* **ui:** right-click context menu, fix folder drag-and-drop, IBM Plex + text-crispness pass ([42f41db](https://github.com/porthex/portcode/commit/42f41db2228f4e973c860e37ea0dc5223aae64f3))
* **ui:** sessions sidebar — sort/group/folders, drag-reorder, git-branch grouping, collapsible rail ([1c9343e](https://github.com/porthex/portcode/commit/1c9343eb81084915088e76912f05f2a525caef4a))
* **ui:** sessions sidebar — sort/group/folders, drag-reorder, git-branch grouping, collapsible rail ([b2e69a8](https://github.com/porthex/portcode/commit/b2e69a80c0376a25cdbab41a1c5d364158eacf07))
* **update:** in-app auto-updater with staging channel + manual check ([a715382](https://github.com/porthex/portcode/commit/a715382921d2a0c2471a6f1776511ba78f49038d))
* **wasm:** Phase 2 — real browser iroh transport + portcode-wasm Session (IOS_WEB_CLIENT_PLAN §5.2/§5.3/§5.4) ([bd88df9](https://github.com/porthex/portcode/commit/bd88df93c1d19303a7873e186d0ba4878a25dec6))
* **web:** iOS PWA hardening — install gate, reconnect-on-resume, durable storage (Phase 4) ([4b32ab4](https://github.com/porthex/portcode/commit/4b32ab435415143d77864adc8160eaac5e85f952))
* **web:** iOS web client plan + browser/PWA client foundation ([#67](https://github.com/porthex/portcode/issues/67)) ([1ddd8d5](https://github.com/porthex/portcode/commit/1ddd8d5af994a7972a9e1afac6c1fbcdb8ae88f6))
* **web:** Phase 5 — Web Push client + App Badge for the iOS web client ([f27f79a](https://github.com/porthex/portcode/commit/f27f79a7bd522a64efef68f74597d9bcbf047fd3))


### Bug Fixes

* address CodeRabbit review on PR [#69](https://github.com/porthex/portcode/issues/69) (transport hardening, web client, spike) ([e3c55b1](https://github.com/porthex/portcode/commit/e3c55b1469b9709717e84a6b65b06bfdaacc105b))
* **agent:** harden the local agent loop against edge cases ([#51](https://github.com/porthex/portcode/issues/51)) ([e375ad6](https://github.com/porthex/portcode/commit/e375ad6f036cac0ecdfbb3301eadcbf9f8f4898c))
* **agent:** harden tool execution — fs_write sandbox, Stop interrupt, run ceiling ([#63](https://github.com/porthex/portcode/issues/63)) ([45aeca3](https://github.com/porthex/portcode/commit/45aeca3bce9770bd49c165cc9f7005cd52bd06e8))
* **agent:** register background task before its waiter can finish (PR5a review fold) ([26a7a15](https://github.com/porthex/portcode/commit/26a7a15205baa799db664b9bcb275117a2c0b526))
* **agent:** resolve Rust compile errors from the integration merges (CI-caught) ([a45fab6](https://github.com/porthex/portcode/commit/a45fab6354f0c3319bd8e21d7ada1d1a600b537b))
* apply CodeRabbit review on PR [#69](https://github.com/porthex/portcode/issues/69) (transport timeout, pinning, relay, web client) ([b652d74](https://github.com/porthex/portcode/commit/b652d74dd961f2d4446d0152be3c7ba323edabd6))
* **build:** pin workspace target-dir to src-tauri/target ([086a642](https://github.com/porthex/portcode/commit/086a642b7e3b33e42fa52e5e23c8434a0698ffa8))
* **consent:** clippy -D warnings — dead_code + doc_lazy_continuation ([0ac6697](https://github.com/porthex/portcode/commit/0ac66972a0c8631d24ae32a85516dfc55f3a0a6a))
* **db:** pass model arg to create_session in tests (clippy E0061) ([202635a](https://github.com/porthex/portcode/commit/202635a1d295cd70afe412218dc1555e85c5efb7))
* **db:** surface message-persist failures instead of swallowing them ([#53](https://github.com/porthex/portcode/issues/53)) ([7b46e3e](https://github.com/porthex/portcode/commit/7b46e3ee3cf4dd27411e9f5e18efd0e101eaf299))
* **deps:** switch reqwest from native-tls to rustls (drops openssl-sys android blocker) ([#37](https://github.com/porthex/portcode/issues/37)) ([bde8bc5](https://github.com/porthex/portcode/commit/bde8bc54c9ec5ef94d937b0e95c209ce6fdbd7c2))
* format files failing prettier format:check (CI unblock) ([#7](https://github.com/porthex/portcode/issues/7)) ([c72afae](https://github.com/porthex/portcode/commit/c72afae997bee14a442b75a443464c70960c83ca))
* harden local agent interaction (stuck turns, message bleed, shell window) ([#49](https://github.com/porthex/portcode/issues/49)) ([bfb1d03](https://github.com/porthex/portcode/commit/bfb1d03d683c5cb81dc624665ce584ff1d541c45))
* **llm:** drop unused LlmProvider import in agent.rs - trait-object dispatch needs no import; fixes clippy -D warnings on the Rust legs ([8c8bde8](https://github.com/porthex/portcode/commit/8c8bde897568a768cde83c16e3ee4537fb38d11c))
* **mobile:** scan QR in windowed mode so the custom overlay works (and the app stops getting stuck) ([#48](https://github.com/porthex/portcode/issues/48)) ([701eeeb](https://github.com/porthex/portcode/commit/701eeeb3269ba8696aca3de1bd9eb977a0ab5c8e))
* **permissions:** scope a cancel's permission denials to its own session ([#54](https://github.com/porthex/portcode/issues/54)) ([3e1dac6](https://github.com/porthex/portcode/commit/3e1dac6a10ef23edbff85e5c1c0de5b699f5d9b5))
* **push:** unbreak the desktop + Android CI for Phase 5 web-push ([a1d31b0](https://github.com/porthex/portcode/commit/a1d31b0a3fc6c4f2250b1cb92abe0a579225d8db))
* **store:** remote-mode guard + race-safe background listener (PR5b review fold) ([33e4e1d](https://github.com/porthex/portcode/commit/33e4e1d6c9f4ab83569dc91664a161e57cceca59))
* **sync:** add model field to SessionRow literal in protocol round-trip test (E0063) ([2f5fd9a](https://github.com/porthex/portcode/commit/2f5fd9a540854df981474c52959216e001451f45))
* **sync:** clear stuck turn state on drop/disconnect (holistic-review BLOCKER) ([#47](https://github.com/porthex/portcode/issues/47)) ([1d587eb](https://github.com/porthex/portcode/commit/1d587eb3bdb6a1d9ac25bc91f5809f43453fc7dc))
* **sync:** correct browser relay policy + stage-labelled handshake diagnostics ([9a2e75f](https://github.com/porthex/portcode/commit/9a2e75fc63ea797313af89023636726718c792d4))
* **sync:** enforce desktop-side device trust before serving remote commands (CRITICAL) ([#62](https://github.com/porthex/portcode/issues/62)) ([ee3d0e3](https://github.com/porthex/portcode/commit/ee3d0e3a8b2d8fd1498c226595234fe5625d2b9f))
* **sync:** harden the remote-client connection lifecycle (4 audited races) ([#42](https://github.com/porthex/portcode/issues/42)) ([90e59ec](https://github.com/porthex/portcode/commit/90e59ec90ca8269713a83fd721d2524808266880))
* **sync:** silence unused-import warnings in portcode-sync re-export shims ([ee1467e](https://github.com/porthex/portcode/commit/ee1467e7233c1f5d1d9c64dbc8ef41c4631a1842))
* **sync:** thread per-session model signatures through the remote-command path ([58f6a57](https://github.com/porthex/portcode/commit/58f6a579a74af16f2288fea4835b40aad804ea21))
* **sync:** web client fetches sessions, starts sessions, propagates SAS reject ([ca17441](https://github.com/porthex/portcode/commit/ca17441e7c2885a6ed0ef98c4800c659386339c1))
* **telemetry:** clippy clean — dead_code allow + doc list continuation ([05ad892](https://github.com/porthex/portcode/commit/05ad892f31067cc536fa2d841f5db737d25f731e))
* **telemetry:** close 3 scrubber holes from the privacy audit ([76f57fe](https://github.com/porthex/portcode/commit/76f57fe1850ebc900808db0df3e01811eacf9aa2))
* **telemetry:** re-export consent::set_consent at crate visibility (E0603) ([bf4cd50](https://github.com/porthex/portcode/commit/bf4cd503c5b3d4e6581c4acb3cbdf12887b1c08d))
* **test:** align tests with per-session-model arity after merging main ([036646e](https://github.com/porthex/portcode/commit/036646ed31de75d6711f1ce5de4e525b58686b4a))
* **ui:** edge cases in the command palette, decode animation, and pairing ([#52](https://github.com/porthex/portcode/issues/52)) ([50d249f](https://github.com/porthex/portcode/commit/50d249f8d4035a5e3d2b30c0bb4f1e8b24c1342f))
* **ui:** harden inline rename — error surface, revert, streaming guard, focus (review fold) ([f82445e](https://github.com/porthex/portcode/commit/f82445e9af363fb77c488b277cd157ea3b292ef4))
* **ui:** keep Chakra Petch for the PORTCODE wordmark ([7e8abcd](https://github.com/porthex/portcode/commit/7e8abcd3c49a93616e35cec37e2166a4397753de))
* **ui:** near-full-width layout + UX stability & smoothness pass ([#56](https://github.com/porthex/portcode/issues/56)) ([9c7e048](https://github.com/porthex/portcode/commit/9c7e04814be7da9d5b4d57e09d0d6781042ec0d2))
* **ui:** user message bubbles wrapped short text onto cramped lines ([#55](https://github.com/porthex/portcode/issues/55)) ([6ca9be3](https://github.com/porthex/portcode/commit/6ca9be3e01a1cf38116a5cd9256a1448ff5c5cf3))
* **update:** address CodeRabbit review on the auto-updater ([84be010](https://github.com/porthex/portcode/commit/84be01046a117676084a9a3e0f7b5c85cfaca6ed))
* **update:** make UpdateInfo pub(crate) so update_check satisfies -D private-interfaces ([0ed6df5](https://github.com/porthex/portcode/commit/0ed6df54e3b43cab9a394f964ad200ccf584b051))
* **web:** address CodeRabbit review on PR [#69](https://github.com/porthex/portcode/issues/69) (11 findings) ([86058ad](https://github.com/porthex/portcode/commit/86058adc6bd137a853f5235ac95dc54f8b9ee6e6))
* **web:** make Tailwind scan src/ for the web build (unstyled UI) ([4f94563](https://github.com/porthex/portcode/commit/4f94563197f8ca7e048c89d8467aaa10017afe82))
* **web:** wire the browser QR scanner into phone pairing ([670fad2](https://github.com/porthex/portcode/commit/670fad24989d05511fc8b1ab7d6db5d958d77b15))


### Documentation

* add frontend coverage display, docs, and main/release coverage job ([#25](https://github.com/porthex/portcode/issues/25)) ([77623f9](https://github.com/porthex/portcode/commit/77623f906475a65684f0f98475bf82d2596766b8))
* add self-dev workspace setup guide (docs/DEV_SETUP.md) ([b6be519](https://github.com/porthex/portcode/commit/b6be519dd2c39bd0bd4cbdaea46e1cfb24e7c7d9))
* clarify test coverage is not a merge gate in CONTRIBUTING ([#23](https://github.com/porthex/portcode/issues/23)) ([8e36360](https://github.com/porthex/portcode/commit/8e363608ce643ff49574049cd4ca31df0f4e57e1))
* **progress:** mark Phase 0 complete (0.2-0.4 CI-green); record Phase 1 permission design ([0cedd9a](https://github.com/porthex/portcode/commit/0cedd9a3ba7a4666078619b1879202a5d7cf8f15))
* **progress:** mark Phase 1 permission modes+rules complete; plan mode next ([95248b1](https://github.com/porthex/portcode/commit/95248b10e48911e8d521d540b90a00dd25b567dd))
* **progress:** Phase 1 (control surface) complete — modes+rules, plan mode, pre-apply diff ([0283df3](https://github.com/porthex/portcode/commit/0283df35478f41654d52d62d290506a49490b2d4))
* **progress:** Phase 2 complete — background tasks (PR5a+PR5b) shipped + reviews folded ([7b027c0](https://github.com/porthex/portcode/commit/7b027c0fb7e0b204fbc57f8930af9aa7181f1271))
* **progress:** Phase 2 core parity shipped (PR1-3); defer PR4 worktree isolation pending product decision ([59d582c](https://github.com/porthex/portcode/commit/59d582ce8f0d452c6682562b71dd9f7b10ebc8bd))
* **progress:** Phase 3 PR1 (inline rename) shipped + reviewed; CI flake fixed ([64c51f7](https://github.com/porthex/portcode/commit/64c51f7f0e82509349514fe17563502be6e86e32))
* **telemetry:** document opt-in crash reporting (Sentry Phase 4) ([bf155c3](https://github.com/porthex/portcode/commit/bf155c363f002a4217391c02cc28c6af35de8ce3))
* update CONTRIBUTING Rust gate to the workspace form ([73ca845](https://github.com/porthex/portcode/commit/73ca8452fef96f572e0ea563370a5ef570261ece))


### Code Refactoring

* **agent:** extract testable result reassembly + gate precheck (PR3 review fold) ([4a3f294](https://github.com/porthex/portcode/commit/4a3f294c9d0dc4f26f39172a540b8b3890c2be07))
* **agent:** make the tool registry and system prompt injectable per run ([f2b2899](https://github.com/porthex/portcode/commit/f2b28999ab46e0801bf6bcc5fafe0b3b3ba860dd))
* **store:** model agent runs as a collection (multi-run foundation) ([f160805](https://github.com/porthex/portcode/commit/f160805ef00206677acbe66949e5dad38a31d5f5))
* **telemetry:** shared cross-target consent flag (Sentry Phase 3 foundation) ([883940c](https://github.com/porthex/portcode/commit/883940ca6285b55d649435a91a7322c5a8eed4a8))


### Build System

* **web:** rebuild committed wasm artifact with the relay + diagnostics fix ([cf07d8f](https://github.com/porthex/portcode/commit/cf07d8fac1f1e4e83aad3e8eb490a1bf9e175166))
* **web:** regenerate portcode-wasm artifact ([bc5b952](https://github.com/porthex/portcode/commit/bc5b952a60e1254cc628e4226bf9193ccef05a2d))
* **web:** regenerate portcode-wasm artifact ([5e16adf](https://github.com/porthex/portcode/commit/5e16adfc693e91922a854e49e1cf87a6d213978c))


### Continuous Integration

* add release-please changelog automation + 3-file version sync ([#9](https://github.com/porthex/portcode/issues/9)) ([#5](https://github.com/porthex/portcode/issues/5)) ([40fb94e](https://github.com/porthex/portcode/commit/40fb94ee742567eef22ee6b71799441f51e32e11))
* **android:** non-blocking Tauri Android cross-compile probe ([#36](https://github.com/porthex/portcode/issues/36)) ([dbcadb0](https://github.com/porthex/portcode/commit/dbcadb0900bcefb5daeaefba80be20390c024a61))
* **android:** upload debug APK artifact + record that the app now cross-compiles ([#38](https://github.com/porthex/portcode/issues/38)) ([5f59332](https://github.com/porthex/portcode/commit/5f593324028339da1f717bd4e6d60cf3e4137b2f))
* fire release build on release:published instead of push:tags ([#19](https://github.com/porthex/portcode/issues/19)) ([4cb90ec](https://github.com/porthex/portcode/commit/4cb90ecbd26be3131c978477731d1edd6a886a24))
* persist-credentials: false on the frontend + rust checkouts (SHA-pinning skipped ([b652d74](https://github.com/porthex/portcode/commit/b652d74dd961f2d4446d0152be3c7ba323edabd6))
* **release:** guard release job to tags/release branch ([aa52a91](https://github.com/porthex/portcode/commit/aa52a91740264636ef5a15c4e0fd4044ee146294))
* **release:** make the Windows release build's supply-chain gate work ([0d89c6b](https://github.com/porthex/portcode/commit/0d89c6b178a9706e89f8533f582341222752863b))
* **staging:** restore staging.yml dropped when staging was rebuilt from main ([bd23dda](https://github.com/porthex/portcode/commit/bd23ddafe4016f42e50cb426036367eccf9f351b))


### Miscellaneous Chores

* adopt release-branch model (releases on `release`, main=dev) + docs ([#17](https://github.com/porthex/portcode/issues/17)) ([aba57a8](https://github.com/porthex/portcode/commit/aba57a8a89b381d2e3c366ff824fd6a9a787664f))
* **ci:** Bump actions/setup-java from 4 to 5 ([26faac1](https://github.com/porthex/portcode/commit/26faac11bf17dc7bfea14c3e856782c93b988404))
* **ci:** Bump actions/upload-artifact from 4 to 7 ([#11](https://github.com/porthex/portcode/issues/11)) ([315c53c](https://github.com/porthex/portcode/commit/315c53c45a70106b7c07ac6b3d1774879c4bd58c))
* **ci:** Bump android-actions/setup-android from 3 to 4 ([19b6890](https://github.com/porthex/portcode/commit/19b6890daf003d0a86188260b97f88e765e14c3f))
* **ci:** Bump googleapis/release-please-action from 4 to 5 ([daf8240](https://github.com/porthex/portcode/commit/daf8240a483bb87ebdde46d5fdf6007d6820d2a7))
* **deps-dev:** Bump @eslint/js from 9.39.4 to 10.0.1 ([#14](https://github.com/porthex/portcode/issues/14)) ([efe98d9](https://github.com/porthex/portcode/commit/efe98d9a10a1619ed12d4a16af839ef9e3275c38))
* **deps-dev:** Bump @tauri-apps/cli in the patch-and-minor group ([#12](https://github.com/porthex/portcode/issues/12)) ([48d86a3](https://github.com/porthex/portcode/commit/48d86a37f96870fc1deaca56a1b7ff9780788e66))
* **deps-dev:** Bump @types/node from 22.19.21 to 26.0.0 ([#13](https://github.com/porthex/portcode/issues/13)) ([0248642](https://github.com/porthex/portcode/commit/0248642a90ea7ffa200bf7f89fc0302ac40b8111))
* **deps-dev:** Bump @types/react-dom from 18.3.7 to 19.2.3 ([#3](https://github.com/porthex/portcode/issues/3)) ([697359f](https://github.com/porthex/portcode/commit/697359f394f2f099fdce15f0f9d11c7ca66766df))
* **deps-dev:** Bump @vitejs/plugin-react from 5.2.0 to 6.0.2 ([#15](https://github.com/porthex/portcode/issues/15)) ([cc0fa3a](https://github.com/porthex/portcode/commit/cc0fa3a289f014758fa2ea666d35c1036f25b474))
* **deps-dev:** Bump eslint from 9.39.4 to 10.5.0 ([#2](https://github.com/porthex/portcode/issues/2)) ([a2f653c](https://github.com/porthex/portcode/commit/a2f653c46c941621dc9c37f0a95e6f455bc2ad10))
* **deps-dev:** Bump vite from 6.4.3 to 8.0.16 ([#1](https://github.com/porthex/portcode/issues/1)) ([a8c02e3](https://github.com/porthex/portcode/commit/a8c02e3f1b8d194a5d8a99494511e52a37b767fd))
* enforce prettier via husky pre-commit + format repo ([#10](https://github.com/porthex/portcode/issues/10)) ([1c136a3](https://github.com/porthex/portcode/commit/1c136a340591d9510520a40e61c0e5ec1a56fc76))
* **format:** exclude .mcp.json.example (JSONC) from prettier baseline ([7d9931b](https://github.com/porthex/portcode/commit/7d9931b12396bdc475e7ecd803d4867cedf4bcca))
* gitignore ruflo/claude-flow agent state ([#22](https://github.com/porthex/portcode/issues/22)) ([1dd4aa9](https://github.com/porthex/portcode/commit/1dd4aa9c79b36089f5a057f065fc8d784c31b249))
* **gitignore:** ignore ruflo memory DB copies synced into .claude/ ([47c2c77](https://github.com/porthex/portcode/commit/47c2c77914dbaf7164dca452e9d3a45fc58b7fa5))
* **release:** consolidate staging + all open PRs → main ([25e428c](https://github.com/porthex/portcode/commit/25e428cf5b1aac1602d9f4b3dccbfdff87b76f15))
* set version baseline to 5.0.0 ([#18](https://github.com/porthex/portcode/issues/18)) ([fa6ab7f](https://github.com/porthex/portcode/commit/fa6ab7f10c6c800738e4bec0d09087c5684e196c))
* **vercel:** pin Vite build/output config so preview deploys deterministically ([5a926ad](https://github.com/porthex/portcode/commit/5a926adc9b222048717f0c9b958c219851ae55e1))

## [Unreleased]

### Added

- Open-source community-health and contributor infrastructure: `LICENSE`
  (Apache-2.0), `NOTICE`, `CLA.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, `SUPPORT.md`, `GOVERNANCE.md`, issue/PR templates, and
  `CODEOWNERS`.
- Repository hygiene and quality tooling: EditorConfig, Git attributes, ESLint
  (flat config) + Prettier, Rust toolchain pin + `rustfmt`/`clippy` config,
  Vitest, and a continuous-integration workflow (`ci.yml`) that runs lint,
  type-check, and tests on Windows.

## [0.1.0] - 2026-06-19

Initial public baseline of Portcode — a fast, native Windows AI coding agent
(part of the Porthex toolset).

### Added

- Streaming agent loop over the Anthropic Messages API (bring-your-own-key).
- Seven workspace-sandboxed tools: `fs_read`, `list`, `glob`, `grep`
  (read-only) and `fs_write`, `fs_edit`, `shell` (mutating, gated).
- Permission gate (`allow` / `ask` / `deny`, with "always allow") enforced in
  the Rust core for all mutating tools.
- Persistent sessions backed by SQLite (WAL) with a history sidebar.
- Lazy, gitignore-aware file explorer; colorized unified diffs for edits;
  syntax-highlighted code blocks.
- Per-chat token and cost meter; command palette (`Ctrl+K`) and keyboard
  shortcuts.
- API keys stored in the Windows Credential Manager (never written to disk in
  plaintext).

[Unreleased]: https://github.com/porthex/portcode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/porthex/portcode/releases/tag/v0.1.0
