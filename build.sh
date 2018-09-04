#!/bin/bash

cd $(dirname $0)

tag=${1:-dev}
targets="orderer peer ccenv"

export GOPATH=$PWD/go

if ! [ -d  go/src/github.com/hyperledger/fabric ]; then
    echo "fabric source not found under ./go.  Cloning..."
    git clone --branch master https://github.com/hyperledger/fabric.git ./go/src/github.com/hyperledger/fabric
fi

cd ./go/src/github.com/hyperledger/fabric

for t in $targets; do
  rm -f .build/image/"$t"/.dummy-*-*
done
rm -f .build/goshim.tar.bz2

make_targets=$(echo $targets | sed 's/\(peer\|orderer\)/\1-docker/g')

make $make_targets || exit 1

for t in $targets; do
  id=$(docker image ls --format '{{ .ID }}' "hyperledger/fabric-$t:latest" )
  docker tag "hyperledger/fabric-$t:latest" "hyperledger/fabric-$t:$tag"
  if [ -n "$id" ]; then
    docker image ls --format '{{ .ID }} {{ .Repository }} {{ .Tag }}' | awk "\$1 == \"$id\" && \$3 != \"$tag\" { print(\$2 \":\" \$3) }" | xargs --no-run-if-empty docker image rm 
  fi
done
