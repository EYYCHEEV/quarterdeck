# Releases

This page describes how releases are made. The bot-tool release is described in full, because its workflow is in this repository. Server and app releases are described in short.

A bad release is never edited or replaced. The fix is the next version.

## Bot-tool releases

### What a release contains

| File | What it is |
|---|---|
| `quarterdeck_mcp-X.Y.Z-py3-none-any.whl` | The `qd` command line, the `qd-mcp` server and the `qd-file-v1` adapter. The client uses only the Python standard library |
| `quarterdeck-omp-wake-X.Y.Z.tar.gz` | The wake extension for OMP: its source, tests and install guide. Never configuration, cursors, locks or keys |
| `quarterdeck-web-X.Y.Z.tar` | The web app, built with the server and chat options |
| `quarterdeck-server-qd-web-X.Y.Z.tar.gz` | The qd-web server package: exactly the files its package manifest lists, and the manifest |
| `PARTS.json` | The version, the commit, and for each of the four files above: its kind, its file name, its sha256 and the sha256 of every file inside it; for the web app also its build options |
| `SHA256SUMS` | One line for each of the four files above and one for `PARTS.json` |

All four files share one version number. How to install an exact version of the bot tools and check it is in the [bot tools guide](../bot-tools.md#install-an-exact-version).

### Before a release can start

- The commit is on `main`, and its CI run is green. See [CI.md](CI.md).
- `omp-quarterdeck/package.json` holds `"version": "X.Y.Z"`.
- [CHANGELOG.md](../../CHANGELOG.md) has a line that is exactly `## X.Y.Z`. The release notes are the lines under that heading, up to the next `## ` heading.
- These changes arrive through a normal pull request.

### Starting a release

A maintainer, or an agent on the maintainer's standing word, starts the `Release` workflow from the Actions tab or with `gh workflow run release.yml`. It asks for two inputs:

- the version, as `X.Y.Z`;
- the full 40-character SHA of the commit on `main`.

Only a maintainer decides to publish a release; an agent publishes only on the maintainer's word for that release.

### What the workflow does

The workflow has three jobs. The `build-web` job has `contents: read` only. It:

1. checks both inputs, checks out the named commit, and confirms that the commit is on `main`, that the version is in `omp-quarterdeck/package.json`, and that the heading is in `CHANGELOG.md`;
2. installs the web app's dependencies from the lock file and checks their registry signatures;
3. builds the web app twice with the server and chat options, each time in a clean folder made from the commit, and fails if the two builds differ by a single byte;
4. keeps the web bundle for 7 days for the next job.

The `build` job has `contents: read` only. It:

1. makes the same checks of the inputs and the commit;
2. builds the wheel, the archive and the server package twice, each time in a clean folder made from the commit, and fails if the two builds differ by a single byte; the server package must hold exactly the files its manifest lists;
3. tests the built files, not the source: the wheel unpacks into an empty folder, `qd.py --help` works, and the MCP server answers `initialize` and lists exactly the expected tools; the extension's tests pass from the unpacked archive; the server package unpacks into one folder, matches its manifest, loads, and passes the package guard; the unpacked server package serves the unpacked web bundle, each file whole;
4. rehearses the install switch in a throwaway home with stand-ins and no real key: unpack beside an older stand-in version, move the `current` pointer, run `qd.py --help` through it, move it back, and check that the older one answers;
5. writes `PARTS.json`, `SHA256SUMS` and the release notes, and keeps the files for 7 days for the next job.

The `draft` job has `contents: write` only. It:

1. checks the sums and `PARTS.json` again;
2. creates the annotated tag `vX.Y.Z` on the named commit, tagged as `Quarterdeck Contributors`;
3. creates a draft release with the four files, `PARTS.json` and `SHA256SUMS`;
4. checks that exactly one draft exists for that tag, with exactly those six files.

The workflow stops at a draft. It does not publish. It uses no configured secret.

The `build-web` and `build` jobs live in `.github/workflows/release-build.yml`, which `release.yml` calls; CI runs the same file on every pull request and every push to `main`, without the `draft` job and without the check that the commit is already on `main`, so a build or test step that would fail in a release fails in CI first.

### Publishing

A maintainer looks at the draft and runs further checks that are kept private. Then the maintainer publishes it once, as an immutable release, or an agent does on the maintainer's word for that release. After that the release is read back:

- the tag points to the expected commit;
- the release has exactly the six files;
- the sha256 of each downloaded file equals its line in `SHA256SUMS`.

An immutable release cannot be changed. If something is wrong, the next version fixes it. Each CHANGELOG entry says when a release changes interfaces.

### Installing

Install an exact version, never "latest", and check each file against `SHA256SUMS` before you install. The steps are in the [bot tools guide](../bot-tools.md#install-an-exact-version).

## Server and app releases

A reviewed commit on `main` is built, staged and released by the maintainers. The full steps are private. How a change is classed and watched is in [LIFECYCLE.md](LIFECYCLE.md).

The server package in a bot-tool release is built from `main`. It is not deployed while the live server runs changes that are not on `main` yet; those changes reach `main` first.

The bot-tool workflow above is the only release workflow in this repository.
