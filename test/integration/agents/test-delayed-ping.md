---
name: test-delayed-ping
description: Integration agent that emits a caller ping after one bounded delay
model: openai-codex/gpt-5.6-sol
thinking: low
tools: bash
spawning: false
auto-exit: true
disable-model-invocation: true
---

Follow the task literally. Run its single bounded sleep command once, then call `caller_ping` exactly once with the exact requested message. Never poll or loop. Do not use any other tools and do not add explanation.
