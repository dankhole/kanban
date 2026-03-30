/**
 * Integration test harness for the job_queue sidecar.
 *
 * Usage in a test file:
 *
 *   import { createJobQueueHarness } from "../utilities/job-queue-harness";
 *
 *   const jq = createJobQueueHarness();
 *
 *   beforeAll(() => jq.start(), 30_000);
 *   afterAll(() => jq.stop());
 *
 * The harness:
 *  - ALL environment mutations (KANBAN_JOB_QUEUE_DATA_DIR) happen inside
 *    start() — not at module-evaluation time — so that other test files
 *    sharing the same worker process are never affected.
 *  - Redirects KANBAN_JOB_QUEUE_DATA_DIR to an isolated temp directory so
 *    the test DB never touches the real ~/.kanban/job-queue/ data.
 *  - Starts a real sidecar process (workers + scheduler) with fast poll
 *    intervals to keep test durations short.
 *  - Provides a `waitForJobs` helper that polls inspect() until the
 *    cumulative succeeded count reaches the expected threshold.
 *  - Restores the env var and cleans up the temp directory on stop().
 */

import { mkdirSync } from "node:fs";

import { JobQueueService } from "../../src/server/job-queue-service";
import { createTempDir } from "./temp-dir";

export interface JobQueueHarness {
	/**
	 * The live service instance — only valid after start() resolves.
	 * Accessing before start() throws.
	 */
	readonly service: JobQueueService;
	/**
	 * Poll inspect() until `jobs.status_counts.succeeded` is ≥ `count`,
	 * or until `timeoutMs` elapses (default 10 s).
	 */
	waitForJobs(count: number, timeoutMs?: number): Promise<void>;
	/** Start the sidecar (call in beforeAll). */
	start(): Promise<void>;
	/** Stop the sidecar and clean up (call in afterAll). */
	stop(): Promise<void>;
}

export function createJobQueueHarness(): JobQueueHarness {
	// Temp dir is created eagerly (just mkdtemp — no env mutations yet).
	const tempDir = createTempDir("kanban-jq-test-");

	let _service: JobQueueService | null = null;
	let prevDataDir: string | undefined;

	async function start(): Promise<void> {
		// ALL env mutations are deferred to start() so that other test files
		// sharing the same Vitest worker process don't inherit a stale value
		// during the module-evaluation / collection phase.
		mkdirSync(tempDir.path, { recursive: true });
		prevDataDir = process.env.KANBAN_JOB_QUEUE_DATA_DIR;
		process.env.KANBAN_JOB_QUEUE_DATA_DIR = tempDir.path;

		// Construct after the env var is set so getJobQueueDataDir() picks it up.
		_service = new JobQueueService();

		if (!_service.isAvailable()) {
			// Restore immediately so we don't leave the env mutated.
			restoreEnv();
			throw new Error(
				"job_queue binary not found. Build it with: " + "cd overthink_rust/job_queue_layer && cargo build",
			);
		}

		await _service.startSidecar({
			workers: 2,
			schedulerPollMs: 100, // fast scheduler poll for tests
		});

		// Give the sidecar a moment to finish initialising its DB schema.
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
	}

	function restoreEnv(): void {
		if (prevDataDir === undefined) {
			delete process.env.KANBAN_JOB_QUEUE_DATA_DIR;
		} else {
			process.env.KANBAN_JOB_QUEUE_DATA_DIR = prevDataDir;
		}
	}

	async function stop(): Promise<void> {
		if (_service) {
			await _service.stopSidecar().catch(() => {
				// Ignore errors during teardown — the process may have already exited.
			});
		}
		restoreEnv();
		tempDir.cleanup();
	}

	async function waitForJobs(count: number, timeoutMs = 10_000): Promise<void> {
		const svc = _service;
		if (!svc) throw new Error("waitForJobs() called before start()");

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const snapshot = await svc.inspect();
			// The binary uses "succeeded" as the terminal success status.
			const succeeded = snapshot.jobs.status_counts["succeeded"] ?? 0;
			if (succeeded >= count) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 150));
		}

		// One last check to surface a readable failure message.
		const snapshot = await svc.inspect();
		const succeeded = snapshot.jobs.status_counts["succeeded"] ?? 0;
		throw new Error(
			`Timed out waiting for ${count} succeeded jobs after ${timeoutMs}ms. ` +
				`Actual succeeded: ${succeeded}. ` +
				`Status counts: ${JSON.stringify(snapshot.jobs.status_counts)}`,
		);
	}

	return {
		get service(): JobQueueService {
			if (!_service) throw new Error("service accessed before start()");
			return _service;
		},
		start,
		stop,
		waitForJobs,
	};
}
