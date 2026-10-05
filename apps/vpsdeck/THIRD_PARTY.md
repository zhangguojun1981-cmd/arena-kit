# Third-party components

- `terminal/src/main/java/com/termux/terminal` and `com/termux/view/TerminalRenderer.java`: from Termux app v0.118.0, https://github.com/termux/termux-app/tree/v0.118.0 . Original authors/copyrights retained. See LICENSE.md (GPL-3.0); terminal subdirectory notices are also preserved when provided. `TerminalCanvas.java` is our SSH adapter, not the upstream Termux terminal session implementation. We do not invoke JNI or spawn a local shell.
- JSch (mwiede) 0.2.21: BSD-3-Clause, https://github.com/mwiede/jsch . SSH/SFTP implementation. Bouncy Castle 1.78.1: MIT-style Bouncy Castle licence, https://www.bouncycastle.org/licence.html .
- AndroidX (Compose, Room, Lifecycle, Activity): Apache-2.0.
- Kotlin and kotlinx.coroutines: Apache-2.0.

VPS Deck source is distributed under GPL-3.0, with the corresponding source accompanying APK delivery. Distribution also requires respecting notices of the listed libraries; their metadata/licences remain in dependency archives.
