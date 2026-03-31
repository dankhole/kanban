import { useCallback, useEffect, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { buildProjectPathname, parseProjectIdFromPathname } from "@/hooks/app-utils";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import { useWindowEvent } from "@/utils/react-use";

const REMOVED_PROJECT_ERROR_PREFIX = "Project no longer exists on disk and was removed:";
const DIRECTORY_PICKER_UNAVAILABLE_MARKERS = [
	"could not open directory picker",
	'install "zenity" or "kdialog"',
	'install powershell ("powershell" or "pwsh")',
	'command "osascript" is not available',
] as const;
const MANUAL_PROJECT_PATH_PROMPT_MESSAGE =
	"Kanban could not open a directory picker on this runtime. Enter a project path to add:";

export function parseRemovedProjectPathFromStreamError(streamError: string | null): string | null {
	if (!streamError || !streamError.startsWith(REMOVED_PROJECT_ERROR_PREFIX)) {
		return null;
	}
	return streamError.slice(REMOVED_PROJECT_ERROR_PREFIX.length).trim();
}

export function isDirectoryPickerUnavailableErrorMessage(message: string | null | undefined): boolean {
	if (!message) {
		return false;
	}
	const normalized = message.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return DIRECTORY_PICKER_UNAVAILABLE_MARKERS.some((marker) => normalized.includes(marker));
}

function _promptForManualProjectPath(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	const rawValue = window.prompt(MANUAL_PROJECT_PATH_PROMPT_MESSAGE);
	if (rawValue === null) {
		return null;
	}
	const normalized = rawValue.trim();
	return normalized || null;
}

interface UseProjectNavigationInput {
	onProjectSwitchStart: () => void;
}

export interface UseProjectNavigationResult {
	requestedProjectId: string | null;
	navigationCurrentProjectId: string | null;
	removingProjectId: string | null;
	pendingGitInitializationPath: string | null;
	isInitializingGitProject: boolean;
	currentProjectId: string | null;
	projects: ReturnType<typeof useRuntimeStateStream>["projects"];
	workspaceState: ReturnType<typeof useRuntimeStateStream>["workspaceState"];
	workspaceMetadata: ReturnType<typeof useRuntimeStateStream>["workspaceMetadata"];
	latestTaskChatMessage: ReturnType<typeof useRuntimeStateStream>["latestTaskChatMessage"];
	taskChatMessagesByTaskId: ReturnType<typeof useRuntimeStateStream>["taskChatMessagesByTaskId"];
	latestTaskReadyForReview: ReturnType<typeof useRuntimeStateStream>["latestTaskReadyForReview"];
	latestMcpAuthStatuses: ReturnType<typeof useRuntimeStateStream>["latestMcpAuthStatuses"];
	clineSessionContextVersion: ReturnType<typeof useRuntimeStateStream>["clineSessionContextVersion"];
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	handleSelectProject: (projectId: string) => void;
	handleAddProject: () => Promise<void>;
	handleConfirmInitializeGitProject: () => Promise<void>;
	handleCancelInitializeGitProject: () => void;
	handleRemoveProject: (projectId: string) => Promise<boolean>;
	resetProjectNavigationState: () => void;
	// Folder picker dialog state — used when the native OS picker is unavailable.
	isFolderPickerOpen: boolean;
	handleFolderPickerSelect: (path: string) => Promise<void>;
	handleFolderPickerCancel: () => void;
}

export function useProjectNavigation({ onProjectSwitchStart }: UseProjectNavigationInput): UseProjectNavigationResult {
	const [requestedProjectId, setRequestedProjectId] = useState<string | null>(() => {
		if (typeof window === "undefined") {
			return null;
		}
		return parseProjectIdFromPathname(window.location.pathname);
	});
	const [pendingAddedProjectId, setPendingAddedProjectId] = useState<string | null>(null);
	const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
	const [pendingGitInitializationPath, setPendingGitInitializationPath] = useState<string | null>(null);
	const [isInitializingGitProject, setIsInitializingGitProject] = useState(false);
	const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

	const {
		currentProjectId,
		projects,
		workspaceState,
		workspaceMetadata,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		latestTaskReadyForReview,
		latestMcpAuthStatuses,
		clineSessionContextVersion,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
	} = useRuntimeStateStream(requestedProjectId);

	const hasNoProjects = hasReceivedSnapshot && projects.length === 0 && currentProjectId === null;
	const isProjectSwitching = requestedProjectId !== null && requestedProjectId !== currentProjectId && !hasNoProjects;
	const navigationCurrentProjectId = requestedProjectId ?? currentProjectId;

	const handleSelectProject = useCallback(
		(projectId: string) => {
			if (!projectId || projectId === currentProjectId) {
				return;
			}
			onProjectSwitchStart();
			setRequestedProjectId(projectId);
		},
		[currentProjectId, onProjectSwitchStart],
	);

	const addProjectByPath = useCallback(
		async (path: string, initializeGit = false) => {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const added = await trpcClient.projects.add.mutate({
				path,
				initializeGit,
			});
			if (!added.ok || !added.project) {
				if (added.requiresGitInitialization) {
					setPendingGitInitializationPath(path);
					return;
				}
				throw new Error(added.error ?? "Could not add project.");
			}
			setPendingGitInitializationPath(null);
			setPendingAddedProjectId(added.project.id);
			handleSelectProject(added.project.id);
		},
		[currentProjectId, handleSelectProject],
	);

	const handleAddProject = useCallback(async () => {
		// Try the native OS picker first; fall back to the in-browser folder picker.
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const picked = await trpcClient.projects.pickDirectory.mutate();

			if (picked.ok && picked.path) {
				await addProjectByPath(picked.path);
				return;
			}
			if (!picked.ok && picked.error === "No directory was selected.") {
				return;
			}
			// Native picker unavailable — open the in-browser folder picker.
			if (!picked.ok && isDirectoryPickerUnavailableErrorMessage(picked.error)) {
				setIsFolderPickerOpen(true);
				return;
			}
			throw new Error(picked.error ?? "Could not pick project directory.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// If the error looks like the native picker is just unavailable, open the UI picker.
			if (isDirectoryPickerUnavailableErrorMessage(message)) {
				setIsFolderPickerOpen(true);
				return;
			}
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		}
	}, [addProjectByPath, currentProjectId]);

	const handleFolderPickerSelect = useCallback(
		async (path: string) => {
			setIsFolderPickerOpen(false);
			await addProjectByPath(path);
		},
		[addProjectByPath],
	);

	const handleFolderPickerCancel = useCallback(() => {
		setIsFolderPickerOpen(false);
	}, []);

	const handleConfirmInitializeGitProject = useCallback(async () => {
		if (!pendingGitInitializationPath || isInitializingGitProject) {
			return;
		}
		setIsInitializingGitProject(true);
		try {
			await addProjectByPath(pendingGitInitializationPath, true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message,
				timeout: 7000,
			});
		} finally {
			setIsInitializingGitProject(false);
		}
	}, [addProjectByPath, isInitializingGitProject, pendingGitInitializationPath]);

	const handleCancelInitializeGitProject = useCallback(() => {
		if (isInitializingGitProject) {
			return;
		}
		setPendingGitInitializationPath(null);
	}, [isInitializingGitProject]);

	const handleRemoveProject = useCallback(
		async (projectId: string): Promise<boolean> => {
			if (removingProjectId) {
				return false;
			}
			setRemovingProjectId(projectId);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.projects.remove.mutate({ projectId });
				if (!payload.ok) {
					throw new Error(payload.error ?? "Could not remove project.");
				}
				if (currentProjectId === projectId) {
					onProjectSwitchStart();
					setRequestedProjectId(null);
				}
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return false;
			} finally {
				setRemovingProjectId((current) => (current === projectId ? null : current));
			}
		},
		[currentProjectId, onProjectSwitchStart, removingProjectId],
	);

	const handlePopState = useCallback(() => {
		if (typeof window === "undefined") {
			return;
		}
		const nextProjectId = parseProjectIdFromPathname(window.location.pathname);
		setRequestedProjectId(nextProjectId);
	}, []);
	useWindowEvent("popstate", handlePopState);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!currentProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		const nextPathname = buildProjectPathname(currentProjectId);
		if (nextUrl.pathname === nextPathname) {
			return;
		}
		window.history.replaceState({}, "", `${nextPathname}${nextUrl.search}${nextUrl.hash}`);
	}, [currentProjectId]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!hasNoProjects || !requestedProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		if (nextUrl.pathname !== "/") {
			window.history.replaceState({}, "", `/${nextUrl.search}${nextUrl.hash}`);
		}
		setRequestedProjectId(null);
	}, [hasNoProjects, requestedProjectId]);

	useEffect(() => {
		if (!pendingAddedProjectId) {
			return;
		}
		const projectExists = projects.some((project) => project.id === pendingAddedProjectId);
		if (!projectExists && currentProjectId !== pendingAddedProjectId) {
			return;
		}
		setPendingAddedProjectId(null);
	}, [currentProjectId, pendingAddedProjectId, projects]);

	useEffect(() => {
		if (!requestedProjectId || !currentProjectId) {
			return;
		}
		if (pendingAddedProjectId && requestedProjectId === pendingAddedProjectId) {
			return;
		}
		const requestedStillExists = projects.some((project) => project.id === requestedProjectId);
		if (requestedStillExists) {
			return;
		}
		setRequestedProjectId(currentProjectId);
	}, [currentProjectId, pendingAddedProjectId, projects, requestedProjectId]);

	const resetProjectNavigationState = useCallback(() => {
		setRemovingProjectId(null);
		setPendingGitInitializationPath(null);
		setIsInitializingGitProject(false);
	}, []);

	return {
		requestedProjectId,
		navigationCurrentProjectId,
		removingProjectId,
		pendingGitInitializationPath,
		isInitializingGitProject,
		currentProjectId,
		projects,
		workspaceState,
		workspaceMetadata,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		latestTaskReadyForReview,
		latestMcpAuthStatuses,
		clineSessionContextVersion,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handleAddProject,
		handleConfirmInitializeGitProject,
		handleCancelInitializeGitProject,
		handleRemoveProject,
		resetProjectNavigationState,
		isFolderPickerOpen,
		handleFolderPickerSelect,
		handleFolderPickerCancel,
	};
}
