#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — blocks any `git commit` whose message
# contains an AI-authorship marker (Co-Authored-By, Anthropic, "Generated
# with Claude", robot emoji). Voir CLAUDE.md : ce depot est un projet a deux
# humains, les messages de commit ne doivent mentionner ni IA ni assistant.
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

# Ne s'applique qu'aux invocations de `git commit` — le reste passe.
if ! printf '%s' "$cmd" | grep -qiE '\bgit\b.*\bcommit\b'; then
  echo '{}'
  exit 0
fi

if printf '%s' "$cmd" | grep -qiE 'co-authored-by|noreply@anthropic\.com|generated with \[?claude|🤖'; then
  reason="Commit bloque : le message contient une mention d'auteur IA (Co-Authored-By / Anthropic / Generated with Claude / robot emoji). Ce depot interdit ces mentions dans les messages de commit (voir CLAUDE.md) - reformule le message sans elles."
  jq -n --arg reason "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
else
  echo '{}'
fi
