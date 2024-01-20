# Changelog

All notable changes to the YoWASP toolchain extension will be documented in this file.

## 0.2.6

- Use release version of Yosys instead of latest build by default.
- Updated the internal interface to the YoWASP runtime.

## 0.2.5

- Added support for running commands that use WebUSB on desktop VS Code.

## 0.2.4

- Updated the internal interface to the YoWASP runtime.

## 0.2.3

- Switched to an automated publishing workflow. All releases starting from this one are published from the continuous integration environment.

## 0.2.2

- Updated the internal interface to the YoWASP runtime.

## 0.2.1

- Files are no longer overwritten if their contents matches exactly. This fixes a problem where read-only files in the workspace would cause any Python commands to fail.

## 0.2.0

- Added Python language support.
- Renamed `yowaspToolchain.baseURL` setting to `yowaspToolchain.bundleBaseURL`.

## 0.1.4

- Added default bundle: `@yowasp/openfpgaloader`.
- The "Run Command..." prompt now remembers the last typed command within the session.

## 0.1.3

- Added support for commands that use WebUSB.
- Added default bundles: `@yowasp/nextpnr-machxo2` and `@yowasp/nextpnr-nexus`.
- Changed the key to close an inactive terminal to Enter, from any key. This makes copying text from a terminal easier.
- Removed restriction of `yowaspToolchain.baseURL` and `yowaspToolchain.bundles` settings to application scope. They may now be overridden in the workspace.
- Added parallelism and pipelining for loading bundles and bundle resources. Builds should now wait for downloads much less.
- The status bar item is now only shown for "Build..." terminal, and clicking on it opens the terminal.

## 0.1.2

- Improved lexing in "Run Command..." prompt to handle quotes and whitespace like a shell.
- Added compatibility with desktop VS Code.
- Only run one build process at a time when using the "Build..." command.

## 0.1.1

- Added extraction of bundle entry point via package.json.
- Fixed a race condition in file input/output.
- Renamed "YoWASP Toolchain: Run Build..." to "YoWASP Toolchain: Build...".

## 0.1.0

- Initial release.