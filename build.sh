#!/bin/bash

set -ex

cd $(dirname $0)

tag=${1:-dev}
branch=${2:-dev}
base=${3:-0.4.15-dev}

targets="native orderer peer ccenv baseos tools"
#targets="peer"

export GOPATH=$PWD/go

if ! [ -d  go/src/github.com/hyperledger/fabric ]; then
    echo "fabric source not found under ./go.  Cloning..."
    git clone --branch $branch https://github.com/hyperledger/fabric.git ./go/src/github.com/hyperledger/fabric
    (cd ./go/src/github.com/hyperledger/fabric && git checkout -b $tag)
    #echo "applying patches"
    #for p in patches/*.patch; do
    #    [[ -f "$p" ]] && patch -p1 -d ./go/src/github.com/hyperledger/fabric < "$p"
    #done
fi

origdir=$PWD
cd ./go/src/github.com/hyperledger/fabric

for t in $targets; do
  rm -f .build/image*/"$t"/.dummy-*-*
done
rm -f .build/goshim.tar.bz2

make_targets=$(echo $targets | sed -E 's/(peer|orderer|tools)/\1-docker/g')

make BASEIMAGE_RELEASE="$base" $make_targets || exit 1
#make $make_targets || exit 1

for t in $targets; do
  if [[ "$t" = native ]]; then
    cp .build/bin/* "$origdir/bin/"
    continue
  fi
  id=$(docker image ls --format '{{ .ID }}' "hyperledger/fabric-$t:latest" )
  docker tag "hyperledger/fabric-$t:latest" "hyperledger/fabric-$t:$tag"
  if [[ -n "$id" ]]; then
    #docker image ls --format '{{ .ID }} {{ .Repository }} {{ .Tag }}' | awk "\$1 == \"$id\" && \$3 != \"$tag\" { print(\$2 \":\" \$3) }" | xargs $(xargs --version > /dev/null 2>&1 && echo -e --no-run-if-empty) docker image rm
    docker image ls --format '{{ .ID }} {{ .Repository }} {{ .Tag }}' | awk "\$1 == \"$id\" && \$3 != \"$tag\" && ( \$3 == \"latest\" || \$3 ~ /snapshot/) { print(\$2 \":\" \$3) }" | xargs $(xargs --version > /dev/null 2>&1 && echo -e --no-run-if-empty) docker image rm

  fi
done
