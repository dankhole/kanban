/**
 * G.3 — Detection pipeline integration tests.
 *
 * These tests run the DetectionPipeline with the Quality Enforcer's real rules
 * but with a mock evidence layer.  This verifies:
 *   - Correct findings are produced for each triggered rule.
 *   - Findings are correctly fingerprinted (stable, deterministic).
 *   - No findings are produced when evidence is clean.
 *   - The maxFindingsPerScan policy limit is respected.
 *   - Board-state evidence drives the stale-review and repeated-agent-failure rules.
 *   - Unknown template IDs produce error results with no findings.
 */
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { qualityEnforcerRules } from "../../../src/automations/agents/quality-enforcer/rules";
import { QUALITY_ENFORCER_TEMPLATE } from "../../../src/automations/agents/quality-enforcer/template";
import type { AutomationAgentInstance } from "../../../src/automations/automation-types";
import { DetectionPipeline } from "../../../src/automations/detection-pipeline";
import { ruleCatalog } from "../../../src/automations/rule-catalog";
import { templateRegistry } from "../../../src/automations/template-registry";

// ---------------------------------------------------------------------------
// Mock the evidence collector so the pipeline never runs real subprocesses
// ---------------------------------------------------------------------------

vi.mock("../../../src/automations/evidence-collectors", () => ({
	collectEvidence: vi.fn(),
	getRequiredCollectorIds: vi.fn().mockReturnValue([]),
}));

// Import the mock handle so individual tests can set return values.
import { collectEvidence, getRequiredCollectorIds } from "../../../src/automations/evidence-collectors";

const mockCollectEvidence = vi.mocked(collectEvidence);
const mockGetRequiredCollectorIds = vi.mocked(getRequiredCollectorIds);

// ---------------------------------------------------------------------------
// Register templates and rules once for the whole test file.
// (The singletons are fresh per vitest worker isolation.)
// ---------------------------------------------------------------------------

beforeAll(() => {
	templateRegistry.registerTemplate(QUALITY_ENFORCER_TEMPLATE);
	for (const evaluator of qualityEnforcerRules) {
		ruleCatalog.registerRule(evaluator);
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT_PATH = "/projects/test-repo";

function makeInstance(overrides: Partial<AutomationAgentInstance> = {}): AutomationAgentInstance {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		templateId: "quality-enforcer",
		projectPaths: [TEST_PROJECT_PATH],
		label: "Test QE",
		enabled: true,
		policyOverrides: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function emptyEvidence(): Map<string, string> {
	return new Map<string, string>();
}

function evidenceWith(entries: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(entries));
}

/**
 * Compute the expected fingerprint the same way the pipeline does.
 * Keeps the assertion self-documenting.
 */
function expectedFingerprint(
	instanceId: string,
	ruleId: string,
	projectPath: string,
	vars: Record<string, string>,
): string {
	const key = JSON.stringify({ instanceId, ruleId, projectPath, ...vars });
	return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	mockCollectEvidence.mockResolvedValue(emptyEvidence());
	mockGetRequiredCollectorIds.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DetectionPipeline — Quality Enforcer integration", () => {
	const pipeline = new DetectionPipeline();

	// -------------------------------------------------------------------------
	// Unregistered template
	// -------------------------------------------------------------------------

	it("returns an error and no findings for an unknown template ID", async () => {
		const instance = makeInstance({ templateId: "does-not-exist" });
		const result = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);

		expect(result.findings).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("does-not-exist");
	});

	// -------------------------------------------------------------------------
	// Clean project — no findings
	// -------------------------------------------------------------------------

	it("produces no findings when all evidence is clean", async () => {
		// All exit codes default to "0" (missing = clean) for tests, lint, and type.
		mockCollectEvidence.mockResolvedValue(
			evidenceWith({
				"test-results.exitCode": "0",
				"typecheck-output.exitCode": "0",
				"lint-output.exitCode": "0",
				"git-diff-stat.changedFiles": "",
				"board-state.reviewCards": "[]",
				"board-state.inProgressCards": "[]",
				"board-state.sessionsJson": "{}",
			}),
		);

		const instance = makeInstance();
		const result = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);

		expect(result.errors).toHaveLength(0);
		expect(result.findings).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// failing-tests rule
	// -------------------------------------------------------------------------

	describe("failing-tests rule", () => {
		it("produces a finding when test exit code is non-zero", async () => {
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"test-results.exitCode": "1",
					"test-results.output": "FAIL src/foo.test.ts\n  ✗ should return 42",
					"test-results.failingTests": "src/foo.test.ts > should return 42",
				}),
			);

			const instance = makeInstance();
			const result = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);

			const finding = result.findings.find((f) => f.ruleId === "failing-tests");
			expect(finding).toBeDefined();
			expect(finding?.severity).toBe("error");
			expect(finding?.title).toBe("Fix failing tests");
			expect(finding?.instanceId).toBe(instance.id);
			expect(finding?.projectPath).toBe(TEST_PROJECT_PATH);
		});

		it("fingerprint is stable across identical runs", async () => {
			const evidence = evidenceWith({
				"test-results.exitCode": "1",
				"test-results.output": "FAIL",
				"test-results.failingTests": "test-a",
			});
			mockCollectEvidence.mockResolvedValue(evidence);

			const instance = makeInstance();
			const result1 = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);
			const result2 = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);

			const fp1 = result1.findings.find((f) => f.ruleId === "failing-tests")?.fingerprint;
			const fp2 = result2.findings.find((f) => f.ruleId === "failing-tests")?.fingerprint;

			expect(fp1).toBeDefined();
			expect(fp1).toBe(fp2);
		});

		it("fingerprint matches expected deterministic computation", async () => {
			mockCollectEvidence.mockResolvedValue(evidenceWith({ "test-results.exitCode": "2" }));

			const instance = makeInstance();
			const result = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);
			const finding = result.findings.find((f) => f.ruleId === "failing-tests");

			const expected = expectedFingerprint(instance.id, "failing-tests", TEST_PROJECT_PATH, {
				projectPath: TEST_PROJECT_PATH,
			});
			expect(finding?.fingerprint).toBe(expected);
		});

		it("fingerprint differs when instance ID changes", async () => {
			mockCollectEvidence.mockResolvedValue(evidenceWith({ "test-results.exitCode": "1" }));

			const instanceA = makeInstance({ id: "instance-a" });
			const instanceB = makeInstance({ id: "instance-b" });

			const resultA = await pipeline.run(instanceA, TEST_PROJECT_PATH, null, null);
			const resultB = await pipeline.run(instanceB, TEST_PROJECT_PATH, null, null);

			const fpA = resultA.findings.find((f) => f.ruleId === "failing-tests")?.fingerprint;
			const fpB = resultB.findings.find((f) => f.ruleId === "failing-tests")?.fingerprint;

			expect(fpA).toBeDefined();
			expect(fpB).toBeDefined();
			expect(fpA).not.toBe(fpB);
		});

		it("produces no finding when test exit code is 0", async () => {
			mockCollectEvidence.mockResolvedValue(evidenceWith({ "test-results.exitCode": "0" }));

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			expect(result.findings.filter((f) => f.ruleId === "failing-tests")).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// type-errors rule
	// -------------------------------------------------------------------------

	describe("type-errors rule", () => {
		it("produces a finding when tsc exits non-zero", async () => {
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"typecheck-output.exitCode": "1",
					"typecheck-output.output": "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.",
					"typecheck-output.errorCount": "3",
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			const finding = result.findings.find((f) => f.ruleId === "type-errors");

			expect(finding).toBeDefined();
			expect(finding?.title).toContain("3");
			expect(finding?.evidence.errorCount).toBe("3");
		});
	});

	// -------------------------------------------------------------------------
	// lint-errors rule
	// -------------------------------------------------------------------------

	describe("lint-errors rule", () => {
		it("produces a finding when lint exits non-zero and has output", async () => {
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"lint-output.exitCode": "1",
					"lint-output.output": "src/foo.ts:1:1 error: some-rule\n",
					"lint-output.errorCount": "1",
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			const finding = result.findings.find((f) => f.ruleId === "lint-errors");

			expect(finding).toBeDefined();
			expect(finding?.severity).toBe("warning");
		});

		it("skips lint finding when output is empty (tool not found)", async () => {
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"lint-output.exitCode": "1",
					"lint-output.output": "",
					"lint-output.errorCount": "0",
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			expect(result.findings.filter((f) => f.ruleId === "lint-errors")).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// missing-test-coverage rule
	// -------------------------------------------------------------------------

	describe("missing-test-coverage rule", () => {
		it("produces a finding for each source file without test coverage", async () => {
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"git-diff-stat.changedFiles": "src/foo.ts\nsrc/bar.ts",
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			const coverageFindings = result.findings.filter((f) => f.ruleId === "missing-test-coverage");

			expect(coverageFindings).toHaveLength(2);
			expect(coverageFindings.map((f) => f.affectedFiles[0]).sort()).toEqual(["src/bar.ts", "src/foo.ts"]);
		});

		it("does not flag source files that have a corresponding test change", async () => {
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"git-diff-stat.changedFiles": "src/foo.ts\nsrc/foo.test.ts",
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			const coverageFindings = result.findings.filter((f) => f.ruleId === "missing-test-coverage");

			expect(coverageFindings).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// stale-review rule (board-state based)
	// -------------------------------------------------------------------------

	describe("stale-review rule", () => {
		it("produces a finding for a card stale in review for >24h", async () => {
			const staleCard = {
				id: "task-stale-001",
				prompt: "Implement the new feature",
				updatedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
			};
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"board-state.reviewCards": JSON.stringify([staleCard]),
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			const finding = result.findings.find((f) => f.ruleId === "stale-review");

			expect(finding).toBeDefined();
			expect(finding?.evidence.taskId).toBe("task-stale-001");
			expect(finding?.severity).toBe("info");
		});

		it("does not produce a finding for a recent review card (<24h)", async () => {
			const freshCard = {
				id: "task-fresh-001",
				prompt: "New task just added",
				updatedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
			};
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"board-state.reviewCards": JSON.stringify([freshCard]),
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			expect(result.findings.filter((f) => f.ruleId === "stale-review")).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// repeated-agent-failure rule (board-state based)
	// -------------------------------------------------------------------------

	describe("repeated-agent-failure rule", () => {
		it("produces a finding for a failed in-progress task", async () => {
			const failedCard = {
				id: "task-failed-001",
				prompt: "Investigate the authentication bug",
				sessionState: "failed",
			};
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"board-state.inProgressCards": JSON.stringify([failedCard]),
					"board-state.sessionsJson": "{}",
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			const finding = result.findings.find((f) => f.ruleId === "repeated-agent-failure");

			expect(finding).toBeDefined();
			expect(finding?.evidence.sessionState).toBe("failed");
		});

		it("does not flag in-progress tasks with active session state", async () => {
			const activeCard = {
				id: "task-active-001",
				prompt: "Build the dashboard component",
				sessionState: "running",
			};
			mockCollectEvidence.mockResolvedValue(
				evidenceWith({
					"board-state.inProgressCards": JSON.stringify([activeCard]),
					"board-state.sessionsJson": "{}",
				}),
			);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			expect(result.findings.filter((f) => f.ruleId === "repeated-agent-failure")).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// Policy: maxFindingsPerScan limit
	// -------------------------------------------------------------------------

	describe("policy enforcement", () => {
		it("truncates findings to maxFindingsPerScan when limit is exceeded", async () => {
			// Provide 5 changed source files without test coverage, giving 5 raw findings.
			const manyFiles = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"].join("\n");
			mockCollectEvidence.mockResolvedValue(evidenceWith({ "git-diff-stat.changedFiles": manyFiles }));

			const instance = makeInstance({
				// Override policy to allow only 2 findings per scan.
				policyOverrides: { maxFindingsPerScan: 2 },
			});
			const result = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);

			expect(result.findings.length).toBeLessThanOrEqual(2);
			expect(result.policy.maxFindingsPerScan).toBe(2);
		});

		it("returns the resolved policy in the result", async () => {
			const instance = makeInstance({
				policyOverrides: { maxFindingsPerScan: 7, maxTasksCreatedPerHour: 3 },
			});
			const result = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);

			expect(result.policy.maxFindingsPerScan).toBe(7);
			expect(result.policy.maxTasksCreatedPerHour).toBe(3);
		});
	});

	// -------------------------------------------------------------------------
	// Finding structure verification
	// -------------------------------------------------------------------------

	describe("finding structure", () => {
		it("produced findings have all required fields", async () => {
			mockCollectEvidence.mockResolvedValue(evidenceWith({ "test-results.exitCode": "1" }));

			const instance = makeInstance();
			const result = await pipeline.run(instance, TEST_PROJECT_PATH, null, null);
			const finding = result.findings[0];

			expect(finding).toBeDefined();
			expect(typeof finding?.id).toBe("string");
			expect(finding?.id.length).toBeGreaterThan(0);
			expect(typeof finding?.fingerprint).toBe("string");
			expect(finding?.fingerprint.length).toBe(32); // SHA-256 hex truncated to 32
			expect(finding?.status).toBe("open");
			expect(finding?.instanceId).toBe(instance.id);
			expect(finding?.templateId).toBe(instance.templateId);
			expect(finding?.projectPath).toBe(TEST_PROJECT_PATH);
			expect(typeof finding?.firstSeenAt).toBe("number");
			expect(typeof finding?.lastSeenAt).toBe("number");
			expect(finding?.linkedTaskId).toBeNull();
		});

		it("each finding has a unique ID even when produced in the same scan", async () => {
			// Two changed source files → two missing-coverage findings.
			mockCollectEvidence.mockResolvedValue(evidenceWith({ "git-diff-stat.changedFiles": "src/a.ts\nsrc/b.ts" }));

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);
			const ids = result.findings.map((f) => f.id);
			const uniqueIds = new Set(ids);

			expect(ids.length).toBeGreaterThan(1);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("result includes the evidence map for the project", async () => {
			const fakeEvidence = evidenceWith({ "test-results.exitCode": "1" });
			mockCollectEvidence.mockResolvedValue(fakeEvidence);

			const result = await pipeline.run(makeInstance(), TEST_PROJECT_PATH, null, null);

			expect(result.evidence.has(TEST_PROJECT_PATH)).toBe(true);
			expect(result.evidence.get(TEST_PROJECT_PATH)?.get("test-results.exitCode")).toBe("1");
		});
	});
});
