#!/bin/bash

channel=${1:-mychannel}
target_org=${2:-org1}
peer="$3"

peers=$(jq --arg channel "$channel" -r '.channels[$channel].peers | keys_unsorted | .[]' connection-profile.json)

if [ -z "$peer" ]; then
  for peer in $peers; do
    org=$(jq --arg peer $peer -r '.organizations | to_entries[] | select(.value.peers[] | . == $peer).key' connection-profile.json)
    if [ "$org" == "$target_org" ]; then
        break
    fi
  done
fi
org="$target_org"

mspid=$(jq --arg org $org -r '.organizations[$org] | .mspid' connection-profile.json)
mspdir=$(jq --arg org $org -r '.organizations[$org] | .adminPrivateKey.path | sub("/[^/]*/[^/]*$";"")' connection-profile.json)
endpoint=$(jq --arg peer $peer -r '.peers[$peer].url | sub("grpc.?://";"")' connection-profile.json)
tlsca=$(jq --arg peer $peer -r '.peers[$peer].tlsCACerts.path' connection-profile.json)

orderer=$(jq --arg channel "$channel" -r '.channels[$channel].orderers[0]' connection-profile.json)
orderer_endpoint=$(jq --arg orderer $orderer -r '.orderers[$orderer].url | sub("grpc.?://";"")' connection-profile.json)
orderer_tlsca=$(jq --arg orderer $orderer -r '.orderers[$orderer].tlsCACerts.path' connection-profile.json)

CORE_PEER_LOCALMSPID=$mspid CORE_PEER_ADDRESS=$endpoint CORE_PEER_TLS_ROOTCERT_FILE=$tlsca CORE_PEER_MSPCONFIGPATH=$mspdir \
    ./peer.sh chaincode invoke --orderer $orderer_endpoint --tls true --cafile $orderer_tlsca \
    -C mychannel -n ccperf -c '{"Args":["putstate","1","64","key"]}' 
