#!/bin/bash

os=$(go env GOOS)
arch=$(go env GOARCH)

. ./.env

mkdir -p bin && docker run --rm hyperledger/fabric-tools:$FABRIC_TAG tar -cf - -C /usr/local/bin configtxgen configtxlator cryptogen discover idemixgen peer | tar -xvf - -C ./bin
docker run --rm hyperledger/fabric-tools:$FABRIC_TAG cat /etc/hyperledger/fabric/core.yaml > core.yaml

[ $(docker image ls -q tinyproxy) == "" ] && (cd dockerfiles/tinyproxy && ./build.sh)
