#!/bin/bash

os=$(go env GOOS)
arch=$(go env GOARCH)
. ./.env
[ -d ./bin ] || mkdir -p bin && docker run --rm hyperledger/fabric-tools:$FABRIC_TAG tar -cf - -C /usr/local/bin configtxgen configtxlator cryptogen discover idemixgen peer | tar -xvf - -C ./bin
[ -e core.yaml ] || docker run --rm hyperledger/fabric-tools:$FABRIC_TAG cat /etc/hyperledger/fabric/core.yaml > core.yaml
