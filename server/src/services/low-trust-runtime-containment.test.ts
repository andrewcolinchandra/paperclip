import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  LOW_TRUST_DENIAL_FAILURE_CODE,
  LowTrustDenialFailure,
  assertLowTrustRuntimeServicesAllowed,
  assertLowTrustWorkspaceIsolation,
  isLowTrustDenialFailure,
} from "./low-trust-runtime-containment.js";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";

const deniedResolution = (reason: TrustPresetResolution extends { reason: infer R } ? R : string): TrustPresetResolution => ({
  kind: "denied",
  reason: reason as never,
  source: "issue",
  detail: `Denied: ${reason}`,
  sourcePresets: {},
});

const lowTrustReviewResolution = (): TrustPresetResolution => ({
  kind: "low_trust_review",
  preset: "low_trust_review",
  boundary: {
    mode: "low_trust_review",
    companyId: "company-1",
    rootIssueId: "issue-root",
    allowedToolClasses: ["git.read"],
  },
  sourcePresets: {},
});

const baseWorkspaceInput = {
  isolatedWorkspacesEnabled: true,
  effectiveExecutionWorkspaceMode: "isolated_workspace" as string,
  selectedEnvironmentDriver: "sandbox" as string | undefined,
  issue: { companyId: "company-1", id: "issue-root", projectId: null },
};

describe("assertLowTrustWorkspaceIsolation — deny is a typed, catchable failure (TES-1103)", () => {
  it("throws LowTrustDenialFailure (not a raw 422) for a denied trust preset", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...baseWorkspaceInput,
        resolution: deniedResolution("missing_low_trust_boundary_scope"),
      }),
    ).rejects.toMatchObject({
      name: "LowTrustDenialFailure",
      code: LOW_TRUST_DENIAL_FAILURE_CODE,
      denyCode: "missing_low_trust_boundary_scope",
    });
  });

  it("carries the human-readable detail as the error message", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...baseWorkspaceInput,
        resolution: deniedResolution("cross_company_boundary"),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof LowTrustDenialFailure)) return false;
      return error.message.includes("cross_company_boundary") && error.denyCode === "cross_company_boundary";
    });
  });

  it("throws LowTrustDenialFailure when isolated workspaces are unavailable", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...baseWorkspaceInput,
        isolatedWorkspacesEnabled: false,
        resolution: lowTrustReviewResolution(),
      }),
    ).rejects.toMatchObject({
      name: "LowTrustDenialFailure",
      code: LOW_TRUST_DENIAL_FAILURE_CODE,
      denyCode: "low_trust_isolation_unavailable",
    });
  });

  it("throws LowTrustDenialFailure when the workspace is not isolated", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...baseWorkspaceInput,
        effectiveExecutionWorkspaceMode: "shared_workspace",
        resolution: lowTrustReviewResolution(),
      }),
    ).rejects.toMatchObject({
      name: "LowTrustDenialFailure",
      code: LOW_TRUST_DENIAL_FAILURE_CODE,
      denyCode: "low_trust_requires_isolated_workspace",
    });
  });

  it("does not throw for a standard (non-low-trust) resolution", async () => {
    await expect(
      assertLowTrustWorkspaceIsolation({
        ...baseWorkspaceInput,
        resolution: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertLowTrustRuntimeServicesAllowed — deny is a typed failure (TES-1103)", () => {
  it("throws LowTrustDenialFailure for a denied trust preset", () => {
    expect(() =>
      assertLowTrustRuntimeServicesAllowed({
        resolution: deniedResolution("missing_low_trust_boundary_scope"),
        runtimeServiceCount: 0,
      }),
    ).toThrow(LowTrustDenialFailure);
  });

  it("throws LowTrustDenialFailure when runtime services are not granted by the boundary", () => {
    let caught: unknown;
    try {
      assertLowTrustRuntimeServicesAllowed({
        resolution: lowTrustReviewResolution(),
        runtimeServiceCount: 1,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LowTrustDenialFailure);
    expect((caught as LowTrustDenialFailure).code).toBe(LOW_TRUST_DENIAL_FAILURE_CODE);
    expect((caught as LowTrustDenialFailure).denyCode).toBe("low_trust_runtime_services_denied");
  });
});

describe("isLowTrustDenialFailure — recognition guard for the run-setup catch (TES-1103)", () => {
  it("recognizes a LowTrustDenialFailure", () => {
    expect(isLowTrustDenialFailure(new LowTrustDenialFailure("nope", "missing_low_trust_boundary_scope"))).toBe(true);
  });

  it("does NOT recognize a generic 422 HttpError (would be misrouted if it did)", () => {
    expect(isLowTrustDenialFailure(new HttpError(422, "some other unprocessable", { code: "responsible_user_unresolved" }))).toBe(false);
  });

  it("does NOT recognize a plain Error or nullish values", () => {
    expect(isLowTrustDenialFailure(new Error("boom"))).toBe(false);
    expect(isLowTrustDenialFailure(null)).toBe(false);
    expect(isLowTrustDenialFailure(undefined)).toBe(false);
  });
});
