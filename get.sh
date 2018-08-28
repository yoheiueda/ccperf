#!/bin/bash

os=$(go env GOOS)
arch=$(go env GOARCH)
rel=1.2.0
url="https://nexus.hyperledger.org/content/repositories/releases/org/hyperledger/fabric/hyperledger-fabric/$os-$arch-$rel/hyperledger-fabric-$os-$arch-$rel.tar.gz"

[ -d ./bin ] || curl "$url" | tar xzf - bin
[ -e core.yaml ] || curl -O -L https://raw.githubusercontent.com/hyperledger/fabric/release-1.2/sampleconfig/core.yaml
