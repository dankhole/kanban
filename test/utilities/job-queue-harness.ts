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
 *  - Redirects KANBAN_JOB_QUEUE_DATA_DIR to an isolated temp directory so
 *    the test DB never touches the real ~/.kanban/job-queue/ data.
 *  - Starts a real sidecar process (workers + scheduler) with fast poll
 *    intervals to keep test durations short.
 *  - Provides a `waitForJobs` helper that polls inspect() until the
 *    cumulative completed count reaches the expected threshold.
 *  - Restores the env var and cleans up the temp directory on stop().
 */

import { mkdirSync } from "node:fs";

import { JobQueueService } from "../../src/server/job-queue-service";
import { createTempDir } from "./temp-dir";

export interface JobQueueHarness {
	/** The live service instance — use its methods in tests. */
	service: JobQueueService;
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
	const tempDir = createTempDir("kanban-jq-test-");

	// Create the data directory immediately so the env var is valid when the
	// service is constructed (JobQueueService reads it at call time, not at
	// construction, but we mkdir early to be safe).
	mkdirSync(tempDir.path, { recursive: true });

	// Point the service at the isolated temp DB.
	const prevDataDir = process.env.KANBAN_JOB_QUEUE_DATA_DIR;
	process.env.KANBAN_JOB_QUEUE_DATA_DIR = tempDir.path;

	// Construct after the env var is set so getJobQueueDataDir() picks it up.
	const service = new JobQueueService();

	async function start(): Promise<void> {
		if (!service.isAvailable()) {
			throw new Error(
				"job_queue binary not found. Build it with: " + "cd overthink_rust/job_queue_layer && cargo build",
			);
		}
		await service.startSidecar({
			workers: 2,
			schedulerPollMs: 100, // fast scheduler poll for tests
		});

		// Give the sidecar a moment to finish initialising its DB schema.
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
	}

	async function stop(): Promise<void> {
		await service.stopSidecar().catch(() => {
			// Ignore errors during teardown — the process may have already exited.
		});

		// Restore env var.
		if (prevDataDir === undefined) {
			delete process.env.KANBAN_JOB_QUEUE_DATA_DIR;
		} else {
			process.env.KANBAN_JOB_QUEUE_DATA_DIR = prevDataDir;
		}

		tempDir.cleanup();
	}

	async function waitForJobs(count: number, timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const snapshot = await service.inspect();
			// The binary uses "succeeded" as the terminal success status.
			const succeeded = snapshot.jobs.status_counts.succeeded ?? 0;
			if (succeeded >= count) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 150));
		}

		// One last check to surface a readable failure message.
		const snapshot = await service.inspect();
		const succeeded = snapshot.jobs.status_counts.succeeded ?? 0;
		throw new Error(
			`Timed out waiting for ${count} succeeded jobs after ${timeoutMs}ms. ` +
				`Actual succeeded: ${succeeded}. ` +
				`Status counts: ${JSON.stringify(snapshot.jobs.status_counts)}`,
		);
	}

	return { service, start, stop, waitForJobs };
}
