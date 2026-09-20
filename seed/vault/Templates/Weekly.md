---
source: user
type: resource
tags: [template]
---
# Week of {{ date format: "YYYY-MM-DD" }}

## What shipped

## What is still open

{{ section "Overdue" if_empty: "hide" }}
{{ tasks where: "overdue" order: "due, priority" as: "list" }}
{{ /section }}

## Next week

## Notes
