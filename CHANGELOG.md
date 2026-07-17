# Changelog

## [0.47.1](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.47.0...v0.47.1) (2026-07-17)


### Fixed

* **lenses:** steer an exhibit retire to its room, not a retired index ([#321](https://github.com/danielscholl/keelson-rib-chamber/issues/321)) ([e0d9f55](https://github.com/danielscholl/keelson-rib-chamber/commit/e0d9f5549f54dcc426ba986b93c21818bdc8c2ce))


### Documentation

* realign the lens, surface, and briefing docs with what ships ([#319](https://github.com/danielscholl/keelson-rib-chamber/issues/319)) ([6ac11df](https://github.com/danielscholl/keelson-rib-chamber/commit/6ac11df31731ab3106a3ba9e5cb76c1c42d37655))

## [0.47.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.46.0...v0.47.0) (2026-07-16)


### Added

* **surface:** fold the Chamber panel once the bench is assembled ([#317](https://github.com/danielscholl/keelson-rib-chamber/issues/317)) ([940ee23](https://github.com/danielscholl/keelson-rib-chamber/commit/940ee23d04fff764e7da4d37fe1cac4aad286d23))

## [0.46.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.45.0...v0.46.0) (2026-07-16)


### Added

* **surface:** drop the Chamber surface subtitle for a bare tab ([#315](https://github.com/danielscholl/keelson-rib-chamber/issues/315)) ([544b02d](https://github.com/danielscholl/keelson-rib-chamber/commit/544b02dcd8a95f9cd841e2f2e36bfa6549a86c2a))

## [0.45.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.44.0...v0.45.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* **lens:** index lenses by default, pin them to the surface ([#312](https://github.com/danielscholl/keelson-rib-chamber/issues/312))

### Added

* **lens:** index lenses by default, pin them to the surface ([#312](https://github.com/danielscholl/keelson-rib-chamber/issues/312)) ([7d776de](https://github.com/danielscholl/keelson-rib-chamber/commit/7d776de7228249cf7d640af8bc3c4ac7eeb7daf3))

## [0.44.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.43.0...v0.44.0) (2026-07-15)


### Added

* **lens:** bring the HTML lens to parity with the canvas one ([#307](https://github.com/danielscholl/keelson-rib-chamber/issues/307)) ([3cbc886](https://github.com/danielscholl/keelson-rib-chamber/commit/3cbc88662b60a0258301c71269078211e9c6b8cd))
* **lens:** ground the bundled lens authors in read-only file access ([#308](https://github.com/danielscholl/keelson-rib-chamber/issues/308)) ([e68f9b0](https://github.com/danielscholl/keelson-rib-chamber/commit/e68f9b041dea1a84fd1afb6d77cc91f42d19e105))
* **lens:** make a lens's own refresh workflow reachable ([#306](https://github.com/danielscholl/keelson-rib-chamber/issues/306)) ([66f0f97](https://github.com/danielscholl/keelson-rib-chamber/commit/66f0f97a1cb9e6ca20686956326db0a76ccaa1a7))


### Fixed

* **lens:** hold provenance and freshness across an unchanged refresh ([#304](https://github.com/danielscholl/keelson-rib-chamber/issues/304)) ([409ae35](https://github.com/danielscholl/keelson-rib-chamber/commit/409ae3562f321fbf65e6292881cdd4b830ed8a7e))

## [0.43.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.42.0...v0.43.0) (2026-07-15)


### Added

* **lenses:** teach board composition to the lens and exhibit authors ([#297](https://github.com/danielscholl/keelson-rib-chamber/issues/297)) ([59da241](https://github.com/danielscholl/keelson-rib-chamber/commit/59da2411ff4a8d996a6caadd0809d3f1eedda1db))


### Fixed

* **rooms:** summarize a room from its closing turn, not its formatting ([#295](https://github.com/danielscholl/keelson-rib-chamber/issues/295)) ([66ca144](https://github.com/danielscholl/keelson-rib-chamber/commit/66ca144b8c997f9365737fdd8c1f810471bf09a6))

## [0.42.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.41.0...v0.42.0) (2026-07-15)


### Added

* **rooms:** add HTML summary action for room outcomes ([#291](https://github.com/danielscholl/keelson-rib-chamber/issues/291)) ([2653826](https://github.com/danielscholl/keelson-rib-chamber/commit/2653826d1b084e337c3109e737b636cf0707a3aa))
* **rooms:** give a room card a toned exhibit field ([#288](https://github.com/danielscholl/keelson-rib-chamber/issues/288)) ([9a38ece](https://github.com/danielscholl/keelson-rib-chamber/commit/9a38ece214fa765b29ee2476e2fa7fc49d1cbd36))


### Fixed

* **brief:** drop deleted-room chips from briefing ([#286](https://github.com/danielscholl/keelson-rib-chamber/issues/286)) ([054b0c4](https://github.com/danielscholl/keelson-rib-chamber/commit/054b0c4d635a025c6bf5e525c7e6ca650bb95e69))
* **exhibits:** a cross-room re-table steals an exhibit and overwrites its board ([#287](https://github.com/danielscholl/keelson-rib-chamber/issues/287)) ([82e2398](https://github.com/danielscholl/keelson-rib-chamber/commit/82e239858079d4fc317882a6f8ee7c2f876994f8))
* **room:** retry empty turns and mark no-text output ([#290](https://github.com/danielscholl/keelson-rib-chamber/issues/290)) ([34bc67a](https://github.com/danielscholl/keelson-rib-chamber/commit/34bc67a396b1a3c72d92535cbc3fd2c7ca52cde9))

## [0.41.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.40.2...v0.41.0) (2026-07-14)


### ⚠ BREAKING CHANGES

* **chamber:** the rib:chamber:exhibits snapshot key and the chamber-exhibits workflow are removed. A client bound to either gets nothing.

### Added

* **chamber:** cascade a room delete to its exhibits ([810386e](https://github.com/danielscholl/keelson-rib-chamber/commit/810386e72ffc1ab41b309da4aedaa734b6c28f01))
* **chamber:** retire the Exhibits index ([c267fcd](https://github.com/danielscholl/keelson-rib-chamber/commit/c267fcdf4c8c1841252824a4cb659d69ff48cbf3))
* **rooms:** drop the duplicate exhibit links from closed room cards ([5133291](https://github.com/danielscholl/keelson-rib-chamber/commit/51332916bf918131a1043cde875c5e3c70569930))
* **rooms:** open a live room from its index card ([4f9d487](https://github.com/danielscholl/keelson-rib-chamber/commit/4f9d4879561bd8f5eba225c662c93b387ae7558c))
* **rooms:** retire the per-room surface panels ([9b89a4e](https://github.com/danielscholl/keelson-rib-chamber/commit/9b89a4e13a067c0e9ec98c6b07dd03087deed3ff))
* **room:** table exhibits on the room board ([0781457](https://github.com/danielscholl/keelson-rib-chamber/commit/078145740e57ec9b26fe5ee8838a172e1910806f))


### Fixed

* **chamber:** offer convene while rooms run below the cap ([f4ca2e7](https://github.com/danielscholl/keelson-rib-chamber/commit/f4ca2e779546e149dd30f4a61db45712bb851199))


### Documentation

* **prime:** update invariant to describe bounded concurrent rooms ([#270](https://github.com/danielscholl/keelson-rib-chamber/issues/270)) ([8f3f01c](https://github.com/danielscholl/keelson-rib-chamber/commit/8f3f01c2f51aa5685087c8bb22aa6c5cd48b7474))
* retire the Exhibits shelf and the live room panels ([d99536a](https://github.com/danielscholl/keelson-rib-chamber/commit/d99536aa1e9483eb4c245896b3654b8cc85c5336))

## [0.40.2](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.40.1...v0.40.2) (2026-07-14)


### Documentation

* correct the single-active-room invariant to bounded concurrency ([#268](https://github.com/danielscholl/keelson-rib-chamber/issues/268)) ([9315c5b](https://github.com/danielscholl/keelson-rib-chamber/commit/9315c5b398d8a435a3f87e4fa720bd7cd6da6345))

## [0.40.1](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.40.0...v0.40.1) (2026-07-14)


### Fixed

* **genesis:** settle the boot card its own run started ([#267](https://github.com/danielscholl/keelson-rib-chamber/issues/267)) ([802074a](https://github.com/danielscholl/keelson-rib-chamber/commit/802074a92d19b112521dbca6f9be340d0286bac4))


### Documentation

* **readme:** update compatibility notes ([#265](https://github.com/danielscholl/keelson-rib-chamber/issues/265)) ([c37cb5f](https://github.com/danielscholl/keelson-rib-chamber/commit/c37cb5feed319be4e82640289566fe242d83c2f8))

## [0.40.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.39.0...v0.40.0) (2026-07-14)


### Added

* **chamber:** drop the redundant Clear chip from the bench ([#263](https://github.com/danielscholl/keelson-rib-chamber/issues/263)) ([9248518](https://github.com/danielscholl/keelson-rib-chamber/commit/9248518c3d2701ef805e303921c9c9c942bd81b9))

## [0.39.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.38.0...v0.39.0) (2026-07-14)


### Added

* **chamber:** seat Minds without a convene mode and quiet a fresh bench ([df112ed](https://github.com/danielscholl/keelson-rib-chamber/commit/df112ede090910bb9ba9041e6b1298f2d99afe9c))

## [0.38.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.37.0...v0.38.0) (2026-07-14)


### Added

* **chamber:** click a card to seat a Mind while assembling ([#259](https://github.com/danielscholl/keelson-rib-chamber/issues/259)) ([e7f2929](https://github.com/danielscholl/keelson-rib-chamber/commit/e7f29294754e196e19604000136743a5483fcc59))

## [0.37.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.36.2...v0.37.0) (2026-07-14)


### Added

* **chamber:** fold Convene into the Chamber bench ([#257](https://github.com/danielscholl/keelson-rib-chamber/issues/257)) ([04cd49a](https://github.com/danielscholl/keelson-rib-chamber/commit/04cd49a8472fe863749cb422a84dfd2013747935))

## [0.36.2](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.36.1...v0.36.2) (2026-07-14)


### Fixed

* **boards:** trim empty-state help text and slim Convene shape tabs ([#252](https://github.com/danielscholl/keelson-rib-chamber/issues/252)) ([71273ab](https://github.com/danielscholl/keelson-rib-chamber/commit/71273ab508cd0449f9cd857e00153b7ef1609a26))
* **briefing:** lapse promoted delta when a lens or exhibit is deleted ([#254](https://github.com/danielscholl/keelson-rib-chamber/issues/254)) ([5b2a773](https://github.com/danielscholl/keelson-rib-chamber/commit/5b2a77398222167dc8e9147e58115a03759aa12e))
* **convene:** hide the panel until two Minds are seated ([#255](https://github.com/danielscholl/keelson-rib-chamber/issues/255)) ([0d0f395](https://github.com/danielscholl/keelson-rib-chamber/commit/0d0f395bde63dee62846e21306c232d5a4c42b6e))
* **lenses:** drop starter chips so the empty index is a pure list ([#256](https://github.com/danielscholl/keelson-rib-chamber/issues/256)) ([6213d9f](https://github.com/danielscholl/keelson-rib-chamber/commit/6213d9f4aaeeeb808a29f0a5f592ce2faf13cbf1))

## [0.36.1](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.36.0...v0.36.1) (2026-07-13)


### Fixed

* **index:** move action handlers to src/actions and wire via dispatch ([#250](https://github.com/danielscholl/keelson-rib-chamber/issues/250)) ([a8f81d3](https://github.com/danielscholl/keelson-rib-chamber/commit/a8f81d37b11d321e7f9a3ad2ce7373b8254b4d5a))

## [0.36.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.35.0...v0.36.0) (2026-07-13)


### Added

* **bench:** four-seat bench law with parallel genesis ([#232](https://github.com/danielscholl/keelson-rib-chamber/issues/232)) ([09f3cad](https://github.com/danielscholl/keelson-rib-chamber/commit/09f3cad15ce711c89d4980a51f42d098c0c984f8))

## [0.35.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.34.0...v0.35.0) (2026-07-13)


### Added

* **roster:** starter chips wear the name; role and blurb ride the hover ([#230](https://github.com/danielscholl/keelson-rib-chamber/issues/230)) ([943f75c](https://github.com/danielscholl/keelson-rib-chamber/commit/943f75cf410c3cd6d15040c27e2dc1232af1e085))

## [0.34.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.33.0...v0.34.0) (2026-07-12)


### Added

* **bench:** authored mission stanza and grid bench with ghost open seat ([#228](https://github.com/danielscholl/keelson-rib-chamber/issues/228)) ([47f916a](https://github.com/danielscholl/keelson-rib-chamber/commit/47f916ab239a0390f70bd50e0667c2121ab9f6de))

## [0.33.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.32.0...v0.33.0) (2026-07-12)


### Added

* **boards:** show convene mode subtitles inline ([#226](https://github.com/danielscholl/keelson-rib-chamber/issues/226)) ([e7f8f01](https://github.com/danielscholl/keelson-rib-chamber/commit/e7f8f013f274ca9387f30be2b8600c948bc02483))


### Fixed

* **room:** clamp the header turns chip and label Start chips with shape words ([#225](https://github.com/danielscholl/keelson-rib-chamber/issues/225)) ([2b4ff6e](https://github.com/danielscholl/keelson-rib-chamber/commit/2b4ff6e6e861e6150228e368a9819fa96762ce74))

## [0.32.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.31.0...v0.32.0) (2026-07-12)


### Added

* **chamber:** merge the Roster into the Chamber panel ([#218](https://github.com/danielscholl/keelson-rib-chamber/issues/218)) ([27eea35](https://github.com/danielscholl/keelson-rib-chamber/commit/27eea354069cbc0a16150196aa688d685476f3fd))
* **lenses:** teach empty state with starter lens chips ([#222](https://github.com/danielscholl/keelson-rib-chamber/issues/222)) ([c67680b](https://github.com/danielscholl/keelson-rib-chamber/commit/c67680b11527d8908d676927cd66f29366fa8174))
* **room:** add journey timeline to live room panel ([#223](https://github.com/danielscholl/keelson-rib-chamber/issues/223)) ([046d6a3](https://github.com/danielscholl/keelson-rib-chamber/commit/046d6a3592a908245a2698ae0b602b99e0572a3d))


### Fixed

* **boards:** polish live-review defect batch ([#221](https://github.com/danielscholl/keelson-rib-chamber/issues/221)) ([c835de7](https://github.com/danielscholl/keelson-rib-chamber/commit/c835de7b8762484beeb41346f5a027f0916d94a8))

## [0.31.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.30.0...v0.31.0) (2026-07-12)


### Added

* **grounding:** room brief + pre-synthesis fidelity check ([#212](https://github.com/danielscholl/keelson-rib-chamber/issues/212)) ([c45b37a](https://github.com/danielscholl/keelson-rib-chamber/commit/c45b37a58e3b280f492f5c7307079f45e903bc7b))

## [0.30.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.29.0...v0.30.0) (2026-07-11)


### Added

* **briefing:** promote the Briefing to an always-on banner ([#207](https://github.com/danielscholl/keelson-rib-chamber/issues/207)) ([d18f9e3](https://github.com/danielscholl/keelson-rib-chamber/commit/d18f9e3860b1bc9d03bc28e4f510a8703e19b6d6))

## [0.29.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.28.0...v0.29.0) (2026-07-11)


### Added

* **presence:** lead the Chamber with a presence ribbon ([#205](https://github.com/danielscholl/keelson-rib-chamber/issues/205)) ([5858997](https://github.com/danielscholl/keelson-rib-chamber/commit/58589978742ab9ca38c9e3d57d67f11f2823b863))

## [0.28.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.27.0...v0.28.0) (2026-07-10)


### Added

* **convene:** rename build to delegate and require three minds to run ([#200](https://github.com/danielscholl/keelson-rib-chamber/issues/200)) ([8ebe366](https://github.com/danielscholl/keelson-rib-chamber/commit/8ebe366d2927c8d4a4c9d2cd992b67c2e970d892))

## [0.27.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.26.0...v0.27.0) (2026-07-10)


### Added

* **docs:** contribute the Chamber docs corpus to keelson_docs ([#199](https://github.com/danielscholl/keelson-rib-chamber/issues/199)) ([be59aed](https://github.com/danielscholl/keelson-rib-chamber/commit/be59aed41a8debee7d9a4ffeef6eb5d43d679656))


### Fixed

* **room-start:** resolve projectId by name or id, not id only ([#198](https://github.com/danielscholl/keelson-rib-chamber/issues/198)) ([1153b57](https://github.com/danielscholl/keelson-rib-chamber/commit/1153b579359ae81c258b75cfc01833bae067a572))


### Documentation

* **tutorials:** add "A room that writes code" and wire the rail around it ([#195](https://github.com/danielscholl/keelson-rib-chamber/issues/195)) ([bee6ec8](https://github.com/danielscholl/keelson-rib-chamber/commit/bee6ec88676aae18b8438e9d7b58b3f981a3d1c0))

## [0.26.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.25.0...v0.26.0) (2026-07-09)


### Added

* **convene:** add per-room-type purpose hints on hover ([#193](https://github.com/danielscholl/keelson-rib-chamber/issues/193)) ([f9697a0](https://github.com/danielscholl/keelson-rib-chamber/commit/f9697a0d9d5afb6f80b62ef5ad1f57d1e439939c))

## [0.25.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.24.0...v0.25.0) (2026-07-09)


### Added

* **roster:** switch the model control to the host catalog picker ([#192](https://github.com/danielscholl/keelson-rib-chamber/issues/192)) ([5f25e52](https://github.com/danielscholl/keelson-rib-chamber/commit/5f25e52d78ec6501b89088392d92d6908d8d7444))


### Documentation

* drop em dashes from docs-site prose ([7c2c5f7](https://github.com/danielscholl/keelson-rib-chamber/commit/7c2c5f76d765f3733560749b2d6b5cc930fc0977))
* realign chamber docs with current rib behavior ([25c052b](https://github.com/danielscholl/keelson-rib-chamber/commit/25c052bdb47c95c616c2f0a6f0ec9747bcf353c4))

## [0.24.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.23.0...v0.24.0) (2026-07-09)


### Added

* **roster:** introduce curated model picker via set-model action ([#187](https://github.com/danielscholl/keelson-rib-chamber/issues/187)) ([105134f](https://github.com/danielscholl/keelson-rib-chamber/commit/105134f94878e95d030111836afb794e1f47c8ab))

## [0.23.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.22.0...v0.23.0) (2026-07-09)


### Added

* **exhibits:** split room deliverables onto an Exhibits shelf ([#183](https://github.com/danielscholl/keelson-rib-chamber/issues/183)) ([f2f5d67](https://github.com/danielscholl/keelson-rib-chamber/commit/f2f5d6791ec7e9ad2700dc3def92e7f7027b3b55))
* **lens:** living lenses, panel head verbs, and room exhibit links ([#185](https://github.com/danielscholl/keelson-rib-chamber/issues/185)) ([bec22e1](https://github.com/danielscholl/keelson-rib-chamber/commit/bec22e1cd3e43cf530e9c320efaac85f9a6ac320))

## [0.22.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.21.0...v0.22.0) (2026-07-08)


### Added

* **read:** grant read tier to project-targeted rooms ([#181](https://github.com/danielscholl/keelson-rib-chamber/issues/181)) ([98d1be7](https://github.com/danielscholl/keelson-rib-chamber/commit/98d1be7e98193e3c89eafe90248e8cb9d5c658f4))

## [0.21.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.20.0...v0.21.0) (2026-07-08)


### Added

* **convene:** move convening into its own collapsible region ([#179](https://github.com/danielscholl/keelson-rib-chamber/issues/179)) ([acb6215](https://github.com/danielscholl/keelson-rib-chamber/commit/acb62153ec63c7ad3a8d39cf871f7f06982dab90))

## [0.20.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.19.0...v0.20.0) (2026-07-08)


### Added

* **roster:** emit the header roster peek + collapse hint ([#178](https://github.com/danielscholl/keelson-rib-chamber/issues/178)) ([3c6b79f](https://github.com/danielscholl/keelson-rib-chamber/commit/3c6b79faac42609347e4b5c00b35a843c5f67cea))
* **roster:** replace open-seat grid with launchpad sections ([#176](https://github.com/danielscholl/keelson-rib-chamber/issues/176)) ([485fcba](https://github.com/danielscholl/keelson-rib-chamber/commit/485fcbac1e87b3ffc48c7bd460bd228d92ff05b8))

## [0.19.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.18.0...v0.19.0) (2026-07-08)


### Added

* **roster:** tighten the cold-start Chamber and hide panel chrome ([#174](https://github.com/danielscholl/keelson-rib-chamber/issues/174)) ([7ab2ebb](https://github.com/danielscholl/keelson-rib-chamber/commit/7ab2ebbd5bca3421e16e1ade3580f9c1628ca219))

## [0.18.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.17.0...v0.18.0) (2026-07-07)


### Added

* **capabilities:** add osdu capability slug and external tool pool ([#171](https://github.com/danielscholl/keelson-rib-chamber/issues/171)) ([58cef32](https://github.com/danielscholl/keelson-rib-chamber/commit/58cef32829bc202776f43d441b25e1f6cbd6d12b))

## [0.17.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.16.0...v0.17.0) (2026-07-06)


### Added

* **lens-html:** introduce first-class per-subject HTML lenses ([#169](https://github.com/danielscholl/keelson-rib-chamber/issues/169)) ([f663f29](https://github.com/danielscholl/keelson-rib-chamber/commit/f663f29fec7e6e189d4dd04ee89d1cce45ac4176))

## [0.16.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.15.0...v0.16.0) (2026-07-06)


### Added

* briefing jump chips, identity-toned cast, stacked boot liturgy ([#167](https://github.com/danielscholl/keelson-rib-chamber/issues/167)) ([e5b9e02](https://github.com/danielscholl/keelson-rib-chamber/commit/e5b9e0256017f7d081c0fc429a408cd48c7e8c7e))

## [0.15.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.14.0...v0.15.0) (2026-07-06)


### Added

* room DX — batched start validation, synthesis at budget exhaustion, transcript accessor ([#165](https://github.com/danielscholl/keelson-rib-chamber/issues/165)) ([615ee26](https://github.com/danielscholl/keelson-rib-chamber/commit/615ee26832f4687b920c93faf4d999fcd42bf494))

## [0.14.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.13.0...v0.14.0) (2026-07-06)


### Added

* shape picker as a single-select tabs strip ([#161](https://github.com/danielscholl/keelson-rib-chamber/issues/161)) ([0afc278](https://github.com/danielscholl/keelson-rib-chamber/commit/0afc278f9a45f148de5f9751d6e4921808cedaad))

## [0.13.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.12.0...v0.13.0) (2026-07-06)


### Added

* collapsible roster, aligned transcript speakers, live rooms-index bar ([#159](https://github.com/danielscholl/keelson-rib-chamber/issues/159)) ([620082e](https://github.com/danielscholl/keelson-rib-chamber/commit/620082eb496721ff0af89177ac1d901465a6f44a))
* convene composer as compact wrapping chip rows ([#160](https://github.com/danielscholl/keelson-rib-chamber/issues/160)) ([450b3b2](https://github.com/danielscholl/keelson-rib-chamber/commit/450b3b2afa2c9504c9dea3eb0fdd33c0b760846e))
* recompose the cold start to the design's hero hierarchy ([#156](https://github.com/danielscholl/keelson-rib-chamber/issues/156)) ([9a5816a](https://github.com/danielscholl/keelson-rib-chamber/commit/9a5816acbb86b740b3cfd0763fc580da77fea29f))


### Fixed

* drop the cold start's journey strip — the anchor and nudges carry it ([#158](https://github.com/danielscholl/keelson-rib-chamber/issues/158)) ([c2fd09a](https://github.com/danielscholl/keelson-rib-chamber/commit/c2fd09a47ce84114e3e50b0bbe527a0f9a592d8b))

## [0.12.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.11.0...v0.12.0) (2026-07-06)


### Added

* fold the standing panels into one Briefing and add a genesis boot card ([#155](https://github.com/danielscholl/keelson-rib-chamber/issues/155)) ([fc9f644](https://github.com/danielscholl/keelson-rib-chamber/commit/fc9f64461f8abe74b0015a41a75e53e0df50fe7b))
* seat authoring, identity tones, and room shapes on the home surface ([#153](https://github.com/danielscholl/keelson-rib-chamber/issues/153)) ([c4c165a](https://github.com/danielscholl/keelson-rib-chamber/commit/c4c165aaedfb6e0328e8981a2f2f5ba5a58d9880))

## [0.11.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.10.3...v0.11.0) (2026-07-05)


### Added

* **board:** recompose the room view as a debate + decisions layout ([#151](https://github.com/danielscholl/keelson-rib-chamber/issues/151)) ([980212b](https://github.com/danielscholl/keelson-rib-chamber/commit/980212b87c469e53fcf312752825dff3e94737ea))

## [0.10.3](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.10.2...v0.10.3) (2026-06-30)


### Documentation

* add upstream copyright line to Chamber NOTICE ([#144](https://github.com/danielscholl/keelson-rib-chamber/issues/144)) ([4257d7c](https://github.com/danielscholl/keelson-rib-chamber/commit/4257d7c3b4f71e5ada981c426f42b298da09de7e))

## [0.10.2](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.10.1...v0.10.2) (2026-06-27)


### Fixed

* **digest:** cold-start the digest board once the chamber empties ([#143](https://github.com/danielscholl/keelson-rib-chamber/issues/143)) ([4007dc2](https://github.com/danielscholl/keelson-rib-chamber/commit/4007dc2d213c6a3b3ed54aa2016bd7ea33bfe4f6))


### Documentation

* add what you proved sections to moderated-room and first-room ([#141](https://github.com/danielscholl/keelson-rib-chamber/issues/141)) ([b7acd90](https://github.com/danielscholl/keelson-rib-chamber/commit/b7acd906c49da06b692f50e8f695adf17a8e0458))

## [0.10.1](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.10.0...v0.10.1) (2026-06-26)


### Documentation

* document how minds remember across rooms ([#137](https://github.com/danielscholl/keelson-rib-chamber/issues/137)) ([6b7a1de](https://github.com/danielscholl/keelson-rib-chamber/commit/6b7a1deef456b41ff26ecb0aaf6b065d016e8b05))
* rework the chamber tutorial rail (decouple, self-contain, real artifacts) ([#140](https://github.com/danielscholl/keelson-rib-chamber/issues/140)) ([4ea431a](https://github.com/danielscholl/keelson-rib-chamber/commit/4ea431aa7db82639c5cd25b20ad9361d78b2bee1))

## [0.10.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.9.0...v0.10.0) (2026-06-26)


### Added

* **chamber:** expose the room lifecycle as MCP-reachable tools ([#133](https://github.com/danielscholl/keelson-rib-chamber/issues/133)) ([0e28cd5](https://github.com/danielscholl/keelson-rib-chamber/commit/0e28cd5c2a4b92c159e41111829b99a70558e4b0))
* **chamber:** minds remember across rooms via close-only reflection ([#136](https://github.com/danielscholl/keelson-rib-chamber/issues/136)) ([8a865c8](https://github.com/danielscholl/keelson-rib-chamber/commit/8a865c873ad5783afafe05ef5be9590ec5224c51))
* **chamber:** standing-panel refresh + one-click delete confirms ([#132](https://github.com/danielscholl/keelson-rib-chamber/issues/132)) ([d46879c](https://github.com/danielscholl/keelson-rib-chamber/commit/d46879c7d31048a7ff4082624fbced9097199e46))


### Fixed

* **chamber:** refresh the sessions index when a room starts ([#130](https://github.com/danielscholl/keelson-rib-chamber/issues/130)) ([aef3c22](https://github.com/danielscholl/keelson-rib-chamber/commit/aef3c229f664c12b1e754ee8ab1ba359e13b2665))


### Documentation

* **chamber:** add a magentic tutorial; document the sixth strategy ([#134](https://github.com/danielscholl/keelson-rib-chamber/issues/134)) ([db8f601](https://github.com/danielscholl/keelson-rib-chamber/commit/db8f6011e67b01c9922c3ce09a45a42b1cc4c6ae))
* **magentic:** document magentic strategy and ledger ([#135](https://github.com/danielscholl/keelson-rib-chamber/issues/135)) ([b40da62](https://github.com/danielscholl/keelson-rib-chamber/commit/b40da624195d94461d47cb6b0350cb861e93afec))

## [0.9.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.8.2...v0.9.0) (2026-06-25)


### Added

* **activity:** add chamber-activity standing lens and collector ([#127](https://github.com/danielscholl/keelson-rib-chamber/issues/127)) ([a5bb2a8](https://github.com/danielscholl/keelson-rib-chamber/commit/a5bb2a85e334bc4d13ac61370fab54693c6ef398))
* **coding:** opt-in coding capability tier for room turns ([#125](https://github.com/danielscholl/keelson-rib-chamber/issues/125)) ([94df358](https://github.com/danielscholl/keelson-rib-chamber/commit/94df358337b387afd768eea4f32bb4dd6f6ea18d))
* **digest:** add watermark-gated standing digest lens ([#129](https://github.com/danielscholl/keelson-rib-chamber/issues/129)) ([9042fdc](https://github.com/danielscholl/keelson-rib-chamber/commit/9042fdc27a79beba9e86f88318857a8dc1827284))
* **genesis:** surface authored Mind slug and name in output ([#108](https://github.com/danielscholl/keelson-rib-chamber/issues/108)) ([f366124](https://github.com/danielscholl/keelson-rib-chamber/commit/f366124e4855c39297f7c7b77ae7062f06de89e2))
* **lens:** add html canvas lens ([#123](https://github.com/danielscholl/keelson-rib-chamber/issues/123)) ([ac288e5](https://github.com/danielscholl/keelson-rib-chamber/commit/ac288e5c928445bc24086170aebfcfe6a32c4d10))
* **lens:** append-note write-back action for lenses ([#121](https://github.com/danielscholl/keelson-rib-chamber/issues/121)) ([7aec957](https://github.com/danielscholl/keelson-rib-chamber/commit/7aec957f60d6a07b5d6f072aa79c70c58907fafc))
* **magentic:** add manager-led task-ledger room strategy ([#128](https://github.com/danielscholl/keelson-rib-chamber/issues/128)) ([232c66d](https://github.com/danielscholl/keelson-rib-chamber/commit/232c66dbe45b84d36c02511d2215b5773c58af52))
* **room:** coding review points the reviewer at the repo ([#126](https://github.com/danielscholl/keelson-rib-chamber/issues/126)) ([4c3684a](https://github.com/danielscholl/keelson-rib-chamber/commit/4c3684ae4b1f2cc5e4f87939d101a4fafcd6b8fc))
* **room:** target a room at a keelson project (per-room cwd) ([#122](https://github.com/danielscholl/keelson-rib-chamber/issues/122)) ([670156e](https://github.com/danielscholl/keelson-rib-chamber/commit/670156e347b56b1244e801a52a7ef211188c0a3b))
* set a Mind's model without hand-editing mind.json ([#109](https://github.com/danielscholl/keelson-rib-chamber/issues/109)) ([19d6f81](https://github.com/danielscholl/keelson-rib-chamber/commit/19d6f81380b171acaa1dc5170742cd0500b28c56))


### Fixed

* **brief:** tolerate fenced or prose-wrapped JSON in brief turn reply ([#110](https://github.com/danielscholl/keelson-rib-chamber/issues/110)) ([63ce2aa](https://github.com/danielscholl/keelson-rib-chamber/commit/63ce2aab335ab94fe0ff6256faff8d1466c62b02))


### Documentation

* add lens verdict-board and app-diff to the Cosmos tutorial ([#107](https://github.com/danielscholl/keelson-rib-chamber/issues/107)) ([d743b44](https://github.com/danielscholl/keelson-rib-chamber/commit/d743b447e365e3b8a6dd54100a996b3ff4054c99))
* add value page and a Cosmos contract-review tutorial ([#106](https://github.com/danielscholl/keelson-rib-chamber/issues/106)) ([4f02ebf](https://github.com/danielscholl/keelson-rib-chamber/commit/4f02ebfcba5ac0d0f61285bfa3bd89066aec9edd))
* correctness pass across the tiers and a CI drift guard ([#113](https://github.com/danielscholl/keelson-rib-chamber/issues/113)) ([9b6168d](https://github.com/danielscholl/keelson-rib-chamber/commit/9b6168df981b07565ae5880c446ddd943bfbf644))
* remove the superseded product PRD and repoint references ([#99](https://github.com/danielscholl/keelson-rib-chamber/issues/99)) ([d467605](https://github.com/danielscholl/keelson-rib-chamber/commit/d467605afe5427fd4083df57f5a526539d531726))
* resequence overview and concepts to lead with value ([#111](https://github.com/danielscholl/keelson-rib-chamber/issues/111)) ([0412c85](https://github.com/danielscholl/keelson-rib-chamber/commit/0412c85a513cb089ff72de28e974574ee94192b7))
* sync architecture docs with shipped state ([#101](https://github.com/danielscholl/keelson-rib-chamber/issues/101)) ([fea937f](https://github.com/danielscholl/keelson-rib-chamber/commit/fea937f61ba55e11b41ae230ec2d1a6ed3ec456b))
* tighten boundary claims in the concepts tier ([#112](https://github.com/danielscholl/keelson-rib-chamber/issues/112)) ([ef0bcbe](https://github.com/danielscholl/keelson-rib-chamber/commit/ef0bcbe59ae8972ca675398a02bf26f121048df4))
* tighten user-facing docs to Chamber's capabilities ([#102](https://github.com/danielscholl/keelson-rib-chamber/issues/102)) ([325cf77](https://github.com/danielscholl/keelson-rib-chamber/commit/325cf7710cc204249b9aaf72462d9f42bd242cde))

## [0.8.2](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.8.1...v0.8.2) (2026-06-23)


### Documentation

* build out guides, tutorials, reference, and design tiers ([#97](https://github.com/danielscholl/keelson-rib-chamber/issues/97)) ([d183a45](https://github.com/danielscholl/keelson-rib-chamber/commit/d183a450daad8abf9fff06f1ac6e2fc58fc68f31))

## [0.8.1](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.8.0...v0.8.1) (2026-06-23)


### Fixed

* **chamber:** per-room canvas keys for closed-room Open boards ([#96](https://github.com/danielscholl/keelson-rib-chamber/issues/96)) ([e00a1ec](https://github.com/danielscholl/keelson-rib-chamber/commit/e00a1ec4ce3438489bf7eb50c71aebd27e445131))
* **chamber:** refresh roster pulse + guard brief-gate teardown ([#94](https://github.com/danielscholl/keelson-rib-chamber/issues/94)) ([7cf3a60](https://github.com/danielscholl/keelson-rib-chamber/commit/7cf3a604a23e5a1d1c279ca5457804b3573848de))

## [0.8.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.7.0...v0.8.0) (2026-06-23)


### Added

* **attention:** calm pulse and substance-gated briefing ([#92](https://github.com/danielscholl/keelson-rib-chamber/issues/92)) ([5440903](https://github.com/danielscholl/keelson-rib-chamber/commit/5440903f0867b35796ac058d2c7803e34b80cf76))
* **draft:** implement Convene draft exclusion for roster ([#86](https://github.com/danielscholl/keelson-rib-chamber/issues/86)) ([6086123](https://github.com/danielscholl/keelson-rib-chamber/commit/60861234ca99156f939155c56388b27e62248336))
* **lens:** add persistent lens store and retire lens support ([#87](https://github.com/danielscholl/keelson-rib-chamber/issues/87)) ([8be6025](https://github.com/danielscholl/keelson-rib-chamber/commit/8be602576cdf0e91de35b4e2bd87a576683664b0))
* **lens:** capture index-card provenance (scope, by-Mind, reason) ([#91](https://github.com/danielscholl/keelson-rib-chamber/issues/91)) ([f0585f6](https://github.com/danielscholl/keelson-rib-chamber/commit/f0585f635fac26d6eb9e138c0b32f31b99d6cf47))
* **lenses:** implement chamber-lenses index and collector ([#88](https://github.com/danielscholl/keelson-rib-chamber/issues/88)) ([85621f4](https://github.com/danielscholl/keelson-rib-chamber/commit/85621f498f8e11e9f89707a97bace40a51a8fc50))
* **rooms:** add rooms index board and collector ([#85](https://github.com/danielscholl/keelson-rib-chamber/issues/85)) ([b345de8](https://github.com/danielscholl/keelson-rib-chamber/commit/b345de804765f3051225dedf79c67222ec7bd627))
* **rooms:** implement room-open action and reusable room-view drawer ([#89](https://github.com/danielscholl/keelson-rib-chamber/issues/89)) ([0f6a02e](https://github.com/danielscholl/keelson-rib-chamber/commit/0f6a02e3ea9a01d37c3a220aac791d071c4334a2))
* **rooms:** name convened rooms and index active sessions ([#90](https://github.com/danielscholl/keelson-rib-chamber/issues/90)) ([7f3f164](https://github.com/danielscholl/keelson-rib-chamber/commit/7f3f164861eaf9057ebe9243c88313d00d15771d))
* **roster:** add enhanced roster with mind roles and genesis actions ([#82](https://github.com/danielscholl/keelson-rib-chamber/issues/82)) ([f1c5604](https://github.com/danielscholl/keelson-rib-chamber/commit/f1c5604c8657efda0d0f85557e4793b885104287))
* **roster:** move enter action to per-card actions ([#84](https://github.com/danielscholl/keelson-rib-chamber/issues/84)) ([d2530c4](https://github.com/danielscholl/keelson-rib-chamber/commit/d2530c499f62d5e94295cebe8b5de5446fd7f738))

## [0.7.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.6.0...v0.7.0) (2026-06-22)


### Added

* root Mind/room data at the keelson home ([#72](https://github.com/danielscholl/keelson-rib-chamber/issues/72)) ([8e591ab](https://github.com/danielscholl/keelson-rib-chamber/commit/8e591abfbafedbd31f93aa3401e3decbed2f50b2))

## [0.6.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.5.0...v0.6.0) (2026-06-21)


### Added

* **room:** lift single-active-room constraint for concurrent rooms ([#70](https://github.com/danielscholl/keelson-rib-chamber/issues/70)) ([6fc2203](https://github.com/danielscholl/keelson-rib-chamber/commit/6fc2203c5dd92207cc2e406eb169965c1fac5e86))

## [0.5.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.4.0...v0.5.0) (2026-06-19)


### Added

* add authStatus readiness probe ([#66](https://github.com/danielscholl/keelson-rib-chamber/issues/66)) ([f539633](https://github.com/danielscholl/keelson-rib-chamber/commit/f539633ff5de862dc8d81cce171cd5c1c2149f78))
* **room:** per-slug room snapshot keys + dynamic surface regions ([#68](https://github.com/danielscholl/keelson-rib-chamber/issues/68)) ([ad99e1c](https://github.com/danielscholl/keelson-rib-chamber/commit/ad99e1cfad6d63f75ac65d673a55fa5c39fc2ece))

## [0.4.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.3.0...v0.4.0) (2026-06-16)


### Added

* **lens:** make agent-authored lenses unbounded via dynamic regions ([#61](https://github.com/danielscholl/keelson-rib-chamber/issues/61)) ([8210795](https://github.com/danielscholl/keelson-rib-chamber/commit/82107953987830f1e985645ff69a17ea9116124d))
* **room:** add cross-vendor review strategy ([#63](https://github.com/danielscholl/keelson-rib-chamber/issues/63)) ([5c9edc0](https://github.com/danielscholl/keelson-rib-chamber/commit/5c9edc00c453d6d9b236c3222c7b11f2c7077dd6)), closes [#59](https://github.com/danielscholl/keelson-rib-chamber/issues/59)
* **room:** implement per-mind tool rail scoping via capability slugs ([#64](https://github.com/danielscholl/keelson-rib-chamber/issues/64)) ([ced9493](https://github.com/danielscholl/keelson-rib-chamber/commit/ced9493f784ce72cd5b586ff2c83622d4c31faa9))


### Documentation

* **concepts:** add concepts tier with minds, rooms, and lenses pages ([#65](https://github.com/danielscholl/keelson-rib-chamber/issues/65)) ([27de93c](https://github.com/danielscholl/keelson-rib-chamber/commit/27de93cbae209ddaa334dcc8e4099660feef7b04))

## [0.3.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.2.0...v0.3.0) (2026-06-15)


### Added

* **lens:** implement agent-authored lenses with fixed slot pool ([#56](https://github.com/danielscholl/keelson-rib-chamber/issues/56)) ([8a87e82](https://github.com/danielscholl/keelson-rib-chamber/commit/8a87e8227ab3eae16cf26bc4a6cdf3fcfbe76385))
* **room:** wire the lens tool into room turns via turnTools ([#58](https://github.com/danielscholl/keelson-rib-chamber/issues/58)) ([f2832eb](https://github.com/danielscholl/keelson-rib-chamber/commit/f2832ebed5e563f0f656c0b0636ee208bad24076))

## [0.2.0](https://github.com/danielscholl/keelson-rib-chamber/compare/v0.1.0...v0.2.0) (2026-06-14)


### Added

* adopt keelson's agent + slash-command seams (/mind, /genesis) ([#47](https://github.com/danielscholl/keelson-rib-chamber/issues/47)) ([2a56e22](https://github.com/danielscholl/keelson-rib-chamber/commit/2a56e22a7f3676cae4ddd8671a8b9c830f777d9a))
* **mind:** compose a soul prompt and an enter-mind open-chat action ([#44](https://github.com/danielscholl/keelson-rib-chamber/issues/44)) ([c331241](https://github.com/danielscholl/keelson-rib-chamber/commit/c331241a2049fe2eaa0c97312c36d18f0dbe0b2a))
* **roster:** offer starter mind archetypes on the empty roster ([#46](https://github.com/danielscholl/keelson-rib-chamber/issues/46)) ([fb21594](https://github.com/danielscholl/keelson-rib-chamber/commit/fb215949dcb7efbbc99f4a3f2911da239fb868d3))
