#!/bin/bash

logtop='./logs'

mkdir -p "$logtop"

duration=120

function run() {
        logdir=$(printf "$logtop/$txtype-%02d-%05d/%04d" $num $size $target)
        if ! [ -e "$logdir" ]; then
            mkdir -p "$logdir"
            ./run.sh "$logdir" $target $txtype $num $size 2>&1 | tee "$logdir/run.log"
        fi
}

for txtype in putstate; do
  for num in 8; do
    for size in 64; do
      for target in $(seq 200 200 2000); do
        run
      done
    done
  done
done
