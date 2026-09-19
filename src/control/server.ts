import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";
import { insertWakeEvent } from "../state/database.js";
import {
  countPendingOwnerMessages,
  enqueueOwnerMessage,
  getOwnerControlAudit,
  getOwnerControlFlags,
  initializeOwnerControlSchema,
  updateOwnerControlFlags,
  type OwnerControlFlags,
} from "./state.js";
import {
  decideOwnerApproval,
  initializeOwnerApprovalSchema,
  listOwnerApprovals,
} from "./approvals.js";

const MAX_BODY_BYTES = 32 * 1024;

export interface OwnerControlServerOptions {
  db: AutomatonDatabase;
  config: AutomatonConfig;
  token: string;
  host?: string;
  port?: number;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function authorized(req: http.IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  return timingSafeEqual(tokenDigest(supplied), tokenDigest(expectedToken));
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_JSON");
  }
}

function recentPolicyDecisions(db: AutomatonDatabase, limit = 50): unknown[] {
  try {
    return db.raw.prepare(
      `SELECT id, turn_id, tool_name, risk_level, decision, reason, created_at
       FROM policy_decisions
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(Math.min(Math.max(limit, 1), 200));
  } catch {
    return [];
  }
}

function statusPayload(db: AutomatonDatabase, config: AutomatonConfig): Record<string, unknown> {
  const children = db.getChildren();
  const recentTurns = db.getRecentTurns(5);
  const approvals = listOwnerApprovals(db.raw, 100);
  return {
    name: config.name,
    version: config.version,
    state: db.getAgentState(),
    turnCount: db.getTurnCount(),
    activeChildren: children.filter((child) => !["dead", "failed", "cleaned_up"].includes(child.status)).length,
    totalChildren: children.length,
    pendingOwnerMessages: countPendingOwnerMessages(db.raw),
    pendingApprovals: approvals.filter((approval) => approval.status === "pending").length,
    controls: getOwnerControlFlags(db.raw),
    latestBusinessReviewSummary: db.getKV("business.latest_review_summary") ?? null,
    recentTurns: recentTurns.map((turn) => ({
      id: turn.id,
      timestamp: turn.timestamp,
      state: turn.state,
      inputSource: turn.inputSource,
      toolCount: turn.toolCalls.length,
      costCents: turn.costCents,
    })),
  };
}

export function createOwnerControlServer(options: OwnerControlServerOptions): http.Server {
  const { db, config, token } = options;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;

  if (token.length < 32) {
    throw new Error("OWNER_CONTROL_TOKEN must be at least 32 characters");
  }

  initializeOwnerControlSchema(db.raw);
  initializeOwnerApprovalSchema(db.raw);

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/console")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
        });
        res.end(OWNER_CONSOLE_HTML);
        return;
      }

      if (!authorized(req, token)) {
        res.setHeader("www-authenticate", "Bearer");
        json(res, 401, { error: "unauthorized" });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/health") {
        json(res, 200, { ok: true, state: db.getAgentState(), controls: getOwnerControlFlags(db.raw) });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/status") {
        json(res, 200, statusPayload(db, config));
        return;
      }

      if (method === "GET" && url.pathname === "/v1/audit") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const safeLimit = Number.isFinite(limit) ? limit : 50;
        json(res, 200, {
          controlAudit: getOwnerControlAudit(db.raw, safeLimit),
          policyDecisions: recentPolicyDecisions(db, safeLimit),
          modifications: db.getRecentModifications(Math.min(Math.max(safeLimit, 1), 200)),
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/approvals") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        json(res, 200, {
          approvals: listOwnerApprovals(db.raw, Number.isFinite(limit) ? limit : 50),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/chat") {
        const body = await readJson(req);
        if (typeof body.message !== "string") {
          json(res, 400, { error: "message must be a string" });
          return;
        }
        const message = enqueueOwnerMessage(db.raw, body.message);
        insertWakeEvent(db.raw, "owner_control", "owner_message", { messageId: message.id });
        json(res, 202, { accepted: true, messageId: message.id });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/controls") {
        const body = await readJson(req);
        const patch: Partial<OwnerControlFlags> = {};
        for (const key of ["autonomyPaused", "spendingPaused", "tradingPaused", "childCreationPaused"] as const) {
          if (key in body) {
            if (typeof body[key] !== "boolean") {
              json(res, 400, { error: `${key} must be boolean` });
              return;
            }
            patch[key] = body[key] as boolean;
          }
        }
        if (Object.keys(patch).length === 0) {
          json(res, 400, { error: "no control fields supplied" });
          return;
        }
        const controls = updateOwnerControlFlags(db.raw, patch);
        if (patch.autonomyPaused === false) {
          insertWakeEvent(db.raw, "owner_control", "autonomy_resumed");
        }
        json(res, 200, { controls });
        return;
      }

      const approvalMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)\/decision$/);
      if (method === "POST" && approvalMatch) {
        const body = await readJson(req);
        if (body.decision !== "approve" && body.decision !== "reject") {
          json(res, 400, { error: "decision must be approve or reject" });
          return;
        }
        const approvalId = decodeURIComponent(approvalMatch[1]);
        const approval = decideOwnerApproval(
          db.raw,
          approvalId,
          body.decision,
          typeof body.note === "string" ? body.note : undefined,
        );

        if (body.decision === "approve") {
          const message = enqueueOwnerMessage(
            db.raw,
            `Owner approved action ${approval.id} for ${approval.toolName}. Retry the exact previously quarantined action only if it is still appropriate.`,
          );
          insertWakeEvent(db.raw, "owner_control", "approval_approved", {
            approvalId: approval.id,
            messageId: message.id,
          });
        } else {
          insertWakeEvent(db.raw, "owner_control", "approval_rejected", { approvalId: approval.id });
        }

        json(res, 200, { approval });
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "REQUEST_TOO_LARGE") {
        json(res, 413, { error: "request_too_large" });
      } else if (message === "INVALID_JSON") {
        json(res, 400, { error: "invalid_json" });
      } else if (/Approval .* not found/.test(message)) {
        json(res, 404, { error: "approval_not_found" });
      } else if (/Approval .* is already/.test(message)) {
        json(res, 409, { error: "approval_already_decided" });
      } else {
        json(res, 500, { error: "internal_error" });
      }
    }
  });

  server.listen(port, host);
  return server;
}

const OWNER_CONSOLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Automaton Owner Console</title>
<style>body{font:14px system-ui;max-width:960px;margin:32px auto;padding:0 16px;background:#111;color:#eee}button,input,textarea{font:inherit}pre{background:#1d1d1d;padding:16px;overflow:auto}.row{display:flex;gap:8px;flex-wrap:wrap}.danger{border:1px solid #a44;padding:12px;margin:16px 0}textarea{width:100%;min-height:100px;background:#222;color:#fff}input{background:#222;color:#fff;padding:8px;min-width:360px}.approval{background:#1d1d1d;padding:12px;margin:8px 0}</style></head>
<body><h1>Automaton Owner Console</h1><p>Token stays in this browser tab only.</p>
<div class="row"><input id="token" type="password" placeholder="OWNER_CONTROL_TOKEN"><button onclick="saveToken()">Use token</button><button onclick="refresh()">Refresh</button></div>
<h2>Status</h2><pre id="status">Not loaded</pre>
<div class="danger"><h2>Emergency controls</h2><div class="row"><button onclick="control('autonomyPaused',true)">Pause autonomy</button><button onclick="control('autonomyPaused',false)">Resume autonomy</button><button onclick="control('spendingPaused',true)">Stop spending</button><button onclick="control('spendingPaused',false)">Resume spending</button><button onclick="control('tradingPaused',true)">Stop trading</button><button onclick="control('tradingPaused',false)">Resume trading</button><button onclick="control('childCreationPaused',true)">Disable children</button><button onclick="control('childCreationPaused',false)">Enable children</button></div></div>
<h2>Owner message</h2><textarea id="message" placeholder="Send an instruction to the automaton as creator input"></textarea><button onclick="chat()">Send</button>
<h2>Approvals</h2><button onclick="approvals()">Refresh approvals</button><div id="approvals">Not loaded</div>
<h2>Audit</h2><button onclick="audit()">Load audit</button><pre id="audit">Not loaded</pre>
<script>
function saveToken(){sessionStorage.setItem('ownerToken',document.getElementById('token').value);refresh();approvals()}
function headers(){return {'authorization':'Bearer '+(sessionStorage.getItem('ownerToken')||''),'content-type':'application/json'}}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{...headers(),...(opts.headers||{})}});const j=await r.json();if(!r.ok)throw new Error(JSON.stringify(j));return j}
async function refresh(){try{document.getElementById('status').textContent=JSON.stringify(await api('/v1/status'),null,2)}catch(e){document.getElementById('status').textContent=String(e)}}
async function control(k,v){await api('/v1/controls',{method:'POST',body:JSON.stringify({[k]:v})});await refresh()}
async function chat(){const m=document.getElementById('message');await api('/v1/chat',{method:'POST',body:JSON.stringify({message:m.value})});m.value='';await refresh()}
async function approvals(){try{const x=await api('/v1/approvals');const root=document.getElementById('approvals');root.innerHTML='';for(const a of x.approvals){const d=document.createElement('div');d.className='approval';const p=document.createElement('pre');p.textContent=JSON.stringify(a,null,2);d.appendChild(p);if(a.status==='pending'){for(const decision of ['approve','reject']){const b=document.createElement('button');b.textContent=decision;b.onclick=async()=>{await api('/v1/approvals/'+encodeURIComponent(a.id)+'/decision',{method:'POST',body:JSON.stringify({decision})});await approvals();await refresh()};d.appendChild(b)}}root.appendChild(d)}}catch(e){document.getElementById('approvals').textContent=String(e)}}
async function audit(){document.getElementById('audit').textContent=JSON.stringify(await api('/v1/audit'),null,2)}
</script></body></html>`;
