---
source: user
type: resource
tags: [template]
---
# Morning Brief — {{ date format: "YYYY-MM-DD" }}

{{ prose "In two or three sentences: what matters most today, and the one thing that moved since yesterday" using: "Journal/Fold/{{date offset: -1}}" }}

## Standup

![[Journal/Standup/{{ date format: "YYYY-MM-DD" }}]]

## Next Up

{{ section "Waiting on you" if_empty: "hide" }}
{{ requests limit: 5 }}
{{ /section }}

The plan is the day below — [[Journal/Plan/{{ date format: "YYYY-MM-DD" }}]]
