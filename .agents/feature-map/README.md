# Moss Feature Map (Layer 2)

This directory maps code modules to **user-perspective journeys and observable proof criteria**. Before opening or updating a PR, every agent identifies the affected feature map(s) and runs the [`self-verify`](../skills/self-verify/SKILL.md) skill.

## Maps

| File                                                   | Domain                                                                          | Primary Owner(s)                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------- |
| [desktop-chat.md](./desktop-chat.md)                   | Chat, Composer, Steering, Tool Rows, Approvals, Localization                    | `moss-desktop-core`, `moss-qa-eval`   |
| [desktop-canvas-space.md](./desktop-canvas-space.md)   | Canvas Board, Data Space Docs/Slides/Sheets/Dashboards, App Pages, Sharing      | `moss-desktop-core`, `moss-qa-eval`   |
| [desktop-voice-plugins.md](./desktop-voice-plugins.md) | CN & Global Realtime Voice, Voice Dictation, Plugins/Skills, Auto-Update & Exit | `moss-ops-voice`, `moss-desktop-core` |
| [mobile-core.md](./mobile-core.md)                     | Mobile Chat, Voice Dictation, M2 Images, Space Viewers, `/apps`, Asset Sync     | `moss-mobile-owner`, `moss-qa-eval`   |

## Rule

Every feature map file (except this `README.md`) must be claimed in `docs/factory/modules.json` (`boundaries:check` fails on unowned maps).
