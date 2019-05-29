#!/bin/bash

os=$(go env GOOS)
arch=$(go env GOARCH)

. ./env.sh

mkdir -p bin
mkdir -p go/bin

go get -u github.com/google/pprof
go get -u github.com/uber/go-torch

[ -d "bin/FlameGraph" ] || git clone https://github.com/brendangregg/FlameGraph.git bin/FlameGraph

rel=2.0.0-alpha
url="https://nexus.hyperledger.org/content/repositories/releases/org/hyperledger/fabric/hyperledger-fabric/$os-$arch-$rel/hyperledger-fabric-$os-$arch-$rel.tar.gz"
curl "$url" | tar xzf - bin

[ ! -e core.yaml ] && docker run --rm hyperledger/fabric-tools:$FABRIC_TAG cat /etc/hyperledger/fabric/core.yaml > core.yaml

[ "$(docker image ls -q tinyproxy)" == "" ] && (cd dockerfiles/tinyproxy && ./build.sh)
