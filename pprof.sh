#!/bin/bash

logdir=${1:-./logs}
host=localhost

export http_proxy="http://$host:8888"

while sleep 5; do
    t=$(date -u +%s)
    (
      curl -s "http://org1-peer1:6060/debug/pprof/goroutine?debug=2" > "$logdir/pprof-goroutines-peer1-$t.json" 
      curl -s "http://org1-peer1:6060/debug/pprof/block?debug=1" > "$logdir/pprof-block-peer1-$t.json" 
      curl -s "http://org1-peer1:6060/debug/pprof/wakeup?debug=2&rate=1000" > "$logdir/pprof-wakeup-peer1-$t.json"
    ) &
    (
      curl -s "http://orderer1:6060/debug/pprof/goroutine?debug=2" > "$logdir/pprof-goroutines-orderer1-$t.json" 
      curl -s "http://orderer1:6060/debug/pprof/block?debug=1" > "$logdir/pprof-block-orderer1-$t.json" 
      curl -s "http://orderer1:6060/debug/pprof/wakeup?debug=2&rate=1000" > "$logdir/pprof-wakeup-orderer1-$t.json" 
    ) &
    (
      curl -s "http://dev-peer1.org1.example.com-ccperf-v1:6060/debug/pprof/goroutine?debug=2" > "$logdir/pprof-goroutines-chaincode-$t.json" 
      curl -s "http://dev-peer1.org1.example.com-ccperf-v1:6060/debug/pprof/block?debug=1" > "$logdir/pprof-block-chaincode-$t.json" 
      curl -s "http://dev-peer1.org1.example.com-ccperf-v1:6060/debug/pprof/wakeup?debug=2&rate=1000" > "$logdir/pprof-wakeup-chaincode-$t.json"
    ) &
done
