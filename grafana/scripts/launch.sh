#!/bin/bash

dashboard_uid=fabric1

/run.sh "$@" &
sleep 5
id=$(curl -s -H 'Accept: application/json' -X GET --user "admin:$GF_SECURITY_ADMIN_PASSWORD" "http://localhost:3000/api/dashboards/uid/$dashboard_uid" | grep -Po '"dashboard":.*?"id":\K\d+')
curl -q -H 'Accept: application/json' -H 'Content-type: application/json' -X PUT --data "{ \"homeDashboardId\": $id }" --user "admin:$GF_SECURITY_ADMIN_PASSWORD" 'http://localhost:3000/api/org/preferences'
wait
