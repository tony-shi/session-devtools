---
layout: default
title: Session List
parent: Product Capabilities
grand_parent: English
nav_order: 1
---

# Session List

The session list is the entry point of session-devtools — it shows all Claude Code sessions on your machine with key metrics, plus search and filtering.

---

## Overview

![Session list overview](../../assets/screenshots/session-list-overview.png)

<!-- Screenshot note: full-width view of the session list main UI -->

Each row represents one Claude Code session, showing (left to right): session name / working directory, start time, token usage, LLM call count, tool call count, sub-agent count.

---

## Session Card

![Session card detail](../../assets/screenshots/session-list-card.png)

<!-- Screenshot note: zoomed-in view of a single session row -->

| Field | Description |
|---|---|
| Session name | Auto-extracted from the first message |
| Working directory | Project path for the session |
| Token usage | Total input/output tokens (including cache) |
| LLM calls | Total number of LLM requests in this session |
| Tool calls | Total tool invocations |
| Sub-agents | Whether sub-agents exist and how many levels deep |

---

## Search & Filter

![Search feature](../../assets/screenshots/session-list-search.png)

<!-- Screenshot note: search box active, showing filtered results -->

Filter by:

- **Session ID** — exact match
- **Working directory** — fuzzy path match
- **First message** — keyword search

---

## Sub-agent Indicator

![Sub-agent indicator](../../assets/screenshots/session-list-subagent.png)

<!-- Screenshot note: session row with sub-agent badge highlighted -->

Sessions with sub-agents show a dedicated badge. Clicking through to session detail lets you expand the full agent hierarchy.
