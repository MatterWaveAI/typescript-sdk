# Changelog

All notable changes to `@matterwave/sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-30

### Added

- `client.notifications`: `list({ unread?, limit? })`, `read(id)` and
  `readAll()`, the caller's own rows behind the bell
  (`GET/POST /api/me/notifications*`).
- `client.announcements.list()`: the operator's announcements inside their
  window, most severe first (`GET /api/announcements`).
- `client.entitlements.get()`: the org's plan, its limits with the
  null-means-unlimited convention applied, and what a downgrade blocks
  (`GET /api/entitlements`).
- `client.conversations.report(id, kind, { message_id?, note? })`: file a
  report on a conversation or one message in it, `kind` being `unsafe` or
  `unhelpful` (`POST /api/conversations/{id}/report`).
- CI on every push and PR (`.github/workflows/ci.yml`): lint, typecheck and
  test. Publishing remains tag-only in `publish-npm.yml`.
