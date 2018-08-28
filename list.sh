#!/bin/bash

./peer.sh channel list
./peer.sh chaincode list --installed
./peer.sh chaincode list --channelID mychannel --instantiated
