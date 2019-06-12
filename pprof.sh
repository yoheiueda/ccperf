#!/bin/bash

seconds=${1:-60}
label=${2:-pprof}
logdir=${3:-./logs}
interval=5
host=localhost
list='orderer1 org1-peer1 dev-peer1.org1.example.com-ccperf-v1'
export http_proxy="http://$host:8888"

collect_start() {
    t=$(date -u +%s)

    for target in $list; do
      (
        curl -s "http://$target:6060/debug/pprof/wakeup?debug=2&rate=1000" > "$logdir/$label-wakeup-$target-$t.json"
        curl -s "http://$target:6060/debug/pprof/wakeup" > "$logdir/$label-wakeup-$target-$t.pb"
        curl -s "http://$target:6060/debug/pprof/block?seconds=$seconds&rate=1000" > "$logdir/$label-block-$target.pb" &
        curl -s "http://$target:6060/debug/pprof/profile?seconds=$seconds" > "$logdir/$label-cpu-$target.pb" &
      ) &
    done
}

collect_end() {
    t=$(date -u +%s)
    for target in $list; do
      (
        curl -s "http://$target:6060/debug/pprof/wakeup?debug=2" > "$logdir/$label-wakeup-$target-$t.json"
        curl -s "http://$target:6060/debug/pprof/wakeup" > "$logdir/$label-wakeup-$target-$t.pb"
        #curl -s "http://$target:6060/debug/pprof/block" > "$logdir/$label-block-$target-$t.pb" 
      ) &
    done
}

collect_start

while [[ $seconds > 0 ]] && [[ -z "$finish" ]] ; do
    t=$(date -u +%s)
    for target in $list; do
      curl -s "http://org1-peer1:6060/debug/pprof/goroutine?debug=2" > "$logdir/$label-goroutines-$target-$t.json"  &
    done
    (( seconds -= $interval ))
    sleep $interval || break
done

collect_end

wait

for target in $list; do
    if [ -x ./go-bottleneck ]; then
        ./go-bottleneck "$logdir"/$label-goroutines-$target-*.json "$logdir"/$label-wakeup-$target-*.json > "$logdir"/$label-$target.dot
        dot -Tpdf "$logdir"/$label-$target.dot > "$logdir"/$label-$target.pdf
    fi
    [ -d bin/FlameGraph ] && go tool pprof -raw "$logdir/$label-cpu-$target.pb" | bin/FlameGraph/stackcollapse-go.pl | bin/FlameGraph/flamegraph.pl > "$logdir/$label-cpu-$target.svg"
done
