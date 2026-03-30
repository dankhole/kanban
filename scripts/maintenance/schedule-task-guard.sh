#!/bin/bash
set -euo pipefail
# Guard script for scheduled task execution.
# Called by the job queue when a scheduled task is due.
# Checks whether the task is still in the backlog before starting it,
# so that trashing or manually starting a scheduled task before the due
# time results in a clean no-op rather than an error.
#
# Args:
#   $1 = TASK_ID
#   $2 = PROJECT_PATH
#   $3 = BASE_REF (optional, default: main)

TASK_ID="${1:?TASK_ID is required}"
PROJECT_PATH="${2:?PROJECT_PATH is required}"
BASE_REF="${3:-main}"

echo "[schedule-task-guard] Checking task $TASK_ID in $PROJECT_PATH"

# Use `kanban task list` to check the current column of this task
KANBAN_BIN="${KANBAN_BIN:-kanban}"
TASK_INFO=$(
  "$KANBAN_BIN" task list \
    --project-path "$PROJECT_PATH" \
    --json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
tasks = data.get('tasks', [])
for t in tasks:
    if t.get('id') == '${TASK_ID}':
        print(json.dumps({'column': t.get('column', ''), 'id': t.get('id', '')}))
        break
" 2>/dev/null || true
)

if [ -z "$TASK_INFO" ]; then
  echo "[schedule-task-guard] Task $TASK_ID not found — may have been deleted. Skipping."
  exit 0
fi

COLUMN=$(echo "$TASK_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('column',''))" 2>/dev/null || true)

if [ "$COLUMN" != "backlog" ]; then
  echo "[schedule-task-guard] Task $TASK_ID is in '$COLUMN', not 'backlog'. Skipping scheduled start."
  exit 0
fi

echo "[schedule-task-guard] Task $TASK_ID is in backlog. Starting now."
"$KANBAN_BIN" task start \
  --task-id "$TASK_ID" \
  --project-path "$PROJECT_PATH"

echo "[schedule-task-guard] Task $TASK_ID started successfully."
