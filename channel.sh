#!/bin/bash

channel=${1:-mychannel}

orderer=$(jq --arg channel "$channel" -r '.channels[$channel].orderers[0]' connection-profile.json)
endpoint=$(jq --arg orderer $orderer -r '.orderers[$orderer].url | sub("grpc.?://";"")' connection-profile.json)
tlsca=$(jq --arg orderer $orderer -r '.orderers[$orderer].tlsCACerts.path' connection-profile.json)

./peer.sh channel create --orderer $endpoint --channelID $channel --file "./$channel.tx" --tls true --cafile $tlsca

peers=$(jq --arg channel "$channel" -r '.channels[$channel].peers | keys_unsorted | .[]' connection-profile.json)

for peer in $peers; do
    org=$(jq --arg peer $peer -r '.organizations | to_entries[] | select(.value.peers[] | . == $peer).key' connection-profile.json)
    mspid=$(jq --arg org $org -r '.organizations[$org] | .mspid' connection-profile.json)
    mspdir=$(jq --arg org $org -r '.organizations[$org] | .adminPrivateKey.path | sub("/[^/]*/[^/]*$";"")' connection-profile.json)
    endpoint=$(jq --arg peer $peer -r '.peers[$peer].url | sub("grpc.?://";"")' connection-profile.json)
    tlsca=$(jq --arg peer $peer -r '.peers[$peer].tlsCACerts.path' connection-profile.json)

    CORE_PEER_LOCALMSPID=$mspid CORE_PEER_ADDRESS=$endpoint CORE_PEER_TLS_ROOTCERT_FILE=$tlsca CORE_PEER_MSPCONFIGPATH=$mspdir \
        ./peer.sh channel join -b "./$channel.block"
done
exit 0
orderer=$(jq --arg channel "$channel" -r '.channels[$channel].orderers[0]' connection-profile.json)
endpoint=$(jq --arg orderer $orderer -r '.orderers[$orderer].url | sub("grpc.?://";"")' connection-profile.json)
tlsca=$(jq --arg orderer $orderer -r '.orderers[$orderer].tlsCACerts.path' connection-profile.json)
orgs=$(jq -r '.organizations | keys[]' connection-profile.json)
for org in $orgs; do
    mspid=$(jq --arg org $org -r '.organizations[$org] | .mspid' connection-profile.json)
    mspdir=$(jq --arg org $org -r '.organizations[$org] | .adminPrivateKey.path | sub("/[^/]*/[^/]*$";"")' connection-profile.json)
    CORE_PEER_LOCALMSPID=$mspid CORE_PEER_MSPCONFIGPATH=$mspdir \
        ./peer.sh channel update --orderer $endpoint --channelID $channel --tls true --cafile $tlsca --file "${mspid}anchors.tx"
done
