import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { handleClineMcpOauthCallback } from "../cline-sdk/cline-mcp-runtime-service";
import {
	type ClineTaskSessionService,
	createInMemoryClineTaskSessionService,
} from "../cline-sdk/cline-task-session-service";
import { createClineWatcherRegistry } from "../cline-sdk/cline-watcher-registry";
import type { RuntimeCommandRunResponse, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import {
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
} from "../core/runtime-endpoint";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createHooksApi } from "../trpc/hooks-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createRuntimeApi } from "../trpc/runtime-api";
import { createWorkspaceApi } from "../trpc/workspace-api";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import type { RuntimeStateHub } from "./runtime-state-hub";
import type { WorkspaceRegistry } from "./workspace-registry";

interface DisposeTrackedWorkspaceResult {
	terminalManager: TerminalSessionManager | null;
	workspacePath: string | null;
}

export interface CreateRuntimeServerDependencies {
	workspaceRegistry: WorkspaceRegistry;
	runtimeStateHub: RuntimeStateHub;
	warn: (message: string) => void;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeWorkspace: (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedWorkspaceResult;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeWorkspaceStateResponse["board"]) => Set<string>;
	pickDirectoryPathFromSystemDialog: () => string | null;
}

export interface RuntimeServer {
	url: string;
	close: () => Promise<void>;
}

function readWorkspaceIdFromRequest(request: IncomingMessage, requestUrl: URL): string | null {
	const headerValue = request.headers["x-kanban-workspace-id"];
	const headerWorkspaceId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerWorkspaceId === "string") {
		const normalized = headerWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryWorkspaceId = requestUrl.searchParams.get("workspaceId");
	if (typeof queryWorkspaceId === "string") {
		const normalized = queryWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

export async function createRuntimeServer(deps: CreateRuntimeServerDependencies): Promise<RuntimeServer> {
	// ---------------------------------------------------------------------------
	// Job queue sidecar — instantiate once, reuse across all requests.
	// ---------------------------------------------------------------------------
	// We inline the import here so the linter cannot strip it as "unused" before
	// the service is wired into the TRPC context below.
	const { JobQueueService } = await import("./job-queue-service");
	const { createJobsApi } = await import("../trpc/jobs-api");
	const jobQueueService = new JobQueueService();
	const jobsApi = createJobsApi({ getJobQueueService: () => jobQueueService });

	// ---------------------------------------------------------------------------
	// Automation Agents — imports only; service is constructed after all deps
	// are wired (see the block just before createTrpcContext, below).
	// ---------------------------------------------------------------------------
	const { AutomationService } = await import("../automations/automation-service");
	const { createAutomationsApi } = await import("../trpc/automations-api");
	const { templateRegistry } = await import("../automations/template-registry");
	const { QUALITY_ENFORCER_TEMPLATE } = await import("../automations/agents/quality-enforcer/template");
	const { qualityEnforcerRules } = await import("../automations/agents/quality-enforcer/rules");
	const { ruleCatalog } = await import("../automations/rule-catalog");
	const { addTaskToColumn } = await import("../core/task-board-mutations");
	const { mutateWorkspaceState } = await import("../state/workspace-state");

	// Start sidecar if the binary is available — failure is non-fatal.
	if (jobQueueService.isAvailable()) {
		jobQueueService
			.startSidecar()
			.then(async () => {
				// Seed periodic maintenance jobs after the sidecar is ready.
				const { seedMaintenanceJobs, seedProjectAutomationJobs } = await import("./maintenance-jobs");
				await seedMaintenanceJobs(jobQueueService);
				// Seed per-project automation watchers (dependency auto-start, etc.).
				await seedProjectAutomationJobs(jobQueueService, getKanbanRuntimeOrigin());
				// Wire inspect-snapshot polling → WebSocket health broadcast (30 s cadence).
				jobQueueService.startInspectPolling(30_000, (snapshot) => {
					deps.runtimeStateHub.broadcastJobQueueStatus(
						jobQueueService.isSidecarRunning(),
						snapshot as unknown as Record<string, unknown>,
						jobsApi.getActiveBatches(),
					);
				});
			})
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				deps.warn(`[job-queue] sidecar failed to start: ${msg}`);
			});
	}

	const webUiDir = getWebUiDir();

	try {
		await readFile(join(webUiDir, "index.html"));
	} catch {
		throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
	}

	const resolveWorkspaceScopeFromRequest = async (
		request: IncomingMessage,
		requestUrl: URL,
	): Promise<{
		requestedWorkspaceId: string | null;
		workspaceScope: RuntimeTrpcWorkspaceScope | null;
	}> => {
		const requestedWorkspaceId = readWorkspaceIdFromRequest(request, requestUrl);
		if (!requestedWorkspaceId) {
			return {
				requestedWorkspaceId: null,
				workspaceScope: null,
			};
		}
		const requestedWorkspaceContext = await loadWorkspaceContextById(requestedWorkspaceId);
		if (!requestedWorkspaceContext) {
			return {
				requestedWorkspaceId,
				workspaceScope: null,
			};
		}
		return {
			requestedWorkspaceId,
			workspaceScope: {
				workspaceId: requestedWorkspaceContext.workspaceId,
				workspacePath: requestedWorkspaceContext.repoPath,
			},
		};
	};

	const getScopedTerminalManager = async (scope: RuntimeTrpcWorkspaceScope): Promise<TerminalSessionManager> =>
		await deps.ensureTerminalManagerForWorkspace(scope.workspaceId, scope.workspacePath);
	const clineTaskSessionServiceByWorkspaceId = new Map<string, ClineTaskSessionService>();
	const clineWatcherRegistry = createClineWatcherRegistry();
	const getScopedClineTaskSessionService = async (
		scope: RuntimeTrpcWorkspaceScope,
	): Promise<ClineTaskSessionService> => {
		let service = clineTaskSessionServiceByWorkspaceId.get(scope.workspaceId);
		if (!service) {
			service = createInMemoryClineTaskSessionService({
				watcherRegistry: clineWatcherRegistry,
			});
			clineTaskSessionServiceByWorkspaceId.set(scope.workspaceId, service);
			deps.runtimeStateHub.trackClineTaskSessionService(scope.workspaceId, scope.workspacePath, service);
		}
		return service;
	};
	const disposeClineTaskSessionServiceAsync = async (workspaceId: string): Promise<void> => {
		const service = clineTaskSessionServiceByWorkspaceId.get(workspaceId);
		if (!service) {
			return;
		}
		clineTaskSessionServiceByWorkspaceId.delete(workspaceId);
		await service.dispose();
	};
	const disposeClineTaskSessionService = (workspaceId: string): void => {
		void disposeClineTaskSessionServiceAsync(workspaceId);
	};
	const prepareForStateReset = async (): Promise<void> => {
		const workspaceIds = new Set<string>();
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspaceIds.add(workspaceId);
		}
		for (const workspaceId of clineTaskSessionServiceByWorkspaceId.keys()) {
			workspaceIds.add(workspaceId);
		}
		const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
		if (activeWorkspaceId) {
			workspaceIds.add(activeWorkspaceId);
		}
		for (const workspaceId of workspaceIds) {
			await disposeClineTaskSessionServiceAsync(workspaceId);
			deps.disposeWorkspace(workspaceId, {
				stopTerminalSessions: true,
			});
		}
		deps.workspaceRegistry.clearActiveWorkspace();
	};

	// ---------------------------------------------------------------------------
	// Automation Agents — construct the service now that all deps are available.
	// ---------------------------------------------------------------------------

	// Register the Quality Enforcer template and rules (idempotent at boot).
	if (!templateRegistry.hasTemplate(QUALITY_ENFORCER_TEMPLATE.id)) {
		templateRegistry.registerTemplate(QUALITY_ENFORCER_TEMPLATE);
	}
	for (const rule of qualityEnforcerRules) {
		if (!ruleCatalog.getEvaluator(rule.rule.id)) {
			ruleCatalog.registerRule(rule);
		}
	}

	const automationService = new AutomationService({
		getBoardState: async (projectPath) => {
			const match = deps.workspaceRegistry.listManagedWorkspaces().find((w) => w.workspacePath === projectPath);
			if (!match || !match.workspacePath) {
				return null;
			}
			try {
				const state = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(
					match.workspaceId,
					match.workspacePath,
				);
				return {
					cards: state.board.columns.flatMap((col) => col.cards),
					sessions: state.sessions,
				};
			} catch {
				return null;
			}
		},
		createTask: async (workspacePath, prompt, options) => {
			const result = await mutateWorkspaceState(workspacePath, (state) => {
				const baseRef = state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0] ?? "";
				if (!baseRef) {
					throw new Error(`Could not determine base ref for workspace at ${workspacePath}`);
				}
				const added = addTaskToColumn(
					state.board,
					"backlog",
					{
						prompt,
						baseRef,
						createdByAutomation: options?.automationInstanceId ?? null,
						automationFindingFingerprint: options?.findingFingerprint ?? null,
					},
					() => globalThis.crypto.randomUUID(),
				);
				return { board: added.board, value: added.task };
			});
			const taskId = result.value.id;

			// Auto-start if requested.
			if (options?.autoStart) {
				const workspaceEntry = deps.workspaceRegistry
					.listManagedWorkspaces()
					.find((w) => w.workspacePath === workspacePath);
				if (workspaceEntry) {
					const scope = { workspaceId: workspaceEntry.workspaceId, workspacePath };
					// Create a fresh runtimeApi (cheap — just closures) and start the
					// task asynchronously so the scan result returns immediately.
					const runtimeApi = createRuntimeApi({
						getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
						getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
						loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
						setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
						getScopedTerminalManager,
						getScopedClineTaskSessionService,
						resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
						runCommand: deps.runCommand,
						broadcastClineMcpAuthStatusesUpdated: deps.runtimeStateHub.broadcastClineMcpAuthStatusesUpdated,
						broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
						bumpClineSessionContextVersion: deps.runtimeStateHub.bumpClineSessionContextVersion,
						prepareForStateReset,
					});
					runtimeApi
						.startTaskSession(scope, {
							taskId,
							prompt,
							baseRef: result.value.baseRef,
						})
						.catch((err: unknown) => {
							const msg = err instanceof Error ? err.message : String(err);
							process.stderr.write(`[automation-service] auto-start failed for task ${taskId}: ${msg}\n`);
						});
				}
			}

			return { taskId };
		},
		broadcastUpdated: (payload) => {
			deps.runtimeStateHub.broadcastAutomationUpdated(payload);
		},
	});

	automationService.start().catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		deps.warn(`[automation-service] failed to start: ${msg}`);
	});

	const automationsApi = createAutomationsApi({
		getAutomationService: () => automationService,
	});

	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
		return {
			requestedWorkspaceId: scope.requestedWorkspaceId,
			workspaceScope: scope.workspaceScope,
			runtimeApi: createRuntimeApi({
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
				loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
				setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
				getScopedTerminalManager,
				getScopedClineTaskSessionService,
				resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
				runCommand: deps.runCommand,
				broadcastClineMcpAuthStatusesUpdated: deps.runtimeStateHub.broadcastClineMcpAuthStatusesUpdated,
				broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
				bumpClineSessionContextVersion: deps.runtimeStateHub.bumpClineSessionContextVersion,
				prepareForStateReset,
			}),
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				getScopedClineTaskSessionService,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
			}),
			projectsApi: createProjectsApi({
				getActiveWorkspacePath: deps.workspaceRegistry.getActiveWorkspacePath,
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				rememberWorkspace: deps.workspaceRegistry.rememberWorkspace,
				setActiveWorkspace: deps.workspaceRegistry.setActiveWorkspace,
				clearActiveWorkspace: deps.workspaceRegistry.clearActiveWorkspace,
				resolveProjectInputPath: deps.resolveProjectInputPath,
				assertPathIsDirectory: deps.assertPathIsDirectory,
				hasGitRepository: deps.hasGitRepository,
				summarizeProjectTaskCounts: deps.workspaceRegistry.summarizeProjectTaskCounts,
				createProjectSummary: deps.workspaceRegistry.createProjectSummary,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				getTerminalManagerForWorkspace: deps.workspaceRegistry.getTerminalManagerForWorkspace,
				disposeWorkspace: (workspaceId, options) => {
					disposeClineTaskSessionService(workspaceId);
					return deps.disposeWorkspace(workspaceId, options);
				},
				collectProjectWorktreeTaskIdsForRemoval: deps.collectProjectWorktreeTaskIdsForRemoval,
				warn: deps.warn,
				buildProjectsPayload: deps.workspaceRegistry.buildProjectsPayload,
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
			}),
			hooksApi: createHooksApi({
				getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
			}),
			automationsApi,
			jobsApi,
		};
	};

	const trpcHttpHandler = createHTTPHandler({
		basePath: "/api/trpc/",
		router: runtimeAppRouter,
		createContext: async ({ req }) => await createTrpcContext(req),
	});

	const server = createServer(async (req, res) => {
		try {
			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);
			const oauthCallbackResponse = await handleClineMcpOauthCallback(requestUrl);
			if (oauthCallbackResponse) {
				res.writeHead(oauthCallbackResponse.statusCode, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(oauthCallbackResponse.body);
				return;
			}
			if (pathname.startsWith("/api/trpc")) {
				await trpcHttpHandler(req, res);
				return;
			}
			if (pathname.startsWith("/api/")) {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"error":"Not found"}');
				return;
			}

			const asset = await readAsset(webUiDir, pathname);
			res.writeHead(200, {
				"Content-Type": asset.contentType,
				"Cache-Control": "no-store",
			});
			res.end(asset.content);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
		}
	});
	server.on("upgrade", (request, socket, head) => {
		let requestUrl: URL;
		try {
			requestUrl = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
		} catch {
			socket.destroy();
			return;
		}
		if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
			return;
		}
		(request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled = true;
		const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId")?.trim() || null;
		deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedWorkspaceId });
	});
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		server,
		resolveTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
		isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
		isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
	});
	server.on("upgrade", (request, socket) => {
		const handled = (request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled;
		if (handled) {
			return;
		}
		socket.destroy();
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(getKanbanRuntimePort(), getKanbanRuntimeHost(), () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to start local server.");
	}
	const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
	const url = activeWorkspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimeOrigin();

	return {
		url,
		close: async () => {
			await Promise.all(
				Array.from(clineTaskSessionServiceByWorkspaceId.values()).map(async (service) => {
					await service.dispose();
				}),
			);
			clineTaskSessionServiceByWorkspaceId.clear();
			await clineWatcherRegistry.close();
			await deps.runtimeStateHub.close();
			await terminalWebSocketBridge.close();
			// Stop inspect polling before stopping the sidecar so no background
			// calls race with the shutdown.
			automationService.stop();
			jobQueueService.stopInspectPolling();
			// Stop the job queue sidecar before closing the HTTP server so that
			// any in-flight jobs have a chance to complete.
			await jobQueueService.stopSidecar().catch(() => {
				/* non-fatal */
			});
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			});
		},
	};
}
