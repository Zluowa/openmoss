FROM node:24-bookworm
ARG CLAUDE_VERSION=2.1.316
ARG CODEX_VERSION=0.166.0
ARG BUN_VERSION=1.4.4
RUN test -n "$CLAUDE_VERSION" && test -n "$CODEX_VERSION" \
 && npm install -g "@anthropic-ai/claude-code@$CLAUDE_VERSION" "@openai/codex@$CODEX_VERSION" "bun@$BUN_VERSION" \
 && npm cache clean --force
ENV HOME=/tmp/moss-devs-home
ENV CODEX_HOME=/tmp/moss-devs-home/.codex
USER node
WORKDIR /workspace
