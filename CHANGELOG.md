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
