# Owner Control Plane

## Purpose

The Owner Control Plane gives the owner a private, authenticated way to inspect and intervene in the parent Automaton without exposing the parent runtime as a public product.

It provides:

- runtime/status visibility;
- trusted owner-to-agent messages;
- policy/control audit visibility;
- exact, single-use approval of quarantined actions;
- emergency controls for autonomy, outbound spending, live trading execution, and child/worker creation.

## Network posture

The server is disabled unless `OWNER_CONTROL_TOKEN` is configured.

Defaults:

- host: `127.0.0.1`
- port: `8787`
- authentication: `Authorization: Bearer <OWNER_CONTROL_TOKEN>`
- minimum token length: 32 characters

The default loopback binding is intentional. Do not bind the owner console directly to a public interface over plaintext HTTP. Remote access should be provided through a private tunnel/VPN or an authenticated TLS reverse proxy. Public customer traffic belongs in separate product sandboxes, not on this control port.

The HTML console itself contains no runtime data. All status, chat, audit, approval, and control API calls require Bearer authentication. The browser console stores the token only in `sessionStorage`, so it is cleared when the browser session ends.

## Configuration

In `/etc/automaton/automaton.env`:

```bash
OWNER_CONTROL_TOKEN=<random-secret-at-least-32-characters>
OWNER_CONTROL_HOST=127.0.0.1
OWNER_CONTROL_PORT=8787
```

Restart the service after configuration changes:

```bash
systemctl restart automaton.service
```

## API

Authenticated endpoints:

- `GET /v1/health` — runtime state and active control flags.
- `GET /v1/status` — runtime summary, child counts, pending messages/approvals, latest business review, and recent turn metadata.
- `GET /v1/audit` — owner-control audit, policy decisions, and recent modification entries.
- `GET /v1/approvals` — pending and historical owner approvals.
- `POST /v1/chat` — enqueue a trusted owner instruction.
- `POST /v1/controls` — update emergency-control flags.
- `POST /v1/approvals/:id/decision` — approve or reject a pending approval.

The browser console is available at `/` and `/console` on the configured control listener.

## Trusted owner messages

Owner chat does not write directly into `wake_events` as the message payload. Messages are persisted in the dedicated `owner_messages` queue and a wake event is used only to wake the runtime.

The agent loop claims the message durably and presents it as `InputSource = creator`. The message is marked processed only when the turn is persisted successfully. If the turn fails, the message returns to pending for retry.

## Emergency controls

### Pause autonomy

`autonomyPaused=true` stops new agent-loop turns and leaves the runtime in sleeping state. The control server and heartbeat remain available so the owner can inspect and resume the system.

### Stop spending

`spendingPaused=true` blocks outbound-capital tools and autonomous top-up paths. Safe financial accounting and portfolio-inspection tools remain usable.

The control applies to:

- credit transfers;
- credit top-ups;
- child funding;
- x402 payments;
- paid domain registration;
- dangerous financial execution tools;
- startup/bootstrap top-ups;
- heartbeat auto-top-ups;
- low-credit inline top-ups;
- sandbox top-ups used during worker creation.

### Stop trading

`tradingPaused=true` is the durable kill switch for live trading execution. It does not prevent trading research, risk inspection, or configuration. Future trading adapters must continue to route live order/position execution through this gate.

### Disable child creation

`childCreationPaused=true` prevents new child/worker creation. The check is enforced at the remote `spawnChild()` boundary and in orchestration before either remote or local worker creation.

Existing children are not destroyed by this flag; it stops new creation only.

## Approvals

Existing treasury policy can quarantine actions that exceed the configured owner-confirmation threshold. The control plane makes quarantine actionable rather than equivalent to denial.

Approval properties:

- bound to the exact tool name;
- bound to the exact policy argument hash;
- cannot authorize changed amount/recipient/arguments;
- single-use;
- consumed before the approved execution attempt;
- rejected or consumed approvals cannot be reused.

Approving an action also wakes the agent with a trusted owner instruction to retry the exact previously quarantined action only if it is still appropriate.

## Audit model

Control changes and owner-message enqueue operations are written to `owner_control_audit`. Tool policy decisions continue to use the existing `policy_decisions` audit trail. Approvals are retained in `owner_approvals` with pending/approved/rejected/consumed state.

The API intentionally does not return wallet private material, API keys, or raw runtime configuration.

## Recovery behavior

Emergency-control flags live in SQLite KV state, so they survive process restarts and VM reboots. In particular, a persisted spending pause must be checked before any startup auto-top-up. A persisted autonomy pause prevents the agent loop from resuming simply because systemd restarted the process.
