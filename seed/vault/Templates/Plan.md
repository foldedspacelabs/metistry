---
source: user
type: resource
tags: [template]
---
# Plan — {{ date format: "YYYY-MM-DD" offset: 1 }}

{{ calendar day: tomorrow }}

{{ section "Recurring tomorrow" if_empty: "hide" }}
{{ recurring due: tomorrow }}
{{ /section }}

{{ section "Today's tasks" if_empty: "hide" }}
{{ tasks where: "due <= tomorrow or overdue" order: "priority, due, size" limit: 10 as: "list" }}
{{ /section }}

{{ section "⛔ Agents are waiting on you" if_empty: "hide" }}
{{ work where: "blocked or waiting_on_me" limit: 5 }}
{{ /section }}

{{ section "Requests" if_empty: "hide" }}
{{ requests limit: 5 }}
{{ /section }}

## Prioritisation

{{ include "Me/Working Style.md#Prioritisation" }}
