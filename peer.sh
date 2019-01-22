#!/bin/bash

#export CORE_LOGGING_LEVEL=${CORE_LOGGING_LEVEL:-ERROR}
export FABRIC_LOGGING_SPEC=${CORE_LOGGING_LEVEL:-ERROR}
export CORE_PEER_ID=${CORE_PEER_ID:-cli}
export CORE_PEER_ADDRESS=${CORE_PEER_ADDRESS:-localhost:7051}
export CORE_PEER_LOCALMSPID=${CORE_PEER_LOCALMSPID:-PeerOrg1}
export CORE_PEER_TLS_ENABLED=${CORE_PEER_TLS_ENABLED:-true}
export CORE_PEER_TLS_ROOTCERT_FILE=${CORE_PEER_TLS_ROOTCERT_FILE:-./crypto-config/peerOrganizations/org1.example.com/peers/peer1.org1.example.com/tls/ca.crt}
export CORE_PEER_MSPCONFIGPATH=${CORE_PEER_MSPCONFIGPATH:-./crypto-config/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp}
export FABRIC_CFG_PATH=${FABRIC_CFG_PATH:-.}

exec ./bin/peer "$@"
