#!/bin/sh
# SessionStart hook — injects WorshipApp's working protocol into the model's context.
# Loop-free: SessionStart runs once per session and only ADDS context.
set -eu

DIR="${CLAUDE_PROJECT_DIR:-.}"
INDEX="$DIR/.claude/knowledge/INDEX.md"

INDEX_BODY=""
if [ -f "$INDEX" ]; then
  INDEX_BODY=$(grep '^- \[' "$INDEX" || true)
fi

CONTEXT=$(printf '%s\n' \
  "Himnova Live — mandatory protocol for this session (see CLAUDE.md for the details):" \
  "" \
  "1. CERTAINTY BEFORE CODE: before writing non-trivial code, list your assumptions and use" \
  "   AskUserQuestion until you reach ~99% certainty about what the user wants. Never" \
  "   assume scope, UX or behavior. Exceptions: typos, obvious renames and read-only" \
  "   requests (explain, search, audit)." \
  "2. SELF-IMPROVEMENT CYCLE: when closing a non-trivial task, decide whether a durable" \
  "   finding came up (something not derivable from the code, that was costly to discover and" \
  "   will matter again). If so, record it with the /learn skill in .claude/knowledge/ + one" \
  "   line in INDEX.md." \
  "3. MINIMUM BAR before calling a task done: npm run typecheck && npm run lint" \
  "   && npm run test." \
  "" \
  "Index of findings already recorded in .claude/knowledge/ (read it before touching those areas):" \
  "$INDEX_BODY")

jq -n --arg ctx "$CONTEXT" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
