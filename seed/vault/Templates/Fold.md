---
source: user
type: resource
tags: [template]
---
# Fold — {{ date format: "YYYY-MM-DD" }}

## What happened

{{ prose "summarise yesterday in three lines" using: "Journal/Fold/{{date offset: -1}}" }}

## What was decided

{{ prose "list anything decided today, one line each; say so if nothing was" using: "Journal/{{date}}" }}

## Tasks found

{{ requests limit: 5 }}
