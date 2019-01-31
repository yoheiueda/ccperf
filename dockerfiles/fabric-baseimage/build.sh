#!/bin/bash

orig=${1:-0.4.14}
suffix=${2:-dev}
arch=$(go env GOARCH)

tag="$arch-$orig"

docker pull hyperledger/fabric-baseos:"$tag"
docker tag hyperledger/fabric-baseos:"$tag"  hyperledger/fabric-baseos:"$tag-$suffix"

docker build -t hyplerledger/fabric-baseimage:"$tag-$suffix" .
