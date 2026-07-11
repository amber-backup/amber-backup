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
