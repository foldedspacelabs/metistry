---
source: user
type: resource
tags: [template]
---
# Standup — {{ date format: "YYYY-MM-DD" }}

{{ include "Me/Working Style.md#Standup" }}

## Yesterday

{{ tasks where: "done = yesterday and status = done" order: "priority" as: "list" }}

## Today

{{ tasks where: "due = today or do = today" order: "priority, due" as: "list" }}

## Blockers

{{ section "Blocked" if_empty: "hide" }}
{{ work where: "blocked" limit: 10 }}
{{ /section }}
