#!/bin/bash

. env.sh

channel=${1:-mychannel}
name=ccperf
ver=v1
path=$name
label="$name-$ver"
pkgname="$label.tar.gz"
profile=./connection-profile.yaml

peers=$(jq --arg channel "$channel" -r '.channels[$channel].peers | keys_unsorted | .[]' connection-profile.json)

./peer.sh lifecycle chaincode package "$pkgname" --path "$path" --lang golang --label "$label"

if true; then
for peer in $peers; do
    org=$(jq --arg peer $peer -r '.organizations | to_entries[] | select(.value.peers[] | . == $peer).key' connection-profile.json)
    mspid=$(jq --arg org $org -r '.organizations[$org] | .mspid' connection-profile.json)
    mspdir=$(jq --arg org $org -r '.organizations[$org] | .adminPrivateKey.path | sub("/[^/]*/[^/]*$";"")' connection-profile.json)
    endpoint=$(jq --arg peer $peer -r '.peers[$peer].url | sub("grpc.?://";"")' connection-profile.json)
    tlsca=$(jq --arg peer $peer -r '.peers[$peer].tlsCACerts.path' connection-profile.json)

    CORE_PEER_LOCALMSPID=$mspid CORE_PEER_ADDRESS=$endpoint CORE_PEER_TLS_ROOTCERT_FILE=$tlsca CORE_PEER_MSPCONFIGPATH=$mspdir \
        ./peer.sh lifecycle chaincode install "$pkgname"
done
else
    ./peer.sh lifecycle chaincode install --connectionProfile "$profile" "$pkgname"
fi

pkgid=$(./peer.sh lifecycle chaincode queryinstalled | awk "/Label: $label\$/"' { sub(/Package ID: /, ""); sub(/,.*$/,""); print}')

orderer=$(jq --arg channel "$channel" -r '.channels[$channel].orderers[0]' connection-profile.json)
endpoint=$(jq --arg orderer $orderer -r '.orderers[$orderer].url | sub("grpc.?://";"")' connection-profile.json)
tlsca=$(jq --arg orderer $orderer -r '.orderers[$orderer].tlsCACerts.path' connection-profile.json)
orgs=$(jq -r '.organizations | keys[]' connection-profile.json)
for org in $orgs; do
    mspid=$(jq --arg org $org -r '.organizations[$org] | .mspid' connection-profile.json)
    mspdir=$(jq --arg org $org -r '.organizations[$org] | .adminPrivateKey.path | sub("/[^/]*/[^/]*$";"")' connection-profile.json)
    CORE_PEER_LOCALMSPID=$mspid CORE_PEER_MSPCONFIGPATH=$mspdir \
        ./peer.sh lifecycle chaincode approveformyorg --channelID "$channel" --name "$name" --version "$ver" --init-required --package-id "$pkgid"  --sequence 1 --waitForEvent --orderer "$endpoint" --tls --cafile "$tlsca"
done

./peer.sh lifecycle chaincode commit --channelID "$channel" --name "$name" --version "$ver" --sequence 1 --init-required --orderer "$endpoint" --tls --cafile "$tlsca"


flags=''
for peer in $peers; do
    peerEndpoint=$(jq --arg peer $peer -r '.peers[$peer].url | sub("grpc.?://";"")' connection-profile.json)
    peerTlsCa=$(jq --arg peer $peer -r '.peers[$peer].tlsCACerts.path' connection-profile.json)
    flags+=" --peerAddresses $peerEndpoint --tlsRootCertFiles $peerTlsCa"
done

./peer.sh chaincode invoke $flags --orderer "$endpoint" --tls --cafile "$tlsca"  -C "$channel" -n "$name" --waitForEvent --isInit -c '{"Args":[]}'
