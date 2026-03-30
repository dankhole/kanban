#!/bin/bash
set -euo pipefail
# Dependency-driven auto-start watcher.
# Polls for backlog tasks with autoStartWhenReady=true whose dependencies are
# all satisfied (in trash), then starts them up to CONCURRENCY_LIMIT at a time.
# Self-rescheduling via job queue.
#
# Args:
#   $1 = KANBAN_RUNTIME_URL
#   $2 = JOB_QUEUE_DB_URL
#   $3 = INTERVAL_SECS        (default: 30)
#   $4 = PROJECT_PATH
#   $5 = CONCURRENCY_LIMIT    (default: 2)
#   $6 = STATE_FILE

RUNTIME_URL="${1:?KANBAN_RUNTIME_URL is required}"
JOB_QUEUE_DB_URL="${2:?JOB_QUEUE_DB_URL is required}"
INTERVAL="${3:-30}"
PROJECT_PATH="${4:?PROJECT_PATH is required}"
CONCURRENCY_LIMIT="${5:-2}"
STATE_FILE="${6:-${HOME}/.kanban/job-queue/state/dependency-auto-start.iter}"

mkdir -p "$(dirname "$STATE_FILE")"
iter=0
[ -f "$STATE_FILE" ] && iter=$(cat "$STATE_FILE")
iter=$((iter + 1))
echo "$iter" > "$STATE_FILE"

echo "[dependency-auto-start] Iteration $iter — project: $PROJECT_PATH"

KANBAN_BIN="${KANBAN_BIN:-kanban}"

# Ask Kanban for backlog tasks with autoStartWhenReady=true and all deps in trash
READY_OUTPUT=$(
  "$KANBAN_BIN" task list-ready \
    --project-path "$PROJECT_PATH" \
    --json 2>/dev/null || echo '{"ok":false,"tasks":[]}'
)

COUNT=$(echo "$READY_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tasks = data.get('tasks', [])
print(len(tasks))
" 2>/dev/null || echo "0")

echo "[dependency-auto-start] Found $COUNT ready task(s)."

if [ "$COUNT" -gt 0 ]; then
  # Start up to CONCURRENCY_LIMIT tasks
  echo "$READY_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
tasks = data.get('tasks', [])
limit = int('${CONCURRENCY_LIMIT}')
for t in tasks[:limit]:
    print(t.get('id', ''))
" 2>/dev/null | while IFS= read -r task_id; do
    if [ -n "$task_id" ]; then
      echo "[dependency-auto-start] Auto-starting task: $task_id"
      "$KANBAN_BIN" task start \
        --task-id "$task_id" \
        --project-path "$PROJECT_PATH" 2>&1 || \
        echo "[dependency-auto-start] Warning: could not start task $task_id"
    fi
  done
fi

echo "[dependency-auto-start] Iteration $iter complete."

# Schedule next run
JOB_QUEUE_BIN="${KANBAN_JOB_QUEUE_BINARY:-job_queue}"
"$JOB_QUEUE_BIN" --database-url "$JOB_QUEUE_DB_URL" schedule \
  --queue kanban.automation \
  --due-in "${INTERVAL}s" \
  --command "$0" \
  --arg "$RUNTIME_URL" \
  --arg "$JOB_QUEUE_DB_URL" \
  --arg "$INTERVAL" \
  --arg "$PROJECT_PATH" \
  --arg "$CONCURRENCY_LIMIT" \
  --arg "$STATE_FILE" \
  2>&1 && echo "[dependency-auto-start] Next run scheduled in ${INTERVAL}s."
