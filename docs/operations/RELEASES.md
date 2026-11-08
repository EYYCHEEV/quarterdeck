# Releases

This page describes how releases are made. The bot-tool release is described in full, because its workflow is in this repository. Server and app releases are described in short.

A bad release is never edited or replaced. The fix is the next version.

## Bot-tool releases

### What a release contains

| File | What it is |
|---|---|
| `quarterdeck_mcp-X.Y.Z-py3-none-any.whl` | The `qd` command line, the `qd-mcp` server and the `qd-file-v1` adapter. The client uses only the Python standard library |
| `quarterdeck-omp-wake-X.Y.Z.tar.gz` | The wake extension for OMP: its source, tests and install guide. Never configuration, cursors, locks or keys |
| `SHA256SUMS` | One line for each file above |

The wheel and the wake extension share one version number. How to install an exact version and check it is in the [bot tools guide](../bot-tools.md#install-an-exact-version).

### Before a release can start

- The commit is on `main`, and its CI run is green. See [CI.md](CI.md).
- `omp-quarterdeck/package.json` holds `"version": "X.Y.Z"`.
- [CHANGELOG.md](../../CHANGELOG.md) has a line that is exactly `## X.Y.Z`. The release notes are the lines under that heading, up to the next `## ` heading.
- These changes arrive through a normal pull request.

### Starting a release

A maintainer starts the `Release` workflow by hand from the Actions tab. It asks for two inputs:

- the version, as `X.Y.Z`;
- the full 40-character SHA of the commit on `main`.

Only a maintainer starts a release, and only a maintainer publishes one. An agent never does either on its own.

### What the workflow does

The `build` job has `contents: read` only. It:

1. checks both inputs, checks out the named commit, and confirms that the commit is on `main`, that the version is in `omp-quarterdeck/package.json`, and that the heading is in `CHANGELOG.md`;
2. builds the wheel and the archive twice, each time in a clean folder made from the commit, and fails if the two builds differ by a single byte;
3. tests the built files, not the source: the wheel unpacks into an empty folder, `qd.py --help` works, and the MCP server answers `initialize` and lists exactly the expected tools; the extension's tests pass from the unpacked archive;
4. rehearses the install switch in a throwaway home with stand-ins and no real key: unpack beside an older stand-in version, move the `current` pointer, run `qd.py --help` through it, move it back, and check that the older one answers;
5. writes `SHA256SUMS` and the release notes, and keeps the files for 7 days for the next job.

The `draft` job has `contents: write` only. It:

1. checks the sums again;
2. creates the annotated tag `vX.Y.Z` on the named commit, tagged as `Quarterdeck Contributors`;
3. creates a draft release with the two files and `SHA256SUMS`;
4. checks that exactly one draft exists for that tag, with exactly those three files.

The workflow stops at a draft. It does not publish. It uses no configured secret.

### Publishing

A maintainer looks at the draft and runs further checks that are kept private. Then the maintainer publishes it once, as an immutable release. After that the maintainer reads the release back:

- the tag points to the expected commit;
- the release has exactly the three files;
- the sha256 of each downloaded file equals its line in `SHA256SUMS`.

An immutable release cannot be changed. If something is wrong, the next version fixes it. Each CHANGELOG entry says when a release changes interfaces.

### Installing

Install an exact version, never "latest", and check each file against `SHA256SUMS` before you install. The steps are in the [bot tools guide](../bot-tools.md#install-an-exact-version).

## Server and app releases

A reviewed commit on `main` is built, staged and released by the maintainers. The full steps are private. How a change is classed and watched is in [LIFECYCLE.md](LIFECYCLE.md).

The bot-tool workflow above is the only release workflow in this repository.
