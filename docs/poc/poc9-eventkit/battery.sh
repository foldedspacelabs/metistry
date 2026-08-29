#!/bin/zsh
# Full PoC-9 battery, to run once consent has been granted.
# Order: shell CRUD -> launchd CRUD -> cleanup -> leave sync artifact.
D=${0:a:h}
run() { echo; echo "################ $* ################"; }

run "SHELL: status"
"$D/ekpoc" status 2>&1

run "SHELL: test-events"
"$D/ekpoc" test-events 2>&1

run "SHELL: test-reminders"
"$D/ekpoc" test-reminders 2>&1

run "SHELL: cleanup (reset before launchd runs)"
"$D/ekpoc" cleanup 2>&1

run "LAUNCHD: status"
"$D/run-launchd.sh" status 30 2>&1

run "LAUNCHD: test-events"
"$D/run-launchd.sh" test-events 60 2>&1

run "LAUNCHD: test-reminders"
"$D/run-launchd.sh" test-reminders 60 2>&1

run "LAUNCHD: cleanup"
"$D/run-launchd.sh" cleanup 30 2>&1

run "LAUNCHD: sync-artifact (leaves ONE reminder behind for iPhone check)"
"$D/run-launchd.sh" sync-artifact 30 2>&1

echo; echo "################ BATTERY DONE ################"
