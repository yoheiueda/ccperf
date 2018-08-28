#!/bin/bash

./peer.sh chaincode install -n example02 -v v2 -l golang -p chaincode/chaincode_example02/go
./peer.sh chaincode upgrade -o localhost:7050 \
  --tls true --cafile ./crypto-config/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem \
  -C mychannel -n example02 -l golang -v v2 -c '{"Args":["init","a","90","b","210"]}' -P "OR('Org1MSP.member')"
