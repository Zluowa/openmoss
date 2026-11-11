# The Moss handbook

How the agents who build and run Moss work. Start with the root `AGENTS.md`; it
sends you here for the detail.

| Page                               | What it holds                                                           |
| ---------------------------------- | ----------------------------------------------------------------------- |
| [constitution.md](constitution.md) | The law: who decides, the five gates, ten laws. It overrides the rest.  |
| [roles.md](roles.md)               | What each role is for, may do, may never do, and hands over             |
| [coordination.md](coordination.md) | The brief, the path of a change, the standard report, who talks to whom |
| [resources.md](resources.md)       | Worktrees, ports, scratch, builds, tokens, and giving them back         |
| [quality.md](quality.md)           | Lanes, red means red, when a change is done, risk, isolation, review    |
| [engineering.md](engineering.md)   | Code conventions that cross areas                                       |
| [skills.md](skills.md)             | How skills are written and kept, which exist, which are planned         |

Some pages describe the target way of working, such as the workspace tool and the
merge queue. Each such section says so in one line and names what to use until it
lands.

Design rules live in `docs/design/`, starting with `docs/design/moss-design-standard.md`
(kept in the private repository; of `docs/`, the public mirror carries only this
folder and `docs/zh-CN-product-glossary.md`).
Conventions for one area live in that area's `README.md`, such as `apps/web/README.md`.
