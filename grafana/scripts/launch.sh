#!/bin/bash

/run.sh "$@" &
sleep 5
curl -q -H 'Accept: application/json' -H 'Content-type: application/json' -X PUT --data '{ "homeDashboardId": 1 }' --user "admin:$GF_SECURITY_ADMIN_PASSWORD" 'http://localhost:3000/api/org/preferences'
wait
