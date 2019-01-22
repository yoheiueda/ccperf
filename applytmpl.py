#!/usr/bin/env python3

import sys
import glob
import json
import yaml

from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader('./', encoding='utf8'))

if sys.argv[1] == '--json':
    genJSON = True
    tplfile = sys.argv[2]
else:
    genJSON = False
    tplfile = sys.argv[1]

def findsk(org):
    dir = 'crypto-config/peerOrganizations/' + org['domain'] + '/users/Admin@' + org['domain'] + '/msp/keystore'
    return glob.glob(dir + '/*_sk')[0]

env.filters['findsk'] = findsk
tpl = env.get_template(tplfile)

commonDomain = 'example.com'
commonHostname = 'localhost'

data = {
    'network': 'ccperf',
    'ordererorg': {
          'name': 'orderer',
          'mspid': 'OrdererOrg',
          'domain': commonDomain,
          'orderers': [
              { 'name': 'orderer1', 'host': commonHostname, 'ports': { 'requests':7050, 'pprof':7060 }},
          ]
    },
    'orgs': [
        {   'name': 'org1',
            'mspid': 'PeerOrg1',
            'domain': 'org1.' + commonDomain,
            'peers': [
                { 'name': 'peer1', 'ports': { 'requests':7051, 'pprof':7061, 'metrics':8080 }, 'host': commonHostname },
            ]
        }
    ]
}

out = tpl.render(data)

if genJSON:
    print(json.dumps(yaml.load(out), indent=4))
else:
    print(out)
