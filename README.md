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

    --logdir [dir]                  Directory name where log files are stored
    --processes [number]            Number of processes to be launched
    --profile [path]                Connection profile
    --channelID [channel]           Channel name
    --target [number]               Target input TPS
    --rampup [number]               Rampup in second
    --duration [number]             Duration in second
    --org [string]                  Organization name
    --type [string]                 Type of workload (eg. putstate)
    --num [number]                  Number of operations per transaction
    --size [bytes]                  Payload size of a PutState call
    --population [number]           Number of prepopulated key-values
    --tx-plugin                     JavaScript file that defines transaction handler
    --committing-peer [name]        Peer name whose commit events are monitored
    --endorsing-orgs [org1,org2]    Comma-separated list of organizations
    --orderer-selection [type]      Orderer selection method: first or balance. Default is first
    --grafana [url]                 Grafana endpoint URL
    --prometheus-pushgateway [url]  Prometheus endpoint URL
    --remote [hostport]             Remote worker daemons. Comma-separated list of host:port or local
    --client-keys [dir]             Directory for client keys
    -h, --help                      output usage information             output usage information

$ node ccperf.js run --profile connection-profile.yaml --processes 4 --target 50 --rampup 5 --duration 15 --committing-peer peer1.org1.example.com --type putstate --num 1 --size 64
Creating local driver
Started workers
Start:  1553489086324
End:  1553489101324
 elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg
       0    48.00       48.80      49.60    15.71        8.39      85.29
       5    48.80       48.80      47.20    13.44        7.78      80.16
      10    48.40       48.00      49.60    12.04        6.10      83.11
      15     0.40        0.80       0.80    10.50        8.00     122.25
```