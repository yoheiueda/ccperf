# Setup scripts to build an example Fabric network

## Prerequisites
* go
* [jq](https://stedolan.github.io/jq/)
* Python 3
  * `pip install jinja2 PyYAML`

## Set up instructions
```
. env.sh
./get.sh
./gen.sh
docker-compose up -d
./channel.sh
./deploy.sh
./invoke.sh
```

## Measurement
```
$ npm install
$ node ccperf.js run --help

  Usage: run [options]

  Options:

    --logdir [dir]            Directory name where log files are stored
    --processes [number]      Number of processes to be launched
    --profile [path]          Connection profile
    --target [number]         Target input TPS
    --duration [number]       Duration in second
    --org [string]            Organization name
    --type [string]           Type of workload (eg. putstate)
    --num [number]            Number of operations per transaction
    --size [bytes]            Payload size of a PutState call
    --population [number]     Number of prepopulated key-values
    --endorsing-peer [name]   Peer name to which transaction proposals are sent
    --committing-peer [name]  Peer name whose commit events are monitored
    -h, --help                output usage information

$ node ccperf.js run --profile connection-profile.yaml --processes 1 --target 100 --duration 30 --org org1 --endorsing-peer peer1.org1.example.com --committing-peer peer1.org1.example.com --type putstate --num 4 --size 64
Block 6 contains 106 transaction(s). TPS is 83.73
Block 7 contains 99 transaction(s). TPS is 102.48
Block 8 contains 100 transaction(s). TPS is 100.30
Block 9 contains 99 transaction(s). TPS is 98.31
Block 10 contains 99 transaction(s). TPS is 98.21
Block 11 contains 101 transaction(s). TPS is 101.41
Block 12 contains 100 transaction(s). TPS is 98.23
Block 13 contains 100 transaction(s). TPS is 99.50
Block 14 contains 100 transaction(s). TPS is 99.30
Block 15 contains 100 transaction(s). TPS is 99.90
Block 16 contains 99 transaction(s). TPS is 99.20
Block 17 contains 100 transaction(s). TPS is 99.11
Block 18 contains 100 transaction(s). TPS is 98.14
Block 19 contains 100 transaction(s). TPS is 99.70
Block 20 contains 101 transaction(s). TPS is 101.30
Block 21 contains 100 transaction(s). TPS is 98.72
Block 22 contains 100 transaction(s). TPS is 95.24
Block 23 contains 99 transaction(s). TPS is 101.64
Block 24 contains 100 transaction(s). TPS is 97.66
Block 25 contains 101 transaction(s). TPS is 103.59
Block 26 contains 99 transaction(s). TPS is 98.70
Block 27 contains 100 transaction(s). TPS is 97.94
Block 28 contains 100 transaction(s). TPS is 97.94
Block 29 contains 100 transaction(s). TPS is 99.90
Block 30 contains 101 transaction(s). TPS is 101.51
Block 31 contains 101 transaction(s). TPS is 100.90
Block 32 contains 100 transaction(s). TPS is 97.18
Block 33 contains 101 transaction(s). TPS is 100.80
Block 34 contains 101 transaction(s). TPS is 102.23
Block 35 contains 68 transaction(s). TPS is 68.20
 elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg peer.pctl orderer.pctl commit.pctl
       0    75.60       75.40      61.00     8.84        6.47     610.97     12.00         7.00     1022.00
       5    99.20       99.20      99.80     7.07        4.85     574.21      8.00         6.00      975.00
      10    99.20       99.20      99.80     7.21        4.91     567.16      8.00         6.00      969.00
      15    99.20       99.40     100.00     7.08        4.78     579.22      8.00         6.00      981.00
      20    99.40       99.40     100.00     6.76        4.53     577.64      8.00         6.00      979.00
      25   100.00       99.80     100.60     6.93        4.55     581.91      8.00         6.00      984.00
      30    22.20       22.40      33.60     6.43        4.23     623.61      7.00         6.00      974.00
```