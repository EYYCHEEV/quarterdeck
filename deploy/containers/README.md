# Quarterdeck container layout

This directory is a build package for the Quarterdeck containers. It builds the runtime image and renders the Compose files. It is not permission to pull, build, start or change anything on the production host. Every renderer writes new output files only.

Stalwart is AGPL-3.0. This package holds only the recipe that copies the pinned upstream program into an image and contains no Stalwart code. See `licenses/STALWART-AGPL-3.0-NOTE.md`.

## Images

The selected sources are the official Stalwart `v1.0.1`, Python `3.14.0-slim-trixie` and Caddy `2.11.7-alpine` images. The runtime Dockerfile, `Dockerfile.stalwart-runtime`, copies only the pinned Stalwart program into the pinned Python runtime and adds the first-start launchers and the door declaration. It installs no package.

The runtime Dockerfile and the image manifest, `image-manifest.json`, are not in this repository. They describe the live Stalwart image, and the Dockerfile copies first-start code that is not released, so both stay in the private infrastructure repository. Before you build or render, place the Dockerfile in the `containers/` folder of the assembled package root and keep the manifest at a path you pass to `layout.py`.

The image manifest records:

- the three approved source digests;
- the reproducible local runtime manifest digest used as the Compose reference, and its separate config digest;
- its 15 RootFS diff IDs;
- the package-record hash of every file copied into it.

`layout.py` refuses every Compose render if a reference or config digest is unset, mutable or all-zero, if a source reference is tied to another repository, or if the runtime content identity is incomplete.

## Reproducible runtime build

Read `STALWART_SOURCE` and `PYTHON_SOURCE` from the exact references in the image manifest. Build only from the assembled package root (the folder that holds `containers/`, the first-start launchers and the door declaration), with the already pulled sources and a new OCI output path:

```sh
docker build --network=none --pull=false --no-cache --provenance=false \
  --build-arg SOURCE_DATE_EPOCH=0 \
  --output type=oci,dest=OUTPUT,rewrite-timestamp=true \
  --file containers/Dockerfile.stalwart-runtime \
  --build-arg STALWART_SOURCE="$STALWART_SOURCE" \
  --build-arg PYTHON_SOURCE="$PYTHON_SOURCE" \
  --tag local/quarterdeck-stalwart:v1 .
docker image load --input OUTPUT
```

- The OCI timestamp rewrite is required. A direct Docker exporter includes variable build metadata and cannot satisfy the exact runtime identity gate.
- For approval evidence, repeat the no-cache build to a second new OCI output and require both manifest digests to match. The deploy build uses the same contract and loads the output.
- Docker's containerd image store resolves the OCI manifest digest, not the config digest. So the first deploy check inspects the manifest reference that Compose uses. The second check streams `docker save` of that reference and refuses a saved manifest digest, config digest, RootFS diff ID list or copied-file hash that differs from the approved runtime record.
- For a required offline rebuild, first verify that local aliases point to the manifest's two approved source IDs, then pass those aliases as `STALWART_SOURCE` and `PYTHON_SOURCE`. BuildKit can consult a registry metadata endpoint when a canonical digest reference appears in `FROM`, even with `--network=none`. A local alias avoids that resolver access.

## Normal layout

- Caddy is the only service on the edge network and the only service with a published port. The door policy maps public 443 to Caddy's configured unprivileged endpoint. Port 80 stays closed.
- Caddy, Stalwart, join, helper, the approval sign-in service (the compose service `approval`) and the approval app (the compose service `captain-app`) each run as a separate non-root numeric user. Every root filesystem is read-only. All capabilities are dropped. No-new-privileges and Docker's default syscall filter stay active.
- Caddy, Stalwart, join and the approval sign-in service use distinct addresses on the internal service network defined by the door policy. The approval app is attached only to that internal network, without a published address or port. Only Caddy also has the edge network. The approval sign-in service alone joins the dedicated egress bridge, for its Google token exchange. Caddy routes the exact approved paths and obtains or renews its certificate with TLS-ALPN on 443.
- Compose fixes the edge bridge name to `qd-edge0`, the internal service bridge name to `qd-svc0` and the approval-only egress bridge name to `qd-egress0`, with `com.docker.network.bridge.name`. The host firewall rules are kept outside this repository. They treat these three owned bridge names as the only container forward paths.
- Stalwart publishes no port and trusts proxy metadata only from the Caddy address derived from the door policy.
- The join service publishes no port. It shares a narrow control socket with the helper and a different protected socket with the approval page.
- The helper shares Stalwart's network namespace solely to reach the loopback administration listener. Only the helper receives the administrator credential mount. Its filesystem, user and credentials stay separate, but there is no network wall between those two containers.
- The approval sign-in service has its own user and secret volume. Neither Caddy, Stalwart, join, helper nor the approval app can mount that volume.
- The approval app runs as user 2700 with no public port. Only it mounts the owner's mail key and its application state. It shares group 2701 and the private sign-in socket with the approval sign-in service, but it never mounts approval secrets or the administrator credential.
- The approval sign-in service imports `captain_auth.py` from the approval app directly. It owns the one Google callback and the shared session, then serves bounded session and one-use CSRF checks to the approval app through the peer-checked socket. No copied sign-in contract can drift.
- The helper, join and approval sign-in services mount the one authoritative `signup` package directly and set `/opt/quarterdeck/signup` as an import path. The approval app mounts its own sources, the card checker, the JMAP adapter and the shared door permission declaration directly. No copied contract can drift.
- CPU, memory, swap, process, open-file, temporary-file and log bounds are explicit.

`QD_PACKAGE` is the package root. The Compose model mounts `signup/` directly and mounts the server programs from the package. Program paths are read-only.

## First-start layout

`compose.first-start.template.json` has three one-shot services.

- `stalwart-bootstrap` starts only `bootstrap_launcher.py` as UID 2000 with no external network and no published port. The rendered helper runtime config supplies its exact non-secret management username and the `/run/quarterdeck-admin/credential` path.
- The launcher captures the Stalwart child's output through private pipes and uses only the rendered credential-free bootstrap request. It writes only the returned printable secret bytes directly to that mode 0600 file, then requires the returned username to match. A mismatch preserves the credential and fails with one fixed line. No credential is a Compose argument, environment value or log value.
- The helper-admin directory is temporarily owned by UID 2000 only for this sealed bootstrap write. After the service exits cleanly, the listener is gone and `PrivateSecretFile.read()` accepts the credential, an operator step transfers the directory and `credential` to helper UID 2200 without reading the file. Normal Stalwart never mounts that directory.
- The recovery Stalwart service has no external network and no published port. The configurator joins only that service's network namespace. The recovery password is a file mount. No recovery setting or credential appears in Compose, an image, an argument or a Docker-managed environment field. Normal Stalwart does not mount the active recovery-password directory. Its launcher refuses normal start unless the approved policy was read back, the recovery password was retired and no recovery setting remains.

## Account one-shot overlay

`compose.step13.template.json` is merged with the normal rendered model only for the approved account-setup commands.

- The sign-in setup one-shots run as approval UID 2500 with no network.
- The registry writer and the prepare, place and readback account modes run as the approval app's UID 2700 with no network.
- Create, activate and revoke run as helper UID 2200 in Stalwart's network namespace.
- None of these services publishes a port. None has a TTY or a restart policy, and Docker logging is disabled for all of them.

The account key moves only through `prepare | create | place`. The create stage emits the configured name, key, account id and key id through the inherited pipe. Place writes the key and `captain-ids.json` as exclusive private files. Activation uses `prepare --name-only | activate | readback`, carrying only the configured name and both validated ids. No account or key listing is used.

## Server-side ownership contract

Create these paths only after the owner's explicit approval, then read ownership and mode back before use:

| Path class | Numeric owner | Required mode | Mounted by |
| --- | ---: | ---: | --- |
| Stalwart configuration, data, logs and first-start state | 2000 | 0700 directories; private files 0600 | Stalwart or first-start only |
| Join state | 2100 | 0700 | Join only |
| Helper state and administrator files | 2200 | 0700 directories; private files 0600 | Helper and the account administrator one-shot only |
| Caddy certificate and configuration state | 2300 | 0700 directories; private files 0600 | Caddy only |
| Approval secrets | 2500 | 0700 directory; private files 0600 | Approval and its one-shots only |
| The approval app's application state and mail key | 2700 | 0700 directories; private files 0600 | The approval app and its one-shots only |
| Backups | 2600 | 0700 | No normal service |
| Join-helper control socket directory | group 2400 | 2770 | Join and helper only |
| Join-approval socket directory | 2100 (join), group 2501 | 2770 | Join and approval only |
| Sign-in socket directory | 2500 (approval), group 2701 | 2770; socket 0660 | The approval sign-in service and the approval app only |

## Render gate

The door policy file is the one source for the hostname, public origin, mail domain, service network and private endpoints (`qd.example.invalid` and `mail.qd.example.invalid` in documentation). Code and templates contain deployment tokens such as `${deployment:public-origin}`, not copies of those values. The real policy file is deployment configuration and is not part of this repository.

Some values are not rendered by `layout.py`. `QD_ROOT`, `QD_PACKAGE`, `QD_EGRESS_SUBNET` and `QD_CARD_LINK_ORIGIN` are deploy-time values that stay as `${QD_ROOT}`, `${QD_PACKAGE}`, `${QD_EGRESS_SUBNET}` and `${QD_CARD_LINK_ORIGIN}` in the rendered Compose file. The install step fills in the real subnet of the egress bridge `qd-egress0` in place of `${QD_EGRESS_SUBNET}`, and the origin that plain-http card links may use (`http://` and a host, with no port) in place of `${QD_CARD_LINK_ORIGIN}`. The approval app accepts those links only on ports 8780 to 8799 of that origin. If `QD_CARD_LINK_ORIGIN` is unset or empty, it accepts no plain-http card link, only https links. The only values written in public files are the documentation examples `203.0.113.0/29` and `http://qd.example.invalid`. No real subnet or host appears in this repository.

After the four exact digests have their approval, fill the `reference` fields and render only new output files. `layout.py` has four modes:

| Mode | Inputs | Output |
| --- | --- | --- |
| `configuration` | the door policy, one service's `runtime-config.template.json` (join, the approval sign-in service, helper or the approval app) or the first-start `bootstrap-request.json` | that service's rendered config |
| `normal` | the image manifest, the door policy, `compose.template.json` | `compose.json` |
| `first-start` | the image manifest, the door policy, `compose.first-start.template.json`, the rendered helper runtime config | `compose.first-start.json` |
| `step13` | the image manifest, the door policy, `compose.step13.template.json` | `compose.step13.json` |

For example, with `DOOR_POLICY` set to the door policy file and `IMAGE_MANIFEST` set to the image manifest:

```sh
python3 apps/server/door/door_policy.py "$DOOR_POLICY" OUTPUT/caddy/Caddyfile
python3 deploy/containers/layout.py configuration "$DOOR_POLICY" apps/server/join/runtime-config.template.json OUTPUT/join/runtime.json
python3 deploy/containers/layout.py normal "$IMAGE_MANIFEST" "$DOOR_POLICY" deploy/containers/compose.template.json OUTPUT/compose.json
```

The default Caddy render validates the chat route block but omits every chat route. After the account setup and the owner's named approval of the exact chat bot list, render a new candidate with `CHAT_ROUTE_BLOCK` set to the chat route block file:

```sh
python3 apps/server/door/door_policy.py "$DOOR_POLICY" OUTPUT/caddy/Caddyfile.chat --enable-chat "$CHAT_ROUTE_BLOCK"
```

Each writer refuses to overwrite an existing output. Stop on an unresolved token or a rendered value that differs from the approved policy. Validate the rendered Compose model and the generated Caddy configuration with the exact approved images before any build or start.

## Tests

```sh
python3 -m unittest discover -s deploy/containers -p 'test_*.py'
```

`test_layout.py` and `test_deployment_contract.py` cover the renderers and the deployment contract.
