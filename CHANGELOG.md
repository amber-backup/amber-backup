# [1.33.0](https://github.com/amber-backup/amber-backup/compare/v1.32.0...v1.33.0) (2026-09-15)


### Features

* **cli:** start integrity checks and manage their schedule ([677ac4f](https://github.com/amber-backup/amber-backup/commit/677ac4f24444a8b4bd63e173fe1815225a9b41bb))
* **jobs:** retry failed backups automatically ([9ddd0cc](https://github.com/amber-backup/amber-backup/commit/9ddd0cc53764b3f83e2420fb35ed4c5a00f5417e))

# [1.32.0](https://github.com/amber-backup/amber-backup/compare/v1.31.0...v1.32.0) (2026-09-15)


### Features

* **swagger:** toggle the API explorer with SWAGGER_ENABLED ([6850d00](https://github.com/amber-backup/amber-backup/commit/6850d00f035849af96a912266bb9c6cc0a7f1741))

# [1.31.0](https://github.com/amber-backup/amber-backup/compare/v1.30.1...v1.31.0) (2026-09-15)


### Features

* **cli:** list, inspect and enroll agents with an admin API key ([51e05ba](https://github.com/amber-backup/amber-backup/commit/51e05ba8be2ace69e6429598d48743d0f78d0f6a))

## [1.30.1](https://github.com/amber-backup/amber-backup/compare/v1.30.0...v1.30.1) (2026-09-14)


### Bug Fixes

* **integrity:** refuse checks for agents too old to run them ([d3c9ac2](https://github.com/amber-backup/amber-backup/commit/d3c9ac23341b8f48b5955b7f6ecc5fde9f266ad8))
* **restic:** browse snapshots while a check or prune locks the repository ([781a572](https://github.com/amber-backup/amber-backup/commit/781a572f4967c082cfd1271138f886a9ccf51150))

# [1.30.0](https://github.com/amber-backup/amber-backup/compare/v1.29.0...v1.30.0) (2026-09-13)


### Features

* **auth:** per-user UI language preference ([018094c](https://github.com/amber-backup/amber-backup/commit/018094c1e486f25a666c2e44c738b3590944dd88))
* **client:** German translation with language switch in settings ([5fa8f4d](https://github.com/amber-backup/amber-backup/commit/5fa8f4dd52e06a90907667b4aa446367881fd5a2))

# [1.29.0](https://github.com/amber-backup/amber-backup/compare/v1.28.0...v1.29.0) (2026-09-13)


### Features

* **client:** show upgrade hint next to the version label ([6299959](https://github.com/amber-backup/amber-backup/commit/6299959e6deaf7604676f55a4e711f742ee2ef17))
* **updates:** periodically check GitHub for a newer release ([1b836e0](https://github.com/amber-backup/amber-backup/commit/1b836e0c3e2c454765dad903f799463fd0658b60))

# [1.28.0](https://github.com/amber-backup/amber-backup/compare/v1.27.0...v1.28.0) (2026-09-13)


### Features

* **auth:** device authorization flow for CLI login ([244b1d8](https://github.com/amber-backup/amber-backup/commit/244b1d87cfe070e939b4e868f513d94cf497140c))
* **cli:** `ambb login` / `ambb logout` via browser device pairing ([1902eb5](https://github.com/amber-backup/amber-backup/commit/1902eb5ed2e23da1df26401781ade5a8164db24b))
* **cli:** add `ambb update` to self-update from GitHub Releases ([e200ffb](https://github.com/amber-backup/amber-backup/commit/e200ffb9917581a57db2bcb915f95a89eccc5dfd))
* **client:** device login page to approve `ambb login` ([0ee196e](https://github.com/amber-backup/amber-backup/commit/0ee196e6b0bc1f004a7dc36116b7b55dc90ec020))

# [1.27.0](https://github.com/amber-backup/amber-backup/compare/v1.26.0...v1.27.0) (2026-09-13)


### Bug Fixes

* **snapshots:** move the back button above the page header ([56847bd](https://github.com/amber-backup/amber-backup/commit/56847bd4951e0cf5728dae181c749a9168182cee))


### Features

* **snapshots:** open jobs by clicking the row, with a chevron hint ([4c9def6](https://github.com/amber-backup/amber-backup/commit/4c9def6a08f8f2a80fd953e3d71a6a3c8ae01b95))

# [1.26.0](https://github.com/amber-backup/amber-backup/compare/v1.25.1...v1.26.0) (2026-09-13)


### Features

* **integrity:** restic integrity checks on the Snapshots page ([149506c](https://github.com/amber-backup/amber-backup/commit/149506c344780c55586e0f33b413cc682203df1d))

## [1.25.1](https://github.com/amber-backup/amber-backup/compare/v1.25.0...v1.25.1) (2026-09-13)


### Bug Fixes

* **agent:** only auto-update over HTTPS ([c6d795b](https://github.com/amber-backup/amber-backup/commit/c6d795b5dbf4d990f34eb7aeb3c726b33373ff80))
* **agents:** bound agent-submitted string fields ([2a1df64](https://github.com/amber-backup/amber-backup/commit/2a1df648fec804200366170e7846659c9c1157f0))
* **agents:** consume one-time enrollment token atomically ([f064dc8](https://github.com/amber-backup/amber-backup/commit/f064dc8230eeab0d98930500d9830e29f7fcd3ff))
* **agents:** keep the enrollment token out of the world-readable unit file ([5dcae18](https://github.com/amber-backup/amber-backup/commit/5dcae189772f530882b1e443243af35c0fa3a5a1))
* **audit:** derive client IP via trust-proxy instead of raw XFF ([88412d8](https://github.com/amber-backup/amber-backup/commit/88412d8442973afed271db60b9acddc128dad9da))
* **audit:** redact secrets by declared fields, not just a name regex ([8122c31](https://github.com/amber-backup/amber-backup/commit/8122c312e52d62a0517831e292bdb994cc818108))
* **auth:** enforce API-key scopes and block privilege minting ([9e01927](https://github.com/amber-backup/amber-backup/commit/9e019270806c961f787548e3f2dfcc72509ef3bb))
* **auth:** make the 2FA challenge single-use and attempt-capped ([324eac3](https://github.com/amber-backup/amber-backup/commit/324eac3e875705143ef26e6ea736d92a59d10ca1))
* **auth:** rate-limit login, 2FA and passkey endpoints ([63a35b8](https://github.com/amber-backup/amber-backup/commit/63a35b88b24b4a636fd697ad5524be7e317435d1))
* **auth:** revoke existing sessions on password change/reset ([44596fb](https://github.com/amber-backup/amber-backup/commit/44596fb2dd11412f4afb4f252b705783be6bc260))
* **auth:** stop returning the session JWT in login response bodies ([6f33af2](https://github.com/amber-backup/amber-backup/commit/6f33af250959e6f081372aff1f262c01cfde835e))
* **cors:** restrict origins instead of reflecting any with credentials ([d6f671f](https://github.com/amber-backup/amber-backup/commit/d6f671f2ad056644a2a3b0a54ee08f6e62310f66))
* **crypto:** bind each secret's ciphertext to its row via GCM AAD ([bad2ab3](https://github.com/amber-backup/amber-backup/commit/bad2ab3a02e74591a8105a75e21af84a864c79d8))
* **deps:** upgrade nodemailer to v10 (drops known advisories) ([5938fe1](https://github.com/amber-backup/amber-backup/commit/5938fe1f37628b1b56bfe550c02000b917fd46b3))
* **docker:** verify restic checksum and require secrets in compose ([a2b9a84](https://github.com/amber-backup/amber-backup/commit/a2b9a84fae934cc1d6a0bafbf1b7bc803f7374af))
* **dto:** validate authorization-critical nested inputs ([3773e30](https://github.com/amber-backup/amber-backup/commit/3773e30fbce1572cb45a5a130b0463d1fb47d637))
* **exec:** strip server secrets from child-process environments ([add5fb8](https://github.com/amber-backup/amber-backup/commit/add5fb89e4de04a32c94f882433db092136dd427))
* **headers:** add security headers via helmet ([84fb794](https://github.com/amber-backup/amber-backup/commit/84fb794e4f3a5d86c3524ef7a90cde2063b09f31))
* **jobs:** gate host-filesystem access behind admin ([54633ab](https://github.com/amber-backup/amber-backup/commit/54633ab5c20b6825d39236a07d872dfbee23804a))
* **notifications:** prevent message-injection in Slack and Discord ([705206d](https://github.com/amber-backup/amber-backup/commit/705206de5bd35b5058a568d5986982ba7167b9e7))
* **passkeys:** keep passkeys local-only and drop them on SSO switch ([48d19c1](https://github.com/amber-backup/amber-backup/commit/48d19c16032b7f39239b01a36c777c1ea5fba78c))
* **repositories:** require manage to reveal decrypted credentials ([eaea595](https://github.com/amber-backup/amber-backup/commit/eaea59516472f5f526e007a34425a21948045d5a))
* **restic:** enforce the per-job backup time limit ([2a572f1](https://github.com/amber-backup/amber-backup/commit/2a572f199063203c5a8610e8429735a1326cc6ed))
* **restic:** scrub embedded credentials from restic output ([42556f5](https://github.com/amber-backup/amber-backup/commit/42556f552781d5a9003133cb9f833c2cbddb52b5))
* **restic:** terminate option parsing with -- before user positionals ([2a95d7e](https://github.com/amber-backup/amber-backup/commit/2a95d7e7622cf3a7e6c2ef442ce5faae6b78d61e))
* **restore:** require admin to restore onto a host filesystem ([b18af09](https://github.com/amber-backup/amber-backup/commit/b18af090884f842ab119f2f04867daca855eda96))
* **sftp:** reject ssh-option injection in host/user/port ([3955833](https://github.com/amber-backup/amber-backup/commit/395583342c685dca217ffc4988beb8cd6e9be308))
* **sso:** require a verified email before linking or provisioning ([51fa077](https://github.com/amber-backup/amber-backup/commit/51fa0774f26fb2fdcb5f422df81c972236f14a2c))
* **ssrf:** block loopback/link-local/metadata for outbound connections ([60fe17d](https://github.com/amber-backup/amber-backup/commit/60fe17d376c3abbf8ddf7b2cc30929d6a4b9d166))
* **swagger:** do not expose the API explorer in production ([e555c88](https://github.com/amber-backup/amber-backup/commit/e555c88f86fa336764ebe0c05462767f10fa2956))
* **users:** prevent locking out the last administrator ([1306faf](https://github.com/amber-backup/amber-backup/commit/1306fafdc0511928ba5830f12010d559ab2d4083))

# [1.25.0](https://github.com/amber-backup/amber-backup/compare/v1.24.3...v1.25.0) (2026-09-13)


### Features

* **jobs:** show agent, target and repository in the job list ([d3e1bba](https://github.com/amber-backup/amber-backup/commit/d3e1bbaf3803109a77a0bd3aaf4823ea2f087eef))

## [1.24.3](https://github.com/amber-backup/amber-backup/compare/v1.24.2...v1.24.3) (2026-09-13)


### Bug Fixes

* **modal:** keep dialogs open on backdrop clicks ([577d818](https://github.com/amber-backup/amber-backup/commit/577d818b62d5378e2d8debcbdbe424c575004fb5))

## [1.24.2](https://github.com/amber-backup/amber-backup/compare/v1.24.1...v1.24.2) (2026-09-12)


### Bug Fixes

* **dashboard:** align the progress figures with the bar, not the x ([684d3c7](https://github.com/amber-backup/amber-backup/commit/684d3c7a8a5a9f08d71f2fe57dc3902c1a3d134b))

## [1.24.1](https://github.com/amber-backup/amber-backup/compare/v1.24.0...v1.24.1) (2026-09-12)


### Bug Fixes

* **agents:** show newly enrolled agents without a reload ([d758d12](https://github.com/amber-backup/amber-backup/commit/d758d12115af74acef6ff31d7ff36d84b7baf278))
* **dashboard:** make the cancel icon a small inline control ([13d9272](https://github.com/amber-backup/amber-backup/commit/13d9272501fde89d658631a71baeb97e42d2425f))
* **dashboard:** refresh an activity's status right after cancelling it ([f2e0f53](https://github.com/amber-backup/amber-backup/commit/f2e0f5344ba7887e67ad9e0ddf8b0d90234c96f8))

# [1.24.0](https://github.com/amber-backup/amber-backup/compare/v1.23.0...v1.24.0) (2026-09-12)


### Features

* **dashboard:** show average daily growth in the storage summary ([54e910f](https://github.com/amber-backup/amber-backup/commit/54e910f10c4fde42ea10e292b77299fe7058ce6f))
* **runs:** cancel activities from the recent activity list ([57a3ee2](https://github.com/amber-backup/amber-backup/commit/57a3ee2290bac760fd1344b60beafbc4777990e9))

# [1.23.0](https://github.com/amber-backup/amber-backup/compare/v1.22.0...v1.23.0) (2026-09-10)


### Bug Fixes

* **client:** make the mobile layout fit the viewport ([b7750a3](https://github.com/amber-backup/amber-backup/commit/b7750a3c25e214ec43cb3bed9b2d1d2f7ed11d8f))


### Features

* **auth:** convert accounts to SSO and switch local login off ([690c05b](https://github.com/amber-backup/amber-backup/commit/690c05b1078c5525f390f51bb4a76c0531732b65))
* **dashboard:** filter prunes out of the activity list ([a90d719](https://github.com/amber-backup/amber-backup/commit/a90d719f3c1b666280f9c0a42bc6b19654a6725a))

# [1.22.0](https://github.com/amber-backup/amber-backup/compare/v1.21.1...v1.22.0) (2026-09-09)


### Bug Fixes

* **dashboard:** show the storage chart and align activity columns ([ddd04c3](https://github.com/amber-backup/amber-backup/commit/ddd04c3322c15166db99e84d637a905b583ba2b0))


### Features

* **dashboard:** give the storage chart and activities equal height ([1666560](https://github.com/amber-backup/amber-backup/commit/1666560d23774743acecd74212987f1a9482e963))

## [1.21.1](https://github.com/amber-backup/amber-backup/compare/v1.21.0...v1.21.1) (2026-09-09)


### Bug Fixes

* **dashboard:** keep the storage chart at a fixed height ([695a10e](https://github.com/amber-backup/amber-backup/commit/695a10e64b33077df7b35afda9df95c1773cc3ee))

# [1.21.0](https://github.com/amber-backup/amber-backup/compare/v1.20.0...v1.21.0) (2026-09-09)


### Features

* **dashboard:** compact upcoming schedules ([c3820aa](https://github.com/amber-backup/amber-backup/commit/c3820aa33d08114a9841f52f19a56e3d46e87788))
* **dashboard:** move storage chart above recent activities ([f77897e](https://github.com/amber-backup/amber-backup/commit/f77897e0157b01f5ee57cfb5e7ab5b82a429ac03))
* **dashboard:** show how long each run took ([d4d1b1d](https://github.com/amber-backup/amber-backup/commit/d4d1b1d9452d40d315d1fe9f1710fcd663c3c619))
* **restore:** compact job and snapshot lists, show repository size ([05d6482](https://github.com/amber-backup/amber-backup/commit/05d648202430fabd46128f32cecdcf3832b5bae2))
* **runs:** fail backups that wait in the queue for too long ([2499718](https://github.com/amber-backup/amber-backup/commit/24997187155cbfd7536ddbb6fc4036ceaed5ca02))
* **runs:** record prune as its own activity ([5ecc180](https://github.com/amber-backup/amber-backup/commit/5ecc180319b7de3ed588a75b625cbca05bd73a30))

# [1.20.0](https://github.com/amber-backup/amber-backup/compare/v1.19.0...v1.20.0) (2026-09-09)


### Features

* **repositories:** show repository size and storage growth ([924f430](https://github.com/amber-backup/amber-backup/commit/924f4302cb34cbeb4e47d6c8867610adece1fc2e))

# [1.19.0](https://github.com/amber-backup/amber-backup/compare/v1.18.0...v1.19.0) (2026-09-04)


### Features

* **notifications:** render Teams reports as an Adaptive Card ([f69e13f](https://github.com/amber-backup/amber-backup/commit/f69e13f6e45eae786001eee59bf8f13d23e51af8))

# [1.18.0](https://github.com/amber-backup/amber-backup/compare/v1.17.0...v1.18.0) (2026-09-03)


### Features

* **jobs:** allow overriding target credentials per job ([bf55297](https://github.com/amber-backup/amber-backup/commit/bf55297cb1dce1dedf2d5ead500c890dd94a8b88))
* **restore:** support slug resolution for job snapshots ([bfec3de](https://github.com/amber-backup/amber-backup/commit/bfec3debf74cfbaddda54f72b20b758a3ae1d7b9))

# [1.17.0](https://github.com/amber-backup/amber-backup/compare/v1.16.0...v1.17.0) (2026-07-18)


### Bug Fixes

* **restore:** center icons properly with flex styling ([9008200](https://github.com/amber-backup/amber-backup/commit/90082008a0a13f623797182dac92eacd9d4ee98b))


### Features

* **restore:** improve job selection and navigation ([448e674](https://github.com/amber-backup/amber-backup/commit/448e674137eb80d3ab0c9ff941d0a7fc24cf22c2))

# [1.16.0](https://github.com/amber-backup/amber-backup/compare/v1.15.1...v1.16.0) (2026-07-18)


### Features

* **slugs:** add support for name-derived unique slugs ([b99b75a](https://github.com/amber-backup/amber-backup/commit/b99b75adafdb9cfacb831dc4a7a46e4f47932c90))
* **targets:** add target health checks and UI integration ([52c6ca2](https://github.com/amber-backup/amber-backup/commit/52c6ca2d810043ee9dc656209d4ad6cf07d6cfe3))

## [1.15.1](https://github.com/amber-backup/amber-backup/compare/v1.15.0...v1.15.1) (2026-07-16)


### Bug Fixes

* **client:** break list rows into two lines on mobile ([c5cf8cc](https://github.com/amber-backup/amber-backup/commit/c5cf8ccf89aa8848c6ab61f30c28653a8cb4189f))

# [1.15.0](https://github.com/amber-backup/amber-backup/compare/v1.14.0...v1.15.0) (2026-07-15)


### Features

* **cli:** refactor environment handling for Restic commands ([55b54ed](https://github.com/amber-backup/amber-backup/commit/55b54ed6ae44f218339581225617bb55c5c17e48))
* **targets:** add support for REST backend repository paths ([d713f05](https://github.com/amber-backup/amber-backup/commit/d713f05069fddeb7e8efa381e7497e3a060c9e5e))

# [1.14.0](https://github.com/amber-backup/amber-backup/compare/v1.13.4...v1.14.0) (2026-07-14)


### Features

* **repo use:** add CLI support for local restic execution ([a6f3e7f](https://github.com/amber-backup/amber-backup/commit/a6f3e7f33f69a61d45844387f4d49eae9f6bf2cb))
* **repository:** extract repositories from backup jobs ([81d1227](https://github.com/amber-backup/amber-backup/commit/81d1227ea8c2f10c4dcf910e3c3317ded28290e1))

## [1.13.4](https://github.com/amber-backup/amber-backup/compare/v1.13.3...v1.13.4) (2026-07-13)


### Bug Fixes

* **targets:** remove standalone flag and revise backend handling ([570ecb3](https://github.com/amber-backup/amber-backup/commit/570ecb35edbd8055283437b13421570769a05acf))

## [1.13.3](https://github.com/amber-backup/amber-backup/compare/v1.13.2...v1.13.3) (2026-07-13)


### Bug Fixes

* **jobs:** enforce local repo restrictions for agents ([73cf6e2](https://github.com/amber-backup/amber-backup/commit/73cf6e2873aec98655470885fbd3f9f709a10875))

## [1.13.2](https://github.com/amber-backup/amber-backup/compare/v1.13.1...v1.13.2) (2026-07-13)


### Bug Fixes

* **targets:** update backend filtering logic for connections ([8df27a9](https://github.com/amber-backup/amber-backup/commit/8df27a9a55145242e19adcb7048a37175151454f))
* **ui:** add toast for modal confirm error handling ([3689d94](https://github.com/amber-backup/amber-backup/commit/3689d948189384f26a88123230a32a4a6cbda6ad))

## [1.13.1](https://github.com/amber-backup/amber-backup/compare/v1.13.0...v1.13.1) (2026-07-13)


### Bug Fixes

* **docker:** add openssh-client for SFTP support ([800f24c](https://github.com/amber-backup/amber-backup/commit/800f24ca968126760905461be8294009eee784d3))

# [1.13.0](https://github.com/amber-backup/amber-backup/compare/v1.12.3...v1.13.0) (2026-07-13)


### Features

* **repository:** split targets from repositories in schema ([496ec82](https://github.com/amber-backup/amber-backup/commit/496ec82a521001d8b61b870e3aec9119b2bc2887))
* **sftp:** add SSH key generation and SFTP integration ([74fb010](https://github.com/amber-backup/amber-backup/commit/74fb0101677e71957528e1af6cab98cb1e6d0469))

## [1.12.3](https://github.com/amber-backup/amber-backup/compare/v1.12.2...v1.12.3) (2026-07-12)


### Bug Fixes

* **ui:** improve TOTP input and login button styling ([aa1c1cf](https://github.com/amber-backup/amber-backup/commit/aa1c1cfeec22616e72d53c2356502cd0e2e46d1d))

## [1.12.2](https://github.com/amber-backup/amber-backup/compare/v1.12.1...v1.12.2) (2026-07-12)


### Bug Fixes

* **ui:** adjust login button styling for consistency ([261dcc8](https://github.com/amber-backup/amber-backup/commit/261dcc86767514433c4b1d0ea8ea2c42d2a75572))

## [1.12.1](https://github.com/amber-backup/amber-backup/compare/v1.12.0...v1.12.1) (2026-07-12)


### Bug Fixes

* **ui:** set height for mobile top bar ([a32bf5d](https://github.com/amber-backup/amber-backup/commit/a32bf5d09193e3f818f3e706025273357fb9036a))

# [1.12.0](https://github.com/amber-backup/amber-backup/compare/v1.11.0...v1.12.0) (2026-07-12)


### Bug Fixes

* **ui:** add responsive grid and improve layout ([e860f97](https://github.com/amber-backup/amber-backup/commit/e860f97d2e2d73f1d16a45b14a3cba235a7de231))


### Features

* **auth:** add passkey-based authentication support ([4faa04d](https://github.com/amber-backup/amber-backup/commit/4faa04d310e94b3ec3c7983d36504e39c2b8b4d1))
* **auth:** implement TOTP-based 2FA support ([6cd7a95](https://github.com/amber-backup/amber-backup/commit/6cd7a9501fec669c295be1d0a94a1271d035f89a))

# [1.11.0](https://github.com/amber-backup/amber-backup/compare/v1.10.0...v1.11.0) (2026-07-12)


### Features

* **progress:** fix agent progress update validation ([73ada3c](https://github.com/amber-backup/amber-backup/commit/73ada3c18cd8c4631b0cda4194a9edb512143968))

# [1.10.0](https://github.com/amber-backup/amber-backup/compare/v1.9.0...v1.10.0) (2026-07-12)


### Features

* **logging:** add HTTP request logging middleware ([2b71fb0](https://github.com/amber-backup/amber-backup/commit/2b71fb0939d82ee3f90328cf197a175516bba763))
* **progress:** improve progress percentage calculation ([9a707d9](https://github.com/amber-backup/amber-backup/commit/9a707d96ffebcfac9fdd95845c0080e57cbc2ca5))

# [1.9.0](https://github.com/amber-backup/amber-backup/compare/v1.8.0...v1.9.0) (2026-07-12)


### Features

* **job-scripts:** add pre, success, and failure script support ([80143f7](https://github.com/amber-backup/amber-backup/commit/80143f7337ff04a86fcfa2782056d04d9df6b639))
* **progress:** enhance live backup progress tracking ([c1a8998](https://github.com/amber-backup/amber-backup/commit/c1a8998b97da85bc830a2cd749de94b9002d2e5b))

# [1.8.0](https://github.com/amber-backup/amber-backup/compare/v1.7.0...v1.8.0) (2026-07-12)


### Features

* **pwa:** add PWA support with service worker and manifest ([187f61e](https://github.com/amber-backup/amber-backup/commit/187f61ef30d17f86bbeaef7cb937cfa11b602b12))

# [1.7.0](https://github.com/amber-backup/amber-backup/compare/v1.6.1...v1.7.0) (2026-07-12)


### Bug Fixes

* **ui:** restrict modal close to its own backdrop ([3a38960](https://github.com/amber-backup/amber-backup/commit/3a389603b26f10a3a17cc610c21652a5e0eddb26))


### Features

* **agents:** improve agent liveness tracking and task handling ([7efd672](https://github.com/amber-backup/amber-backup/commit/7efd6724ea4533b385984010d68ba19b3e90d7a7))
* **cli:** implement initial Amber Backup CLI with core features ([519841f](https://github.com/amber-backup/amber-backup/commit/519841f22ef0a45603d243404842a84215cabb21))
* **notifications:** improve message structure for channels ([be6f012](https://github.com/amber-backup/amber-backup/commit/be6f0127589f210b43e6383e6b61be32bfd212f0))
* **reports:** add report management with scheduling ([95c28eb](https://github.com/amber-backup/amber-backup/commit/95c28ebc61b87e9fa3551b38d3594b90913826de))

## [1.6.1](https://github.com/amber-backup/amber-backup/compare/v1.6.0...v1.6.1) (2026-07-11)


### Bug Fixes

* **ui:** enhance SSO redirect URI layout in admin page ([c93685c](https://github.com/amber-backup/amber-backup/commit/c93685c0cbb41117345680ed0814edd61441bcf5))
* **ui:** improve token row layout with flex and alignment ([09bd45c](https://github.com/amber-backup/amber-backup/commit/09bd45c404357a114194ca6a1891c5b03e985556))
* **ui:** resolve dropdown clipping and improve positioning ([cb380ab](https://github.com/amber-backup/amber-backup/commit/cb380ab2b9143fdd272107b15fb43fb10a247cf4))

# [1.6.0](https://github.com/amber-backup/amber-backup/compare/v1.5.1...v1.6.0) (2026-07-11)


### Bug Fixes

* **ui:** add margin-bottom to panels for spacing ([1aceb0f](https://github.com/amber-backup/amber-backup/commit/1aceb0f9cc18d486b03a50cd39d213f6c5cb8ab8))
* **ui:** remove redundant margin-bottom from panels ([3cf0ee7](https://github.com/amber-backup/amber-backup/commit/3cf0ee7d861582bf75c4db423d786842b3bb9daa))


### Features

* **auth:** support multi-provider SSO with expanded types ([deaed13](https://github.com/amber-backup/amber-backup/commit/deaed133253f2f68914e27a1e3047f1caa338b86))
* **ui:** add standalone input and select components ([a253078](https://github.com/amber-backup/amber-backup/commit/a2530788d85b1fbbc367f23ecbf3b84161fe2d62))
* **ui:** implement infinite scroll for recent runs panel ([777a6c7](https://github.com/amber-backup/amber-backup/commit/777a6c7fd5fb94872bbec582e5c98bb5e5ea11bb))

## [1.5.1](https://github.com/amber-backup/amber-backup/compare/v1.5.0...v1.5.1) (2026-07-11)


### Bug Fixes

* **ui:** correct sidebar padding to remove extra bottom gap ([de36963](https://github.com/amber-backup/amber-backup/commit/de36963d015067fbdf1fe73755eed25e04d0f64c))

# [1.5.0](https://github.com/amber-backup/amber-backup/compare/v1.4.0...v1.5.0) (2026-07-11)


### Features

* **admin:** add runtime settings management for agents and SSO ([cc3e685](https://github.com/amber-backup/amber-backup/commit/cc3e685a1f984ddce136146612711a2d2cc6890a))
* **admin:** add system-wide settings page and password change ([fcf360d](https://github.com/amber-backup/amber-backup/commit/fcf360d66110e1ef56e236375b75c0b62c1680a5))
* **audit:** add comprehensive audit logging system ([f9e528a](https://github.com/amber-backup/amber-backup/commit/f9e528a68e8cdb39c78991362ca08d89b47e42d9))
* **audit:** add retention policy and automated purging ([b2d1ead](https://github.com/amber-backup/amber-backup/commit/b2d1eadab89783f8a7368222627dc7d1f32fcb73))
* **ui:** display app version in footer and inject at build ([5ed1e89](https://github.com/amber-backup/amber-backup/commit/5ed1e89195597aaabc1ba4ba6fa82d2e8553a910))

# [1.4.0](https://github.com/amber-backup/amber-backup/compare/v1.3.0...v1.4.0) (2026-07-11)


### Features

* **agent:** validate restic binary before installation ([85ebe76](https://github.com/amber-backup/amber-backup/commit/85ebe760ebaf9e5cb9edcee892208eb8924b32bd))
* **server:** add snapshot deletion and pruning support ([22d5777](https://github.com/amber-backup/amber-backup/commit/22d5777f3380b617ed594700007ab030bc076cec))
* **ui:** add custom-styled checkboxes ([e899f9b](https://github.com/amber-backup/amber-backup/commit/e899f9bf007965efab45e5e02f9928f72d31fc4d))

# [1.3.0](https://github.com/amber-backup/amber-backup/compare/v1.2.0...v1.3.0) (2026-07-11)


### Features

* **agent:** enable self-updating agent capability ([8d78852](https://github.com/amber-backup/amber-backup/commit/8d788523c47ca91f8aa42d0c71aea0a8949c6985))

# [1.2.0](https://github.com/amber-backup/amber-backup/compare/v1.1.0...v1.2.0) (2026-07-11)


### Features

* **server:** implement agent self-registration and global tokens ([6c5435c](https://github.com/amber-backup/amber-backup/commit/6c5435c60f522381759aa732f76fa3ea6c8a0435))
* **ui:** add duplication feature for jobs and targets ([5855765](https://github.com/amber-backup/amber-backup/commit/585576596205c6e8182adc00a9fa5df2f63db84c))

# [1.1.0](https://github.com/amber-backup/amber-backup/compare/v1.0.1...v1.1.0) (2026-07-11)


### Features

* **server:** add binary streaming for agent architectures ([4a226d9](https://github.com/amber-backup/amber-backup/commit/4a226d9cf6086ae12c1c4dcefc5b39cf5fbfe538))
* **ui:** replace inline SVG with external logo file ([a159ef5](https://github.com/amber-backup/amber-backup/commit/a159ef56da6300ba904675497cf61db376f2b8ca))

## [1.0.1](https://github.com/amber-backup/amber-backup/compare/v1.0.0...v1.0.1) (2026-07-11)


### Bug Fixes

* **server:** limit `restic ls` output to immediate children ([22cbd32](https://github.com/amber-backup/amber-backup/commit/22cbd32e91056dc9f32803a1633a6df7e79dcdc2))

# 1.0.0 (2026-07-11)


### Features

* **ci:** add Docker image publishing workflow with buildx ([694540e](https://github.com/amber-backup/amber-backup/commit/694540e1a60398870a834277d74e19e7b9438aa9))
* **notifications:** add ntfy channel support ([3131a40](https://github.com/amber-backup/amber-backup/commit/3131a4001b792170652dfd3582c6db47ffcd5043))
