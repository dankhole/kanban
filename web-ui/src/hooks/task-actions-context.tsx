import type { ReactElement, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

export interface TaskActionsContextValue {
	createTask: () => void;
	startAllBacklogTasks: () => void;
	openClearTrash: () => void;
}

const TaskActionsContext = createContext<TaskActionsContextValue | null>(null);

export function TaskActionsProvider({
	children,
	createTask,
	startAllBacklogTasks,
	openClearTrash,
}: TaskActionsContextValue & { children: ReactNode }): ReactElement {
	const value = useMemo<TaskActionsContextValue>(
		() => ({ createTask, startAllBacklogTasks, openClearTrash }),
		[createTask, startAllBacklogTasks, openClearTrash],
	);

	return <TaskActionsContext.Provider value={value}>{children}</TaskActionsContext.Provider>;
}

export function useTaskActions(): TaskActionsContextValue {
	const ctx = useContext(TaskActionsContext);
	if (!ctx) {
		throw new Error("useTaskActions must be used within a TaskActionsProvider");
	}
	return ctx;
}
