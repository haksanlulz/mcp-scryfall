# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Planned as 2.0.0, because the first change below breaks a program that reads results by position.

### Changed

- **Breaking:** every tool result opens with a fixed label block. `content[0]` says the next block came from Scryfall and is data, never instructions; the data that used to be `content[0]` is now `content[1]`, unchanged.
- A failed call returns a tool error (`isError: true`) the model can read, instead of a protocol error.
- `card_collection` takes at most 1,000 identifiers in one call.
- Every tool's `inputSchema` says `additionalProperties: false`.
- `SCRYFALL_CONTACT` with control characters or over the length limit is refused at startup; `SCRYFALL_MAX_ATTEMPTS` has a ceiling as well as a floor.
- MCP SDK 1.32.2 and patched dependencies.

### Added

- MCP tool annotations on every tool.
- `card_named` and `card_fuzzy` carry every printing inline, oldest first, with `first_printing`, and a `record_scope` sentence saying the result is one printing and whether it is a reprint.
- A test holding the whole `tools/list` in a reviewed snapshot.

### Fixed

- An unknown argument is refused, with the nearest real name suggested, before any request leaves.
- A blank optional argument means absent; `full` is read as a boolean; a one-element `page` array is no longer unwrapped through `String()`.
- Retry and pacing: `Retry-After` is floored at the backoff, the 100 ms pacer advances per request, a body that dies mid-read is retried, and a stalled upstream is bounded.

## [1.1.0] - 2026-08-25

Tagged `v1.1.0`; its notes were not kept in this file.

[Unreleased]: https://github.com/haksanlulz/mcp-scryfall/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/haksanlulz/mcp-scryfall/releases/tag/v1.1.0
