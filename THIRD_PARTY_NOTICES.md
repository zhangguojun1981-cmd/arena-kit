# Third-party notices / 第三方声明

ArenaKit bundles or ports code from the projects below. Each ported file keeps
its origin and license notice in its header. Details and hand-over notes:
[`vendor/UPSTREAM.md`](vendor/UPSTREAM.md).

| File | Origin | License |
|---|---|---|
| `injected/manager.js` | [JimAchievo/Arena-Manager](https://github.com/JimAchievo/Arena-Manager) v5.2.1 | MIT |
| `injected/plus.js` | [chen-dahan/Arena.ai-Plus](https://github.com/chen-dahan/Arena.ai-Plus) `content.js` — Copyright (C) 2025 Arena.ai Plus | **GNU GPL v3 or later** |
| `injected/unlock.js` | [theraker526/Arena-AI-Model-Unlocker-Extension](https://github.com/theraker526/Arena-AI-Model-Unlocker-Extension) | not declared (README: research use) |
| `injected/eni.js` | [peyton2065/Arena-Ai](https://github.com/peyton2065/Arena-Ai) | not declared |
| `injected/snoop.js`, `injected/probe.js`, `injected/conversation-rename.js`, `src-tauri/src/{trace,usage}.rs`, `src/lib/*` (trace/probe/turn logic) | the author's own Arena Trace projects | own copyright |

## What this means

- **GPL v3 (`plus.js`)** — If a build containing `plus.js` is distributed to
  others, the GPL requires offering that file's corresponding source under the
  same license, and the combined work may be affected. This repository is used
  privately and is not distributed; **before any public release, either
  license-compatibly relicense, or ship `plus.js` as a separate opt-in package,
  or remove it.** This file is a notice, not legal advice.
- **MIT (`manager.js`)** — keep the copyright/permission notice (kept in the
  file's `@license MIT` header and the upstream link above).
- **Undeclared licenses (`unlock.js`, `eni.js`)** — treated as "personal use,
  do not redistribute"; get the authors' permission or rewrite before any
  public release.
- **Android signing key** — `.github/android/debug.keystore` is a committed,
  public throwaway key (password `android`). Anyone can produce an APK that
  installs over yours. Fine for personal use; for distribution, sign with your
  own key stored in GitHub secrets.
