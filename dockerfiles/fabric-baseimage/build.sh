#!/bin/bash

orig=${1:-0.4.15}
suffix=${2:-dev}
arch=$(go env GOARCH)

tag="$arch-$orig"

docker pull hyperledger/fabric-baseos:"$tag"
docker tag hyperledger/fabric-baseos:"$tag"  hyperledger/fabric-baseos:"$tag-$suffix"

docker build --build-arg BASE_VERSION="$orig" --build-arg GO_VERSION=1.12.5 -t hyperledger/fabric-baseimage:"$tag-$suffix" .
docker tag hyperledger/fabric-baseimage:"$tag-$suffix"  hyperledger/fabric-baseimage:"$orig-$suffix"
