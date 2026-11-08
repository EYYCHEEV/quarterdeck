# Engineering rules

These rules keep the code base small, exact and checked. They apply to every part of the repository. [AGENTS.md](../../AGENTS.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md) point here.

## One source for each rule

- Each module has one supported production source. There is no second copy of a policy, and no hidden two-way sync between copies.
- A change reaches this repository by a pull request. Two live copies of one module are never authoritative at the same time.
- Do not copy an upstream project's source tree into this repository to make it look complete.

Each kind of rule has one owner. Everything else calls the owner.

| Rule | Owner |
|---|---|
| Card meanings, revisions, limits and resend behavior | The card policy checker in the server. The web app uses its contract. It does not hold a second implementation of the policy |
| Mailbox state and delivery | The mail server owns stored mail. The mail adapter owns the JMAP interaction and the resend and acknowledgement contract. The app and the bot tools call that adapter |
| App views and requests | The web app uses one data interface. Fixtures implement the same interface |
| Agent wake | The OMP extension takes mail notices through its supported boundary. In tests, every process call ends at a stand-in, never at a real session |

The server parts of this table arrive in a later change.

### Contracts

- Keep wire versions and retry keys as they are when files move.
- When a contract changes, check the producer, the API route, the serializer, the adapter, the stored mail, the consumer and the final screen.
- Do not merge a change on the producing side if the consuming side cannot handle it.
- If a declaration must be generated, export it from the authoritative shape. Do not add a second hand-kept validator. Moving to a generator is a separate small pull request, with a proof that the wire format did not change.

## Exact pins and lock files

- Install from the lock file. In the web app that is `npm ci --ignore-scripts`, which fails when `package.json` and the lock file disagree.
- Pin exact versions of the tools that matter: the Node patch version, Bun, Playwright, the browser revision, and container images by digest. They live in `tools/ci/pins.json`, in the lock files and in the workflow files. See [CI.md](../operations/CI.md).
- Never use a moving tag such as `latest`.
- A dependency change is its own pull request. It names the lock file change. Dependency updates do not ride along with feature work.
- Review dependency and license changes against the lock file. A package that ships inside a built bundle needs its notice in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
- Caches hold dependencies only, keyed by the exact lock files and runtime. Never cache the result of a check.
- Released files are immutable. A later fix is a new release, never silently replaced bytes.

## Local checks, and CI for the full suites

- While you edit, run the focused checks for what you changed. CI runs the full suites on every pull request. Name in the pull request what you ran and what you could not run.
- Run each Python suite in its own process and in the right folder, so that same-named modules and import caches cannot mix.
- Build an allowlisted environment for tests. Do not pass live selectors or credentials from your shell, and never print the environment.
- Tests use in-process stand-ins. A test never reaches a real server, a real mailbox or a real key.
- Every pull request starts with the full affordable suites. Choosing only the affected tests needs its own tests of the dependency closure, a full run when in doubt, and a full run on `main`. An unknown change selects more checks, never fewer.
- CI runs on pull requests and on pushes to `main`. A required workflow gets no path filter that could leave its check unreported. A new run cancels the superseded run of the same pull request, and nothing else. A pull request's CI is never a deploy command.
- No check may carry an escape such as `continue-on-error` for an acceptance failure. A required suite that runs zero tests fails.
- Targets, not promises: logic feedback in about a minute, and the ordinary pull request gate within ten minutes. Record the first real baseline before adding shards or relaxing a check.
- Every long phase has a timeout that fits its work, prints its phase and its counts, and keeps its diagnostics. A confirmed error or stall fails clearly. Healthy start-up or silence alone is not a failure.

## No comments in code

- This covers production code, tests, scripts, inline HTML, CSS and JavaScript, and operational source and configuration. It includes Python and the lint implementation itself.
- Use clear names, explicit types, small functions, tests and short decision documents. Do not use explanatory comments, commented-out code, TODOs, docblock narration, or lint and type suppression comments.
- Documentation prose and license or notice files are not source-code comments.
- A runtime string is data. It is not a place to hide deleted commentary. If a docstring or schema is read by a machine, it keeps its behavior or becomes explicit metadata with tests.
- There is no keep-list and no exception list.
- The check is syntax-aware. A regular expression that mistakes URLs and strings for comments is not enough. It must reject real examples and keep strings that contain comment-like characters.
- Where a shebang line would be the only comment in a file, start the script by naming the interpreter directly instead.
- The check is read-only in CI. Nothing strips comments in bulk before a review.

## Notices and credit

- Record the origin, the original copyright, the exact upstream commit, the license and the changes of every borrowed file in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Keep the full license texts in [licenses](../../licenses).
- Credit lives in `THIRD_PARTY_NOTICES.md` and in the README. A one-line thank-you alone is not enough.
- Never erase a required third-party notice from a file to satisfy a style rule. If an import cannot meet both its legal terms and the no-comments rule, stop that import and decide, instead of publishing stripped code.

## Versions

- Releases use semantic versions. While the version starts with 0, a minor release can change a feature or a contract on purpose, and a patch release is a compatible fix.
- Any breaking change gets a migration note. Version 1.0 comes when install, update and the core workflows are stable, not at a calendar date.
- Only the release owner publishes. See [RELEASES.md](../operations/RELEASES.md).
