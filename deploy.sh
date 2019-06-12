#!/bin/bash

. env.sh

channel=${1:-mychannel}
suffix=${2:-""}

peers=$(jq --arg channel "$channel" -r '.channels[$channel].peers | keys_unsorted | .[]' connection-profile.json)

for peer in $peers; do
    org=$(jq --arg peer $peer -r '.organizations | to_entries[] | select(.value.peers[] | . == $peer).key' connection-profile.json)
    mspid=$(jq --arg org $org -r '.organizations[$org] | .mspid' connection-profile.json)
    mspdir=$(jq --arg org $org -r '.organizations[$org] | .adminPrivateKey.path | sub("/[^/]*/[^/]*$";"")' connection-profile.json)
    endpoint=$(jq --arg peer $peer -r '.peers[$peer].url | sub("grpc.?://";"")' connection-profile.json)
    tlsca=$(jq --arg peer $peer -r '.peers[$peer].tlsCACerts.path' connection-profile.json)

    CORE_PEER_LOCALMSPID=$mspid CORE_PEER_ADDRESS=$endpoint CORE_PEER_TLS_ROOTCERT_FILE=$tlsca CORE_PEER_MSPCONFIGPATH=$mspdir \
        ./peer.sh chaincode install -n "ccperf$suffix" -v v1 -l golang -p ccperf
done

orderer=$(jq --arg channel "$channel" -r '.channels[$channel].orderers[0]' connection-profile.json)
endpoint=$(jq --arg orderer $orderer -r '.orderers[$orderer].url | sub("grpc.?://";"")' connection-profile.json)
tlsca=$(jq --arg orderer $orderer -r '.orderers[$orderer].tlsCACerts.path' connection-profile.json)

./peer.sh chaincode instantiate --orderer $endpoint --tls true --cafile $tlsca \
  -C $channel -n "ccperf$suffix" -l golang -v v1 -c '{"Args":[]}'
