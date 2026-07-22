import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";
import {
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH,
  isIssueWithinLowTrustBoundary,
} from "./trust-preset-resolver.js";

export const LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS = "runtime.manage";

// A low-trust boundary refusing content is *expected, defensive behavior*, not a
// crash. Surfacing it as a typed failure (instead of a raw 422) lets the run-setup
// path route the deny to a graceful issue transition (blocked + CEO surface) and
// keep the agent healthy, rather than pinning it to status=error. See TES-1103.
export const LOW_TRUST_DENIAL_FAILURE_CODE = "low_trust_denied";

export class LowTrustDenialFailure extends Error {
  code = LOW_TRUST_DENIAL_FAILURE_CODE;
  /** Specific boundary reason, e.g. `missing_low_trust_boundary_scope`. */
  denyCode: string;
  /** Trust-policy source that produced the denial, when known. */
  denySource: string | null;

  constructor(message: string, denyCode: string, denySource: string | null = null) {
    super(message);
    this.name = "LowTrustDenialFailure";
    this.denyCode = denyCode;
    this.denySource = denySource;
  }
}

export function isLowTrustDenialFailure(error: unknown): error is LowTrustDenialFailure {
  return error instanceof LowTrustDenialFailure;
}

function raiseLowTrustDenial(message: string, denyCode: string, denySource: string | null = null): never {
  throw new LowTrustDenialFailure(message, denyCode, denySource);
}

export interface LowTrustDenial {
  kind: "denied";
  reason: string;
  detail: string;
  source: string | null;
}

export function getLowTrustDenial(resolution: TrustPresetResolution): LowTrustDenial | null {
  if (resolution.kind === "denied") {
    return {
      kind: "denied",
      reason: resolution.reason,
      detail: resolution.detail,
      source: resolution.source,
    };
  }
  return null;
}

export function isLowTrustRuntimeManagementAllowed(resolution: TrustPresetResolution) {
  return resolution.kind === "low_trust_review" &&
    (resolution.boundary.allowedToolClasses ?? []).includes(LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS);
}

async function issueIdIsDescendantOf(db: Db, issueId: string, rootIssueId: string, companyId: string) {
  let cursor: string | null = issueId;
  // Keep the runtime preflight aligned with authorization while bounding DB work.
  for (let depth = 0; cursor && depth < LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH; depth += 1) {
    if (cursor === rootIssueId) return true;
    const row: { id: string; companyId: string; parentId: string | null } | null = await db
      .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, cursor))
      .then((rows) => rows[0] ?? null);
    if (!row || row.companyId !== companyId) return false;
    cursor = row.parentId;
  }
  return false;
}

async function workspaceIssueWithinLowTrustBoundary(input: {
  db?: Db;
  boundary: Extract<TrustPresetResolution, { kind: "low_trust_review" }>["boundary"];
  issue: { companyId: string; id?: string | null; projectId?: string | null };
}) {
  if (isIssueWithinLowTrustBoundary(input.boundary, input.issue)) return true;
  if (!input.db || !input.issue.id || !input.boundary.rootIssueId) return false;
  return issueIdIsDescendantOf(input.db, input.issue.id, input.boundary.rootIssueId, input.boundary.companyId);
}

export async function assertLowTrustWorkspaceIsolation(input: {
  db?: Db;
  resolution: TrustPresetResolution;
  isolatedWorkspacesEnabled: boolean;
  effectiveExecutionWorkspaceMode: string | null | undefined;
  selectedEnvironmentDriver: string | null | undefined;
  issue: { companyId: string; id?: string | null; projectId?: string | null } | null;
}) {
  const denial = getLowTrustDenial(input.resolution);
  if (denial) {
    raiseLowTrustDenial(denial.detail, denial.reason, denial.source);
  }
  if (input.resolution.kind !== "low_trust_review") return;

  if (!input.isolatedWorkspacesEnabled) {
    raiseLowTrustDenial(
      "Low-trust execution requires isolated workspaces to be enabled.",
      "low_trust_isolation_unavailable",
    );
  }
  if (input.effectiveExecutionWorkspaceMode !== "isolated_workspace") {
    raiseLowTrustDenial(
      "Low-trust execution requires an isolated execution workspace.",
      "low_trust_requires_isolated_workspace",
    );
  }
  if (
    !input.issue ||
    !(await workspaceIssueWithinLowTrustBoundary({
      db: input.db,
      boundary: input.resolution.boundary,
      issue: input.issue,
    }))
  ) {
    raiseLowTrustDenial(
      "Low-trust execution issue is outside the active trust boundary.",
      "low_trust_boundary_mismatch",
    );
  }
  if (input.selectedEnvironmentDriver !== "sandbox") {
    raiseLowTrustDenial(
      "Low-trust execution requires a sandbox environment driver.",
      "low_trust_requires_sandbox_environment",
    );
  }
}

export function assertLowTrustRuntimeServicesAllowed(input: {
  resolution: TrustPresetResolution;
  runtimeServiceCount: number;
}) {
  const denial = getLowTrustDenial(input.resolution);
  if (denial) {
    raiseLowTrustDenial(denial.detail, denial.reason, denial.source);
  }
  if (input.resolution.kind !== "low_trust_review") return;
  if (input.runtimeServiceCount === 0) return;
  if (isLowTrustRuntimeManagementAllowed(input.resolution)) return;
  raiseLowTrustDenial(
    "Low-trust execution cannot start runtime services unless the boundary grants runtime.manage.",
    "low_trust_runtime_services_denied",
  );
}
