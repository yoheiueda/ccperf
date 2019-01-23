#!/bin/bash

os=$(go env GOOS)
arch=$(go env GOARCH)

. ./env.sh

mkdir -p bin
mkdir -p go/bin

go get -u github.com/google/pprof
go get -u github.com/uber/go-torch

[ -d "$PWD/FlameGraph" ] || git clone https://github.com/brendangregg/FlameGraph.git bin/FlameGraph

docker run --rm hyperledger/fabric-tools:$FABRIC_TAG tar -cf - -C /usr/local/bin configtxgen configtxlator cryptogen discover idemixgen peer | tar -xvf - -C ./bin
docker run --rm hyperledger/fabric-tools:$FABRIC_TAG cat /etc/hyperledger/fabric/core.yaml > core.yaml

[ $(docker image ls -q tinyproxy) == "" ] && (cd dockerfiles/tinyproxy && ./build.sh)
