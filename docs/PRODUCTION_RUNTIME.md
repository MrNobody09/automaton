# Production Runtime Architecture

## Decision

The parent Automaton runs continuously on a dedicated Conway Cloud Linux sandbox/VM. GitHub remains the source-of-truth for code and CI; it is not the runtime. Public products and worker workloads run in separate sandboxes so a public service compromise does not directly expose the parent wallet, business state, or credentials.

## Target topology

```text
Owner (browser/mobile)
        |
        |  future authenticated Owner Console (PR #4)
        v
+-------------------------------+
| Parent Automaton VM           |
| Conway Cloud                  |
|                               |
| agent loop + heartbeat        |
| policy + spend controls       |
| business/intelligence engine  |
| wallet + SQLite + memory      |
| private control surface       |
+---------------+---------------+
                |
       +--------+---------+
       |                  |
       v                  v
 Product sandbox      Worker sandbox
 public API/web       delegated/child work
```

The parent VM must not host customer-facing products. A product gets its own sandbox and its own narrowly scoped credentials.

## Production paths

The current runtime derives its state directory from `$HOME` and several existing tool/replication paths still assume `/root`. Until those assumptions are removed, the production service runs as root inside the dedicated Conway VM.

- application: `/opt/automaton`
- live state: `/root/.automaton`
- service environment: `/etc/automaton/automaton.env`
- routine state backups: `/var/backups/automaton`
- systemd unit: `automaton.service`

The root service choice is a compatibility decision, not the long-term privilege model. A dedicated service user should be introduced only after all `/root` assumptions are removed and covered by tests.

## State and secrets

`/root/.automaton` is the authoritative live state. It includes the SQLite database, configuration, heartbeat configuration, SOUL, skills, wallet material, and Conway credentials.

Routine backups deliberately exclude raw secrets:

- `wallet.json` is never copied by the standard backup job.
- `api-key` is never copied by the standard backup job.
- `automaton.json` is copied only as a sanitized JSON file with API-key fields removed.
- `state.db` is captured with SQLite's online backup API, not a raw file copy.

Wallet/key recovery must use a separate encrypted recovery procedure whose encryption key is not stored on the parent VM.

## Process supervision

`automaton.service` owns the long-running process.

- starts `node /opt/automaton/dist/index.js --run`
- restarts on failure
- sends SIGTERM for graceful shutdown
- uses a restrictive umask
- prevents privilege escalation
- keeps temporary files private
- loads optional secrets from `/etc/automaton/automaton.env`

The application already handles SIGTERM/SIGINT by stopping the heartbeat, moving the agent to sleeping state, closing SQLite, and exiting cleanly.

## Health model

Two layers are used:

1. **Process liveness** — `systemd` is authoritative (`systemctl is-active automaton`).
2. **Runtime readiness** — `pnpm production:health` checks configuration, wallet presence/permissions, SQLite availability, and current agent state without printing secrets.

PR #4 will expose authenticated owner-facing health/status through the control plane. PR #3 does not expose a public health endpoint from the parent VM.

## Backup and recovery

`pnpm production:backup` creates a timestamped backup directory containing:

- consistent `state.db` snapshot
- sanitized `automaton.json`
- heartbeat configuration
- SOUL/constitution when present
- skills directory
- manifest describing exclusions

The included systemd timer runs the backup job periodically. Backup retention and off-VM encrypted replication are deployment configuration, not hard-coded business logic.

Recovery order:

1. provision a clean Conway VM;
2. deploy a CI-validated application commit;
3. restore the non-secret state snapshot;
4. separately restore wallet/API credentials through the encrypted recovery process;
5. run `pnpm production:health`;
6. start `automaton.service`;
7. verify heartbeat and business review execution before allowing new capital allocation.

## Deployment lifecycle

```text
feature branch
    -> pull request
    -> typecheck
    -> production build
    -> full tests
    -> security/financial tests
    -> blocking high-severity dependency audit
    -> merge main
    -> deploy pinned commit/release to /opt/automaton
    -> pnpm install --frozen-lockfile
    -> pnpm build
    -> pnpm production:health
    -> restart automaton.service
    -> post-deploy health verification
```

Production must deploy a pinned tested commit or release. It must not `git pull` an arbitrary latest revision directly into a running agent.

## Authority and emergency control

The future Owner Console will provide authenticated chat, approvals, audit views, and emergency controls such as pause autonomy, stop spending, stop trading, and disable child creation. Until that control plane exists, deployment operators use systemd plus configuration/policy controls.

No production deployment should enable unrestricted child replication or live trading merely because the process is online. Those capabilities require their own explicit limits and later implementation gates.

## Public networking

The parent Automaton is private by default. Conway port exposure is reserved for the future authenticated Owner Console/control API. Public products use separate sandboxes and separate exposed ports/domains.

## PR sequence

- PR #3: production runtime foundation — supervision, health, backup, secrets/deployment documentation.
- PR #4: Owner Control Plane — authenticated API, chat/dashboard, approvals, emergency controls.
- Later PRs: external opportunity acquisition, owned/x402 products, and trading execution.
