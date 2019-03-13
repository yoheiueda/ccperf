#!/bin/bash

./applytmpl.py templates/crypto-config.yaml.tmpl > crypto-config.yaml

rm -fr ./crypto-config/peerOrganizations/*/peers ./crypto-config/ordererOrganizations/*/orderers ./crypto-config/*Organizations/*/users/User*@*
./bin/cryptogen extend --config=./crypto-config.yaml --input=./crypto-config

./applytmpl.py templates/configtx.yaml.tmpl > configtx.yaml
./bin/configtxgen -profile OrdererGenesis -channelID testchainid -outputBlock ./genesis.block
./bin/configtxgen -profile MyChannel -channelID mychannel -outputCreateChannelTx ./mychannel.tx

./applytmpl.py templates/docker-compose.yaml.tmpl > docker-compose.yaml
./applytmpl.py templates/connection-profile.yaml.tmpl > connection-profile.yaml
./applytmpl.py --json templates/connection-profile.yaml.tmpl > connection-profile.json

mspids=$(jq -r '.organizations[].mspid' connection-profile.json)
for mspid in $mspids; do
  ./bin/configtxgen -profile MyChannel -outputAnchorPeersUpdate ${mspid}anchors.tx -channelID mychannel -asOrg ${mspid}
done

./applytmpl.py templates/prometheus-fabric.yml.tmpl  > ./prometheus/prometheus-fabric.yml
