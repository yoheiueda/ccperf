#!/bin/bash

logdir=${1:-./logs}
target=${2:-100}
txtype=${3:-putstate}
num=${4:-1}
size=${5:-1}
duration=${6:-120}

set -ex

docker ps -a --format '{{ .ID }}' | xargs --no-run-if-empty docker rm -f
#sudo rm -fr ./storage/*
#sudo tar xzf ./storage.tar.gz
docker-compose up -d

sleep 10

./channel.sh
./deploy.sh

sleep 3

(cd "$logdir" && nmon -f -s 2 -c 5000 -t)

set +e
killall ./pprof.sh 2> /dev/null || true
( sleep 30; ./pprof.sh "$logdir" & sleep 60 ; killall pprof.sh) &

node ccperf.js run --profile connection-profile.yaml \
                 --processes 16 \
                 --target $target \
                 --duration $duration \
                 --org org1 \
                 --endorsing-peer peer1.org1.example.com \
                 --committing-peer peer1.org1.example.com \
                 --type "$txtype" \
                 --num "$num" \
                 --size "$size" \
                 --logdir "$logdir" | tee "$logdir/perf.log"

sleep 10

killall nmon || true

for c in $(docker ps --format '{{ .Names }}'); do
    docker logs $c > "$logdir/$c.log" 2>&1
done

docker-compose down
docker ps -a --format '{{ .ID }}' | xargs --no-run-if-empty docker rm -f
sleep 1
#sudo rm -fr ./storage/*
