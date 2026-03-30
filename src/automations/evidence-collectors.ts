/**
 * Evidence collectors for the detection pipeline.
 *
 * Each collector gathers one category of evidence for a given project.
 * Collectors are cheap to run — they either execute a short shell command
 * or query the board state.  Expensive collectors (LLM-based) are heuristic
 * tier and are only invoked when deterministic rules produce signals.
 *
 * Collector IDs are the keys used in the evidence Map passed to rules.
 * Rules declare which collector IDs they need via requiredCollectors.
 *
 * All collectors return a Record<string, string> of evidence key-value pairs.
 * The keys are namespaced by collector ID to prevent collisions.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CollectorContext {
	/** Absolute path to the project repository. */
	projectPath: string;
	/** Unix ms of the last scan, or null if never scanned. */
	lastScanAt: number | null;
	/** Board state for this project's workspace (may be null if unavailable). */
	boardState: {
		cards: RuntimeBoardCard[];
		sessions: Record<string, RuntimeTaskSessionSummary>;
	} | null;
}

export interface EvidenceCollector {
	/** Unique collector ID, e.g. "test-results". */
	id: string;
	/** Rule IDs that require this collector's output. */
	requiredByRules: string[];
	/**
	 * Collect evidence for the given project.
	 * Returns a Record<string, string> of evidence key → value.
	 * Must not throw — return empty object on error.
	 */
	collect(context: CollectorContext): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 1024 * 1024 * 4, // 4 MB
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (err: unknown) {
		const execError = err as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: execError.stdout ?? "",
			stderr: execError.stderr ?? "",
			exitCode: execError.code ?? 1,
		};
	}
}

/**
 * Detect what test command a project uses.
 * Inspects package.json scripts.test field and falls back to vitest/jest.
 */
function detectTestCommand(projectPath: string): { command: string; args: string[] } | null {
	const pkgPath = join(projectPath, "package.json");
	if (!existsSync(pkgPath)) {
		return null;
	}
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			scripts?: Record<string, string>;
		};
		const testScript = pkg.scripts?.test;
		if (!testScript) {
			return null;
		}
		// If the test script runs vitest, use npx vitest run for non-interactive mode.
		if (testScript.includes("vitest")) {
			return { command: "npx", args: ["vitest", "run", "--reporter=verbose"] };
		}
		if (testScript.includes("jest")) {
			return { command: "npx", args: ["jest", "--no-coverage"] };
		}
		if (testScript.includes("mocha")) {
			return { command: "npx", args: ["mocha"] };
		}
		// Fall back to npm test.
		return { command: "npm", args: ["test", "--", "--reporter=verbose"] };
	} catch {
		return null;
	}
}

/**
 * Detect what lint command a project uses.
 */
function detectLintCommand(projectPath: string): { command: string; args: string[] } | null {
	const pkgPath = join(projectPath, "package.json");
	if (!existsSync(pkgPath)) {
		return null;
	}
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			scripts?: Record<string, string>;
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		const lintScript = pkg.scripts?.lint;
		if (lintScript) {
			if (lintScript.includes("biome")) {
				return { command: "npx", args: ["biome", "check", "."] };
			}
			if (lintScript.includes("eslint")) {
				return { command: "npx", args: ["eslint", ".", "--max-warnings=0"] };
			}
		}
		// Auto-detect based on devDependencies.
		const allDeps = { ...pkg.devDependencies, ...pkg.dependencies };
		if ("@biomejs/biome" in allDeps) {
			return { command: "npx", args: ["biome", "check", "."] };
		}
		if ("eslint" in allDeps) {
			return { command: "npx", args: ["eslint", ".", "--max-warnings=0"] };
		}
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Built-in collectors
// ---------------------------------------------------------------------------

/**
 * git-diff-stat — changed files since last scan.
 * Evidence keys: "changedFiles", "diffOutput".
 */
const gitDiffStatCollector: EvidenceCollector = {
	id: "git-diff-stat",
	requiredByRules: ["missing-test-coverage"],
	async collect(ctx) {
		// If never scanned, get changed files in the last 24 hours.
		const since = ctx.lastScanAt
			? new Date(ctx.lastScanAt).toISOString()
			: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

		const result = await runCommand(
			"git",
			["diff", "--name-status", `HEAD@{${since}}`, "HEAD"],
			ctx.projectPath,
			30_000,
		);

		if (result.exitCode !== 0 || !result.stdout.trim()) {
			// Fallback: get uncommitted changes.
			const fallback = await runCommand("git", ["status", "--short"], ctx.projectPath, 10_000);
			return {
				"git-diff-stat.changedFiles": fallback.stdout.trim(),
				"git-diff-stat.diffOutput": fallback.stdout.trim(),
			};
		}

		const lines = result.stdout.trim().split("\n").filter(Boolean);
		return {
			"git-diff-stat.changedFiles": lines.map((l) => l.split("\t").slice(1).join("\t")).join("\n"),
			"git-diff-stat.diffOutput": result.stdout.trim(),
			"git-diff-stat.fileCount": String(lines.length),
		} as Record<string, string>;
	},
};

/**
 * git-recent-commits — recent commit messages for context.
 * Evidence keys: "recentCommits".
 */
const gitRecentCommitsCollector: EvidenceCollector = {
	id: "git-recent-commits",
	requiredByRules: [],
	async collect(ctx) {
		const result = await runCommand("git", ["log", "--oneline", "-20"], ctx.projectPath, 10_000);
		return {
			"git-recent-commits.recentCommits": result.stdout.trim(),
		};
	},
};

/**
 * test-results — test suite output and exit code.
 * Evidence keys: "output", "exitCode", "failingTests".
 */
const testResultsCollector: EvidenceCollector = {
	id: "test-results",
	requiredByRules: ["failing-tests"],
	async collect(ctx) {
		const cmd = detectTestCommand(ctx.projectPath);
		if (!cmd) {
			return { "test-results.exitCode": "0", "test-results.output": "no test command detected" };
		}

		const result = await runCommand(cmd.command, cmd.args, ctx.projectPath, 120_000);
		const combined = `${result.stdout}\n${result.stderr}`.trim();

		// Extract failing test names from common runner patterns.
		const failingTests: string[] = [];
		const patterns = [/✗\s+(.+)/g, /FAIL\s+(.+)/g, /●\s+(.+)/g, /\d+\s+failing/g, /AssertionError/g];
		for (const pattern of patterns) {
			const matches = combined.matchAll(pattern);
			for (const match of matches) {
				if (match[1]) {
					failingTests.push(match[1].trim());
				}
			}
		}

		return {
			"test-results.exitCode": String(result.exitCode),
			"test-results.output": combined.slice(0, 50_000), // cap at 50KB
			"test-results.failingTests": failingTests.slice(0, 20).join("\n"),
		} as Record<string, string>;
	},
};

/**
 * typecheck-output — TypeScript type checker output.
 * Evidence keys: "output", "exitCode", "errorCount".
 */
const typecheckOutputCollector: EvidenceCollector = {
	id: "typecheck-output",
	requiredByRules: ["type-errors"],
	async collect(ctx) {
		const tsconfigPath = join(ctx.projectPath, "tsconfig.json");
		if (!existsSync(tsconfigPath)) {
			return { "typecheck-output.exitCode": "0", "typecheck-output.output": "no tsconfig.json found" };
		}

		const result = await runCommand("npx", ["tsc", "--noEmit", "--pretty", "false"], ctx.projectPath, 60_000);
		const combined = `${result.stdout}\n${result.stderr}`.trim();

		// Count errors.
		const errorMatches = combined.match(/error TS\d+/g);
		const errorCount = errorMatches ? errorMatches.length : 0;

		return {
			"typecheck-output.exitCode": String(result.exitCode),
			"typecheck-output.output": combined.slice(0, 50_000),
			"typecheck-output.errorCount": String(errorCount),
		} as Record<string, string>;
	},
};

/**
 * lint-output — linter findings.
 * Evidence keys: "output", "exitCode", "errorCount".
 */
const lintOutputCollector: EvidenceCollector = {
	id: "lint-output",
	requiredByRules: ["lint-errors"],
	async collect(ctx) {
		const cmd = detectLintCommand(ctx.projectPath);
		if (!cmd) {
			return { "lint-output.exitCode": "0", "lint-output.output": "no lint command detected" };
		}

		const result = await runCommand(cmd.command, cmd.args, ctx.projectPath, 60_000);
		const combined = `${result.stdout}\n${result.stderr}`.trim();

		// Count errors (heuristic patterns).
		const errorPatterns = [/\berror\b/gi, /✗/g, /× /g];
		let errorCount = 0;
		for (const pattern of errorPatterns) {
			const matches = combined.match(pattern);
			if (matches) {
				errorCount = Math.max(errorCount, matches.length);
			}
		}

		return {
			"lint-output.exitCode": String(result.exitCode),
			"lint-output.output": combined.slice(0, 50_000),
			"lint-output.errorCount": String(errorCount),
		} as Record<string, string>;
	},
};

/**
 * board-state — current board cards and sessions.
 * Evidence keys: collected from the provided boardState, not a shell command.
 */
const boardStateCollector: EvidenceCollector = {
	id: "board-state",
	requiredByRules: ["stale-review", "repeated-agent-failure"],
	async collect(ctx) {
		if (!ctx.boardState) {
			return {
				"board-state.available": "false",
				"board-state.reviewCards": "[]",
				"board-state.inProgressCards": "[]",
			};
		}

		const reviewCards = ctx.boardState.cards.filter((c) => {
			// Cards are found via column inspection — in practice the pipeline
			// passes filtered cards by column; here we use heuristic.
			// The review column cards are those with stale updatedAt.
			return c.updatedAt < Date.now() - 24 * 60 * 60 * 1000;
		});

		const inProgressCards = ctx.boardState.cards.filter((c) => {
			const session = ctx.boardState?.sessions[c.id];
			return session && (session.state === "failed" || session.state === "interrupted");
		});

		return {
			"board-state.available": "true",
			"board-state.reviewCards": JSON.stringify(
				reviewCards.map((c) => ({
					id: c.id,
					prompt: c.prompt.slice(0, 200),
					updatedAt: c.updatedAt,
				})),
			),
			"board-state.inProgressCards": JSON.stringify(
				inProgressCards.map((c) => {
					const session = ctx.boardState?.sessions[c.id];
					return {
						id: c.id,
						prompt: c.prompt.slice(0, 200),
						sessionState: session?.state,
						startedAt: session?.startedAt,
					};
				}),
			),
			"board-state.cardCount": String(ctx.boardState.cards.length),
			"board-state.sessionsJson": JSON.stringify(ctx.boardState.sessions),
		} as Record<string, string>;
	},
};

// ---------------------------------------------------------------------------
// Collector registry
// ---------------------------------------------------------------------------

const BUILT_IN_COLLECTORS: EvidenceCollector[] = [
	gitDiffStatCollector,
	gitRecentCommitsCollector,
	testResultsCollector,
	typecheckOutputCollector,
	lintOutputCollector,
	boardStateCollector,
];

const collectorMap = new Map<string, EvidenceCollector>(BUILT_IN_COLLECTORS.map((c) => [c.id, c]));

/**
 * Get a collector by ID.
 */
export function getCollector(id: string): EvidenceCollector | null {
	return collectorMap.get(id) ?? null;
}

/**
 * List all registered collectors.
 */
export function listCollectors(): EvidenceCollector[] {
	return Array.from(collectorMap.values());
}

/**
 * Register a custom collector.  Throws on duplicate ID.
 */
export function registerCollector(collector: EvidenceCollector): void {
	if (collectorMap.has(collector.id)) {
		throw new Error(`Evidence collector "${collector.id}" is already registered.`);
	}
	collectorMap.set(collector.id, collector);
}

/**
 * Given a set of rule IDs, return the minimal set of collector IDs needed.
 */
export function getRequiredCollectorIds(ruleIds: string[]): string[] {
	const needed = new Set<string>();
	for (const collector of collectorMap.values()) {
		if (collector.requiredByRules.some((r) => ruleIds.includes(r))) {
			needed.add(collector.id);
		}
	}
	return Array.from(needed);
}

/**
 * Run all required collectors for a project and merge their outputs.
 * Returns a Map<collectorId, Record<string, string>>.
 */
export async function collectEvidence(
	requiredCollectorIds: string[],
	context: CollectorContext,
): Promise<Map<string, string>> {
	const merged = new Map<string, string>();

	await Promise.all(
		requiredCollectorIds.map(async (id) => {
			const collector = collectorMap.get(id);
			if (!collector) {
				return;
			}
			try {
				const result = await collector.collect(context);
				for (const [key, value] of Object.entries(result)) {
					merged.set(key, value);
				}
			} catch {
				// Evidence collection failure is non-fatal.
			}
		}),
	);

	return merged;
}
