#!/bin/bash

logdir=${1:-./logs}
host=localhost

docker rm -f socat 2> /dev/null || true
docker run -d --name socat --network net_ccperf --publish 7062:7062 socat tcp-listen:7062,fork,reuseaddr tcp-connect:dev-peer1.org1.example.com-ccperf-v1:6060

while sleep 5; do
    t=$(date -u +%s)
    (
      curl -s "http://$host:7060/debug/pprof/goroutine?debug=2" > "$logdir/pprof-goroutines-orderer1.json" 
      #curl -s "http://$host:7060/debug/pprof/block?debug=1" > "$logdir/pprof-block-orderer1.json" 
      #curl -s "http://$host:7060/debug/pprof/wakeup?debug=2&rate=1000" > "$logdir/pprof-wakeup-peer1-$t.json"
    ) &
    (
      curl -s "http://$host:7061/debug/pprof/goroutine?debug=2" > "$logdir/pprof-goroutines-$t.json" 
      #curl -s "http://$host:7061/debug/pprof/block?debug=1" > "$logdir/pprof-block-peer1-$t.json" 
      #curl -s "http://$host:7061/debug/pprof/wakeup?debug=2&rate=1000" > "$logdir/pprof-wakeup-peer1-$t.json" 
    ) &
    (
      curl -s "http://$host:7062/debug/pprof/goroutine?debug=2" > "$logdir/pprof-goroutines-chaincode-$t.json" 
      #curl -s "http://$host:7062/debug/pprof/block?debug=1" > "$logdir/pprof-block-chaincode.json" 
      #curl -s "http://$host:7062/debug/pprof/wakeup?debug=2&rate=1000" > "$logdir/pprof-chaincode-goroutines-$t.json"
    ) &
done

docker rm -f socat
