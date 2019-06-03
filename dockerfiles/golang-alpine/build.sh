#!/bin/bash

go_ver=1.12.5

docker build -t golang:$go_ver-alpine3.9 .
