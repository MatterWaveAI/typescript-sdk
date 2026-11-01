# Versioning

`@matterwave/sdk` follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html),
read the way it reads before 1.0:

- **0.x.y**: a minor release (0.5 to 0.6) may change or remove something; a
  patch release (0.5.0 to 0.5.1) only fixes and adds. `~0.5.0` (or `^0.5.0`,
  which npm reads the same way below 1.0) takes fixes without changes.
- A name that is renamed keeps working under its old name, as an alias, for at
  least one minor release, and the CHANGELOG says so under **Deprecated**.
- Every change is in [CHANGELOG.md](CHANGELOG.md), under the release that ships
  it.
- A release that breaks something lists it under **Changed** or **Removed**,
  with what to do instead.

## The API each release speaks

The OpenAI-compatible routes live under `/v1`, which is a namespace, not a
release train: within it the API only adds, never removes or retypes a field,
and announces a retirement twelve months ahead with `Deprecation` and `Sunset`
headers. The app's own routes (`/api/...`) are not versioned yet; each release
is tested against the API's OpenAPI export of its day, the snapshot in
`tests/openapi.json`.

| SDK release | API namespace |
| --- | --- |
| every 0.x release so far | `v1` |

## Deprecation signals

When a response carries `Deprecation` or `Sunset`, the client warns through
its `logger` (the console unless one is given) once per route per process,
naming the route, the date it was deprecated and the date it stops answering.
A logger whose `warn` throws turns that into a failure, to catch a retiring
route in CI before it retires.
